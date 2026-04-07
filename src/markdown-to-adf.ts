import type { AdfDocument, AdfNode, AdfMark } from './confluence-client';

/**
 * Convert Markdown back to an ADF document.
 *
 * @param markdown  Stripped markdown content (no frontmatter).
 * @param pageIndex Maps sanitized filename (no extension) → full Confluence page URL.
 *                  Used to rewrite [[wikilinks]] back to inlineCard nodes.
 * @param baseUrl   Confluence base URL (unused for link generation but kept for symmetry).
 */
export function markdownToAdf(
  markdown: string,
  pageIndex: Map<string, string>,
  _baseUrl: string
): AdfDocument {
  const lines = markdown.split('\n');
  const nodes = parseBlocks(lines, 0, lines.length, pageIndex);
  return { version: 1, type: 'doc', content: nodes };
}

// ---------------------------------------------------------------------------
// Block-level parser
// ---------------------------------------------------------------------------

function parseBlocks(
  lines: string[],
  start: number,
  end: number,
  pageIndex: Map<string, string>
): AdfNode[] {
  const nodes: AdfNode[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i];

    // Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block
    if (line.match(/^```/)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < end && !lines[i].match(/^```\s*$/)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing ```
      nodes.push({
        type: 'codeBlock',
        attrs: { language: lang || null },
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+\s*$/) || line.match(/^\*\*\*+\s*$/) || line.match(/^___+\s*$/)) {
      nodes.push({ type: 'rule' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      nodes.push({
        type: 'heading',
        attrs: { level: headingMatch[1].length },
        content: parseInline(headingMatch[2], pageIndex),
      });
      i++;
      continue;
    }

    // Table
    if (line.match(/^\|/)) {
      const tableLines: string[] = [];
      while (i < end && lines[i].match(/^\|/)) {
        tableLines.push(lines[i]);
        i++;
      }
      const tableNode = parseTable(tableLines, pageIndex);
      if (tableNode) nodes.push(tableNode);
      continue;
    }

    // Blockquote
    if (line.match(/^>\s?/)) {
      const quoteLines: string[] = [];
      while (i < end && lines[i].match(/^>\s?/)) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      nodes.push({
        type: 'blockquote',
        content: parseBlocks(quoteLines, 0, quoteLines.length, pageIndex),
      });
      continue;
    }

    // Lists
    if (line.match(/^(\s*)[-*]\s/) || line.match(/^(\s*)\d+\.\s/)) {
      const { node, consumed } = parseList(lines, i, end, pageIndex, 0);
      nodes.push(node);
      i += consumed;
      continue;
    }

    // Paragraph — collect until blank line
    const paraLines: string[] = [];
    while (i < end && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const inlineContent = parseInline(paraLines.join('\n'), pageIndex);
      if (inlineContent.length > 0) {
        nodes.push({ type: 'paragraph', content: inlineContent });
      }
    }
  }

  return nodes;
}

function isBlockStart(line: string): boolean {
  return !!(
    line.match(/^#{1,6}\s/) ||
    line.match(/^```/) ||
    line.match(/^---+\s*$/) ||
    line.match(/^>\s?/) ||
    line.match(/^(\s*)[-*]\s/) ||
    line.match(/^(\s*)\d+\.\s/) ||
    line.match(/^\|/)
  );
}

// ---------------------------------------------------------------------------
// List parser
// ---------------------------------------------------------------------------

interface ListResult {
  node: AdfNode;
  consumed: number;
}

function parseList(
  lines: string[],
  start: number,
  end: number,
  pageIndex: Map<string, string>,
  depth: number
): ListResult {
  const isOrdered = !!lines[start].match(/^(\s*)\d+\.\s/);
  const listType = isOrdered ? 'orderedList' : 'bulletList';
  const items: AdfNode[] = [];
  let i = start;
  const baseIndent = getIndent(lines[start]);

  while (i < end) {
    const line = lines[i];
    const indent = getIndent(line);

    if (indent < baseIndent && i > start) break;
    if (line.trim() === '') { i++; continue; }

    const bulletMatch = line.match(/^(\s*)[-*]\s(.*)/);
    const orderedMatch = line.match(/^(\s*)\d+\.\s(.*)/);
    const match = bulletMatch ?? orderedMatch;

    if (!match || indent !== baseIndent) break;

    const itemText = match[2];
    const itemInline = parseInline(itemText, pageIndex);
    const itemContent: AdfNode[] = [{ type: 'paragraph', content: itemInline }];

    i++;

    // Collect nested list lines
    const nestedLines: string[] = [];
    while (i < end) {
      const nextIndent = getIndent(lines[i]);
      if (lines[i].trim() === '') { i++; continue; }
      if (nextIndent > baseIndent) {
        nestedLines.push(lines[i]);
        i++;
      } else {
        break;
      }
    }

    if (nestedLines.length > 0) {
      const { node: nestedList } = parseList(nestedLines, 0, nestedLines.length, pageIndex, depth + 1);
      itemContent.push(nestedList);
    }

    items.push({ type: 'listItem', content: itemContent });
  }

  return { node: { type: listType, content: items }, consumed: i - start };
}

