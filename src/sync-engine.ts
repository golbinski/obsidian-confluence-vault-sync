import { Notice, Vault } from 'obsidian';
import type { ConfluenceVaultSyncSettings, SyncTarget } from './settings';
import { ConfluenceClient, type ConfluencePage } from './confluence-client';
import { AdfConverter } from './adf-converter';
import { ImageDownloader } from './image-downloader';
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
      const filePath = `${folderPath}/index.md`;
      pathMap.set(node.page.id, filePath);
      computePaths(node.children, folderPath, pathMap);
    } else {
      const filePath = `${parentPath}/${sanitized}.md`;
      pathMap.set(node.page.id, filePath);
    }
  }
}

type VaultAdapter = {
  getFullPath(p: string): string;
  rmdir(p: string, recursive: boolean): Promise<void>;
};

function getFullPath(vault: Vault, relativePath: string): string {
  return (vault.adapter as unknown as VaultAdapter).getFullPath(relativePath);
}

function makeWritable(vault: Vault, relativePath: string): void {
  try {
    fs.chmodSync(getFullPath(vault, relativePath), 0o644);
  } catch {
    // Best effort — file may not exist yet
  }
}

async function removeRecursive(vault: Vault, path: string): Promise<void> {
  try {
    const stat = await vault.adapter.stat(path);
    if (!stat) return;

    if (stat.type === 'folder') {
      const listed = await vault.adapter.list(path);
      for (const file of listed.files) {
        makeWritable(vault, file);
        await vault.adapter.remove(file);
      }
      for (const folder of listed.folders) {
        await removeRecursive(vault, folder);
      }
      try {
        await (vault.adapter as unknown as VaultAdapter).rmdir(path, true);
      } catch {
        // Ignore
      }
    } else {
      makeWritable(vault, path);
      await vault.adapter.remove(path);
    }
  } catch {
    // Path doesn't exist
  }
}

async function wipeSyncFolder(vault: Vault, syncFolderPath: string): Promise<void> {
  console.log(`${LOG} wiping sync folder: ${syncFolderPath}`);
  try {
    const listed = await vault.adapter.list(syncFolderPath);

    for (const file of listed.files) {
      makeWritable(vault, file);
      await vault.adapter.remove(file);
    }

    for (const folder of listed.folders) {
      const name = folder.split('/').pop();
      if (name === 'attachments') {
        await wipeAttachmentsFolder(vault, folder);
      } else {
        await removeRecursive(vault, folder);
      }
    }
  } catch {
    // Folder doesn't exist yet — that's fine
  }
}

async function wipeAttachmentsFolder(vault: Vault, attachmentsPath: string): Promise<void> {
  try {
    const listed = await vault.adapter.list(attachmentsPath);
    for (const file of listed.files) {
      makeWritable(vault, file);
      await vault.adapter.remove(file);
    }
  } catch {
    // Folder doesn't exist
  }
}

function buildFrontmatter(
  pageId: string,
  baseUrl: string,
  spaceKey: string,
  title: string
): string {
  const url = `${baseUrl}/wiki/spaces/${spaceKey}/pages/${pageId}`;
  const lastSynced = new Date().toISOString();
  return [
    '---',
    `confluence-id: "${pageId}"`,
    `confluence-url: "${url}"`,
    `confluence-title: "${title.replace(/"/g, '\\"')}"`,
    `space: "${spaceKey}"`,
    `last-synced: "${lastSynced}"`,
    `read-only: true`,
    '---',
    '',
  ].join('\n');
}

export async function runSyncForTarget(
  target: SyncTarget,
  settings: ConfluenceVaultSyncSettings,
  vault: Vault
): Promise<number> {
  const { spaceKey, syncFolderPath } = target;
  const { confluenceBaseUrl, confluenceEmail, confluenceApiToken, maxImageDownloadSizeKb } =
    settings;

  console.log(`${LOG} starting sync for space "${spaceKey}" → "${syncFolderPath}"`);
  new Notice(`Syncing ${spaceKey}…`);

  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);

  // 1. Fetch all pages
  console.log(`${LOG} fetching page list…`);
  const pages = await client.getSpacePages(spaceKey);
  console.log(`${LOG} ${pages.length} pages to sync`);
  new Notice(`${spaceKey}: ${pages.length} pages found, writing…`);

  // 2. Build tree and compute paths
  const tree = buildTree(pages);
  const pathMap = new Map<string, string>();
  computePaths(tree, syncFolderPath, pathMap);

  // 3. Wipe sync folder
  await wipeSyncFolder(vault, syncFolderPath);

  try {
    await vault.adapter.mkdir(syncFolderPath);
  } catch {
    // Already exists
  }

  const converter = new AdfConverter(pathMap, confluenceBaseUrl);
  let syncedCount = 0;
  let failedCount = 0;

  // 4. Sync each page
  for (const page of pages) {
    const vaultPath = pathMap.get(page.id);
    if (!vaultPath) continue;

    console.log(`${LOG} [${syncedCount + failedCount + 1}/${pages.length}] "${page.title}" → ${vaultPath}`);

    try {
      const adf = await client.getPageBody(page.id);

      const dir = vaultPath.split('/').slice(0, -1).join('/');
      if (dir) {
        try { await vault.adapter.mkdir(dir); } catch { /* exists */ }
      }

      const markdown = await resolveMediaNodes(
        adf, page.id, syncFolderPath, imageDownloader, converter
      );

      const content = buildFrontmatter(page.id, confluenceBaseUrl, spaceKey, page.title) + markdown;
      await vault.adapter.write(vaultPath, content);

      try {
        fs.chmodSync(getFullPath(vault, vaultPath), 0o444);
      } catch {
        // Best effort
      }

      syncedCount++;
    } catch (err) {
      failedCount++;
      console.warn(`${LOG} failed to sync page ${page.id} "${page.title}":`, err);
    }
  }

  console.log(`${LOG} done — ${syncedCount} synced, ${failedCount} failed`);
  if (failedCount > 0) {
    console.warn(`${LOG} ${failedCount} page(s) failed — check console for details`);
  }

  return syncedCount;
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
