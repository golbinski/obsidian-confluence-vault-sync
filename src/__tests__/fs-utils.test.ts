import { describe, it, expect } from 'vitest';
import { extractFrontmatterField, stripFrontmatter } from '../fs-utils';

const SAMPLE = `---
confluence-id: "12345"
confluence-url: "https://example.atlassian.net/wiki/spaces/ENG/pages/12345"
confluence-title: "My Page"
space: "ENG"
last-synced: "2024-01-01T00:00:00.000Z"
read-only: true
---

Page body here.
`;

describe('extractFrontmatterField', () => {
  it('extracts a quoted field value', () => {
    expect(extractFrontmatterField(SAMPLE, 'confluence-id')).toBe('12345');
  });

  it('extracts a URL field value', () => {
    expect(extractFrontmatterField(SAMPLE, 'confluence-url')).toBe(
      'https://example.atlassian.net/wiki/spaces/ENG/pages/12345'
    );
  });

  it('extracts the space field', () => {
    expect(extractFrontmatterField(SAMPLE, 'space')).toBe('ENG');
  });

  it('returns null for a missing field', () => {
    expect(extractFrontmatterField(SAMPLE, 'nonexistent')).toBeNull();
  });

  it('returns null when content has no frontmatter', () => {
    expect(extractFrontmatterField('just plain text', 'confluence-id')).toBeNull();
  });
});

describe('stripFrontmatter', () => {
  it('removes the frontmatter block', () => {
    const result = stripFrontmatter(SAMPLE);
    expect(result).not.toContain('confluence-id');
    expect(result.trim()).toBe('Page body here.');
  });

  it('returns content unchanged when there is no frontmatter', () => {
    const plain = 'No frontmatter here.';
    expect(stripFrontmatter(plain)).toBe(plain);
  });

  it('handles empty body after frontmatter', () => {
    const content = '---\nfield: "value"\n---\n';
    expect(stripFrontmatter(content)).toBe('');
  });
});
