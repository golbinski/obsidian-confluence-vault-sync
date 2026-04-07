import { Notice, Vault } from 'obsidian';
import type { ConfluenceVaultSyncSettings, SyncTarget } from './settings';
import { ConfluenceClient, type ConfluencePage } from './confluence-client';
import { AdfConverter } from './adf-converter';
import { ImageDownloader } from './image-downloader';
import * as fs from 'fs';

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
      // Parent page: written as index.md inside a folder
      const folderPath = `${parentPath}/${sanitized}`;
      const filePath = `${folderPath}/index.md`;
      pathMap.set(node.page.id, filePath);
      computePaths(node.children, folderPath, pathMap);
    } else {
      // Leaf page
      const filePath = `${parentPath}/${sanitized}.md`;
      pathMap.set(node.page.id, filePath);
    }
  }
}

async function removeRecursive(vault: Vault, path: string): Promise<void> {
  try {
    const stat = await vault.adapter.stat(path);
    if (!stat) return;

    if (stat.type === 'folder') {
      const listed = await vault.adapter.list(path);
      for (const file of listed.files) {
        // Make writable before deleting
        try {
          const abs = (vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(file);
          fs.chmodSync(abs, 0o644);
        } catch {
          // Best effort
        }
        await vault.adapter.remove(file);
      }
      for (const folder of listed.folders) {
        await removeRecursive(vault, folder);
      }
      // Remove the folder itself if it's a sub-folder (not the root sync folder)
      if (path !== path) {
        try {
          await (vault.adapter as unknown as { rmdir(p: string, recursive: boolean): Promise<void> }).rmdir(path, true);
        } catch {
          // Ignore
        }
      }
    } else {
      try {
        const abs = (vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(path);
        fs.chmodSync(abs, 0o644);
      } catch {
        // Best effort
      }
      await vault.adapter.remove(path);
    }
  } catch {
    // Path doesn't exist, ignore
  }
}

async function wipeSyncFolder(vault: Vault, syncFolderPath: string): Promise<void> {
  try {
    const listed = await vault.adapter.list(syncFolderPath);

    // Wipe files
    for (const file of listed.files) {
      try {
        const abs = (vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(file);
        fs.chmodSync(abs, 0o644);
      } catch {
        // Best effort
      }
      await vault.adapter.remove(file);
    }

    // Wipe subfolders except attachments (wiped separately)
    for (const folder of listed.folders) {
      const name = folder.split('/').pop();
      if (name === 'attachments') {
        // Wipe attachments folder contents separately
        await wipeAttachmentsFolder(vault, folder);
      } else {
        await removeRecursive(vault, folder);
      }
    }
  } catch {
    // Folder doesn't exist yet, fine
  }
}

async function wipeAttachmentsFolder(vault: Vault, attachmentsPath: string): Promise<void> {
  try {
    const listed = await vault.adapter.list(attachmentsPath);
    for (const file of listed.files) {
      try {
        const abs = (vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(file);
        fs.chmodSync(abs, 0o644);
      } catch {
        // Best effort
      }
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

  new Notice(`Syncing ${spaceKey}…`);

  const client = new ConfluenceClient(confluenceBaseUrl, confluenceEmail, confluenceApiToken);
  const imageDownloader = new ImageDownloader(client, vault, maxImageDownloadSizeKb);

  // 1. Fetch all pages
  const pages = await client.getSpacePages(spaceKey);

  // 2. Build tree
  const tree = buildTree(pages);

  // 3. Compute paths
  const pathMap = new Map<string, string>();
  computePaths(tree, syncFolderPath, pathMap);

  // 4. Wipe sync folder
  await wipeSyncFolder(vault, syncFolderPath);

  // Ensure sync folder exists
  try {
    await vault.adapter.mkdir(syncFolderPath);
  } catch {
    // Already exists
  }

  const converter = new AdfConverter(pathMap, confluenceBaseUrl);
  let syncedCount = 0;

  // 5. Sync each page
  for (const page of pages) {
    const vaultPath = pathMap.get(page.id);
    if (!vaultPath) continue;

    try {
      const adf = await client.getPageBody(page.id);

      // Create parent directories
      const dir = vaultPath.split('/').slice(0, -1).join('/');
      if (dir) {
        try {
          await vault.adapter.mkdir(dir);
        } catch {
          // Already exists
        }
      }

      // Handle media nodes by resolving them before conversion
      const markdown = await resolveMediaNodes(adf, page.id, syncFolderPath, imageDownloader, converter);

      const frontmatter = buildFrontmatter(page.id, confluenceBaseUrl, spaceKey, page.title);
      const content = frontmatter + markdown;

      await vault.adapter.write(vaultPath, content);

      // Make read-only
      try {
        const abs = (vault.adapter as unknown as { getFullPath(p: string): string }).getFullPath(vaultPath);
        fs.chmodSync(abs, 0o444);
      } catch {
        // Best effort
      }

      syncedCount++;
    } catch (err) {
      console.warn(`[Confluence Vault Sync] Failed to sync page ${page.id} "${page.title}":`, err);
    }
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
  // We need to handle media nodes specially since downloading is async.
  // Walk the ADF tree, replace media nodes with placeholder text nodes,
  // then convert.
  const mediaReplacements = new Map<string, string>();

  async function collectMedia(node: import('./confluence-client').AdfNode): Promise<void> {
    if (node.type === 'media') {
      const mediaId = (node.attrs?.id as string) ?? '';
      if (mediaId && !mediaReplacements.has(mediaId)) {
        try {
          const result = await imageDownloader.handleMedia(pageId, mediaId, syncFolderPath);
          mediaReplacements.set(mediaId, result);
        } catch (err) {
          console.warn(`[Confluence Vault Sync] Failed to download media ${mediaId}:`, err);
          mediaReplacements.set(mediaId, `[attachment unavailable]`);
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

  // Replace media nodes with text nodes containing the resolved markdown
  function replaceMedia(node: import('./confluence-client').AdfNode): import('./confluence-client').AdfNode {
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
