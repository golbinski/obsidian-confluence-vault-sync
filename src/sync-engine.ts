import { Notice, Vault } from 'obsidian';
import type { ConfluenceVaultSyncSettings, SyncTarget, VersionHistorySettings } from './settings';
import { ConfluenceClient, type ConfluencePage, type PageVersion } from './confluence-client';
import { AdfConverter } from './adf-converter';
import { ImageDownloader } from './image-downloader';
import {
  makeWritable,
  makeReadOnly,
  extractFrontmatterField,
} from './fs-utils';

export type PullScope =
  | { kind: 'space' }
  | { kind: 'subtree'; vaultPath: string };

const LOG = '[Confluence Vault Sync]';

function sanitizeTitle(title: string): string {
  return title.replace(/[/:?*|\\<>"]/g, '-');
}

interface PageNode {
  page: ConfluencePage;
  children: PageNode[];
}

function buildTree(pages: ConfluencePage[]): PageNode[] {
  const nodeMap = new Map<string, PageNode>();
  for (const page of pages) {
    nodeMap.set(page.id, { page, children: [] });
  }
  const roots: PageNode[] = [];
  for (const page of pages) {
    const node = nodeMap.get(page.id)!;
    if (page.parentId && nodeMap.has(page.parentId)) {
      nodeMap.get(page.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function computePaths(
  nodes: PageNode[],
  parentPath: string,
  pathMap: Map<string, string>
): void {
  for (const node of nodes) {
    const sanitized = sanitizeTitle(node.page.title);
    if (node.children.length > 0) {
      const folderPath = `${parentPath}/${sanitized}`;
      pathMap.set(node.page.id, `${folderPath}/${sanitized}.md`);
      computePaths(node.children, folderPath, pathMap);
    } else {
      pathMap.set(node.page.id, `${parentPath}/${sanitized}.md`);
    }
  }
}

function flattenTree(nodes: PageNode[]): ConfluencePage[] {
  const result: ConfluencePage[] = [];
  for (const node of nodes) {
    result.push(node.page);
    result.push(...flattenTree(node.children));
  }
  return result;
}

/** Scan all .md files under a vault path and return a map of pageId → {path, lastSynced}. */
async function scanExistingFiles(
  vault: Vault,
  dirPath: string,
  excludeFolders: Set<string> = new Set()
): Promise<Map<string, { path: string; lastSynced: string }>> {
  const result = new Map<string, { path: string; lastSynced: string }>();

  async function scanDir(dir: string): Promise<void> {
    let listed;
    try {
      listed = await vault.adapter.list(dir);
    } catch {
      return; // dir doesn't exist yet
    }
    for (const file of listed.files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await vault.adapter.read(file);
        const pageId = extractFrontmatterField(content, 'confluence-id');
        const lastSynced = extractFrontmatterField(content, 'last-synced');
        if (pageId && lastSynced) {
          result.set(pageId, { path: file, lastSynced });
        }
      } catch { /* skip unreadable files */ }
    }
    for (const folder of listed.folders) {
      if (excludeFolders.has(folder)) continue;
      await scanDir(folder);
    }
  }

  await scanDir(dirPath);
  return result;
}

/** Remove .md files that are no longer in the expected path set, then prune empty folders. */
async function removeOrphanedFiles(
  vault: Vault,
  syncFolderPath: string,
  expectedPaths: Set<string>,
  excludeFolders: Set<string> = new Set()
): Promise<void> {
  async function cleanDir(dir: string): Promise<boolean> {
    let listed;
    try {
      listed = await vault.adapter.list(dir);
    } catch {
      return true; // doesn't exist, treat as empty
    }

    for (const file of listed.files) {
      if (file.endsWith('.md') && !expectedPaths.has(file)) {
        console.debug(`${LOG} removing orphaned file: ${file}`);
        makeWritable(vault, file);
        await vault.adapter.remove(file);
      }
    }

    for (const folder of listed.folders) {
      if (excludeFolders.has(folder)) continue; // managed separately
      const isEmpty = await cleanDir(folder);
      if (isEmpty && folder !== `${syncFolderPath}/attachments`) {
        try {
          await (vault.adapter as unknown as { rmdir(p: string, r: boolean): Promise<void> }).rmdir(folder, true);
        } catch { /* ignore */ }
      }
    }

    // Re-check after deletions
    try {
      const recheck = await vault.adapter.list(dir);
      return recheck.files.length === 0 && recheck.folders.length === 0;
    } catch {
      return true;
    }
  }

  await cleanDir(syncFolderPath);
}

/**
 * Runs `fn` over all `items` with at most `limit` concurrent executions.
 * Uses a shared index so workers pull the next item as soon as they finish,
 * keeping all slots busy without pre-slicing the array.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

function pageUrl(baseUrl: string, spaceKey: string, pageId: string): string {
  return `${baseUrl}/wiki/spaces/${spaceKey}/pages/${pageId}`;
}

function buildFrontmatter(
  pageId: string,
  baseUrl: string,
  spaceKey: string,
  title: string,
  lastSynced: string,
  versionEpoch?: number
): string {
  const lines = [
    '---',
    `confluence-id: "${pageId}"`,
    `confluence-url: "${pageUrl(baseUrl, spaceKey, pageId)}"`,
    `confluence-title: "${title.replace(/"/g, '\\"')}"`,
    `space: "${spaceKey}"`,
    `last-synced: "${lastSynced}"`,
  ];
  if (versionEpoch !== undefined) lines.push(`revision-epoch: ${versionEpoch}`);
  lines.push('read-only: true', '---', '');
  return lines.join('\n');
}

function buildRevisionFrontmatter(
  pageId: string,
  baseUrl: string,
  spaceKey: string,
  version: PageVersion,
  primaryWikiPath: string
): string {
  const epoch = Math.floor(new Date(version.createdAt).getTime() / 1000);
  return [
    '---',
    `confluence-id: "${pageId}"`,
    `revision-epoch: ${epoch}`,
    `revision-date: "${version.createdAt}"`,
    `revision-author-id: "${version.authorId}"`,
    `archive-of: "[[${primaryWikiPath}]]"`,
    `confluence-url: "${pageUrl(baseUrl, spaceKey, pageId)}"`,
    `read-only: true`,
    '---',
    '',
  ].join('\n');
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function mkdirp(vault: Vault, dir: string): Promise<void> {
  const parts = dir.split('/');
  for (let i = 1; i <= parts.length; i++) {
    try { await vault.adapter.mkdir(parts.slice(0, i).join('/')); } catch { /* exists */ }
  }
}

/** Fetch and write revision files for a single page into the archive folder. */
export async function syncRevisions(
  vault: Vault,
  client: ConfluenceClient,
  pageId: string,
  primaryVaultPath: string,
  syncFolderPath: string,
  vhSettings: VersionHistorySettings,
  baseUrl: string,
  spaceKey: string
): Promise<void> {
  const { maxVersions, archiveFolder } = vhSettings;
  if (maxVersions <= 0) return;

  let versions: PageVersion[];
  try {
    versions = await client.getPageVersions(pageId, maxVersions);
  } catch (err) {
    console.warn(`${LOG} failed to fetch versions for page ${pageId}:`, err);
    return;
  }

  // Nothing to archive if the page has never had more than one version
  if (versions.length === 0 || (versions.length === 1 && versions[0].number === 1)) return;

  // Vault-relative paths
  // e.g. primaryVaultPath = "Engineering/Architecture/Auth-Service.md"
  //      relativeBase     = "Architecture/Auth-Service"
  //      archiveBasePath  = "Engineering/.confluence/Architecture/Auth-Service"
  const relativeBase = primaryVaultPath.slice(syncFolderPath.length + 1).replace(/\.md$/, '');
  const archiveFolderPath = `${syncFolderPath}/${archiveFolder}`;
  const archiveBasePath = `${archiveFolderPath}/${relativeBase}`;
  const archiveDir = archiveBasePath.split('/').slice(0, -1).join('/');
  const primaryWikiPath = primaryVaultPath.replace(/\.md$/, '');

  await mkdirp(vault, archiveDir);

  const versionNumbers = new Set(versions.map((v) => v.number));

  for (const version of versions) {
    const revPath = `${archiveBasePath}.v${version.number}.md`;
    const content = buildRevisionFrontmatter(pageId, baseUrl, spaceKey, version, primaryWikiPath);
    await vault.adapter.write(revPath, content);
  }

  // Remove stale revision files (versions no longer returned by the API)
  try {
    const listed = await vault.adapter.list(archiveDir);
    const filename = relativeBase.split('/').pop()!;
    const pattern = new RegExp(`^${escapeForRegex(filename)}\\.v(\\d+)\\.md$`);
    for (const file of listed.files) {
      const name = file.split('/').pop() ?? '';
      const match = name.match(pattern);
      if (match && !versionNumbers.has(parseInt(match[1], 10))) {
        await vault.adapter.remove(file);
      }
    }
  } catch { /* archive dir may not yet have any stale files */ }
}

/** Remove revision files whose confluence-id is no longer in the valid page set. */
export async function cleanDeletedPageRevisions(
  vault: Vault,
  archiveFolderPath: string,
  validPageIds: Set<string>
): Promise<void> {
  async function cleanDir(dir: string): Promise<void> {
    let listed;
    try {
      listed = await vault.adapter.list(dir);
    } catch {
      return;
    }
    for (const file of listed.files) {
      if (!file.endsWith('.md')) continue;
      try {
        const content = await vault.adapter.read(file);
        const pageId = extractFrontmatterField(content, 'confluence-id');
        if (pageId && !validPageIds.has(pageId)) {
          await vault.adapter.remove(file);
        }
      } catch { /* skip unreadable */ }
    }
    for (const folder of listed.folders) {
      await cleanDir(folder);
      try {
        const recheck = await vault.adapter.list(folder);
        if (recheck.files.length === 0 && recheck.folders.length === 0) {
          await (vault.adapter as unknown as { rmdir(p: string, r: boolean): Promise<void> }).rmdir(folder, true);
        }
      } catch { /* ignore */ }
    }
  }
  await cleanDir(archiveFolderPath);
}

/** Write the .herbalist.yaml versioning config at the sync folder root. */
export async function writeHerbalistConfig(vault: Vault, syncFolderPath: string): Promise<void> {
  const configPath = `${syncFolderPath}/.herbalist.yaml`;
  const content = 'versioning:\n  resource_key: confluence-id\n  revision_key: revision-epoch\n';
  try {
    await vault.adapter.write(configPath, content);
  } catch (err) {
    console.warn(`${LOG} failed to write .herbalist.yaml at ${configPath}:`, err);
  }
}

export interface ManifestAttachment {
  mediaId: string;
  collection: string;
  filename: string;
  mimeType: string;
}

export interface ManifestPageNode {
  id: string;
  title: string;
  vaultPath: string;
  confluenceUrl: string;
  modifiedAt: string;
  lastSynced: string;
  labels: string[];
  attachments: ManifestAttachment[];
  hasUnsupportedContent: boolean;
  children: ManifestPageNode[];
}

export interface Manifest {
  spaceKey: string;
  spaceName: string | null;
  homePageId: string | null;
  baseUrl: string;
  generatedAt: string;
  pageCount: number;
  tree: ManifestPageNode[];
}

type ManifestData = Map<string, {
  labels: string[];
  lastSynced: string;
  attachments: ManifestAttachment[];
  hasUnsupportedContent: boolean;
}>;

/** Builds ManifestPageNodes from a Confluence page tree + manifestData. Pages without
 *  a manifestData entry are skipped but their children are re-parented upward. */
function buildManifestNodes(
  nodes: PageNode[],
  pathMap: Map<string, string>,
  manifestData: ManifestData,
  spaceKey: string,
  baseUrl: string
): ManifestPageNode[] {
  const out: ManifestPageNode[] = [];
  for (const node of nodes) {
    const meta = manifestData.get(node.page.id);
    const children = buildManifestNodes(node.children, pathMap, manifestData, spaceKey, baseUrl);
    if (!meta) {
      out.push(...children);
      continue;
    }
    out.push({
      id: node.page.id,
      title: node.page.title,
      vaultPath: pathMap.get(node.page.id) ?? '',
      confluenceUrl: pageUrl(baseUrl, spaceKey, node.page.id),
      modifiedAt: node.page.versionDate,
      lastSynced: meta.lastSynced,
      labels: meta.labels,
      attachments: meta.attachments,
      hasUnsupportedContent: meta.hasUnsupportedContent,
      children,
    });
  }
  return out;
}

function countManifestNodes(nodes: ManifestPageNode[]): number {
  let n = 0;
  for (const node of nodes) n += 1 + countManifestNodes(node.children);
  return n;
}

function buildManifest(
  tree: PageNode[],
  pathMap: Map<string, string>,
  manifestData: ManifestData,
  spaceKey: string,
  spaceName: string | null,
  homePageId: string | null,
  baseUrl: string
): Manifest {
  const treeNodes = buildManifestNodes(tree, pathMap, manifestData, spaceKey, baseUrl);
  return {
    spaceKey,
    spaceName,
    homePageId,
    baseUrl,
    generatedAt: new Date().toISOString(),
    pageCount: countManifestNodes(treeNodes),
    tree: treeNodes,
  };
}

/** Finds a PageNode in the Confluence tree by page ID. */
function findPageNode(nodes: PageNode[], pageId: string): PageNode | null {
  for (const node of nodes) {
    if (node.page.id === pageId) return node;
    const found = findPageNode(node.children, pageId);
    if (found) return found;
  }
  return null;
}

/** Returns the page ID whose computed vault path equals targetPath, or null. */
function findPageIdByVaultPath(
  pages: ConfluencePage[],
  pathMap: Map<string, string>,
  targetPath: string
): string | null {
  for (const page of pages) {
    if (pathMap.get(page.id) === targetPath) return page.id;
  }
  return null;
}

/** Replaces the ManifestPageNode with the given ID. Returns true on success. */
function replaceManifestNode(
  nodes: ManifestPageNode[],
  targetId: string,
  replacement: ManifestPageNode
): boolean {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === targetId) { nodes[i] = replacement; return true; }
    if (replaceManifestNode(nodes[i].children, targetId, replacement)) return true;
  }
  return false;
}

