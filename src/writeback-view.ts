import { ItemView, Modal, Notice, WorkspaceLeaf } from 'obsidian';
import type ConfluenceVaultSyncPlugin from '../main';
import { ConfluenceClient } from './confluence-client';
import { markdownToAdf } from './markdown-to-adf';
import {
  extractFrontmatterField,
  getFullPath,
  isWritable,
  makeReadOnly,
  makeWritable,
  stripFrontmatter,
} from './fs-utils';

export const WRITEBACK_VIEW_TYPE = 'confluence-writeback';

const IMAGE_RE = /!\[\[|!\[.+?\]\(.+?\)/;

type FileState =
  | { kind: 'locked' }
  | { kind: 'has-images' }
  | { kind: 'unlocked' }
  | { kind: 'modified' }
  | { kind: 'pushing' };

interface PageEntry {
  path: string;
  pageId: string;
  title: string;
  spaceKey: string;
  lastSynced: string;
  state: FileState;
}

export class WritebackView extends ItemView {
  private plugin: ConfluenceVaultSyncPlugin;
  private pushing = new Set<string>(); // paths currently being pushed

  constructor(leaf: WorkspaceLeaf, plugin: ConfluenceVaultSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return WRITEBACK_VIEW_TYPE; }
  getDisplayText(): string { return 'Confluence Changes'; }
  getIcon(): string { return 'git-pull-request'; }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const entries = await this.scanEntries();
    this.render(entries);
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  private async scanEntries(): Promise<PageEntry[]> {
    const vault = this.app.vault;
    const entries: PageEntry[] = [];

    for (const target of this.plugin.settings.syncTargets) {
      await this.scanDir(target.syncFolderPath, entries);
    }

    return entries;
  }

  private async scanDir(dir: string, entries: PageEntry[]): Promise<void> {
    let listed;
    try {
      listed = await this.app.vault.adapter.list(dir);
    } catch {
      return;
    }

    for (const filePath of listed.files) {
      if (!filePath.endsWith('.md')) continue;
      try {
        const content = await this.app.vault.adapter.read(filePath);
        const pageId = extractFrontmatterField(content, 'confluence-id');
        const title = extractFrontmatterField(content, 'confluence-title');
        const spaceKey = extractFrontmatterField(content, 'space');
        const lastSynced = extractFrontmatterField(content, 'last-synced');

        if (!pageId || !title || !spaceKey || !lastSynced) continue;

        const body = stripFrontmatter(content);
        const state = await this.computeState(filePath, body, lastSynced);

        entries.push({ path: filePath, pageId, title, spaceKey, lastSynced, state });
      } catch { /* skip */ }
    }

    for (const folder of listed.folders) {
      await this.scanDir(folder, entries);
    }
  }

  private async computeState(
    filePath: string,
    body: string,
    lastSynced: string
  ): Promise<FileState> {
    if (this.pushing.has(filePath)) return { kind: 'pushing' };

    const writable = isWritable(this.app.vault, filePath);

    if (!writable) {
      if (IMAGE_RE.test(body)) return { kind: 'has-images' };
      return { kind: 'locked' };
    }

    // File is writable — check mtime
    const stat = await this.app.vault.adapter.stat(filePath);
    const mtime = stat?.mtime ?? 0;
    const syncedTime = new Date(lastSynced).getTime();
    return mtime > syncedTime ? { kind: 'modified' } : { kind: 'unlocked' };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private render(entries: PageEntry[]): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.padding = '12px';

    // Header
    const header = container.createDiv({ cls: 'nav-header' });
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '12px';
    header.createEl('strong', { text: 'Confluence Changes' });
    const refreshBtn = header.createEl('button', { text: '⟳ Refresh' });
    refreshBtn.addEventListener('click', () => this.refresh());

    if (entries.length === 0) {
      container.createEl('p', {
        text: 'No synced pages found. Run a sync first.',
        cls: 'pane-empty-state',
      });
      return;
    }

    // Group by space
    const bySpace = new Map<string, PageEntry[]>();
    for (const entry of entries) {
      const group = bySpace.get(entry.spaceKey) ?? [];
      group.push(entry);
      bySpace.set(entry.spaceKey, group);
    }

    for (const [spaceKey, pages] of bySpace) {
      const section = container.createDiv();
      section.style.marginBottom = '16px';

      const sectionHeader = section.createEl('div');
      sectionHeader.style.fontWeight = '600';
      sectionHeader.style.marginBottom = '6px';
      sectionHeader.style.opacity = '0.7';
      sectionHeader.style.fontSize = '0.85em';
      sectionHeader.style.textTransform = 'uppercase';
      sectionHeader.setText(spaceKey);

      for (const entry of pages) {
        this.renderRow(section, entry);
      }
    }
  }

  private renderRow(container: HTMLElement, entry: PageEntry): void {
    const row = container.createDiv();
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.padding = '5px 4px';
    row.style.borderRadius = '4px';
    row.style.marginBottom = '2px';

    const left = row.createDiv();
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '6px';
    left.style.overflow = 'hidden';

    const { icon, dim } = stateDecoration(entry.state);
    left.createSpan({ text: icon });

    const titleEl = left.createSpan({ text: entry.title });
    titleEl.style.overflow = 'hidden';
    titleEl.style.textOverflow = 'ellipsis';
    titleEl.style.whiteSpace = 'nowrap';
    if (dim) titleEl.style.opacity = '0.45';

    const right = row.createDiv();
    right.style.display = 'flex';
    right.style.gap = '4px';
    right.style.flexShrink = '0';

    switch (entry.state.kind) {
      case 'locked':
        this.addButton(right, 'Unlock', () => this.unlock(entry));
        break;

      case 'has-images': {
        const label = right.createSpan({ text: 'has images' });
        label.style.opacity = '0.45';
        label.style.fontSize = '0.8em';
        label.title = 'Pages with images cannot be edited locally (image upload not supported)';
        break;
      }

      case 'unlocked':
        this.addButton(right, 'Relock', () => this.relock(entry));
        break;

      case 'modified':
        this.addButton(right, 'Push', () => this.push(entry));
        this.addButton(right, 'Relock', () => this.relock(entry));
        break;

      case 'pushing': {
        const spinner = right.createSpan({ text: '⬆️' });
        spinner.title = 'Pushing…';
        break;
      }
    }
  }

  private addButton(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const btn = container.createEl('button', { text: label });
    btn.style.padding = '2px 8px';
    btn.style.fontSize = '0.8em';
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async unlock(entry: PageEntry): Promise<void> {
    makeWritable(this.app.vault, entry.path);
    await this.refresh();
  }

  private async relock(entry: PageEntry): Promise<void> {
    makeReadOnly(this.app.vault, entry.path);
    await this.refresh();
  }

  private async push(entry: PageEntry): Promise<void> {
    const { confluenceBaseUrl, confluenceEmail, confluenceApiToken } = this.plugin.settings;
    if (!confluenceBaseUrl || !confluenceEmail || !confluenceApiToken) {
      new Notice('Confluence credentials not configured.');
      return;
    }

    this.pushing.add(entry.path);
    await this.refresh();

    try {
      const content = await this.app.vault.adapter.read(entry.path);
      const body = stripFrontmatter(content);

      // Double-check for images
      if (IMAGE_RE.test(body)) {
        new Notice(`"${entry.title}" contains images and cannot be pushed.`);
        return;
      }

      const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);

      // Check for conflict
      const { version, updatedAt } = await client.getPageCurrentVersion(entry.pageId);
      const remoteUpdated = new Date(updatedAt).getTime();
      const lastSynced = new Date(entry.lastSynced).getTime();

      if (remoteUpdated > lastSynced) {
        const proceed = await this.showConflictModal(entry.title, updatedAt, entry.lastSynced);
        if (!proceed) return;
      }

      // Build reverse page index: sanitized-filename → Confluence page URL
      const reverseIndex = await this.buildReversePageIndex(entry.spaceKey);

      const adf = markdownToAdf(body, reverseIndex, confluenceBaseUrl);
      await client.updatePage(entry.pageId, entry.title, adf, version);

      // Update last-synced in frontmatter and re-lock
      const updatedContent = updateFrontmatterField(content, 'last-synced', new Date().toISOString());
      makeWritable(this.app.vault, entry.path);
      await this.app.vault.adapter.write(entry.path, updatedContent);
      makeReadOnly(this.app.vault, entry.path);

      new Notice(`"${entry.title}" pushed to Confluence.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Push failed: ${msg}`, 8000);
    } finally {
      this.pushing.delete(entry.path);
      await this.refresh();
    }
  }

  private showConflictModal(
    title: string,
    remoteUpdatedAt: string,
    lastSynced: string
  ): Promise<boolean> {
    return new Promise((resolve) => {
      new ConflictModal(this.app, title, remoteUpdatedAt, lastSynced, resolve).open();
    });
  }

  /** Build a map of sanitized-filename → Confluence page URL for the given space. */
  private async buildReversePageIndex(spaceKey: string): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    const target = this.plugin.settings.syncTargets.find((t) => t.spaceKey === spaceKey);
    if (!target) return index;

    const { confluenceBaseUrl } = this.plugin.settings;

    await this.walkDir(target.syncFolderPath, async (filePath) => {
      try {
        const content = await this.app.vault.adapter.read(filePath);
        const pageId = extractFrontmatterField(content, 'confluence-id');
        if (pageId) {
          const filename = filePath.split('/').pop()?.replace(/\.md$/, '') ?? '';
          const url = `${confluenceBaseUrl}/wiki/spaces/${spaceKey}/pages/${pageId}`;
          index.set(filename, url);
        }
      } catch { /* skip */ }
    });

    return index;
  }

  private async walkDir(dir: string, fn: (path: string) => Promise<void>): Promise<void> {
    let listed;
    try {
      listed = await this.app.vault.adapter.list(dir);
    } catch { return; }
    for (const file of listed.files) {
      if (file.endsWith('.md')) await fn(file);
    }
    for (const folder of listed.folders) {
      await this.walkDir(folder, fn);
    }
  }
}

// ---------------------------------------------------------------------------
// Conflict modal
// ---------------------------------------------------------------------------

class ConflictModal extends Modal {
  private title: string;
  private remoteUpdatedAt: string;
  private lastSynced: string;
  private resolve: (proceed: boolean) => void;

  constructor(
    app: import('obsidian').App,
    title: string,
    remoteUpdatedAt: string,
    lastSynced: string,
    resolve: (proceed: boolean) => void
  ) {
    super(app);
    this.title = title;
    this.remoteUpdatedAt = remoteUpdatedAt;
    this.lastSynced = lastSynced;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Conflict detected' });

    contentEl.createEl('p', {
      text: `"${this.title}" was updated in Confluence on ${fmtDate(this.remoteUpdatedAt)}, after your last sync on ${fmtDate(this.lastSynced)}.`,
    });
    contentEl.createEl('p', {
      text: 'Force pushing will overwrite the Confluence version.',
    });

    const btnRow = contentEl.createDiv();
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.marginTop = '16px';
    btnRow.style.justifyContent = 'flex-end';

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.resolve(false);
      this.close();
    });

    const forceBtn = btnRow.createEl('button', { text: 'Force Push' });
    forceBtn.style.color = 'var(--color-red)';
    forceBtn.addEventListener('click', () => {
      this.resolve(true);
      this.close();
    });
  }

  onClose(): void {
    this.resolve(false); // resolve with false if modal is dismissed without clicking
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateDecoration(state: FileState): { icon: string; dim: boolean } {
  switch (state.kind) {
    case 'locked':    return { icon: '🔒', dim: false };
    case 'has-images':return { icon: '🖼️', dim: true };
    case 'unlocked':  return { icon: '✏️', dim: false };
    case 'modified':  return { icon: '✏️●', dim: false };
    case 'pushing':   return { icon: '⬆️', dim: false };
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Replace a frontmatter field value in-place. */
function updateFrontmatterField(content: string, field: string, value: string): string {
  return content.replace(
    new RegExp(`^(${field}: )"[^"]*"`, 'm'),
    `$1"${value}"`
  );
}
