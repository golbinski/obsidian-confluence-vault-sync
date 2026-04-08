import { Notice, Vault } from 'obsidian';
import type { ConfluenceVaultSyncSettings, SyncTarget } from './settings';
import { ConfluenceClient, type ConfluencePage } from './confluence-client';
import { AdfConverter } from './adf-converter';
import { ImageDownloader } from './image-downloader';
import {
  getFullPath,
  makeWritable,
  makeReadOnly,
  extractFrontmatterField,
} from './fs-utils';
import * as fs from 'fs';

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
      pathMap.set(node.page.id, `${folderPath}/index.md`);
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

type VaultAdapter = {
  rmdir(p: string, recursive: boolean): Promise<void>;
};

/** Scan all .md files under a vault path and return a map of pageId → {path, lastSynced}. */
async function scanExistingFiles(
  vault: Vault,
  dirPath: string
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
  expectedPaths: Set<string>
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
        console.log(`${LOG} removing orphaned file: ${file}`);
        makeWritable(vault, file);
        await vault.adapter.remove(file);
      }
    }

    let allChildrenGone = true;
    for (const folder of listed.folders) {
      const isEmpty = await cleanDir(folder);
      if (isEmpty && folder !== `${syncFolderPath}/attachments`) {
        try {
          await (vault.adapter as unknown as { rmdir(p: string, r: boolean): Promise<void> }).rmdir(folder, true);
        } catch { /* ignore */ }
      } else {
        allChildrenGone = false;
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
  lastSynced: string
): string {
  return [
    '---',
    `confluence-id: "${pageId}"`,
    `confluence-url: "${pageUrl(baseUrl, spaceKey, pageId)}"`,
    `confluence-title: "${title.replace(/"/g, '\\"')}"`,
    `space: "${spaceKey}"`,
    `last-synced: "${lastSynced}"`,
    `read-only: true`,
    '---',
    '',
  ].join('\n');
}

interface ManifestPageNode {
  id: string;
  title: string;
  vaultPath: string;
  confluenceUrl: string;
  modifiedAt: string;
  lastSynced: string;
  labels: string[];
  children: ManifestPageNode[];
}

interface Manifest {
  spaceKey: string;
  spaceName: string | null;
  homePageId: string | null;
  baseUrl: string;
  generatedAt: string;
  pageCount: number;
  tree: ManifestPageNode[];
}

function buildManifest(
  tree: PageNode[],
  pathMap: Map<string, string>,
  manifestData: Map<string, { labels: string[]; lastSynced: string }>,
  spaceKey: string,
  spaceName: string | null,
  homePageId: string | null,
  baseUrl: string
): Manifest {
  function walk(nodes: PageNode[]): ManifestPageNode[] {
    const out: ManifestPageNode[] = [];
    for (const node of nodes) {
      const meta = manifestData.get(node.page.id);
      // Skip pages whose body sync failed — they have no manifest entry.
      // Their children are still emitted (re-parented to this level) so the
      // tree doesn't lose downstream pages just because an ancestor errored.
      const children = walk(node.children);
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
        children,
      });
    }
    return out;
  }

  const treeNodes = walk(tree);
  function count(nodes: ManifestPageNode[]): number {
    let n = 0;
    for (const node of nodes) n += 1 + count(node.children);
    return n;
  }

  return {
    spaceKey,
    spaceName,
    homePageId,
    baseUrl,
    generatedAt: new Date().toISOString(),
    pageCount: count(treeNodes),
    tree: treeNodes,
  };
}

