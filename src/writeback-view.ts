import { ItemView, Modal, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import type ConfluenceVaultSyncPlugin from '../main';
import { ConfluenceClient } from './confluence-client';
import { AdfConverter } from './adf-converter';
import { markdownToAdf } from './markdown-to-adf';
import { mergeMarkdown } from './merge';
import {
  readManifestFile,
  buildPathMapFromManifest,
  buildManifestIndex,
  type ManifestAttachment,
  type ManifestPageNode,
} from './sync-engine';
import type { AttachmentIndex } from './markdown-to-adf';
import {
  extractFrontmatterField,
  isWritable,
  makeReadOnly,
  makeWritable,
  stripFrontmatter,
} from './fs-utils';

const LOG = '[Confluence Vault Sync]';

export const WRITEBACK_VIEW_TYPE = 'confluence-writeback';

type FileState =
  | { kind: 'locked' }
  | { kind: 'has-unsupported' }
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
  attachments: ManifestAttachment[];
  hasUnsupportedContent: boolean;
}

export class WritebackView extends ItemView {
  private plugin: ConfluenceVaultSyncPlugin;
  private pushing = new Set<string>();
  private collapsedFolders = new Set<string>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: ConfluenceVaultSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  // ---------------------------------------------------------------------------
  // Base snapshot helpers
  // Base files are stored in the plugin config dir so they are never shown in
  // the vault file explorer and are not tracked by version control.
  // ---------------------------------------------------------------------------

