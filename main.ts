import {
  App,
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

  async onload(): Promise<void> {
    await this.loadSettings();

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

  async syncAll(): Promise<void> {
    const missing = this.validateSettings();
    if (missing.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${missing.join(', ')}`);
      return;
    }

    let totalPages = 0;
    const targets = this.settings.syncTargets;

    try {
      for (const target of targets) {
        const count = await runSyncForTarget(target, this.settings, this.app.vault);
        totalPages += count;
      }
      new Notice(
        `Sync complete — ${targets.length} space${targets.length !== 1 ? 's' : ''}, ${totalPages} pages synced`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
    }
  }

  async syncTarget(target: SyncTarget): Promise<void> {
    const missing = this.validateSettings();
    const settingsOnly = missing.filter((m) => m !== 'at least one Sync Target');
    if (settingsOnly.length > 0) {
      new Notice(`Confluence Vault Sync: missing settings — ${settingsOnly.join(', ')}`);
      return;
    }

    try {
      const count = await runSyncForTarget(target, this.settings, this.app.vault);
      new Notice(`Sync complete — ${target.spaceKey}: ${count} pages synced`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      new Notice(`Sync failed: ${message}`);
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