/** In-place update of a single ManifestPageNode's fields. Returns true if found. */
function updateManifestNode(
  nodes: ManifestPageNode[],
  pageId: string,
  updates: Partial<ManifestPageNode>
): boolean {
  for (const node of nodes) {
    if (node.id === pageId) { Object.assign(node, updates); return true; }
    if (updateManifestNode(node.children, pageId, updates)) return true;
  }
  return false;
}

/** Builds a pageId → vaultPath map from an existing manifest. */
export function buildPathMapFromManifest(manifest: Manifest): Map<string, string> {
  const map = new Map<string, string>();
  function walk(nodes: ManifestPageNode[]): void {
    for (const node of nodes) { map.set(node.id, node.vaultPath); walk(node.children); }
  }
  walk(manifest.tree);
  return map;
}

export async function readManifestFile(vault: Vault, manifestPath: string): Promise<Manifest | null> {
  try {
    if (!(await vault.adapter.exists(manifestPath))) return null;
    return JSON.parse(await vault.adapter.read(manifestPath)) as Manifest;
  } catch { return null; }
}

export async function writeManifestFile(vault: Vault, manifestPath: string, manifest: Manifest): Promise<void> {
  const json = JSON.stringify(manifest, null, 2) + '\n';
  if (await vault.adapter.exists(manifestPath)) makeWritable(vault, manifestPath);
  await vault.adapter.write(manifestPath, json);
  makeReadOnly(vault, manifestPath);
}

