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

    it('renders a blockquote', () => {
      const node = doc({ type: 'blockquote', content: [p(text('quoted'))] });
      expect(converter.convert(node)).toContain('> quoted');
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

    it('rewrites a link mark pointing to a Confluence page', () => {
      const index = new Map([['7', 'confluence/eng/Setup.md']]);
      const c = new AdfConverter(index, 'https://org.atlassian.net');
      const node = doc(p(text('Setup', { type: 'link', attrs: { href: 'https://org.atlassian.net/wiki/spaces/ENG/pages/7' } })));
      expect(c.convert(node)).toContain('[[Setup]]');
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

    it('renders unknown extension as [key](url) when a URL is found in macroParams', () => {
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
      expect(converter.convert(node)).toBe('[lucidchart](https://lucid.app/chart/abc123)\n\n');
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
      // inlineExtension inside paragraph — no \n\n suffix on the link itself
      expect(converter.convert(node)).toContain('[miro](https://miro.com/app/board/xyz)');
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
