import { ItemView, WorkspaceLeaf } from 'obsidian';
import type { ChildProcess } from 'child_process';
import type ConfluenceVaultSyncPlugin from '../main';
import { resolveHerbalistDbPath } from './herbalist';

export const HERBALIST_VIEW_TYPE = 'herbalist-query';

interface SearchResult {
  path: string;
  section: string;
  snippet: string;
  score: number;
}

export class HerbalistView extends ItemView {
  private plugin: ConfluenceVaultSyncPlugin;
  private serveProcess: ChildProcess | null = null;
  private pendingRequests = new Map<number, (result: unknown) => void>();
  private nextId = 1;
  private initialized = false;
  private stdoutBuffer = '';

  constructor(leaf: WorkspaceLeaf, plugin: ConfluenceVaultSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return HERBALIST_VIEW_TYPE; }
  getDisplayText(): string { return 'Confluence Search'; }
  getIcon(): string { return 'search'; }

  async onOpen(): Promise<void> {
    this.buildUI();
    this.spawnServe();
  }

  async onClose(): Promise<void> {
    this.killServe();
  }

  private buildUI(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('cvs-herbalist-container');

    const inputRow = container.createDiv({ cls: 'cvs-herbalist-input-row' });
    const inputEl = inputRow.createEl('input', {
      type: 'text',
      cls: 'cvs-herbalist-input',
      placeholder: 'Search Confluence notes…',
    });
    const searchBtn = inputRow.createEl('button', { text: 'Search', cls: 'cvs-herbalist-btn' });

    const resultsEl = container.createDiv({ cls: 'cvs-herbalist-results' });

    const doSearch = async (): Promise<void> => {
      const query = inputEl.value.trim();
      if (!query) return;
      resultsEl.empty();
      resultsEl.createDiv({ cls: 'cvs-herbalist-loading', text: 'Searching…' });
      try {
        const raw = await this.callTool('search_notes', { query, top_k: 10 });
        resultsEl.empty();
        const results = parseSearchResults(raw);
        if (results.length === 0) {
          resultsEl.createDiv({ cls: 'cvs-herbalist-empty', text: 'No results.' });
          return;
        }
        for (const r of results) {
          const row = resultsEl.createDiv({ cls: 'cvs-herbalist-result-row' });
          const title = r.path.split('/').pop()?.replace(/\.md$/, '') ?? r.path;
          row.createDiv({ cls: 'cvs-herbalist-result-title', text: title });
          if (r.snippet) {
            row.createDiv({ cls: 'cvs-herbalist-result-snippet', text: r.snippet });
          }
          row.addEventListener('click', () => {
            void this.app.workspace.openLinkText(r.path, '', false);
          });
        }
      } catch (err) {
        resultsEl.empty();
        const msg = err instanceof Error ? err.message : String(err);
        resultsEl.createDiv({ cls: 'cvs-herbalist-error', text: `Error: ${msg}` });
      }
    };

    searchBtn.addEventListener('click', () => void doSearch());
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') void doSearch(); });
  }

  private spawnServe(): void {
    if (!this.plugin.settings.herbalistEnabled) return;

    const { spawn } = require('child_process') as typeof import('child_process');
    const { FileSystemAdapter } = require('obsidian') as typeof import('obsidian');

    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const vaultRoot = adapter.getBasePath();
    const dbPath = resolveHerbalistDbPath(vaultRoot, this.plugin.settings.herbalistIndexScope);
    const bin = this.plugin.settings.herbalistBinaryPath || 'herbalist-mcp';

    const proc = spawn(bin, ['serve', '--vault', vaultRoot, '--db', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stderr?.on('data', (d: Buffer) => console.warn('[herbalist]', d.toString()));

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed) as { id?: number; result?: unknown; error?: unknown };
          if (msg.id != null) {
            const resolve = this.pendingRequests.get(msg.id);
            if (resolve) {
              this.pendingRequests.delete(msg.id);
              resolve(msg.error ? Promise.reject(msg.error) : msg.result);
            }
          }
        } catch { /* non-JSON lines */ }
      }
    });

    proc.on('exit', (code: number | null) => {
      console.warn('[herbalist] serve process exited with code', code);
      this.serveProcess = null;
      this.initialized = false;
    });

    this.serveProcess = proc;
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    await this.send({
      jsonrpc: '2.0', id: 0, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'confluence-vault-sync', version: '1' },
      },
    });
    this.sendNotification({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.initialized = true;
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.serveProcess) this.spawnServe();
    if (!this.initialized) await this.initialize();
    return this.send({
      jsonrpc: '2.0',
      id: this.nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    });
  }

  private send(msg: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = msg.id as number;
      this.pendingRequests.set(id, (result) => {
        if (result instanceof Promise) result.then(resolve).catch(reject);
        else resolve(result);
      });
      this.serveProcess?.stdin?.write(JSON.stringify(msg) + '\n');
    });
  }

  private sendNotification(msg: Record<string, unknown>): void {
    this.serveProcess?.stdin?.write(JSON.stringify(msg) + '\n');
  }

  killServe(): void {
    this.serveProcess?.kill();
    this.serveProcess = null;
    this.initialized = false;
    this.pendingRequests.clear();
  }
}

function parseSearchResults(raw: unknown): SearchResult[] {
  try {
    if (typeof raw === 'object' && raw !== null && 'content' in raw) {
      const content = (raw as { content: Array<{ type: string; text: string }> }).content;
      if (Array.isArray(content) && content[0]?.type === 'text') {
        return JSON.parse(content[0].text) as SearchResult[];
      }
    }
  } catch { /* fall through */ }
  return [];
}