export async function runSyncForTarget(
  target: SyncTarget,
  settings: ConfluenceVaultSyncSettings,
  vault: Vault,
  onProgress?: (current: number, total: number, label: string) => void,
  scope: PullScope = { kind: 'space' }
): Promise<number> {
  const spaceKey = target.spaceKey;
  // Normalize: strip any trailing slashes the user may have typed in settings
  const syncFolderPath = target.syncFolderPath.replace(/\/+$/, '');
  const {
    confluenceBaseUrl,
    confluenceEmail,
    confluenceApiToken,
    maxImageDownloadSizeKb,
    syncConcurrency,
  } = settings;

  console.debug(`${LOG} starting sync for space "${spaceKey}" → "${syncFolderPath}"`);
  new Notice(`Syncing ${spaceKey}…`);

  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);

  // 1. Resolve the space's numeric ID (required to scope the v2 /pages query —
  //    the API silently ignores an unknown `space-key` param and would return
  //    every page in the instance). Then fetch the page list.
  console.debug(`${LOG} resolving space "${spaceKey}"…`);
  const space = await client.getSpaceByKey(spaceKey);
  const spaceName = space.name;
  const homePageId = space.homepageId;
  console.debug(`${LOG} fetching page list for space id ${space.id}…`);
  const pages = await client.getSpacePages(space.id, spaceKey);
  console.debug(`${LOG} ${pages.length} pages fetched, home page ID: ${homePageId ?? 'unknown'}`);

  // 1b. Resolve any parentId references that are missing from the page list.
  //     Confluence Folder entities are excluded from the v2 /pages endpoint but
  //     regular pages reference their IDs as parentId. We use the parentType
  //     field (present in the /pages response) to call the right endpoint:
  //     parentType="folder" → v2 /folders/{id}, anything else → v1 /content/{id}.
  //     Iterate until all parents are accounted for (folders can nest).
  {
    const knownIds = new Set(pages.map((p) => p.id));
    // parentType map: parentId → what type the parent is, as reported by its child
    const parentTypeMap = new Map<string, string>();
    for (const p of pages) {
      if (p.parentId && p.parentType) parentTypeMap.set(p.parentId, p.parentType);
    }

    let missing = new Set(
      pages.map((p) => p.parentId).filter((id): id is string => id !== null && !knownIds.has(id))
    );

    while (missing.size > 0) {
      console.debug(`${LOG} resolving ${missing.size} missing parent ID(s) (folders/non-page content)…`);
      const resolved = await Promise.all(
        [...missing].map(async (id) => {
          const isFolder = parentTypeMap.get(id) === 'folder';
          // Try the most-likely endpoint first, fall back to the other
          const content = isFolder
            ? (await client.getFolderById(id)) ?? (await client.getContentById(id))
            : (await client.getContentById(id)) ?? (await client.getFolderById(id));
          return { id, content, isFolder };
        })
      );

      missing = new Set();
      for (const { content, isFolder } of resolved) {
        if (!content || knownIds.has(content.id)) continue;
        pages.push({
          id: content.id,
          title: content.title,
          parentId: content.parentId,
          parentType: content.parentType,
          contentType: isFolder ? 'folder' : 'unknown',
          spaceKey,
          versionDate: new Date(0).toISOString(),
        });
        knownIds.add(content.id);
        if (content.parentId && !knownIds.has(content.parentId)) {
          if (content.parentType) parentTypeMap.set(content.parentId, content.parentType);
          missing.add(content.parentId);
        }
      }
    }
    if (pages.length > 0) {
      console.debug(`${LOG} ${pages.length} total nodes after parent resolution`);
    }
  }

  // 2. Build the page tree from parentId links.
  //    All 128 (or however many) pages returned by the space-scoped query belong
  //    to this space. Some may have parentId pointing to a space-root container
  //    (not a page entity), making them "roots" in our tree alongside the home
  //    page. We sync ALL roots so no space content is silently dropped.
  //    homePageId is kept only for manifest metadata.
  const tree = buildTree(pages);
  if (homePageId) {
    const homeRoot = tree.find((n) => n.page.id === homePageId);
    console.debug(
      homeRoot
        ? `${LOG} home page "${homeRoot.page.title}" found among ${tree.length} root(s)`
        : `${LOG} home page ${homePageId} not found among tree roots`
    );
  }

  // 3. Compute vault paths and flatten to ordered list
  const pathMap = new Map<string, string>();
  computePaths(tree, syncFolderPath, pathMap);
  const filteredPages = flattenTree(tree);
  const expectedPaths = new Set(pathMap.values());

  // For subtree scope, restrict body fetches and orphan removal to the targeted folder.
  const pagesToSync = scope.kind === 'subtree'
    ? filteredPages.filter((p) => {
        const vp = pathMap.get(p.id);
        return vp !== undefined && vp.startsWith(scope.vaultPath + '/');
      })
    : filteredPages;

  // Version history config (resolved once, used throughout)
  const vhEnabled = settings.versionHistory?.enabled ?? false;
  const archiveFolder = settings.versionHistory?.archiveFolder ?? '.confluence';
  const archiveFolderPath = `${syncFolderPath}/${archiveFolder}`;
  const excludeFolders = vhEnabled ? new Set([archiveFolderPath]) : new Set<string>();

  // 4. Scan existing files to find what's already synced and up-to-date
  const existingFiles = await scanExistingFiles(vault, syncFolderPath, excludeFolders);
  console.debug(`${LOG} ${existingFiles.size} existing synced files found`);

  // 5. Pre-create all directories needed for this sync pass.
  //    Must happen sequentially and sorted by depth so parents exist before
  //    children — vault.adapter.mkdir may not create intermediate directories,
  //    and the parallel body-fetch below would otherwise race on mkdir calls.
  {
    const dirs = new Set<string>([syncFolderPath]);
    for (const vaultPath of pathMap.values()) {
      const dir = vaultPath.split('/').slice(0, -1).join('/');
      if (dir) dirs.add(dir);
    }
    if (vhEnabled) dirs.add(archiveFolderPath);
    const sorted = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const dir of sorted) {
      try { await vault.adapter.mkdir(dir); } catch { /* already exists */ }
    }
  }

  // Pre-load existing manifest so skipped (unchanged) pages keep their attachment data
  const existingManifest = await readManifestFile(vault, `${syncFolderPath}/manifest.json`);
  const existingManifestIndex = existingManifest ? buildManifestIndex(existingManifest) : null;

  const converter = new AdfConverter(pathMap, confluenceBaseUrl);
  let syncedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let completedCount = 0;

  // manifestData is populated only for pagesToSync — callers use it to update
  // only the affected portion of the manifest (vault state, not Confluence state).
  const manifestData: ManifestData = new Map();

  new Notice(`${spaceKey}: ${pagesToSync.length} pages found, syncing…`);
  console.debug(`${LOG} syncing ${pagesToSync.length} pages with concurrency ${syncConcurrency}`);

  // 6. Sync pages in parallel with a concurrency cap
  await runWithConcurrency(pagesToSync, syncConcurrency, async (page, i) => {
    const vaultPath = pathMap.get(page.id);
    if (!vaultPath) return;

    completedCount++;
    onProgress?.(completedCount, pagesToSync.length, page.title);

    // Folder entities and other non-page types don't have a body or labels —
    // just record them in manifestData with empty metadata so the tree is complete.
    if (page.contentType !== 'page') {
      console.debug(`${LOG} [${i + 1}/${pagesToSync.length}] skipping body for ${page.contentType} "${page.title}"`);
      manifestData.set(page.id, { labels: [], lastSynced: new Date().toISOString(), attachments: [], hasUnsupportedContent: false });
      skippedCount++;
      return;
    }

    const existing = existingFiles.get(page.id);
    const isUpToDate =
      existing &&
      existing.path === vaultPath &&
      new Date(existing.lastSynced).getTime() >= new Date(page.versionDate).getTime();

    // Labels are pulled for every page on every run (can change without bumping version).
    const labelsPromise = client.getPageLabels(page.id).catch((err) => {
      console.warn(`${LOG} failed to fetch labels for ${page.id} "${page.title}":`, err);
      return [] as string[];
    });

    if (isUpToDate) {
      skippedCount++;
      console.debug(`${LOG} [${i + 1}/${pagesToSync.length}] skipping unchanged "${page.title}"`);
      const labels = await labelsPromise;
      // Preserve existing attachment data for skipped pages (content unchanged)
      const existingNode = existingManifestIndex?.get(page.id);
      manifestData.set(page.id, {
        labels,
        lastSynced: existing.lastSynced,
        attachments: existingNode?.attachments ?? [],
        hasUnsupportedContent: existingNode?.hasUnsupportedContent ?? false,
      });
      return;
    }

    console.debug(`${LOG} [${i + 1}/${pagesToSync.length}] writing "${page.title}" → ${vaultPath}`);

    try {
      // If the page moved to a new path, remove the old file
      if (existing && existing.path !== vaultPath) {
        console.debug(`${LOG} page "${page.title}" moved: ${existing.path} → ${vaultPath}`);
        makeWritable(vault, existing.path);
        await vault.adapter.remove(existing.path);
      }

      const adf = await client.getPageBody(page.id);

      const { markdown, attachments, hasUnsupportedContent } = await resolveMediaNodes(
        adf, page.id, syncFolderPath, imageDownloader, converter
      );

      const lastSynced = new Date().toISOString();
      const versionEpoch = vhEnabled
        ? Math.floor(new Date(page.versionDate).getTime() / 1000)
        : undefined;
      const content =
        buildFrontmatter(page.id, confluenceBaseUrl, spaceKey, page.title, lastSynced, versionEpoch) + markdown;

      if (existing) makeWritable(vault, vaultPath);
      await vault.adapter.write(vaultPath, content);
      makeReadOnly(vault, vaultPath);

      if (vhEnabled) {
        await syncRevisions(vault, client, page.id, vaultPath, syncFolderPath, settings.versionHistory, confluenceBaseUrl, spaceKey);
      }

      const labels = await labelsPromise;
      manifestData.set(page.id, { labels, lastSynced, attachments, hasUnsupportedContent });
      syncedCount++;
    } catch (err) {
      failedCount++;
      console.warn(`${LOG} failed to sync page ${page.id} "${page.title}":`, err);
      await labelsPromise.catch(() => undefined);
    }
  });

  // 7. Orphan removal — scoped to the pull target
  if (scope.kind === 'space') {
    await removeOrphanedFiles(vault, syncFolderPath, expectedPaths, excludeFolders);
  } else {
    // subtree: only remove files deleted from Confluence within the targeted folder
    const subtreeExpected = new Set(
      [...expectedPaths].filter((p) => p.startsWith(scope.vaultPath + '/'))
    );
    await removeOrphanedFiles(vault, scope.vaultPath, subtreeExpected);
  }

  // 7b. Archive cleanup — remove revision files for pages deleted from Confluence
  if (vhEnabled) {
    const validPageIds = new Set(pathMap.keys());
    await cleanDeletedPageRevisions(vault, archiveFolderPath, validPageIds);
  }

  // 8. Manifest update — reflects vault state, not Confluence state.
  //    Space: full rebuild. Subtree: replace only the affected subtree node.
  const manifestPath = `${syncFolderPath}/manifest.json`;
  try {
    if (scope.kind === 'space') {
      const manifest = buildManifest(tree, pathMap, manifestData, spaceKey, spaceName, homePageId, confluenceBaseUrl);
      await writeManifestFile(vault, manifestPath, manifest);
      console.debug(`${LOG} manifest written: ${manifestPath} (${manifest.pageCount} pages)`);
    } else {
      // Find the Confluence page whose vault path is the subtree root note.
      // Parent pages are stored as FolderName/FolderName.md (not index.md).
      const folderBasename = scope.vaultPath.split('/').pop() ?? '';
      const subtreeRootId = findPageIdByVaultPath(filteredPages, pathMap, `${scope.vaultPath}/${folderBasename}.md`);
      const existingManifest = await readManifestFile(vault, manifestPath);
      if (existingManifest && subtreeRootId) {
        const subtreeRootNode = findPageNode(tree, subtreeRootId);
        if (subtreeRootNode) {
          const freshNodes = buildManifestNodes([subtreeRootNode], pathMap, manifestData, spaceKey, confluenceBaseUrl);
          // Only replace if the root itself was successfully rebuilt
          const freshRoot = freshNodes.find((n) => n.id === subtreeRootId);
          if (freshRoot) {
            replaceManifestNode(existingManifest.tree, subtreeRootId, freshRoot);
            existingManifest.generatedAt = new Date().toISOString();
            existingManifest.pageCount = countManifestNodes(existingManifest.tree);
            await writeManifestFile(vault, manifestPath, existingManifest);
            console.debug(`${LOG} manifest subtree updated: ${subtreeRootId}`);
          }
        }
      }
    }
  } catch (err) {
    console.warn(`${LOG} failed to write manifest at ${manifestPath}:`, err);
  }

  // 9. Write .herbalist.yaml at sync folder root when version history is active
  if (vhEnabled) {
    await writeHerbalistConfig(vault, syncFolderPath);
  }

  console.debug(
    `${LOG} done — ${syncedCount} updated, ${skippedCount} skipped (unchanged), ${failedCount} failed`
  );

  return syncedCount + skippedCount;
}

