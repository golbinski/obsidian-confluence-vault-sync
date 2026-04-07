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

export default class ConfluenceVaultSyncPlugin extends Plugin {
  settings!: ConfluenceVaultSyncSettings;
  private statusBarEl!: HTMLElement;
  private syncInProgress = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();

    // Ribbon icon
    this.addRibbonIcon('refresh-cw', 'Sync Confluence', () => {
      this.syncAll();
    });

    // Command
    this.addCommand({
      id: 'sync-confluence',
      name: 'Sync Confluence',
      callback: () => {
        this.syncAll();
      },
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

    // Read-only enforcement: revert edits to synced files
    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        const isManaged = this.settings.syncTargets.some((t) =>
          file.path.startsWith(t.syncFolderPath + '/')
        );
        if (isManaged) {
          new Notice(
            'This file is managed by Confluence Vault Sync and cannot be edited.'
          );
          // Re-read from disk to revert
          this.app.vault.adapter
            .read(file.path)
            .then((content) => {
              this.app.vault.adapter.write(file.path, content);
            })
            .catch(() => {
              // Ignore if read fails
            });
        }
      })
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private validateSettings(): string[] {
    const missing: string[] = [];
    if (!this.settings.confluenceBaseUrl) missing.push('Confluence Base URL');
    if (!this.settings.confluenceEmail) missing.push('Confluence Email');
    if (!this.settings.confluenceApiToken) missing.push('Confluence API Token');
    if (this.settings.syncTargets.length === 0) missing.push('at least one Sync Target');
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
    const settingsOnly = missing.filter((m) => m !== 'at least one Sync Target');
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

    containerEl.createEl('h2', { text: 'Confluence Vault Sync' });

    new Setting(containerEl)
      .setName('Confluence Base URL')
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
      .setName('Confluence Email')
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
      .setName('Confluence API Token')
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
            new Notice('Fill in Base URL, Email, and API Token first.');
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
    containerEl.createEl('h3', { text: 'Sync Targets' });

    const tableContainer = containerEl.createDiv();
    this.renderSyncTargetsTable(tableContainer);
  }

  private renderSyncTargetsTable(container: HTMLElement): void {
    container.empty();

    const table = container.createEl('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';

    const thead = table.createEl('thead');
    const headerRow = thead.createEl('tr');
    headerRow.createEl('th', { text: 'Space Key' });
    headerRow.createEl('th', { text: 'Vault Folder Path' });
    headerRow.createEl('th', { text: '' });

    const tbody = table.createEl('tbody');

    for (let i = 0; i < this.plugin.settings.syncTargets.length; i++) {
      const target = this.plugin.settings.syncTargets[i];
      const row = tbody.createEl('tr');

      const keyCell = row.createEl('td');
      const keyInput = keyCell.createEl('input', { type: 'text' });
      keyInput.value = target.spaceKey;
      keyInput.placeholder = 'ENG';
      keyInput.style.width = '100%';
      keyInput.addEventListener('change', async () => {
        this.plugin.settings.syncTargets[i].spaceKey = keyInput.value.trim();
        await this.plugin.saveSettings();
      });

      const pathCell = row.createEl('td');
      const pathInput = pathCell.createEl('input', { type: 'text' });
      pathInput.value = target.syncFolderPath;
      pathInput.placeholder = 'confluence/eng';
      pathInput.style.width = '100%';
      pathInput.addEventListener('change', async () => {
        this.plugin.settings.syncTargets[i].syncFolderPath = pathInput.value.trim();
        await this.plugin.saveSettings();
      });

      const removeCell = row.createEl('td');
      const removeBtn = removeCell.createEl('button', { text: '×' });
      removeBtn.style.cursor = 'pointer';
      removeBtn.addEventListener('click', async () => {
        this.plugin.settings.syncTargets.splice(i, 1);
        await this.plugin.saveSettings();
        this.renderSyncTargetsTable(container);
      });
    }

    const addBtn = container.createEl('button', { text: 'Add sync target' });
    addBtn.style.marginTop = '8px';
    addBtn.addEventListener('click', async () => {
      this.plugin.settings.syncTargets.push({ spaceKey: '', syncFolderPath: '' });
      await this.plugin.saveSettings();
      this.renderSyncTargetsTable(container);
    });
  }
}