  private get basesDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/bases`;
  }

  private async saveBase(pageId: string, body: string): Promise<void> {
    try {
      if (!(await this.app.vault.adapter.exists(this.basesDir))) {
        await this.app.vault.adapter.mkdir(this.basesDir);
      }
      await this.app.vault.adapter.write(`${this.basesDir}/${pageId}.md`, body);
    } catch (err) {
      console.warn(`${LOG} failed to save base snapshot for ${pageId}:`, err);
    }
  }

  private async loadBase(pageId: string): Promise<string | null> {
    const path = `${this.basesDir}/${pageId}.md`;
    try {
      if (!(await this.app.vault.adapter.exists(path))) return null;
      return await this.app.vault.adapter.read(path);
    } catch { return null; }
  }

  private async deleteBase(pageId: string): Promise<void> {
    const path = `${this.basesDir}/${pageId}.md`;
    try {
      if (await this.app.vault.adapter.exists(path)) {
        await this.app.vault.adapter.remove(path);
      }
    } catch { /* best effort */ }
  }

  getViewType(): string { return WRITEBACK_VIEW_TYPE; }
  getDisplayText(): string { return 'Confluence changes'; }
  getIcon(): string { return 'upload-cloud'; }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => { void this.refresh(); })
    );
    this.registerEvent(
      this.app.vault.on('modify', () => {
        if (this.containerEl.offsetParent === null) return;
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        this.refreshTimer = setTimeout(() => { void this.refresh(); }, 500);
      })
    );
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
    const entries: PageEntry[] = [];

    for (const target of this.plugin.settings.syncTargets) {
      const manifestPath = `${target.syncFolderPath}/manifest.json`;
      const manifest = await readManifestFile(this.app.vault, manifestPath);
      const manifestIndex = manifest ? buildManifestIndex(manifest) : new Map<string, ManifestPageNode>();
      await this.scanDir(target.syncFolderPath, entries, manifestIndex);
    }

    return entries;
  }

  private async scanDir(
    dir: string,
    entries: PageEntry[],
    manifestIndex: Map<string, ManifestPageNode>
  ): Promise<void> {
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

        const manifestNode = manifestIndex.get(pageId);
        const attachments = manifestNode?.attachments ?? [];
        const hasUnsupportedContent = manifestNode?.hasUnsupportedContent ?? false;

        const state = await this.computeState(filePath, lastSynced, hasUnsupportedContent);

        entries.push({
          path: filePath,
          pageId,
          title,
          spaceKey,
          lastSynced,
          state,
          attachments,
          hasUnsupportedContent,
        });
      } catch { /* skip */ }
    }

    for (const folder of listed.folders) {
      await this.scanDir(folder, entries, manifestIndex);
    }
  }

  private async computeState(
    filePath: string,
    lastSynced: string,
    hasUnsupportedContent: boolean
  ): Promise<FileState> {
    if (this.pushing.has(filePath)) return { kind: 'pushing' };

    const writable = isWritable(this.app.vault, filePath);

    if (!writable) {
      if (hasUnsupportedContent) return { kind: 'has-unsupported' };
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
    container.addClass('cvs-view-container');

    // Header
    const header = container.createDiv({ cls: 'nav-header cvs-view-header' });
    header.createEl('strong', { text: 'Confluence changes' });
    const refreshBtn = header.createEl('button', { cls: 'cvs-icon-btn', title: 'Refresh' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.refresh(); });

    if (entries.length === 0) {
      container.createEl('p', {
        text: 'No synced pages found. Run a sync first.',
        cls: 'pane-empty-state',
      });
      return;
    }

    const activeFilePath = this.app.workspace.getActiveFile()?.path ?? null;
    const activeEntry = activeFilePath
      ? entries.find((e) => e.path === activeFilePath) ?? null
      : null;

    // Current-file context bar
    if (activeEntry) {
      const rootFolder = this.plugin.settings.syncTargets.find(
        (t) => t.spaceKey === activeEntry.spaceKey
      )?.syncFolderPath ?? '';
      const rel = rootFolder && activeEntry.path.startsWith(rootFolder + '/')
        ? activeEntry.path.slice(rootFolder.length + 1)
        : activeEntry.path;
      const breadcrumb = rel.replace(/\.md$/, '').split('/').join(' › ');

      const ctx = container.createDiv({ cls: 'cvs-context-bar' });
      ctx.createSpan({ text: breadcrumb, cls: 'cvs-context-breadcrumb' });
      this.renderRow(ctx, activeEntry, false, 0, true);
    }

    // Group by space
    const bySpace = new Map<string, PageEntry[]>();
    for (const entry of entries) {
      const group = bySpace.get(entry.spaceKey) ?? [];
      group.push(entry);
      bySpace.set(entry.spaceKey, group);
    }

    for (const [spaceKey, pages] of bySpace) {
      const section = container.createDiv({ cls: 'cvs-space-section' });
      section.createEl('div', { cls: 'cvs-space-label', text: spaceKey });

      const rootFolder = this.plugin.settings.syncTargets.find(
        (t) => t.spaceKey === spaceKey
      )?.syncFolderPath ?? '';

      const autoExpand = activeFilePath
        ? foldersContaining(activeFilePath, rootFolder)
        : new Set<string>();

      const tree = buildFolderTree(pages, rootFolder);
      this.renderFolderTree(section, tree, activeFilePath, 0, spaceKey, '', autoExpand);
    }
  }

  private renderFolderTree(
    container: HTMLElement,
    tree: FolderTree,
    activeFilePath: string | null,
    depth: number,
    spaceKey: string,
    folderPath: string,
    autoExpand: Set<string>,
  ): void {
    for (const entry of tree.pages) {
      this.renderRow(container, entry, entry.path === activeFilePath, depth);
    }
    const sortedFolders = [...tree.subfolders.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [name, subtree] of sortedFolders) {
      const subPath = folderPath ? `${folderPath}/${name}` : name;
      const key = `${spaceKey}:${subPath}`;
      const forcedOpen = autoExpand.has(subPath);
      const collapsed = this.collapsedFolders.has(key) && !forcedOpen;

      const folderRow = container.createDiv({ cls: 'cvs-folder-row' });
      folderRow.style.paddingLeft = `${depth * 16 + 4}px`;

      const chevron = folderRow.createSpan({ cls: 'cvs-folder-chevron' });
      setIcon(chevron, collapsed ? 'chevron-right' : 'chevron-down');

      const iconEl = folderRow.createSpan({ cls: 'cvs-folder-icon' });
      setIcon(iconEl, collapsed ? 'folder' : 'folder-open');

      folderRow.createSpan({ text: name, cls: 'cvs-folder-name' });

      folderRow.addEventListener('click', () => {
        if (this.collapsedFolders.has(key)) {
          this.collapsedFolders.delete(key);
        } else {
          this.collapsedFolders.add(key);
        }
        void this.refresh();
      });

      if (!collapsed) {
        this.renderFolderTree(container, subtree, activeFilePath, depth + 1, spaceKey, subPath, autoExpand);
      }
    }
  }

  private renderRow(container: HTMLElement, entry: PageEntry, isActive = false, depth = 0, compact = false): void {
    const row = container.createDiv({ cls: 'cvs-page-row' });
    if (isActive) row.addClass('cvs-page-row--active');
    if (!compact) row.style.paddingLeft = `${depth * 16 + 4}px`;

    if (!compact) {
      const left = row.createDiv({ cls: 'cvs-row-left' });
      const dim = entry.state.kind === 'has-unsupported';
      const titleEl = left.createSpan({ text: entry.title, cls: 'cvs-page-title' });
      if (dim) titleEl.addClass('cvs-page-title--dim');
    }

    const right = row.createDiv({ cls: 'cvs-row-right' });

    switch (entry.state.kind) {
      case 'locked':
        this.addIconButton(right, 'lock-open', 'Unlock', () => { void this.unlock(entry); });
        break;

      case 'has-unsupported': {
        const label = right.createSpan({ text: 'unsupported', cls: 'cvs-dim-label' });
        label.title = 'Page contains embedded content (e.g. Lucid, Miro) that cannot be converted to Markdown and cannot be pushed back to Confluence';
        break;
      }

      case 'unlocked':
        this.addIconButton(right, 'lock', 'Relock', () => { void this.relock(entry); });
        break;

      case 'modified':
        this.addIconButton(right, 'upload-cloud', 'Push to Confluence', () => { void this.push(entry); });
        this.addIconButton(right, 'lock', 'Relock', () => { void this.relock(entry); });
        break;

      case 'pushing': {
        const spinner = right.createSpan({ cls: 'cvs-state-icon' });
        setIcon(spinner, 'loader');
        spinner.title = 'Pushing…';
        break;
      }
    }
  }

  private addIconButton(container: HTMLElement, icon: string, tooltip: string, onClick: () => void): HTMLButtonElement {
    const btn = container.createEl('button', { cls: 'cvs-icon-btn', title: tooltip });
    setIcon(btn, icon);
    btn.addEventListener('click', onClick);
    return btn;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  private async unlock(entry: PageEntry): Promise<void> {
    const content = await this.app.vault.adapter.read(entry.path);
    await this.saveBase(entry.pageId, stripFrontmatter(content));
    makeWritable(this.app.vault, entry.path);
    await this.refresh();
  }

  private async relock(entry: PageEntry): Promise<void> {
    const stat = await this.app.vault.adapter.stat(entry.path);
    const mtime = stat?.mtime ?? 0;
    const hasChanges = mtime > new Date(entry.lastSynced).getTime();

    if (hasChanges) {
      const proceed = await this.showRelockModal(entry.title);
      if (!proceed) return;
    }

    makeReadOnly(this.app.vault, entry.path);
    await this.deleteBase(entry.pageId);
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

      if (entry.hasUnsupportedContent) {
        new Notice(`"${entry.title}" contains embedded content that cannot be pushed (Lucid, Miro, etc.).`);
        return;
      }

      const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);

      // Fetch version info and the base snapshot in parallel
      const [{ version, updatedAt }, base] = await Promise.all([
        client.getPageCurrentVersion(entry.pageId),
        this.loadBase(entry.pageId),
      ]);

      let bodyToPush: string;

      if (base !== null) {
        // Three-way merge: base (snapshot at unlock time) ← local edits + remote edits
        const remoteAdf = await client.getPageBody(entry.pageId);

        const target = this.plugin.settings.syncTargets.find((t) => t.spaceKey === entry.spaceKey);
        const manifest = target
          ? await readManifestFile(this.app.vault, `${target.syncFolderPath}/manifest.json`)
          : null;
        const pathMap = manifest ? buildPathMapFromManifest(manifest) : new Map<string, string>();

        const converter = new AdfConverter(pathMap, confluenceBaseUrl);
        const remoteMarkdown = converter.convert(remoteAdf);

        const { merged, hasConflicts } = mergeMarkdown(base, body, remoteMarkdown);

        if (hasConflicts) {
          // Write conflict markers into the local file and leave it unlocked for resolution
          const frontmatterEnd = content.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
          await this.app.vault.adapter.write(entry.path, frontmatterEnd + merged);
          new Notice(`"${entry.title}" has conflicts — resolve the markers and push again.`, 8000);
          return;
        }

        bodyToPush = merged;
      } else {
        // No base snapshot (e.g. unlocked before this feature) — fall back to conflict modal
        const remoteUpdated = new Date(updatedAt).getTime();
        const lastSynced = new Date(entry.lastSynced).getTime();

        if (remoteUpdated > lastSynced) {
          const proceed = await this.showConflictModal(entry.title, updatedAt, entry.lastSynced);
          if (!proceed) return;
        }

        bodyToPush = body;
      }

      // Convert to ADF and push
      const reverseIndex = await this.buildReversePageIndex(entry.spaceKey);
      const attachmentIndex = await this.resolveAttachmentIndex(
        entry.pageId, entry.spaceKey, entry.attachments, bodyToPush, client
      );
      const adf = markdownToAdf(bodyToPush, reverseIndex, confluenceBaseUrl, attachmentIndex);
      await client.updatePage(entry.pageId, entry.title, adf, version);

      // Write final content (may be merged), update last-synced, relock, delete base
      const frontmatterEnd = content.match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
      const newLastSynced = new Date().toISOString();
      const finalContent = updateFrontmatterField(frontmatterEnd, 'last-synced', newLastSynced) + bodyToPush;
      makeWritable(this.app.vault, entry.path);
      await this.app.vault.adapter.write(entry.path, finalContent);
      makeReadOnly(this.app.vault, entry.path);
      await this.deleteBase(entry.pageId);

      new Notice(`"${entry.title}" pushed to Confluence.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(`Push failed: ${msg}`, 8000);
    } finally {
      this.pushing.delete(entry.path);
      await this.refresh();
    }
  }

  private showRelockModal(title: string): Promise<boolean> {
    return new Promise((resolve) => {
      new RelockModal(this.app, title, resolve).open();
    });
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

  /**
   * Build an AttachmentIndex for a page:
   * - Seeds from known manifest attachments (already on Confluence).
   * - For any ![[filename]] in the body not yet in the index, attempts to upload
   *   the local vault file as a new Confluence attachment.
   */
  private async resolveAttachmentIndex(
    pageId: string,
    spaceKey: string,
    knownAttachments: ManifestAttachment[],
    body: string,
    client: ConfluenceClient
  ): Promise<AttachmentIndex> {
    const index: AttachmentIndex = new Map();

    // Seed with attachments already tracked in the manifest
    for (const att of knownAttachments) {
      index.set(att.filename, { mediaId: att.mediaId, collection: att.collection });
    }

    // Find all local image references in the body
    const wikiImages = [...body.matchAll(/!\[\[([^\]]+)\]\]/g)]
      .map((m) => sanitizeAttachmentFilename(m[1]))
      .filter((f): f is string => f !== null);
    const stdImages = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
      .map((m) => m[1])
      .filter((f) => !f.startsWith('http'))
      .map((f) => sanitizeAttachmentFilename(f))
      .filter((f): f is string => f !== null);
    const allImages = [...new Set([...wikiImages, ...stdImages])];

    const target = this.plugin.settings.syncTargets.find((t) => t.spaceKey === spaceKey);
    if (!target) return index;

    for (const filename of allImages) {
      if (index.has(filename)) continue; // Already known from manifest

      // New local image — attempt to upload as a Confluence attachment
      const attachmentsPath = `${target.syncFolderPath}/attachments/${filename}`;
      try {
        const data = await this.app.vault.adapter.readBinary(attachmentsPath);
        const mimeType = guessMimeType(filename);
        const { mediaId, collection } = await client.uploadAttachment(pageId, filename, data, mimeType);
        index.set(filename, { mediaId, collection });
        console.debug(`${LOG} uploaded new attachment "${filename}" → ${mediaId}`);
      } catch (err) {
        console.warn(`${LOG} could not upload "${filename}":`, err);
        new Notice(`Warning: image "${filename}" could not be uploaded and will be omitted from the page.`, 6000);
      }
    }

    return index;
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
      text: 'Force pushing will overwrite the remote version.',
    });

    const btnRow = contentEl.createDiv({ cls: 'cvs-modal-btn-row' });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => {
      this.resolve(false);
      this.close();
    });

    const forceBtn = btnRow.createEl('button', { text: 'Force push', cls: 'cvs-danger-btn' });
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
// Relock confirmation modal
// ---------------------------------------------------------------------------