/** Pull a single page directly — no full page-list fetch, manifest entry updated in place. */
export async function runPagePull(
  pageId: string,
  vaultPath: string,
  target: SyncTarget,
  settings: ConfluenceVaultSyncSettings,
  vault: Vault
): Promise<void> {
  const spaceKey = target.spaceKey;
  const syncFolderPath = target.syncFolderPath.replace(/\/+$/, '');
  const { confluenceBaseUrl, confluenceEmail, confluenceApiToken, maxImageDownloadSizeKb } = settings;

  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);

  // Read existing vault file to get last-synced timestamp
  const existingContent = await vault.adapter.read(vaultPath);
  const lastSyncedStr = extractFrontmatterField(existingContent, 'last-synced');
  const lastSynced = lastSyncedStr ? new Date(lastSyncedStr).getTime() : 0;

  // Fetch version info + labels in parallel (no full page list needed)
  const [{ updatedAt, title }, labels] = await Promise.all([
    client.getPageCurrentVersion(pageId),
    client.getPageLabels(pageId),
  ]);

  const manifestPath = `${syncFolderPath}/manifest.json`;
  const manifest = await readManifestFile(vault, manifestPath);

  if (new Date(updatedAt).getTime() <= lastSynced) {
    // Content unchanged — just refresh labels in the manifest
    if (manifest && updateManifestNode(manifest.tree, pageId, { labels })) {
      await writeManifestFile(vault, manifestPath, manifest);
    }
    return;
  }

  // Build a path map from the existing manifest so internal links resolve correctly
  const pathMapForLinks = manifest ? buildPathMapFromManifest(manifest) : new Map<string, string>();
  pathMapForLinks.set(pageId, vaultPath);

  const converter = new AdfConverter(pathMapForLinks, confluenceBaseUrl);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);

  const adf = await client.getPageBody(pageId);
  const { markdown, attachments, hasUnsupportedContent } = await resolveMediaNodes(
    adf, pageId, syncFolderPath, imageDownloader, converter
  );

  const newLastSynced = new Date().toISOString();
  const vhEnabled = settings.versionHistory?.enabled ?? false;
  const versionEpoch = vhEnabled ? Math.floor(new Date(updatedAt).getTime() / 1000) : undefined;
  const newContent = buildFrontmatter(pageId, confluenceBaseUrl, spaceKey, title, newLastSynced, versionEpoch) + markdown;

  makeWritable(vault, vaultPath);
  await vault.adapter.write(vaultPath, newContent);
  makeReadOnly(vault, vaultPath);

  if (vhEnabled) {
    await syncRevisions(vault, client, pageId, vaultPath, syncFolderPath, settings.versionHistory, confluenceBaseUrl, spaceKey);
  }

  // Update only this page's manifest entry
  if (manifest) {
    updateManifestNode(manifest.tree, pageId, {
      title,
      labels,
      lastSynced: newLastSynced,
      modifiedAt: updatedAt,
      attachments,
      hasUnsupportedContent,
    });
    await writeManifestFile(vault, manifestPath, manifest);
  }
}

