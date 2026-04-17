import { describe, it, expect } from 'vitest';
import { sanitizeAttachmentFilename } from '../writeback-view';

describe('sanitizeAttachmentFilename', () => {
  it('returns a plain filename unchanged', () => {
    expect(sanitizeAttachmentFilename('image.png')).toBe('image.png');
  });

  it('strips directory components using forward slashes', () => {
    expect(sanitizeAttachmentFilename('attachments/image.png')).toBe('image.png');
  });

  it('strips directory components using backslashes', () => {
    expect(sanitizeAttachmentFilename('attachments\\image.png')).toBe('image.png');
  });

  it('rejects path traversal via forward slashes', () => {
    // `.pop()` extracts the last segment, which is the safe basename
    expect(sanitizeAttachmentFilename('../../etc/passwd')).toBe('passwd');
  });

  it('rejects path traversal via backslashes', () => {
    expect(sanitizeAttachmentFilename('..\\..\\etc\\passwd')).toBe('passwd');
  });

  it('rejects a bare dot', () => {
    expect(sanitizeAttachmentFilename('.')).toBeNull();
  });

  it('rejects double dot', () => {
    expect(sanitizeAttachmentFilename('..')).toBeNull();
  });

  it('rejects hidden (dot-prefixed) filenames', () => {
    expect(sanitizeAttachmentFilename('.bashrc')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(sanitizeAttachmentFilename('')).toBeNull();
  });

  it('rejects whitespace-only names', () => {
    expect(sanitizeAttachmentFilename('   ')).toBeNull();
  });

  it('rejects names containing control characters', () => {
    expect(sanitizeAttachmentFilename('evil\x00.png')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeAttachmentFilename('  image.png  ')).toBe('image.png');
  });
});
