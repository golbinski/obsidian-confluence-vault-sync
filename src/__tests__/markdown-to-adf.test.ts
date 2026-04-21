import { describe, it, expect } from 'vitest';
import { markdownToAdf } from '../markdown-to-adf';
import type { AttachmentIndex } from '../markdown-to-adf';
import type { AdfNode } from '../confluence-client';

const noIndex = new Map<string, string>();

function convert(md: string) {
  return markdownToAdf(md, noIndex, '').content;
}

function firstNode(md: string): AdfNode {
  return convert(md)[0];
}

function convertWithAttachments(md: string, attachments: AttachmentIndex) {
  return markdownToAdf(md, noIndex, '', attachments).content;
}

describe('markdownToAdf', () => {
  describe('block elements', () => {
    it('converts a paragraph', () => {
      const node = firstNode('Hello world');
      expect(node.type).toBe('paragraph');
      expect(node.content?.[0]).toMatchObject({ type: 'text', text: 'Hello world' });
    });

    it('converts headings h1–h6', () => {
      for (let level = 1; level <= 6; level++) {
        const node = firstNode(`${'#'.repeat(level)} Title`);
        expect(node.type).toBe('heading');
        expect(node.attrs?.level).toBe(level);
        expect(node.content?.[0]).toMatchObject({ type: 'text', text: 'Title' });
      }
    });

    it('converts a fenced code block without language', () => {
      const node = firstNode('```\nconst x = 1;\n```');
      expect(node.type).toBe('codeBlock');
      expect(node.attrs?.language).toBeNull();
      expect(node.content?.[0]).toMatchObject({ type: 'text', text: 'const x = 1;' });
    });

    it('converts a fenced code block with language', () => {
      const node = firstNode('```typescript\nconst x = 1;\n```');
      expect(node.type).toBe('codeBlock');
      expect(node.attrs?.language).toBe('typescript');
    });

    it('converts a horizontal rule (---)', () => {
      expect(firstNode('---').type).toBe('rule');
    });

    it('converts a horizontal rule (***)', () => {
      expect(firstNode('***').type).toBe('rule');
    });

    it('converts a blockquote', () => {
      const node = firstNode('> quoted text');
      expect(node.type).toBe('blockquote');
      expect(node.content?.[0].type).toBe('paragraph');
    });
  });

  describe('lists', () => {
    it('converts a bullet list', () => {
      const node = firstNode('- one\n- two');
      expect(node.type).toBe('bulletList');
      expect(node.content).toHaveLength(2);
      expect(node.content?.[0].type).toBe('listItem');
    });

    it('converts an ordered list', () => {
      const node = firstNode('1. first\n2. second');
      expect(node.type).toBe('orderedList');
      expect(node.content).toHaveLength(2);
    });

    it('converts a nested list', () => {
      const md = '- parent\n  - child';
      const node = firstNode(md);
      expect(node.type).toBe('bulletList');
      const parentItem = node.content?.[0];
      const nestedList = parentItem?.content?.find((n) => n.type === 'bulletList');
      expect(nestedList).toBeDefined();
      expect(nestedList?.content?.[0].type).toBe('listItem');
    });
  });

  describe('table', () => {
    it('converts a table, skipping the separator row', () => {
      const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
      const node = firstNode(md);
      expect(node.type).toBe('table');
      // Two data rows (header + body), separator stripped
      expect(node.content).toHaveLength(2);
      expect(node.content?.[0].type).toBe('tableRow');
      expect(node.content?.[0].content?.[0].type).toBe('tableHeader');
      expect(node.content?.[1].content?.[0].type).toBe('tableCell');
    });
  });

  describe('inline marks', () => {
    it('converts bold **text**', () => {
      const [node] = firstNode('**bold**').content ?? [];
      expect(node.marks?.[0].type).toBe('strong');
      expect(node.text).toBe('bold');
    });

    it('converts italic *text*', () => {
      const [node] = firstNode('*italic*').content ?? [];
      expect(node.marks?.[0].type).toBe('em');
    });

    it('converts italic _text_', () => {
      const [node] = firstNode('_italic_').content ?? [];
      expect(node.marks?.[0].type).toBe('em');
    });

    it('converts bold+italic ***text***', () => {
      const [node] = firstNode('***both***').content ?? [];
      const types = node.marks?.map((m) => m.type);
      expect(types).toContain('strong');
      expect(types).toContain('em');
    });

    it('converts strikethrough ~~text~~', () => {
      const [node] = firstNode('~~gone~~').content ?? [];
      expect(node.marks?.[0].type).toBe('strike');
    });

    it('converts inline code `text`', () => {
      const [node] = firstNode('`code`').content ?? [];
      expect(node.marks?.[0].type).toBe('code');
    });

    it('converts a markdown link', () => {
      const [node] = firstNode('[click](https://example.com)').content ?? [];
      expect(node.marks?.[0].type).toBe('link');
      expect(node.marks?.[0].attrs?.href).toBe('https://example.com');
      expect(node.text).toBe('click');
    });
  });

  describe('table of contents', () => {
    it('converts [TOC] to an ADF toc extension node', () => {
      const [node] = convert('[TOC]');
      expect(node.type).toBe('extension');
      expect(node.attrs?.extensionKey).toBe('toc');
      expect(node.attrs?.extensionType).toBe('com.atlassian.confluence.macro.core');
    });

    it('[TOC] followed by text produces two separate nodes', () => {
      const nodes = convert('[TOC]\n\nSome heading');
      expect(nodes[0].type).toBe('extension');
      expect(nodes[1].type).toBe('paragraph');
    });

    it('[TOC] inside a paragraph is not treated as a block element', () => {
      // inline [TOC] — treated as plain text in a paragraph
      const [node] = convert('See [TOC] above');
      expect(node.type).toBe('paragraph');
    });

    it('converts ```table-of-contents``` fence to a toc extension node', () => {
      const [node] = convert('```table-of-contents\n```');
      expect(node.type).toBe('extension');
      expect(node.attrs?.extensionKey).toBe('toc');
      expect(node.attrs?.extensionType).toBe('com.atlassian.confluence.macro.core');
    });

    it('```table-of-contents``` fence followed by text produces two separate nodes', () => {
      const nodes = convert('```table-of-contents\n```\n\nSome text');
      expect(nodes[0].type).toBe('extension');
      expect(nodes[1].type).toBe('paragraph');
    });
  });

  describe('wikilinks', () => {
    it('converts [[wikilink]] to inlineCard when page is in index', () => {
      const index = new Map([['My Page', 'https://org.atlassian.net/wiki/spaces/ENG/pages/42']]);
      const nodes = markdownToAdf('[[My Page]]', index, '').content;
      const inline = nodes[0].content?.[0];
      expect(inline?.type).toBe('inlineCard');
      expect(inline?.attrs?.url).toBe('https://org.atlassian.net/wiki/spaces/ENG/pages/42');
    });

    it('converts [[wikilink]] to plain text when page is not in index', () => {
      const nodes = markdownToAdf('[[Unknown Page]]', noIndex, '').content;
      const inline = nodes[0].content?.[0];
      expect(inline?.type).toBe('text');
      expect(inline?.text).toBe('Unknown Page');
    });

    it('ignores alias portion [[page|alias]]', () => {
      const index = new Map([['Page', 'https://example.com/1']]);
      const nodes = markdownToAdf('[[Page|My Alias]]', index, '').content;
      expect(nodes[0].content?.[0]?.type).toBe('inlineCard');
    });
  });

  describe('images', () => {
    const att: AttachmentIndex = new Map([
      ['chart.png', { mediaId: 'uuid-abc', collection: 'contentId-123' }],
    ]);

    it('converts ![[filename]] to a mediaSingle block when attachment is known', () => {
      const [node] = convertWithAttachments('![[chart.png]]', att);
      expect(node.type).toBe('mediaSingle');
      expect(node.attrs?.layout).toBe('center');
      const media = node.content?.[0];
      expect(media?.type).toBe('media');
      expect(media?.attrs?.id).toBe('uuid-abc');
      expect(media?.attrs?.collection).toBe('contentId-123');
      expect(media?.attrs?.type).toBe('file');
    });

    it('converts standard markdown image to mediaSingle when attachment is known', () => {
      const [node] = convertWithAttachments('![alt text](chart.png)', att);
      expect(node.type).toBe('mediaSingle');
      expect(node.content?.[0].attrs?.id).toBe('uuid-abc');
    });

    it('omits ![[filename]] when attachment is not in index', () => {
      const nodes = convertWithAttachments('![[unknown.png]]', att);
      expect(nodes).toHaveLength(0);
    });

    it('omits standard image when attachment is not in index', () => {
      const nodes = convertWithAttachments('![alt](unknown.png)', att);
      expect(nodes).toHaveLength(0);
    });

    it('handles path prefix in wiki embed — uses only the filename part', () => {
      const index: AttachmentIndex = new Map([
        ['chart.png', { mediaId: 'uuid-xyz', collection: 'contentId-999' }],
      ]);
      const [node] = convertWithAttachments('![[attachments/chart.png]]', index);
      expect(node.type).toBe('mediaSingle');
      expect(node.content?.[0].attrs?.id).toBe('uuid-xyz');
    });

    it('renders image and following paragraph as separate top-level nodes', () => {
      const nodes = convertWithAttachments('![[chart.png]]\n\nSome text', att);
      expect(nodes).toHaveLength(2);
      expect(nodes[0].type).toBe('mediaSingle');
      expect(nodes[1].type).toBe('paragraph');
    });

    it('renders nothing for images when no attachment index is provided', () => {
      // No attachment index → all images silently omitted
      const nodes = convert('![[chart.png]]');
      expect(nodes).toHaveLength(0);
    });

    it('does not add image to attachment index mid-document (index is read-only)', () => {
      // Two images: one known, one unknown — only the known one appears
      const nodes = convertWithAttachments('![[chart.png]]\n\n![[other.png]]', att);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].type).toBe('mediaSingle');
    });
  });

  describe('output structure', () => {
    it('returns a valid ADF document envelope', () => {
      const doc = markdownToAdf('hello', noIndex, '');
      expect(doc.version).toBe(1);
      expect(doc.type).toBe('doc');
      expect(Array.isArray(doc.content)).toBe(true);
    });

    it('ignores blank lines', () => {
      const nodes = convert('\n\n\n');
      expect(nodes).toHaveLength(0);
    });
  });
});
