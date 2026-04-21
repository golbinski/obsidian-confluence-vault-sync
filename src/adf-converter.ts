import type { AdfNode, AdfMark } from './confluence-client';

export class AdfConverter {
  private readonly pageIndex: Map<string, string>;
  private readonly baseUrl: string;

  constructor(pageIndex: Map<string, string>, baseUrl: string) {
    this.pageIndex = pageIndex;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  convert(node: AdfNode): string {
    return this.visitNode(node, 0);
  }

  private visitNode(node: AdfNode, listDepth: number): string {
    switch (node.type) {
      case 'doc':
        return this.visitChildren(node, listDepth);

      case 'paragraph':
        return this.visitChildren(node, listDepth) + '\n\n';

      case 'heading': {
        const level = (node.attrs?.level as number) ?? 1;
        const hashes = '#'.repeat(Math.min(level, 6));
        return `${hashes} ${this.visitChildren(node, listDepth)}\n\n`;
      }

      case 'bulletList':
        return this.visitListItems(node, listDepth, false) + '\n';

      case 'orderedList':
        return this.visitListItems(node, listDepth, true) + '\n';

      case 'listItem': {
        const content = this.visitChildren(node, listDepth + 1)
          .replace(/\n\n$/, '')
          .replace(/\n\n/g, '\n');
        return content;
      }

      case 'codeBlock': {
        const lang = (node.attrs?.language as string) ?? '';
        const code = this.visitChildren(node, listDepth);
        return `\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
      }

      case 'blockquote': {
        const inner = this.visitChildren(node, listDepth).trimEnd();
        return inner
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n') + '\n\n';
      }

      case 'rule':
        return '---\n\n';

      case 'table':
        return this.visitTable(node) + '\n';

      case 'text':
        return this.applyMarks(node.text ?? '', node.marks ?? []);

      case 'hardBreak':
        return '\n';

      case 'inlineCard': {
        const url = (node.attrs?.url as string) ?? '';
        const resolved = this.rewriteConfluenceLink(url);
        if (resolved.kind === 'wikilink') return `[[${resolved.target}]]`;
        return `[${resolved.url}](${resolved.url})`;
      }

      case 'mediaSingle':
      case 'media':
        return this.visitChildren(node, listDepth);

      case 'extension':
      case 'bodiedExtension':
      case 'inlineExtension': {
        const key = (node.attrs?.extensionKey as string) ?? 'extension';
        if (key === 'toc') return '[TOC]\n\n';
        // Best-effort: preserve whatever URL lives in the macro params so the
        // embed is at least clickable in Obsidian. Push remains blocked via
        // hasUnsupportedContent — we don't attempt to reconstruct the node.
        const url = extractExtensionUrl(node.attrs?.parameters, key);
        const label = extensionLabel(key);
        const isInline = node.type === 'inlineExtension';
        const link = url ? `[${label}](${url})` : `[${label}]`;
        return isInline ? link : `${link}\n\n`;
      }

      case 'expand': {
        const title = (node.attrs?.title as string) ?? '';
        const inner = this.visitChildren(node, listDepth).trim();
        const lines = [`> ${title}`, ...inner.split('\n').map((l) => `> ${l}`)];
        return lines.join('\n') + '\n\n';
      }

      case 'mention': {
        const name = (node.attrs?.text as string) ?? (node.attrs?.displayName as string) ?? '';
        return `@${name}`;
      }

      case 'emoji': {
        const text = (node.attrs?.text as string) ?? '';
        if (text) return text;
        const shortName = (node.attrs?.shortName as string) ?? '';
        return shortName ? `:${shortName.replace(/:/g, '')}:` : '';
      }

      default:
        return this.visitChildren(node, listDepth);
    }
  }

  private visitChildren(node: AdfNode, listDepth: number): string {
    if (!node.content) return '';
    return node.content.map((child) => this.visitNode(child, listDepth)).join('');
  }

  private visitListItems(node: AdfNode, listDepth: number, ordered: boolean): string {
    const indent = '  '.repeat(listDepth);
    const items = node.content ?? [];
    return items
      .map((item, idx) => {
        const prefix = ordered ? `${idx + 1}. ` : '- ';
        const content = this.visitNode(item, listDepth);
        const lines = content.split('\n');
        const firstLine = `${indent}${prefix}${lines[0]}`;
        const rest = lines
          .slice(1)
          .map((l) => (l.trim() ? `${indent}  ${l}` : l))
          .join('\n');
        return rest ? `${firstLine}\n${rest}` : firstLine;
      })
      .join('\n');
  }

  private visitTable(node: AdfNode): string {
    const rows = node.content ?? [];
    const renderedRows = rows.map((row) => this.visitTableRow(row));
    if (renderedRows.length === 0) return '';

    const lines: string[] = [];
    lines.push(renderedRows[0]);

    // Build separator from first row column count
    const firstRow = rows[0];
    const colCount = firstRow.content?.length ?? 1;
    lines.push('| ' + Array(colCount).fill('---').join(' | ') + ' |');

    for (let i = 1; i < renderedRows.length; i++) {
      lines.push(renderedRows[i]);
    }

    return lines.join('\n');
  }

  private visitTableRow(node: AdfNode): string {
    const cells = node.content ?? [];
    const cellContents = cells.map((cell) => {
      // Collapse all line-terminator characters (including Unicode U+2028/U+2029
      // which Chromium treats as line breaks and would split the table row).
      // Escape remaining | so that wikilinks like [[Page|text]] don't get
      // split across cells — Obsidian recognises [[Page\|text]] correctly.
      const inner = this.visitChildren(cell, 0)
        .replace(/[\r\n\u2028\u2029]+/g, ' ')
        .trim()
        .replace(/\|/g, '\\|');
      return inner;
    });
    return '| ' + cellContents.join(' | ') + ' |';
  }

  private applyMarks(text: string, marks: AdfMark[]): string {
    let result = text;
    for (const mark of marks) {
      switch (mark.type) {
        case 'strong':
          result = `**${result}**`;
          break;
        case 'em':
          result = `_${result}_`;
          break;
        case 'code':
          result = `\`${result}\``;
          break;
        case 'strike':
          result = `~~${result}~~`;
          break;
        case 'link': {
          const href = (mark.attrs?.href as string) ?? '';
          const resolved = this.rewriteConfluenceLink(href);
          if (resolved.kind === 'wikilink') {
            result = `[[${resolved.target}|${result}]]`;
          } else {
            result = `[${result}](${resolved.url})`;
          }
          break;
        }
        case 'subsup':
          // Ignore sub/superscript — just keep text
          break;
        case 'underline':
          // No markdown underline — keep text as-is
          break;
        case 'textColor':
          // No markdown color — keep text as-is
          break;
      }
    }
    return result;
  }

  private rewriteConfluenceLink(url: string): { kind: 'wikilink'; target: string } | { kind: 'url'; url: string } {
    // Only rewrite links that are either root-relative (`/wiki/...`) or
    // absolute against the configured Confluence base URL. Anchored at the
    // start so that unrelated external URLs containing `/wiki/spaces/.../pages/`
    // in their path aren't silently converted into wikilinks.
    const pattern = new RegExp(
      `^(?:${escapeRegex(this.baseUrl)})?/wiki/spaces/[^/]+/pages/(\\d+)`
    );
    const match = url.match(pattern);
    if (match) {
      const pageId = match[1];
      const vaultPath = this.pageIndex.get(pageId);
      if (vaultPath) {
        const target = vaultPath.split('/').pop()?.replace(/\.md$/, '') ?? vaultPath;
        return { kind: 'wikilink', target };
      }
    }
    return { kind: 'url', url };
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Maps extensionKey prefixes to human-readable labels. */
function extensionLabel(key: string): string {
  if (key.startsWith('miro')) return 'Miro board';
  if (key.startsWith('lucidchart')) return 'Lucidchart';
  if (key.startsWith('drawio') || key.startsWith('draw.io')) return 'draw.io';
  if (key.startsWith('figma')) return 'Figma';
  return key;
}

/**
 * Best-effort URL extraction from an ADF extension node's parameters.
 * Scans macroParams values recursively for any string starting with "http".
 * For Miro macros, also constructs the board URL from a boardId parameter.
 * Returns the first URL found, or null if none.
 */
function extractExtensionUrl(parameters: unknown, extensionKey = ''): string | null {
  if (!parameters || typeof parameters !== 'object') return null;

  function scan(obj: unknown): string | null {
    if (typeof obj === 'string' && obj.startsWith('http')) return obj;
    if (typeof obj !== 'object' || obj === null) return null;
    for (const val of Object.values(obj as Record<string, unknown>)) {
      const found = scan(val);
      if (found) return found;
    }
    return null;
  }

  const found = scan(parameters);
  if (found) return found;

  // Miro-specific: board URL can be reconstructed from boardId or contentId param
  if (extensionKey.startsWith('miro')) {
    const params = (parameters as Record<string, unknown>);
    const macroParams = params.macroParams as Record<string, unknown> | undefined;
    if (macroParams) {
      const boardId =
        (macroParams.boardId as Record<string, unknown>)?.value ??
        (macroParams.contentId as Record<string, unknown>)?.value;
      if (typeof boardId === 'string' && boardId) {
        return `https://miro.com/app/board/${boardId}`;
      }
    }
  }

  return null;
}
