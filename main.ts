import {
  App,
  ButtonComponent,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
} from 'obsidian';
import {
  DEFAULT_SETTINGS,
  type ConfluenceVaultSyncSettings,
  type SyncTarget,
} from './src/settings';
import { encryptToken, decryptToken, isEncryptionAvailable } from './src/token-crypto';
import { runSyncForTarget, runPagePull, readManifestFile, buildManifestIndex, type PullScope } from './src/sync-engine';
import { WritebackView, WRITEBACK_VIEW_TYPE } from './src/writeback-view';
import { HerbalistView, HERBALIST_VIEW_TYPE } from './src/herbalist-view';
import { detectHerbalistBinary, runHerbalistIndex } from './src/herbalist';
import { isWritable, findUnlockedFiles, extractFrontmatterField } from './src/fs-utils';

/** Returns the sync target that owns filePath, or null if unmanaged. */
function findOwningTarget(filePath: string, syncTargets: SyncTarget[]): SyncTarget | null {
  for (const target of syncTargets) {
    if (
      filePath === target.syncFolderPath ||
      filePath.startsWith(target.syncFolderPath + '/')
    ) {
      return target;
    }
  }
  return null;
}

export default class ConfluenceVaultSyncPlugin extends Plugin {
  settings!: ConfluenceVaultSyncSettings;
  pendingRemoteChanges = 0;
  private statusBarEl!: HTMLElement;
  private syncInProgress = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();

    // Register views
    this.registerView(WRITEBACK_VIEW_TYPE, (leaf) => new WritebackView(leaf, this));
    this.registerView(HERBALIST_VIEW_TYPE, (leaf) => new HerbalistView(leaf, this));

    // Ribbon: sync
    this.addRibbonIcon('refresh-cw', 'Sync confluence', () => {
      void this.syncAll();
    });

    // Ribbon: changes pane
    this.addRibbonIcon('upload-cloud', 'Confluence changes', () => {
      this.openWritebackView();
    });

    // Commands
    this.addCommand({
      id: 'sync-confluence',
      name: 'Sync confluence',
      callback: () => { void this.syncAll(); },
    });

    this.addCommand({
      id: 'open-confluence-changes',
      name: 'Open confluence changes',
      callback: () => { this.openWritebackView(); },
    });

    this.addCommand({
      id: 'open-herbalist-search',
      name: 'Open Confluence search',
      callback: () => { this.openHerbalistView(); },
    });

    // Settings tab
    this.addSettingTab(new ConfluenceVaultSyncSettingTab(this.app, this));

    // Context menu for any folder or .md file inside a managed sync target
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        const target = findOwningTarget(file.path, this.settings.syncTargets);
        if (!target) return;

