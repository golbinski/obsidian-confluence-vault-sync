import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Vault } from 'obsidian';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
  Notice: class {},
  Plugin: class {},
  PluginSettingTab: class {},
  ItemView: class {},
  Modal: class {},
  Setting: class {},
  ButtonComponent: class {},
  TFolder: class {},
}));

import { ConfluenceClient } from '../confluence-client';
import {
  syncRevisions,
  cleanDeletedPageRevisions,
  writeHerbalistConfig,
} from '../sync-engine';
import type { VersionHistorySettings } from '../settings';

// ---------------------------------------------------------------------------
// Minimal in-memory vault adapter
// ---------------------------------------------------------------------------

function makeMockVault() {
  const files = new Map<string, string>();

  const adapter = {
    read: vi.fn(async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`Not found: ${p}`);
      return c;
    }),
    write: vi.fn(async (p: string, c: string) => { files.set(p, c); }),
    remove: vi.fn(async (p: string) => { files.delete(p); }),
    mkdir: vi.fn(async () => {}),
    exists: vi.fn(async (p: string) => files.has(p)),
    list: vi.fn(async (dir: string) => {
      const dirFiles: string[] = [];
      const subdirs = new Set<string>();
      for (const key of files.keys()) {
        if (!key.startsWith(dir + '/')) continue;
        const rest = key.slice(dir.length + 1);
        if (!rest.includes('/')) {
          dirFiles.push(key);
        } else {
          subdirs.add(dir + '/' + rest.split('/')[0]);
        }
      }
      return { files: dirFiles, folders: [...subdirs] };
    }),
  };

  return { vault: { adapter } as unknown as Vault, files, adapter };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_VH: VersionHistorySettings = {
  enabled: true,
  maxVersions: 10,
  archiveFolder: '.confluence',
};

function makeClient() {
  return new ConfluenceClient('https://org.atlassian.net', 'user@x', 'tok');
}

// ---------------------------------------------------------------------------
// syncRevisions
// ---------------------------------------------------------------------------

