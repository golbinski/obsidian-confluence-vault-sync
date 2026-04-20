import { ItemView, Modal, Notice, WorkspaceLeaf } from 'obsidian';
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
  private pushing = new Set<string>(); // paths currently being pushed

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
  getIcon(): string { return 'git-pull-request'; }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => { void this.refresh(); })
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
    const refreshBtn = header.createEl('button', { text: 'Refresh' });
    refreshBtn.addEventListener('click', () => { void this.refresh(); });

    if (entries.length === 0) {
      container.createEl('p', {
        text: 'No synced pages found. Run a sync first.',
        cls: 'pane-empty-state',
      });
      return;
    }

    const activeFilePath = this.app.workspace.getActiveFile()?.path ?? null;

    // Group by space, active file floated to top of its group
    const bySpace = new Map<string, PageEntry[]>();
    for (const entry of entries) {
      const group = bySpace.get(entry.spaceKey) ?? [];
      group.push(entry);
      bySpace.set(entry.spaceKey, group);
    }

    for (const [spaceKey, pages] of bySpace) {
      // Sort: active file first, rest unchanged
      const sorted = activeFilePath
        ? [...pages].sort((a, b) => {
            if (a.path === activeFilePath) return -1;
            if (b.path === activeFilePath) return 1;
            return 0;
          })
        : pages;

      const section = container.createDiv({ cls: 'cvs-space-section' });
      section.createEl('div', { cls: 'cvs-space-label', text: spaceKey });

      for (const entry of sorted) {
        this.renderRow(section, entry, entry.path === activeFilePath);
      }
    }
  }

  private renderRow(container: HTMLElement, entry: PageEntry, isActive = false): void {
    const row = container.createDiv({ cls: 'cvs-page-row' });
    if (isActive) row.addClass('cvs-page-row--active');

    const left = row.createDiv({ cls: 'cvs-row-left' });

    const { icon, dim } = stateDecoration(entry.state);
    left.createSpan({ text: icon });

    const titleEl = left.createSpan({ text: entry.title, cls: 'cvs-page-title' });
    if (dim) titleEl.addClass('cvs-page-title--dim');

    const right = row.createDiv({ cls: 'cvs-row-right' });

    switch (entry.state.kind) {
      case 'locked':
        this.addButton(right, 'Unlock', () => { void this.unlock(entry); });
        break;

      case 'has-unsupported': {
        const label = right.createSpan({ text: 'has unsupported content', cls: 'cvs-dim-label' });
        label.title = 'Page contains embedded content (e.g. Lucid, Miro) that cannot be converted to Markdown and cannot be pushed back to Confluence';
        break;
      }

      case 'unlocked':
        this.addButton(right, 'Relock', () => { void this.relock(entry); });
        break;

      case 'modified':
        this.addButton(right, 'Push', () => { void this.push(entry); });
        this.addButton(right, 'Relock', () => { void this.relock(entry); });
        break;

      case 'pushing': {
        const spinner = right.createSpan({ text: '⬆️' });
        spinner.title = 'Pushing…';
        break;
      }
    }
  }

  private addButton(container: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
    const btn = container.createEl('button', { text: label, cls: 'cvs-action-btn' });
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
// Helpers
// ---------------------------------------------------------------------------

function stateDecoration(state: FileState): { icon: string; dim: boolean } {
  switch (state.kind) {
    case 'locked':          return { icon: '🔒', dim: false };
    case 'has-unsupported': return { icon: '🖼️', dim: true };
    case 'unlocked':        return { icon: '✏️', dim: false };
    case 'modified':        return { icon: '✏️●', dim: false };
    case 'pushing':         return { icon: '⬆️', dim: false };
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
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
