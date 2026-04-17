import { describe, it, expect, vi } from 'vitest';
import { resolveMediaNodes } from '../sync-engine';
import { AdfConverter } from '../adf-converter';
import type { AdfDocument } from '../confluence-client';
import type { MediaHandleResult } from '../image-downloader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(...content: object[]): AdfDocument {
  return { version: 1, type: 'doc', content: content as AdfDocument['content'] };
}

function makeMediaSingleAdf(mediaId: string, collection: string): object {
  return {
    type: 'mediaSingle',
    attrs: { layout: 'center' },
    content: [{
      type: 'media',
      attrs: { id: mediaId, type: 'file', collection },
    }],
  };
}

function makeExtension(name: string): object {
  return { type: 'extension', attrs: { extensionType: 'com.lucidchart', extensionKey: name } };
}

function makeBodiedExtension(): object {
  return {
    type: 'bodiedExtension',
    attrs: { extensionType: 'com.miro', extensionKey: 'board' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'miro content' }] }],
  };
}

function makeInlineExtension(): object {
  return { type: 'inlineExtension', attrs: { extensionType: 'com.drawio', extensionKey: 'diagram' } };
}

/** Mock ImageDownloader that returns configurable results per mediaId. */
function mockDownloader(responses: Record<string, MediaHandleResult>) {
  return {
    handleMedia: vi.fn(async (_pageId: string, mediaId: string, _dir: string): Promise<MediaHandleResult> => {
      const result = responses[mediaId];
      if (!result) throw new Error(`Unexpected mediaId: ${mediaId}`);
      return result;
    }),
  };
}

const realConverter = new AdfConverter(new Map(), 'https://example.atlassian.net');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveMediaNodes', () => {
  describe('attachment tracking', () => {
    it('records downloaded images in the attachments list', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-1', 'contentId-100'));
      const downloader = mockDownloader({
        'uuid-1': { markdown: '![[chart.png]]', filename: 'chart.png', mimeType: 'image/png' },
      });

      const { attachments } = await resolveMediaNodes(adf, '100', '/vault/eng', downloader, realConverter);

      expect(attachments).toHaveLength(1);
      expect(attachments[0]).toEqual({
        mediaId: 'uuid-1',
        collection: 'contentId-100',
        filename: 'chart.png',
        mimeType: 'image/png',
      });
    });

    it('records collection from the ADF media node', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-2', 'contentId-999'));
      const downloader = mockDownloader({
        'uuid-2': { markdown: '![[image.png]]', filename: 'image.png', mimeType: 'image/png' },
      });

      const { attachments } = await resolveMediaNodes(adf, '999', '/vault', downloader, realConverter);

      expect(attachments[0].collection).toBe('contentId-999');
    });

    it('does not add to attachments when download result has no filename (too large / link)', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-3', 'contentId-200'));
      const downloader = mockDownloader({
        'uuid-3': { markdown: '![big.png](https://example.com/big.png)', filename: null, mimeType: null },
      });

      const { attachments } = await resolveMediaNodes(adf, '200', '/vault', downloader, realConverter);

      expect(attachments).toHaveLength(0);
    });

    it('tracks multiple distinct attachments', async () => {
      const adf = makeDoc(
        makeMediaSingleAdf('uuid-a', 'contentId-300'),
        makeMediaSingleAdf('uuid-b', 'contentId-300'),
      );
      const downloader = mockDownloader({
        'uuid-a': { markdown: '![[a.png]]', filename: 'a.png', mimeType: 'image/png' },
        'uuid-b': { markdown: '![[b.jpg]]', filename: 'b.jpg', mimeType: 'image/jpeg' },
      });

      const { attachments } = await resolveMediaNodes(adf, '300', '/vault', downloader, realConverter);

      expect(attachments).toHaveLength(2);
      expect(attachments.map((a) => a.filename)).toEqual(['a.png', 'b.jpg']);
    });

    it('deduplicates the same mediaId appearing multiple times', async () => {
      const adf = makeDoc(
        makeMediaSingleAdf('uuid-dup', 'contentId-400'),
        makeMediaSingleAdf('uuid-dup', 'contentId-400'),
      );
      const downloader = mockDownloader({
        'uuid-dup': { markdown: '![[dup.png]]', filename: 'dup.png', mimeType: 'image/png' },
      });

      const { attachments } = await resolveMediaNodes(adf, '400', '/vault', downloader, realConverter);

      expect(attachments).toHaveLength(1);
      expect(downloader.handleMedia).toHaveBeenCalledTimes(1);
    });

    it('stores [attachment unavailable] markdown on download error, no attachment entry', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-err', 'contentId-500'));
      const downloader = {
        handleMedia: vi.fn().mockRejectedValue(new Error('network error')),
      };

      const { markdown, attachments } = await resolveMediaNodes(adf, '500', '/vault', downloader, realConverter);

      expect(attachments).toHaveLength(0);
      expect(markdown).toContain('[attachment unavailable]');
    });
  });

  describe('unsupported content detection', () => {
    it('returns hasUnsupportedContent: false for plain text content', async () => {
      const adf = makeDoc({ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] });
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(false);
    });

    it('detects extension nodes (Lucid, draw.io, etc.)', async () => {
      const adf = makeDoc(makeExtension('lucidchart'));
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(true);
    });

    it('detects bodiedExtension nodes (Miro, etc.)', async () => {
      const adf = makeDoc(makeBodiedExtension());
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(true);
    });

    it('detects inlineExtension nodes', async () => {
      const adf = makeDoc(
        { type: 'paragraph', content: [makeInlineExtension()] }
      );
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(true);
    });

    it('does NOT flag toc extension as unsupported', async () => {
      const adf = makeDoc({
        type: 'extension',
        attrs: {
          extensionType: 'com.atlassian.confluence.macro.core',
          extensionKey: 'toc',
        },
      });
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(false);
    });

    it('flags an unknown extension key as unsupported', async () => {
      const adf = makeDoc({
        type: 'extension',
        attrs: { extensionType: 'com.example', extensionKey: 'custom-widget' },
      });
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(true);
    });

    it('detects unsupported nodes nested inside other content', async () => {
      const adf = makeDoc({
        type: 'table',
        content: [{
          type: 'tableRow',
          content: [{
            type: 'tableCell',
            content: [makeExtension('nested')],
          }],
        }],
      });
      const { hasUnsupportedContent } = await resolveMediaNodes(
        adf, '1', '/vault', mockDownloader({}), realConverter
      );
      expect(hasUnsupportedContent).toBe(true);
    });

    it('page with images only is not flagged as having unsupported content', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-img', 'contentId-600'));
      const downloader = mockDownloader({
        'uuid-img': { markdown: '![[photo.png]]', filename: 'photo.png', mimeType: 'image/png' },
      });
      const { hasUnsupportedContent } = await resolveMediaNodes(adf, '600', '/vault', downloader, realConverter);
      expect(hasUnsupportedContent).toBe(false);
    });
  });

  describe('markdown output', () => {
    it('replaces media node with downloaded image markdown', async () => {
      const adf = makeDoc(makeMediaSingleAdf('uuid-m', 'contentId-700'));
      const downloader = mockDownloader({
        'uuid-m': { markdown: '![[photo.png]]', filename: 'photo.png', mimeType: 'image/png' },
      });

      const { markdown } = await resolveMediaNodes(adf, '700', '/vault', downloader, realConverter);
      expect(markdown).toContain('![[photo.png]]');
    });
  });
});