        if (file instanceof TFolder) {
          const isRoot = file.path === target.syncFolderPath;
          menu.addItem((item) => {
            item
              .setTitle(isRoot ? 'Pull confluence' : 'Pull this folder')
              .setIcon('refresh-cw')
              .onClick(() => {
                const scope: PullScope = isRoot
                  ? { kind: 'space' }
                  : { kind: 'subtree', vaultPath: file.path };
                void this.syncTarget(target, scope);
              });
          });
        } else if (file instanceof TFile && file.extension === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('Pull this page')
              .setIcon('refresh-cw')
              .onClick(() => { void this.pullPage(target, file.path); });
          });
        }
      })
    );

    // Read-only enforcement: keep locked synced files in reading mode.
    // When a leaf switches to edit mode for a locked managed file, silently
    // flip it back to preview mode so the user never sees the editor.
    const enforceReadingMode = (): void => {
      const leaf = this.app.workspace.activeLeaf;
      if (!leaf) return;
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (view.getMode() === 'preview') return;

      const file = view.file;
      if (!file) return;
      const isManaged = this.settings.syncTargets.some((t) =>
        file.path.startsWith(t.syncFolderPath + '/')
      );
      if (!isManaged) return;
      if (isWritable(this.app.vault, file.path)) return;

      // Switch back to reading mode without any popup
      void leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'preview' } });
    };

    this.registerEvent(this.app.workspace.on('active-leaf-change', enforceReadingMode));
    this.registerEvent(this.app.workspace.on('layout-change', enforceReadingMode));

    // Fallback content-revert in case a modification slips through (e.g. from
    // another plugin or a macro), without showing a disruptive notice.
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const isManaged = this.settings.syncTargets.some((t) =>
          file.path.startsWith(t.syncFolderPath + '/')
        );
        if (!isManaged) return;
        if (isWritable(this.app.vault, file.path)) return;

        this.app.vault.adapter
          .read(file.path)
          .then((content) => this.app.vault.adapter.write(file.path, content))
          .catch(() => { /* ignore */ });
      })
    );

    this.startPolling();
  }

  startPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.settings.pollingEnabled) return;
    const ms = this.settings.pollingIntervalMinutes * 60 * 1000;
    void this.pollRemoteChanges();
    this.pollTimer = setInterval(() => { void this.pollRemoteChanges(); }, ms);
  }

  private async pollRemoteChanges(): Promise<void> {
    const { confluenceBaseUrl, confluenceEmail, confluenceApiToken } = this.settings;
    if (!confluenceBaseUrl || !confluenceEmail || !confluenceApiToken) return;

    const { ConfluenceClient } = await import('./src/confluence-client');
    const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);

    let count = 0;
    for (const target of this.settings.syncTargets) {
      try {
        const manifestPath = `${target.syncFolderPath}/manifest.json`;
        const manifest = await readManifestFile(this.app.vault, manifestPath);
        if (!manifest) continue;
        const index = buildManifestIndex(manifest);

        const { id: spaceId } = await client.getSpaceByKey(target.spaceKey);
        const pages = await client.getSpacePages(spaceId, target.spaceKey);

        for (const page of pages) {
          const node = index.get(page.id);
          if (!node) continue;
          const remoteTime = new Date(page.versionDate).getTime();
          const syncedTime = new Date(node.lastSynced).getTime();
          if (remoteTime > syncedTime) count++;
        }
      } catch { /* network errors are silent — polling is best-effort */ }
    }

    if (count !== this.pendingRemoteChanges) {
      this.pendingRemoteChanges = count;
      this.refreshWritebackView();
    }
  }

  refreshWritebackView(): void {
    const leaves = this.app.workspace.getLeavesOfType(WRITEBACK_VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof WritebackView) {
        void (leaf.view as WritebackView).refresh();
      }
    }
  }

  openWritebackView(): void {
    const existing = this.app.workspace.getLeavesOfType(WRITEBACK_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      void leaf.setViewState({ type: WRITEBACK_VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  openHerbalistView(): void {
    const existing = this.app.workspace.getLeavesOfType(HERBALIST_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      void leaf.setViewState({ type: HERBALIST_VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Decrypt token from disk into the in-memory settings field
    this.settings.confluenceApiToken = decryptToken(this.settings.confluenceApiToken);
    // Auto-detect herbalist binary on first load
    if (!this.settings.herbalistBinaryPath) {
      this.settings.herbalistBinaryPath = detectHerbalistBinary();
    }
  }

  async saveSettings(): Promise<void> {
    const toStore: ConfluenceVaultSyncSettings = { ...this.settings };
    if (toStore.encryptApiToken) {
      toStore.confluenceApiToken = encryptToken(toStore.confluenceApiToken);
    }
    await this.saveData(toStore);
  }

  private validateSettings(): string[] {
    const missing: string[] = [];
    if (!this.settings.confluenceBaseUrl) missing.push('Confluence base URL');
    if (!this.settings.confluenceEmail) missing.push('Confluence email');
    if (!this.settings.confluenceApiToken) missing.push('Confluence API token');
    if (this.settings.syncTargets.length === 0) missing.push('at least one sync target');
    return missing;
  }

  private setStatus(text: string): void {
    this.statusBarEl.setText(text);
  }

  private clearStatus(): void {
    this.statusBarEl.setText('');
  }

  async syncAll(): Promise<void> {
    if (this.syncInProgress) {
      new Notice('Confluence vault sync: sync already in progress');
      return;
    }

    const missing = this.validateSettings();
    if (missing.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${missing.join(', ')}`);
      return;
    }

    this.syncInProgress = true;
    let totalPages = 0;
    const targets = this.settings.syncTargets;

    try {
      const skippedSpaces: string[] = [];
      for (const target of targets) {
        const unlocked = await findUnlockedFiles(this.app.vault, target.syncFolderPath);
        if (unlocked.length > 0) {
          new Notice(
            `${target.spaceKey}: ${unlocked.length} unlocked page${unlocked.length !== 1 ? 's' : ''} — push or relock before syncing`,
            8000
          );
          skippedSpaces.push(target.spaceKey);
          continue;
        }
        this.setStatus(`↻ Syncing ${target.spaceKey}…`);
        const count = await runSyncForTarget(
          target,
          this.settings,
          this.app.vault,
          (current, total, label) => {
            this.setStatus(`↻ ${target.spaceKey} ${current}/${total} — ${label}`);
          }
        );
        totalPages += count;
      }
      const synced = targets.length - skippedSpaces.length;
      new Notice(
        `Sync complete — ${synced} space${synced !== 1 ? 's' : ''}, ${totalPages} pages synced` +
        (skippedSpaces.length > 0 ? ` (${skippedSpaces.join(', ')} skipped)` : '')
      );
      if (this.app.vault.adapter instanceof FileSystemAdapter) {
        runHerbalistIndex(this, this.app.vault.adapter.getBasePath());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
    } finally {
      this.syncInProgress = false;
      this.clearStatus();
      this.pendingRemoteChanges = 0;
      this.refreshWritebackView();
      void this.pollRemoteChanges();
    }
  }

  async syncTarget(target: SyncTarget, scope: PullScope = { kind: 'space' }): Promise<void> {
    if (this.syncInProgress) {
      new Notice('Confluence vault sync: sync already in progress');
      return;
    }

    const missing = this.validateSettings();
    const settingsOnly = missing.filter((m) => m !== 'at least one sync target');
    if (settingsOnly.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${settingsOnly.join(', ')}`);
      return;
    }

    // Unlock gate: scoped to the pull target
    const unlocked = scope.kind === 'space'
      ? await findUnlockedFiles(this.app.vault, target.syncFolderPath)
      : await findUnlockedFiles(this.app.vault, scope.vaultPath);

    if (unlocked.length > 0) {
      new Notice(
        `${unlocked.length} unlocked page${unlocked.length !== 1 ? 's' : ''} — push or relock before pulling`,
        8000
      );
      return;
    }

    this.syncInProgress = true;
    try {
      this.setStatus(`↻ Syncing ${target.spaceKey}…`);
      const count = await runSyncForTarget(
        target,
        this.settings,
        this.app.vault,
        (current, total, label) => {
          this.setStatus(`↻ ${target.spaceKey} ${current}/${total} — ${label}`);
        },
        scope
      );
      new Notice(`Sync complete — ${target.spaceKey}: ${count} pages synced`);
      if (this.app.vault.adapter instanceof FileSystemAdapter) {
        runHerbalistIndex(this, this.app.vault.adapter.getBasePath());
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
    } finally {
      this.syncInProgress = false;
      this.clearStatus();
    }
  }

  private async pullPage(target: SyncTarget, filePath: string): Promise<void> {
    if (this.syncInProgress) {
      new Notice('Confluence vault sync: sync already in progress');
      return;
    }

    let rawContent: string;
    try {
      rawContent = await this.app.vault.adapter.read(filePath);
    } catch {
      new Notice('Could not read file.');
      return;
    }
    const pageId = extractFrontmatterField(rawContent, 'confluence-id');
    if (!pageId) {
      new Notice('This file is not a managed Confluence page.');
      return;
    }

    if (isWritable(this.app.vault, filePath)) {
      new Notice('This page is unlocked — push or relock before pulling', 8000);
      return;
    }

    const missing = this.validateSettings().filter((m) => m !== 'at least one sync target');
    if (missing.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${missing.join(', ')}`);
      return;
    }

    this.syncInProgress = true;
    try {
      this.setStatus(`↻ Pulling page…`);
      await runPagePull(pageId, filePath, target, this.settings, this.app.vault);
      new Notice('Page pulled from Confluence.');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Pull failed: ${message}`);
    } finally {
      this.syncInProgress = false;
      this.clearStatus();
    }
  }
}

class ConfluenceVaultSyncSettingTab extends PluginSettingTab {
  plugin: ConfluenceVaultSyncPlugin;

  constructor(app: App, plugin: ConfluenceVaultSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Confluence base URL')
      .setDesc('e.g. https://yourorg.atlassian.net')
      .addText((text) =>
        text
          .setPlaceholder('https://yourorg.atlassian.net')
          .setValue(this.plugin.settings.confluenceBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.confluenceBaseUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence email')
      .setDesc('Your account email')
      .addText((text) =>
        text
          .setPlaceholder('you@example.com')
          .setValue(this.plugin.settings.confluenceEmail)
          .onChange(async (value) => {
            this.plugin.settings.confluenceEmail = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Confluence API token')
      .setDesc('Atlassian API token (stored in plugin data)')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('••••••••••••')
          .setValue(this.plugin.settings.confluenceApiToken)
          .onChange(async (value) => {
            this.plugin.settings.confluenceApiToken = value;
            await this.plugin.saveSettings();
          });
      });

    const encryptAvailable = isEncryptionAvailable();
    new Setting(containerEl)
      .setName('Encrypt API token')
      .setDesc(
        encryptAvailable
          ? 'Encrypt the API token at rest using the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service). Prevents other apps and AI agents from reading it out of data.json.'
          : 'OS-level encryption is not available on this platform. The token will be stored as plain text.'
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.encryptApiToken && encryptAvailable)
          .setDisabled(!encryptAvailable)
          .onChange(async (value) => {
            this.plugin.settings.encryptApiToken = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Max image download size in KB')
      .setDesc('Images at or below this size are downloaded locally')
      .addText((text) =>
        text
          .setPlaceholder('500')
          .setValue(String(this.plugin.settings.maxImageDownloadSizeKb))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxImageDownloadSizeKb = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName('Sync concurrency')
      .setDesc('Number of pages fetched in parallel (1–20). Higher values are faster but may hit confluence rate limits.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.syncConcurrency)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncConcurrency = value;
            await this.plugin.saveSettings();
          })
      );

    // Test connection
    let testBtn: ButtonComponent;
    new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Verify credentials and check access to each configured space')
      .addButton((btn) => {
        testBtn = btn;
        btn.setButtonText('Test').onClick(async () => {
          const { confluenceBaseUrl, confluenceEmail, confluenceApiToken, syncTargets } =
            this.plugin.settings;

          if (!confluenceBaseUrl || !confluenceEmail || !confluenceApiToken) {
            new Notice('Fill in base URL, email, and API token first.');
            return;
          }

          testBtn.setButtonText('Testing…').setDisabled(true);

          try {
            const { ConfluenceClient } = await import('./src/confluence-client');
            const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);

            const displayName = await client.testConnection();
            new Notice(`Connected as ${displayName}`);

            for (const target of syncTargets) {
              if (!target.spaceKey) continue;
              try {
                const spaceName = await client.checkSpaceAccess(target.spaceKey);
                new Notice(`Space "${target.spaceKey}": OK (${spaceName})`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Space "${target.spaceKey}": ${msg}`, 8000);
              }
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Connection failed: ${msg}`, 8000);
          } finally {
            testBtn.setButtonText('Test').setDisabled(false);
          }
        });
      });

    // Herbalist integration section
    new Setting(containerEl).setName('Remote polling').setHeading();

    const pollIntervalSetting = new Setting(containerEl)
      .setName('Check interval')
      .setDesc('How often to poll Confluence for remote changes.')
      .addDropdown((d) =>
        d
          .addOptions({ '5': '5 minutes', '15': '15 minutes', '30': '30 minutes', '60': '1 hour' })
          .setValue(String(this.plugin.settings.pollingIntervalMinutes))
          .onChange(async (v) => {
            this.plugin.settings.pollingIntervalMinutes = parseInt(v);
            await this.plugin.saveSettings();
            this.plugin.startPolling();
          })
      );

    new Setting(containerEl)
      .setName('Enable polling')
      .setDesc('Periodically check Confluence for pages updated since last sync and show a badge in the changes panel.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.pollingEnabled).onChange(async (v) => {
          this.plugin.settings.pollingEnabled = v;
          pollIntervalSetting.settingEl.style.display = v ? '' : 'none';
          await this.plugin.saveSettings();
          this.plugin.startPolling();
        })
      );

    pollIntervalSetting.settingEl.style.display = this.plugin.settings.pollingEnabled ? '' : 'none';

    new Setting(containerEl).setName('Herbalist integration').setHeading();

    const s = this.plugin.settings;

    const toggleDeps = (enabled: boolean): void => {
      depSettings.forEach((d) => { d.settingEl.style.display = enabled ? '' : 'none'; });
    };

    new Setting(containerEl)
      .setName('Enable Herbalist')
      .setDesc('Re-index after each sync and enable semantic search over Confluence notes. Requires herbalist-mcp to be installed.')
      .addToggle((t) =>
        t.setValue(s.herbalistEnabled).onChange(async (v) => {
          s.herbalistEnabled = v;
          await this.plugin.saveSettings();
          toggleDeps(v);
        })
      );

    const binarySetting = new Setting(containerEl)
      .setName('Binary path')
      .setDesc('Path to the herbalist-mcp executable.')
      .addText((t) =>
        t.setValue(s.herbalistBinaryPath)
          .onChange(async (v) => { s.herbalistBinaryPath = v.trim(); await this.plugin.saveSettings(); })
      );

    const scopeSetting = new Setting(containerEl)
      .setName('Index scope')
      .setDesc('Which notes to include in the semantic index.')
      .addDropdown((d) =>
        d.addOption('confluence', 'Confluence sync folders only')
          .addOption('vault', 'Entire vault')
          .setValue(s.herbalistIndexScope)
          .onChange(async (v) => {
            s.herbalistIndexScope = v as 'vault' | 'confluence';
            await this.plugin.saveSettings();
          })
      );

    const modelSetting = new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Downloaded once on first use. Larger models give better results but are slower.')
      .addDropdown((d) =>
        d.addOption('bge-small-en-v1.5', 'bge-small-en-v1.5 — 130 MB (recommended)')
          .addOption('all-minilm-l6-v2', 'all-minilm-l6-v2 — 90 MB (fastest)')
          .addOption('bge-base-en-v1.5', 'bge-base-en-v1.5 — 440 MB')
          .addOption('nomic-embed-text-v1.5', 'nomic-embed-text-v1.5 — 550 MB')
          .setValue(s.herbalistModel)
          .onChange(async (v) => { s.herbalistModel = v; await this.plugin.saveSettings(); })
      );

    const depSettings = [binarySetting, scopeSetting, modelSetting];
    toggleDeps(s.herbalistEnabled);

    // Sync targets section
    new Setting(containerEl).setName('Sync targets').setHeading();

    const tableContainer = containerEl.createDiv();
    this.renderSyncTargetsTable(tableContainer);
  }

  private renderSyncTargetsTable(container: HTMLElement): void {
    container.empty();

    const table = container.createEl('table', { cls: 'cvs-targets-table' });

    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Space key' });
    headerRow.createEl('th', { text: 'Vault folder path' });
    headerRow.createEl('th', { text: '' });

    const tbody = table.createEl('tbody');

    for (let i = 0; i < this.plugin.settings.syncTargets.length; i++) {
      const target = this.plugin.settings.syncTargets[i];
      const row = tbody.createEl('tr');

      const keyCell = row.createEl('td');
      const keyInput = keyCell.createEl('input', { type: 'text', cls: 'cvs-full-width' });
      keyInput.value = target.spaceKey;
      keyInput.placeholder = 'ENG';
      keyInput.addEventListener('change', () => {
        this.plugin.settings.syncTargets[i].spaceKey = keyInput.value.trim();
        void this.plugin.saveSettings();
      });

      const pathCell = row.createEl('td');
      const pathInput = pathCell.createEl('input', { type: 'text', cls: 'cvs-full-width' });
      pathInput.value = target.syncFolderPath;
      pathInput.placeholder = 'confluence/eng';
      pathInput.addEventListener('change', () => {
        this.plugin.settings.syncTargets[i].syncFolderPath = pathInput.value.trim();
        void this.plugin.saveSettings();
      });

      const removeCell = row.createEl('td');
      const removeBtn = removeCell.createEl('button', { text: '×', cls: 'cvs-remove-btn' });
      removeBtn.addEventListener('click', () => {
        this.plugin.settings.syncTargets.splice(i, 1);
        void this.plugin.saveSettings();
        this.renderSyncTargetsTable(container);
      });
    }

    const addBtn = container.createEl('button', { text: 'Add sync target', cls: 'cvs-add-target-btn' });
    addBtn.addEventListener('click', () => {
      this.plugin.settings.syncTargets.push({ spaceKey: '', syncFolderPath: '' });
      void this.plugin.saveSettings();
      this.renderSyncTargetsTable(container);
    });
  }
}