class RelockModal extends Modal {
  private title: string;
  private resolve: (proceed: boolean) => void;

  constructor(app: import('obsidian').App, title: string, resolve: (proceed: boolean) => void) {
    super(app);
    this.title = title;
    this.resolve = resolve;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Discard changes?' });
    contentEl.createEl('p', {
      text: `"${this.title}" has unsaved edits. Relocking will discard them and restore the last synced version.`,
    });

    const btnRow = contentEl.createDiv({ cls: 'cvs-modal-btn-row' });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => { this.resolve(false); this.close(); });

    const confirmBtn = btnRow.createEl('button', { text: 'Discard & relock', cls: 'cvs-danger-btn' });
    confirmBtn.addEventListener('click', () => { this.resolve(true); this.close(); });
  }

  onClose(): void {
    this.resolve(false);
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------

interface FolderTree {
  pages: PageEntry[];
  subfolders: Map<string, FolderTree>;
}

function foldersContaining(filePath: string, rootFolder: string): Set<string> {
  const rel = rootFolder && filePath.startsWith(rootFolder + '/')
    ? filePath.slice(rootFolder.length + 1)
    : filePath;
  const parts = rel.split('/').slice(0, -1);
  const result = new Set<string>();
  for (let i = 1; i <= parts.length; i++) {
    result.add(parts.slice(0, i).join('/'));
  }
  return result;
}

function buildFolderTree(pages: PageEntry[], rootFolder: string): FolderTree {
  const root: FolderTree = { pages: [], subfolders: new Map() };

  for (const entry of pages) {
    const rel = rootFolder && entry.path.startsWith(rootFolder + '/')
      ? entry.path.slice(rootFolder.length + 1)
      : entry.path;
    const parts = rel.split('/');
    const folderParts = parts.slice(0, -1);

    let node = root;
    for (const part of folderParts) {
      if (!node.subfolders.has(part)) {
        node.subfolders.set(part, { pages: [], subfolders: new Map() });
      }
      node = node.subfolders.get(part)!;
    }
    node.pages.push(entry);
  }

  return root;
}

/**
 * Reduce a user-supplied image reference to a safe basename for use in the
 * `attachments/` folder. Strips any directory components (forward or
 * backslashes), rejects names that would escape the folder (`.`, `..`, names
 * beginning with `.`) and rejects control characters or empty strings.
 * Returns null if the reference is unsafe — callers should skip it.
 */
export function sanitizeAttachmentFilename(raw: string): string | null {
  const basename = raw.split(/[\\/]/).pop() ?? '';
  const trimmed = basename.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.startsWith('.')) return null;
  // Reject NUL and other control chars, plus characters Confluence/OS would reject
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(trimmed)) return null;
  return trimmed;
}

function guessMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

/** Replace a frontmatter field value in-place. */
function updateFrontmatterField(content: string, field: string, value: string): string {
  return content.replace(
    new RegExp(`^(${field}: )"[^"]*"`, 'm'),
    `$1"${value}"`
  );
}