export async function runSyncForTarget(
  target: SyncTarget,
  settings: ConfluenceVaultSyncSettings,
  vault: Vault,
  onProgress?: (current: number, total: number, label: string) => void
): Promise<number> {
  const { spaceKey, syncFolderPath } = target;
  const {
    confluenceBaseUrl,
    confluenceEmail,
    confluenceApiToken,
    maxImageDownloadSizeKb,
    syncConcurrency,
  } = settings;

  console.log(`${LOG} starting sync for space "${spaceKey}" → "${syncFolderPath}"`);
  new Notice(`Syncing ${spaceKey}…`);

  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);

  // 1. Fetch pages (with version dates), home page ID, and space name in parallel
  console.log(`${LOG} fetching page list…`);
  const [pages, homePageId, spaceName] = await Promise.all([
    client.getSpacePages(spaceKey),
    client.getSpaceHomePageId(spaceKey),
    client.checkSpaceAccess(spaceKey).catch(() => null),
  ]);
  console.log(`${LOG} ${pages.length} pages fetched, home page ID: ${homePageId ?? 'unknown'}`);

  // 2. Build tree rooted at space home page
  const fullTree = buildTree(pages);
  let tree = fullTree;
  if (homePageId) {
    const homeRoot = fullTree.find((n) => n.page.id === homePageId);
    if (homeRoot) {
      tree = [homeRoot];
      console.log(`${LOG} rooted tree at home page "${homeRoot.page.title}"`);
    } else {
      console.warn(`${LOG} home page ${homePageId} not found — syncing all roots`);
    }
  }

  // 3. Compute vault paths and flatten to ordered list
  const pathMap = new Map<string, string>();
  computePaths(tree, syncFolderPath, pathMap);
  const filteredPages = flattenTree(tree);
  const expectedPaths = new Set(pathMap.values());

  // 4. Scan existing files to find what's already synced and up-to-date
  const existingFiles = await scanExistingFiles(vault, syncFolderPath);
  console.log(`${LOG} ${existingFiles.size} existing synced files found`);

  // 5. Ensure sync folder exists
  try { await vault.adapter.mkdir(syncFolderPath); } catch { /* exists */ }

  const converter = new AdfConverter(pathMap, confluenceBaseUrl);
  let syncedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let completedCount = 0;

  // Per-page metadata accumulated during the sync pass and consumed when
  // building the manifest. Pages whose body sync fails outright are omitted
  // so consumers can rely on every entry having a valid lastSynced.
  const manifestData = new Map<string, { labels: string[]; lastSynced: string }>();

  new Notice(`${spaceKey}: ${filteredPages.length} pages found, syncing…`);
  console.log(`${LOG} syncing ${filteredPages.length} pages with concurrency ${syncConcurrency}`);

  // 6. Sync pages in parallel with a concurrency cap
  await runWithConcurrency(filteredPages, syncConcurrency, async (page, i) => {
    const vaultPath = pathMap.get(page.id);
    if (!vaultPath) return;

    const existing = existingFiles.get(page.id);
    const isUpToDate =
      existing &&
      existing.path === vaultPath &&
      new Date(existing.lastSynced).getTime() >= new Date(page.versionDate).getTime();

    completedCount++;
    onProgress?.(completedCount, filteredPages.length, page.title);

    // Labels are pulled for every page on every run (they can change without
    // bumping the page version). Failures degrade to an empty array so the
    // manifest still gets an entry.
    const labelsPromise = client.getPageLabels(page.id).catch((err) => {
      console.warn(`${LOG} failed to fetch labels for ${page.id} "${page.title}":`, err);
      return [] as string[];
    });

    if (isUpToDate) {
      skippedCount++;
      console.debug(`${LOG} [${i + 1}/${filteredPages.length}] skipping unchanged "${page.title}"`);
      const labels = await labelsPromise;
      manifestData.set(page.id, { labels, lastSynced: existing.lastSynced });
      return;
    }

    console.log(`${LOG} [${i + 1}/${filteredPages.length}] writing "${page.title}" → ${vaultPath}`);

    try {
      // If the page moved to a new path, remove the old file
      if (existing && existing.path !== vaultPath) {
        console.log(`${LOG} page "${page.title}" moved: ${existing.path} → ${vaultPath}`);
        makeWritable(vault, existing.path);
        await vault.adapter.remove(existing.path);
      }

      const adf = await client.getPageBody(page.id);

      const dir = vaultPath.split('/').slice(0, -1).join('/');
      if (dir) {
        try { await vault.adapter.mkdir(dir); } catch { /* exists */ }
      }

      const markdown = await resolveMediaNodes(
        adf, page.id, syncFolderPath, imageDownloader, converter
      );

      const lastSynced = new Date().toISOString();
      const content =
        buildFrontmatter(page.id, confluenceBaseUrl, spaceKey, page.title, lastSynced) + markdown;

      if (existing) makeWritable(vault, vaultPath);
      await vault.adapter.write(vaultPath, content);
      makeReadOnly(vault, vaultPath);

      const labels = await labelsPromise;
      manifestData.set(page.id, { labels, lastSynced });
      syncedCount++;
    } catch (err) {
      failedCount++;
      console.warn(`${LOG} failed to sync page ${page.id} "${page.title}":`, err);
      // Drain the labels promise so it can't surface as an unhandled rejection.
      await labelsPromise.catch(() => undefined);
    }
  });

  // 7. Remove files for pages deleted from Confluence
  await removeOrphanedFiles(vault, syncFolderPath, expectedPaths);

  // 8. Write the space manifest. Failures here are logged but never fail the
  // sync — the .md files are already on disk and that's the load-bearing work.
  const manifestPath = `${syncFolderPath}/manifest.json`;
  try {
    const manifest = buildManifest(
      tree,
      pathMap,
      manifestData,
      spaceKey,
      spaceName,
      homePageId,
      confluenceBaseUrl
    );
    const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
    if (await vault.adapter.exists(manifestPath)) {
      makeWritable(vault, manifestPath);
    }
    await vault.adapter.write(manifestPath, manifestJson);
    makeReadOnly(vault, manifestPath);
    console.log(`${LOG} manifest written: ${manifestPath} (${manifest.pageCount} pages)`);
  } catch (err) {
    console.warn(`${LOG} failed to write manifest at ${manifestPath}:`, err);
  }

  console.log(
    `${LOG} done — ${syncedCount} updated, ${skippedCount} skipped (unchanged), ${failedCount} failed`
  );

  return syncedCount + skippedCount;
}

async function resolveMediaNodes(
  adf: import('./confluence-client').AdfDocument,
  pageId: string,
  syncFolderPath: string,
  imageDownloader: ImageDownloader,
  converter: AdfConverter
): Promise<string> {
  const mediaReplacements = new Map<string, string>();

  async function collectMedia(node: import('./confluence-client').AdfNode): Promise<void> {
    if (node.type === 'media') {
      const mediaId = (node.attrs?.id as string) ?? '';
      if (mediaId && !mediaReplacements.has(mediaId)) {
        try {
          const result = await imageDownloader.handleMedia(pageId, mediaId, syncFolderPath);
          mediaReplacements.set(mediaId, result);
        } catch (err) {
          console.warn(`${LOG} failed to download media ${mediaId}:`, err);
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
      const replacement = mediaReplacements.get(mediaId) ?? '[attachment]';
      return { type: 'text', text: replacement };
    }
    if (node.content) {
      return { ...node, content: node.content.map(replaceMedia) };
    }
    return node;
  }

  const resolvedAdf = replaceMedia(adf) as import('./confluence-client').AdfDocument;
  return converter.convert(resolvedAdf);
}
