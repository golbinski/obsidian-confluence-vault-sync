import {
  App,
  ButtonComponent,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
} from 'obsidian';
import {
  DEFAULT_SETTINGS,
  type ConfluenceVaultSyncSettings,
  type SyncTarget,
} from './src/settings';
import { runSyncForTarget } from './src/sync-engine';
import { WritebackView, WRITEBACK_VIEW_TYPE } from './src/writeback-view';
import { isWritable } from './src/fs-utils';

export default class ConfluenceVaultSyncPlugin extends Plugin {
  settings!: ConfluenceVaultSyncSettings;
  private statusBarEl!: HTMLElement;
  private syncInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();

    // Register writeback view
    this.registerView(WRITEBACK_VIEW_TYPE, (leaf) => new WritebackView(leaf, this));

    // Ribbon: sync
    this.addRibbonIcon('refresh-cw', 'Sync Confluence', () => {
      void this.syncAll();
    });

    // Ribbon: changes pane
    this.addRibbonIcon('git-pull-request', 'Confluence changes', () => {
      this.openWritebackView();
    });

    // Commands
    this.addCommand({
      id: 'sync-confluence',
      name: 'Sync Confluence',
      callback: () => { void this.syncAll(); },
    });

    this.addCommand({
      id: 'open-confluence-changes',
      name: 'Open Confluence changes',
      callback: () => { this.openWritebackView(); },
    });

    // Settings tab
    this.addSettingTab(new ConfluenceVaultSyncSettingTab(this.app, this));

    // Folder context menu
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFolder) {
          const target = this.settings.syncTargets.find(
            (t) => t.syncFolderPath === file.path
          );
          if (target) {
            menu.addItem((item) => {
              item
                .setTitle('Pull Confluence')
                .setIcon('refresh-cw')
                .onClick(() => this.syncTarget(target));
            });
          }
        }
      })
    );

    // Read-only enforcement: revert edits to locked synced files.
    // Skip the revert if the file has been explicitly unlocked (writable).
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const isManaged = this.settings.syncTargets.some((t) =>
          file.path.startsWith(t.syncFolderPath + '/')
        );
        if (!isManaged) return;

        // If the file is writable, the user unlocked it intentionally — don't revert
        if (isWritable(this.app.vault, file.path)) return;

        new Notice('This file is managed by Confluence Vault Sync and cannot be edited.');
        this.app.vault.adapter
          .read(file.path)
          .then((content) => this.app.vault.adapter.write(file.path, content))
          .catch(() => { /* ignore */ });
      })
    );
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      new Notice('Confluence Vault Sync: sync already in progress');
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
      for (const target of targets) {
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
      new Notice(
        `Sync complete — ${targets.length} space${targets.length !== 1 ? 's' : ''}, ${totalPages} pages synced`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
    } finally {
      this.syncInProgress = false;
      this.clearStatus();
    }
  }

  async syncTarget(target: SyncTarget): Promise<void> {
    if (this.syncInProgress) {
      new Notice('Confluence Vault Sync: sync already in progress');
      return;
    }

    const missing = this.validateSettings();
    const settingsOnly = missing.filter((m) => m !== 'at least one sync target');
    if (settingsOnly.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${settingsOnly.join(', ')}`);
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
        }
      );
      new Notice(`Sync complete — ${target.spaceKey}: ${count} pages synced`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
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

    new Setting(containerEl).setName('Confluence vault sync').setHeading();

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
      .setDesc('Your Atlassian account email')
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

    new Setting(containerEl)
      .setName('Max image download size (KB)')
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
      .setDesc('Number of pages fetched in parallel (1–20). Higher values are faster but may hit Confluence rate limits.')
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