function getIndent(line: string): number {
  return line.match(/^(\s*)/)?.[1].length ?? 0;
}

// ---------------------------------------------------------------------------
// Table parser
// ---------------------------------------------------------------------------

function parseTable(
  lines: string[],
  pageIndex: Map<string, string>
): AdfNode | null {
  // Filter out separator rows (---|---|---)
  const dataLines = lines.filter((l) => !l.match(/^\|[\s|:-]+\|$/));
  if (dataLines.length === 0) return null;

  const rows: AdfNode[] = dataLines.map((line, rowIndex) => {
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());

    const cellNodes: AdfNode[] = cells.map((cell) => ({
      type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph', content: parseInline(cell, pageIndex) }],
    }));

    return { type: 'tableRow', content: cellNodes };
  });

  return { type: 'table', content: rows };
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

function parseInline(text: string, pageIndex: Map<string, string>): AdfNode[] {
  const nodes: AdfNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Hard break
    if (remaining.startsWith('\n')) {
      nodes.push({ type: 'hardBreak' });
      remaining = remaining.slice(1);
      continue;
    }

    // Obsidian wiki link [[pagename]] or [[pagename|alias]]
    const wikiMatch = remaining.match(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
    if (wikiMatch) {
      const pageName = wikiMatch[1].trim();
      const url = pageIndex.get(pageName);
      if (url) {
        nodes.push({ type: 'inlineCard', attrs: { url } });
      } else {
        nodes.push({ type: 'text', text: pageName });
      }
      remaining = remaining.slice(wikiMatch[0].length);
      continue;
    }

    // Bold+italic ***text***
    const boldItalicMatch = remaining.match(/^\*\*\*([\s\S]+?)\*\*\*/);
    if (boldItalicMatch) {
      nodes.push(textNode(boldItalicMatch[1], [{ type: 'strong' }, { type: 'em' }]));
      remaining = remaining.slice(boldItalicMatch[0].length);
      continue;
    }

    // Bold **text** or __text__
    const boldMatch = remaining.match(/^\*\*([\s\S]+?)\*\*/) ?? remaining.match(/^__([\s\S]+?)__/);
    if (boldMatch) {
      nodes.push(textNode(boldMatch[1], [{ type: 'strong' }]));
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic *text* or _text_ (single, not double)
    const italicMatch = remaining.match(/^\*((?:[^*])+?)\*/) ?? remaining.match(/^_((?:[^_])+?)_/);
    if (italicMatch) {
      nodes.push(textNode(italicMatch[1], [{ type: 'em' }]));
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Strikethrough ~~text~~
    const strikeMatch = remaining.match(/^~~([\s\S]+?)~~/);
    if (strikeMatch) {
      nodes.push(textNode(strikeMatch[1], [{ type: 'strike' }]));
      remaining = remaining.slice(strikeMatch[0].length);
      continue;
    }

    // Inline code `text`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      nodes.push(textNode(codeMatch[1], [{ type: 'code' }]));
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      nodes.push(textNode(linkMatch[1], [{ type: 'link', attrs: { href: linkMatch[2] } }]));
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Plain text — consume up to next special char
    const plainMatch = remaining.match(/^([\s\S]+?)(?=\[\[|\*\*\*|\*\*|__|\*|_|~~|`|\[|$|\n)/);
    if (plainMatch && plainMatch[1].length > 0) {
      nodes.push({ type: 'text', text: plainMatch[1] });
      remaining = remaining.slice(plainMatch[1].length);
    } else {
      // Fallback: consume one character to avoid infinite loop
      nodes.push({ type: 'text', text: remaining[0] });
      remaining = remaining.slice(1);
    }
  }

  return mergeAdjacentText(nodes);
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return { type: 'text', text, marks };
}

/** Merge consecutive plain text nodes to keep the ADF tidy. */
function mergeAdjacentText(nodes: AdfNode[]): AdfNode[] {
  const result: AdfNode[] = [];
  for (const node of nodes) {
    const prev = result[result.length - 1];
    if (
      node.type === 'text' &&
      prev?.type === 'text' &&
      !node.marks?.length &&
      !prev.marks?.length
    ) {
      prev.text = (prev.text ?? '') + (node.text ?? '');
    } else {
      result.push(node);
    }
  }
  return result;
}
