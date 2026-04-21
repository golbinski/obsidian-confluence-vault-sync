import * as path from 'path';
import { existsSync } from 'fs';
import { Notice } from 'obsidian';
import type ConfluenceVaultSyncPlugin from '../main';

export function resolveHerbalistDbPath(vaultRoot: string, scope: 'vault' | 'confluence'): string {
  const name = scope === 'confluence' ? '.herbalist-cvs.db' : '.herbalist.db';
  return path.join(vaultRoot, name);
}

export function detectHerbalistBinary(): string {
  const os = require('os') as typeof import('os');
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'herbalist-mcp'),
    '/usr/local/bin/herbalist-mcp',
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export function runHerbalistIndex(plugin: ConfluenceVaultSyncPlugin, vaultRoot: string): void {
  const { settings } = plugin;
  if (!settings.herbalistEnabled) return;

  const { spawn } = require('child_process') as typeof import('child_process');
  const dbPath = resolveHerbalistDbPath(vaultRoot, settings.herbalistIndexScope);

  if (!existsSync(dbPath)) {
    new Notice('Herbalist: downloading embedding model (~130 MB on first run), this may take a minute…', 10000);
  }

  const args = ['index', '--vault', vaultRoot, '--db', dbPath, '--model', settings.herbalistModel];

  if (settings.herbalistIndexScope === 'confluence') {
    for (const target of settings.syncTargets) {
      if (target.syncFolderPath) {
        args.push('--include', target.syncFolderPath);
      }
    }
  }

  const bin = settings.herbalistBinaryPath || 'herbalist-mcp';
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  proc.stdout?.on('data', (d: Buffer) => console.log('[herbalist]', d.toString().trimEnd()));
  proc.stderr?.on('data', (d: Buffer) => console.warn('[herbalist]', d.toString().trimEnd()));
  proc.on('exit', (code: number | null) => {
    if (code !== 0 && code !== null) {
      new Notice('Herbalist reindex failed — see developer console');
    }
  });
}
