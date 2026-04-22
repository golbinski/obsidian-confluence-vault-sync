import * as fs from 'fs';
import type { Vault } from 'obsidian';

type VaultAdapter = {
  getFullPath(p: string): string;
  rmdir(p: string, recursive: boolean): Promise<void>;
};

export function getFullPath(vault: Vault, relativePath: string): string {
  return (vault.adapter as unknown as VaultAdapter).getFullPath(relativePath);
}

export function makeWritable(vault: Vault, relativePath: string): void {
  try {
    fs.chmodSync(getFullPath(vault, relativePath), 0o644);
  } catch { /* best effort */ }
}

export function makeReadOnly(vault: Vault, relativePath: string): void {
  try {
    fs.chmodSync(getFullPath(vault, relativePath), 0o444);
  } catch { /* best effort */ }
}

export function isWritable(vault: Vault, relativePath: string): boolean {
  try {
    fs.accessSync(getFullPath(vault, relativePath), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function extractFrontmatterField(content: string, field: string): string | null {
  const match = content.match(new RegExp(`^${field}: "([^"]+)"`, 'm'));
  return match?.[1] ?? null;
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n/);
  return match ? content.slice(match[0].length) : content;
}

/** Returns paths of all writable (unlocked) .md files under folderPath.
 *  Files without a confluence-id frontmatter field are skipped — they are
 *  new local files not yet published, not unlocked synced pages. */
export async function findUnlockedFiles(vault: Vault, folderPath: string): Promise<string[]> {
  const result: string[] = [];

  async function scan(dir: string): Promise<void> {
    let listed;
    try {
      listed = await vault.adapter.list(dir);
    } catch {
      return;
    }
    for (const file of listed.files) {
      if (!file.endsWith('.md') || !isWritable(vault, file)) continue;
      try {
        const content = await vault.adapter.read(file);
        if (extractFrontmatterField(content, 'confluence-id')) result.push(file);
      } catch {
        // unreadable — skip
      }
    }
    for (const folder of listed.folders) {
      await scan(folder);
    }
  }

  await scan(folderPath);
  return result;
}
