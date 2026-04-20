import { describe, it, expect } from 'vitest';
import { AdfConverter } from '../adf-converter';
import type { AdfNode } from '../confluence-client';

function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', content };
}

function p(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function text(t: string, ...marks: { type: string; attrs?: Record<string, unknown> }[]): AdfNode {
  return marks.length ? { type: 'text', text: t, marks } : { type: 'text', text: t };
}

const converter = new AdfConverter(new Map(), 'https://example.atlassian.net');

describe('AdfConverter', () => {
  describe('block nodes', () => {
    it('renders a paragraph', () => {
      expect(converter.convert(doc(p(text('Hello'))))).toBe('Hello\n\n');
    });

    it('renders headings h1–h6', () => {
      for (let level = 1; level <= 6; level++) {
        const node = doc({ type: 'heading', attrs: { level }, content: [text('Title')] });
        expect(converter.convert(node)).toBe(`${'#'.repeat(level)} Title\n\n`);
      }
    });

    it('caps heading level at 6', () => {
      const node = doc({ type: 'heading', attrs: { level: 9 }, content: [text('Deep')] });
      expect(converter.convert(node)).toBe('###### Deep\n\n');
    });

    it('renders a horizontal rule', () => {
      expect(converter.convert(doc({ type: 'rule' }))).toBe('---\n\n');
    });

    it('renders a code block without language', () => {
      const node = doc({ type: 'codeBlock', attrs: {}, content: [text('const x = 1;')] });
      expect(converter.convert(node)).toBe('```\nconst x = 1;\n```\n\n');
    });

    it('renders a code block with language', () => {
      const node = doc({ type: 'codeBlock', attrs: { language: 'typescript' }, content: [text('const x = 1;')] });
      expect(converter.convert(node)).toBe('```typescript\nconst x = 1;\n```\n\n');
    });

    it('renders a blockquote without trailing empty > lines', () => {
      const node = doc({ type: 'blockquote', content: [p(text('quoted'))] });
      const result = converter.convert(node);
      expect(result).toContain('> quoted');
      expect(result).not.toMatch(/^> \s*$/m);
    });

    it('renders an expand as a blockquote', () => {
      const node = doc({
        type: 'expand',
        attrs: { title: 'Details' },
        content: [p(text('body'))],
      });
      const result = converter.convert(node);
      expect(result).toContain('> Details');
      expect(result).toContain('> body');
    });
  });

  describe('inline marks', () => {
    it('renders bold text', () => {
      expect(converter.convert(doc(p(text('hi', { type: 'strong' }))))).toBe('**hi**\n\n');
    });

    it('renders italic text', () => {
      expect(converter.convert(doc(p(text('hi', { type: 'em' }))))).toBe('_hi_\n\n');
    });

    it('renders inline code', () => {
      expect(converter.convert(doc(p(text('foo', { type: 'code' }))))).toBe('`foo`\n\n');
    });

    it('renders strikethrough', () => {
      expect(converter.convert(doc(p(text('gone', { type: 'strike' }))))).toBe('~~gone~~\n\n');
    });

    it('renders an external link', () => {
      const node = doc(p(text('click', { type: 'link', attrs: { href: 'https://example.com' } })));
      expect(converter.convert(node)).toBe('[click](https://example.com)\n\n');
    });
  });

  describe('Confluence link rewriting', () => {
    it('rewrites an inlineCard URL to a wikilink when page is in index', () => {
      const index = new Map([['42', 'confluence/eng/My Page.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const node = doc(p({ type: 'inlineCard', attrs: { url: 'https://org.atlassian.net/wiki/spaces/ENG/pages/42' } }));
      expect(c.convert(node)).toContain('[[My Page]]');
    });

    it('keeps original URL when page is not in index', () => {
      const node = doc(p({ type: 'inlineCard', attrs: { url: 'https://org.atlassian.net/wiki/spaces/ENG/pages/99' } }));
      expect(converter.convert(node)).toContain('https://org.atlassian.net/wiki/spaces/ENG/pages/99');
    });

    it('rewrites a link mark pointing to a Confluence page (same display text)', () => {
      const index = new Map([['7', 'confluence/eng/Setup.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const node = doc(p(text('Setup', { type: 'link', attrs: { href: 'https://org.atlassian.net/wiki/spaces/ENG/pages/7' } })));
      expect(c.convert(node)).toContain('[[Setup|Setup]]');
    });

    it('rewrites a link mark pointing to a Confluence page (custom display text)', () => {
      const index = new Map([['7', 'confluence/eng/Setup.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const node = doc(p(text('Click here', { type: 'link', attrs: { href: 'https://org.atlassian.net/wiki/spaces/ENG/pages/7' } })));
      expect(c.convert(node)).toContain('[[Setup|Click here]]');
    });

    it('wraps a non-Confluence link mark as standard markdown link', () => {
      const node = doc(p(text('Google', { type: 'link', attrs: { href: 'https://google.com' } })));
      expect(converter.convert(node)).toContain('[Google](https://google.com)');
    });

    it('wraps an inlineCard external URL as a clickable markdown link', () => {
      const node = doc(p({ type: 'inlineCard', attrs: { url: 'https://external.example.com/page' } }));
      expect(converter.convert(node)).toContain('[https://external.example.com/page](https://external.example.com/page)');
    });

    it('rewrites a root-relative Confluence URL', () => {
      const index = new Map([['42', 'confluence/eng/My Page.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const node = doc(p({ type: 'inlineCard', attrs: { url: '/wiki/spaces/ENG/pages/42' } }));
      expect(c.convert(node)).toContain('[[My Page]]');
    });

    it('does NOT rewrite an external URL whose path happens to contain /wiki/spaces/...', () => {
      // A malicious or accidental link to an unrelated site with a matching path
      // segment must be preserved verbatim rather than silently converted to a wikilink.
      const index = new Map([['42', 'confluence/eng/My Page.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const external = 'https://evil.example.com/wiki/spaces/ENG/pages/42';
      const node = doc(p(text('click', { type: 'link', attrs: { href: external } })));
      expect(c.convert(node)).toContain(`[click](${external})`);
      expect(c.convert(node)).not.toContain('[[My Page]]');
    });

    it('does NOT rewrite a URL for a different Confluence instance', () => {
      const index = new Map([['42', 'confluence/eng/My Page.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const otherInstance = 'https://other.atlassian.net/wiki/spaces/ENG/pages/42';
      const node = doc(p({ type: 'inlineCard', attrs: { url: otherInstance } }));
      expect(c.convert(node)).toContain(otherInstance);
      expect(c.convert(node)).not.toContain('[[My Page]]');
    });
  });

  describe('lists', () => {
    it('renders a bullet list', () => {
      const node = doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p(text('one'))] },
          { type: 'listItem', content: [p(text('two'))] },
        ],
      });
      const result = converter.convert(node);
      expect(result).toContain('- one');
      expect(result).toContain('- two');
    });

    it('renders an ordered list', () => {
      const node = doc({
        type: 'orderedList',
        content: [
          { type: 'listItem', content: [p(text('first'))] },
          { type: 'listItem', content: [p(text('second'))] },
        ],
      });
      const result = converter.convert(node);
      expect(result).toContain('1. first');
      expect(result).toContain('2. second');
    });

    it('indents nested bullet lists', () => {
      const nested: AdfNode = {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [p(text('child'))] }],
      };
      const node = doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [p(text('parent')), nested] }],
      });
      const result = converter.convert(node);
      expect(result).toContain('  - child');
    });
  });

  describe('table', () => {
    it('renders a table with header separator', () => {
      const node = doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [p(text('A'))] },
              { type: 'tableHeader', content: [p(text('B'))] },
            ],
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [p(text('1'))] },
              { type: 'tableCell', content: [p(text('2'))] },
            ],
          },
        ],
      });
      const result = converter.convert(node);
      expect(result).toContain('| A | B |');
      expect(result).toContain('| --- | --- |');
      expect(result).toContain('| 1 | 2 |');
    });

    it('produces no blank lines inside a multi-row table', () => {
      const node = doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(text('H'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('R1'))] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('R2'))] }] },
        ],
      });
      const result = converter.convert(node);
      expect(result).not.toMatch(/\n\n/);
    });

    it('strips CR and Windows-style line endings from cell content', () => {
      const node = doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(text('H'))] }] },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'line1\r\nline2' }] }],
              },
            ],
          },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('last'))] }] },
        ],
      });
      const result = converter.convert(node);
      expect(result).not.toMatch(/\r/);
      expect(result).not.toMatch(/\n\n/);
      expect(result).toContain('| last |');
    });

    it('strips Unicode line separators (U+2028/U+2029) from cell content', () => {
      // U+2028 (LINE SEPARATOR) survives [\r\n] replace but Chromium treats
      // it as a newline, splitting the table row and breaking Obsidian rendering.
      const node = doc({
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [p(text('H'))] }] },
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'foo\u2028bar' }] }],
              },
            ],
          },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('last'))] }] },
        ],
      });
      const result = converter.convert(node);
      expect(result).not.toContain('\u2028');
      expect(result).not.toMatch(/\n\n/);
      expect(result).toContain('| last |');
    });
  });

  describe('misc inline nodes', () => {
    it('renders a mention', () => {
      const node = doc(p({ type: 'mention', attrs: { text: '@Alice' } }));
      expect(converter.convert(node)).toContain('@Alice');
    });

    it('renders an emoji with text', () => {
      const node = doc(p({ type: 'emoji', attrs: { text: '😀' } }));
      expect(converter.convert(node)).toContain('😀');
    });

    it('renders an emoji with shortName fallback', () => {
      const node = doc(p({ type: 'emoji', attrs: { shortName: ':smile:' } }));
      expect(converter.convert(node)).toContain(':smile:');
    });

    it('renders a hardBreak as newline', () => {
      const node = doc(p(text('a'), { type: 'hardBreak' }, text('b')));
      expect(converter.convert(node)).toContain('a\nb');
    });
  });

  describe('extensions', () => {
    it('renders a toc extension as [TOC]', () => {
      const node = doc({
        type: 'extension',
        attrs: {
          extensionType: 'com.atlassian.confluence.macro.core',
          extensionKey: 'toc',
        },
      });
      expect(converter.convert(node)).toBe('[TOC]\n\n');
    });

    it('renders unknown extension as [key] placeholder when no URL is available', () => {
      const node = doc(
        { type: 'extension', attrs: { extensionType: 'com.example', extensionKey: 'widget' } },
        p(text('after'))
      );
      expect(converter.convert(node)).toBe('[widget]\n\nafter\n\n');
    });

    it('renders known extension key with friendly label and URL', () => {
      const node = doc({
        type: 'extension',
        attrs: {
          extensionType: 'com.lucidchart',
          extensionKey: 'lucidchart',
          parameters: {
            macroParams: {
              url: { value: 'https://lucid.app/chart/abc123' },
            },
          },
        },
      });
      expect(converter.convert(node)).toBe('[Lucidchart](https://lucid.app/chart/abc123)\n\n');
    });

    it('renders inline extension without trailing newlines', () => {
      const node = doc(p({
        type: 'inlineExtension',
        attrs: {
          extensionType: 'com.miro',
          extensionKey: 'miro',
          parameters: { macroParams: { boardUrl: { value: 'https://miro.com/app/board/xyz' } } },
        },
      }));
      expect(converter.convert(node)).toContain('[Miro board](https://miro.com/app/board/xyz)');
    });

    it('renders miro-macro-resizing with boardId param as clickable Miro board link', () => {
      const node = doc({
        type: 'extension',
        attrs: {
          extensionKey: 'miro-macro-resizing',
          parameters: { macroParams: { boardId: { value: 'uXjVIzABcDE=' } } },
        },
      });
      expect(converter.convert(node)).toBe('[Miro board](https://miro.com/app/board/uXjVIzABcDE=)\n\n');
    });

    it('renders miro-macro-resizing with no URL as [Miro board] not raw key', () => {
      const node = doc({
        type: 'extension',
        attrs: { extensionKey: 'miro-macro-resizing', parameters: {} },
      });
      expect(converter.convert(node)).toBe('[Miro board]\n\n');
      expect(converter.convert(node)).not.toContain('miro-macro-resizing');
    });

    it('extracts URL nested inside macroParams value object', () => {
      const node = doc({
        type: 'extension',
        attrs: {
          extensionKey: 'drawio',
          parameters: {
            macroParams: {
              diagramUrl: { value: 'https://draw.io/diagram/abc' },
            },
          },
        },
      });
      expect(converter.convert(node)).toContain('https://draw.io/diagram/abc');
    });
  });
});