describe('syncRevisions', () => {
  let client: ConfluenceClient;

  beforeEach(() => {
    client = makeClient();
  });

  it('writes revision files to the correct paths with correct frontmatter', async () => {
    vi.spyOn(client, 'getPageVersions').mockResolvedValue([
      { number: 3, createdAt: '2025-11-03T14:00:00.000Z', authorId: 'user:abc' },
      { number: 2, createdAt: '2025-10-01T10:00:00.000Z', authorId: 'user:abc' },
    ]);

    const { vault, files } = makeMockVault();

    await syncRevisions(
      vault, client,
      '98765',
      'Engineering/Architecture/Auth-Service.md',
      'Engineering',
      DEFAULT_VH,
      'https://org.atlassian.net',
      'ENG'
    );

    const v3path = 'Engineering/.confluence/Architecture/Auth-Service.v3.md';
    const v2path = 'Engineering/.confluence/Architecture/Auth-Service.v2.md';
    expect(files.has(v3path)).toBe(true);
    expect(files.has(v2path)).toBe(true);

    const v3 = files.get(v3path)!;
    expect(v3).toContain('confluence-id: "98765"');
    expect(v3).toContain('revision-epoch:');
    expect(v3).toContain('revision-date: "2025-11-03T14:00:00.000Z"');
    expect(v3).toContain('revision-author-id: "user:abc"');
    expect(v3).toContain('archive-of: "[[Engineering/Architecture/Auth-Service]]"');
    expect(v3).toContain('confluence-url:');
    expect(v3).toContain('read-only: true');
    // Body must be empty (frontmatter only)
    expect(v3.replace(/^---[\s\S]*?---\n/, '')).toBe('');
  });

  it('respects a custom archiveFolder setting', async () => {
    vi.spyOn(client, 'getPageVersions').mockResolvedValue([
      { number: 2, createdAt: '2025-11-01T00:00:00.000Z', authorId: '' },
    ]);

    const { vault, files } = makeMockVault();
    const vhSettings: VersionHistorySettings = { ...DEFAULT_VH, archiveFolder: '_history' };

    await syncRevisions(
      vault, client,
      '111',
      'Docs/Guide.md',
      'Docs',
      vhSettings,
      'https://org.atlassian.net',
      'ENG'
    );

    expect(files.has('Docs/_history/Guide.v2.md')).toBe(true);
    expect(files.has('Docs/.confluence/Guide.v2.md')).toBe(false);
  });

  it('does not write revision files when there is only one version (v1)', async () => {
    vi.spyOn(client, 'getPageVersions').mockResolvedValue([
      { number: 1, createdAt: '2025-01-01T00:00:00.000Z', authorId: '' },
    ]);

    const { vault, adapter } = makeMockVault();

    await syncRevisions(
      vault, client,
      '42',
      'Space/Page.md',
      'Space',
      DEFAULT_VH,
      'https://org.atlassian.net',
      'ENG'
    );

    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('does not write revision files when maxVersions is 0', async () => {
    const getSpy = vi.spyOn(client, 'getPageVersions');
    const { vault, adapter } = makeMockVault();
    const vhSettings: VersionHistorySettings = { ...DEFAULT_VH, maxVersions: 0 };

    await syncRevisions(vault, client, '42', 'Space/Page.md', 'Space', vhSettings, 'https://org.atlassian.net', 'ENG');

    expect(getSpy).not.toHaveBeenCalled();
    expect(adapter.write).not.toHaveBeenCalled();
  });

  it('removes stale revision files for versions no longer returned by the API', async () => {
    vi.spyOn(client, 'getPageVersions').mockResolvedValue([
      { number: 5, createdAt: '2025-12-01T00:00:00.000Z', authorId: '' },
    ]);

    const { vault, files, adapter } = makeMockVault();
    // Pre-populate a stale v3 file
    files.set('Sync/.confluence/Page.v3.md', '---\nconfluence-id: "7"\n---\n');

    await syncRevisions(
      vault, client,
      '7',
      'Sync/Page.md',
      'Sync',
      DEFAULT_VH,
      'https://org.atlassian.net',
      'ENG'
    );

    expect(files.has('Sync/.confluence/Page.v5.md')).toBe(true);
    // stale v3 should be removed
    expect(adapter.remove).toHaveBeenCalledWith('Sync/.confluence/Page.v3.md');
  });

  it('logs a warning and does not throw when the versions API fails', async () => {
    vi.spyOn(client, 'getPageVersions').mockRejectedValue(new Error('403 Forbidden'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { vault, adapter } = makeMockVault();

    await expect(
      syncRevisions(vault, client, '9', 'Space/Page.md', 'Space', DEFAULT_VH, 'https://org.atlassian.net', 'ENG')
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[Confluence Vault Sync]'), expect.any(Error));
    expect(adapter.write).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('revision-epoch in revision files is the Unix epoch of createdAt', async () => {
    const createdAt = '2025-11-03T14:22:00.000Z';
    vi.spyOn(client, 'getPageVersions').mockResolvedValue([
      { number: 2, createdAt, authorId: '' },
    ]);

    const { vault, files } = makeMockVault();

    await syncRevisions(vault, client, '1', 'Space/Page.md', 'Space', DEFAULT_VH, 'https://org.atlassian.net', 'ENG');

    const content = files.get('Space/.confluence/Page.v2.md')!;
    const expectedEpoch = Math.floor(new Date(createdAt).getTime() / 1000);
    expect(content).toContain(`revision-epoch: ${expectedEpoch}`);
  });
});

// ---------------------------------------------------------------------------
// cleanDeletedPageRevisions
// ---------------------------------------------------------------------------

describe('cleanDeletedPageRevisions', () => {
  it('removes revision files whose confluence-id is not in the valid page set', async () => {
    const { vault, files, adapter } = makeMockVault();
    files.set('Sync/.confluence/Old.v2.md', '---\nconfluence-id: "deleted-page"\n---\n');
    files.set('Sync/.confluence/Current.v3.md', '---\nconfluence-id: "active-page"\n---\n');

    await cleanDeletedPageRevisions(vault, 'Sync/.confluence', new Set(['active-page']));

    expect(adapter.remove).toHaveBeenCalledWith('Sync/.confluence/Old.v2.md');
    expect(adapter.remove).not.toHaveBeenCalledWith('Sync/.confluence/Current.v3.md');
  });

  it('does nothing when archive folder does not exist', async () => {
    const { vault, adapter } = makeMockVault();
    await expect(
      cleanDeletedPageRevisions(vault, 'Sync/.confluence', new Set(['p1']))
    ).resolves.toBeUndefined();
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// writeHerbalistConfig
// ---------------------------------------------------------------------------

describe('writeHerbalistConfig', () => {
  it('writes .herbalist.yaml at the sync folder root', async () => {
    const { vault, files } = makeMockVault();
    await writeHerbalistConfig(vault, 'Engineering');
    const content = files.get('Engineering/.herbalist.yaml')!;
    expect(content).toContain('resource_key: confluence-id');
    expect(content).toContain('revision_key: revision-epoch');
  });
});