/** ADF extension node types (extension/bodiedExtension/inlineExtension). */
const EXTENSION_NODE_TYPES = new Set([
  'extension',
  'bodiedExtension',
  'inlineExtension',
]);

/**
 * Extension keys we know how to round-trip through Markdown.
 * Extensions with these keys do NOT set hasUnsupportedContent.
 */
const SUPPORTED_EXTENSION_KEYS = new Set([
  'toc', // Table of contents — rendered as [TOC] and regenerated on push
]);

export interface ResolvedMedia {
  markdown: string;
  attachments: ManifestAttachment[];
  hasUnsupportedContent: boolean;
}

export async function resolveMediaNodes(
  adf: import('./confluence-client').AdfDocument,
  pageId: string,
  syncFolderPath: string,
  imageDownloader: Pick<ImageDownloader, 'handleMedia'>,
  converter: Pick<AdfConverter, 'convert'>
): Promise<ResolvedMedia> {
  const mediaReplacements = new Map<string, string>();
  const attachments: ManifestAttachment[] = [];
  let hasUnsupportedContent = false;

  async function collectMedia(node: import('./confluence-client').AdfNode): Promise<void> {
    if (EXTENSION_NODE_TYPES.has(node.type)) {
      const key = (node.attrs?.extensionKey as string) ?? '';
      if (!SUPPORTED_EXTENSION_KEYS.has(key)) {
        hasUnsupportedContent = true;
      }
    }

    if (node.type === 'media') {
      const mediaId = (node.attrs?.id as string) ?? '';
      const mediaType = (node.attrs?.type as string) ?? '';
      const collection = (node.attrs?.collection as string) ?? '';

      // External media has a direct URL — no attachment fetch needed.
      if (mediaType === 'external') {
        const extUrl = (node.attrs?.url as string) ?? '';
        if (extUrl && !mediaReplacements.has(mediaId || extUrl)) {
          const key = mediaId || extUrl;
          mediaReplacements.set(key, `![external media](${extUrl})`);
        }
      } else if (mediaId && !mediaReplacements.has(mediaId)) {
        // Derive the attachment-owning page from the collection (contentId-<pageId>).
        // Falls back to current pageId if collection is absent or unparseable.
        const collectionPageId = collection.startsWith('contentId-')
          ? collection.slice('contentId-'.length)
          : pageId;
        try {
          const result = await imageDownloader.handleMedia(collectionPageId, mediaId, syncFolderPath);
          mediaReplacements.set(mediaId, result.markdown);
          if (result.filename && result.mimeType) {
            attachments.push({ mediaId, collection, filename: result.filename, mimeType: result.mimeType });
          }
        } catch (err) {
          console.warn(`${LOG} failed to download media ${mediaId} (collection=${collection}):`, err);
          mediaReplacements.set(mediaId, '[attachment unavailable]');
        }
      }
    }
    if (node.content) {
      for (const child of node.content) {
        await collectMedia(child);
      }
    }
  }

  await collectMedia(adf);

  function replaceMedia(
    node: import('./confluence-client').AdfNode
  ): import('./confluence-client').AdfNode {
    if (node.type === 'media') {
      const mediaId = (node.attrs?.id as string) ?? '';
      const extUrl = (node.attrs?.url as string) ?? '';
      const key = mediaId || extUrl;
      const replacement = mediaReplacements.get(key) ?? '[attachment]';
      return { type: 'text', text: replacement };
    }
    if (node.content) {
      return { ...node, content: node.content.map(replaceMedia) };
    }
    return node;
  }

  const resolvedAdf = replaceMedia(adf) as import('./confluence-client').AdfDocument;
  return { markdown: converter.convert(resolvedAdf), attachments, hasUnsupportedContent };
}

/** Build a flat pageId → ManifestPageNode map for O(1) lookups. */
export function buildManifestIndex(manifest: Manifest): Map<string, ManifestPageNode> {
  const index = new Map<string, ManifestPageNode>();
  function walk(nodes: ManifestPageNode[]): void {
    for (const node of nodes) {
      index.set(node.id, node);
      walk(node.children);
    }
  }
  walk(manifest.tree);
  return index;
}
