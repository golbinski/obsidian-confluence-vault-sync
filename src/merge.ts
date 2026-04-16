import { diff3Merge } from 'node-diff3';

export interface MergeResult {
  merged: string;
  hasConflicts: boolean;
}

/**
 * Three-way merge of Markdown bodies.
 *
 * @param base   Content at the time the page was unlocked (common ancestor).
 * @param local  Current local edits.
 * @param remote Current remote content (from Confluence).
 *
 * On a clean merge the result is the merged text.
 * On conflicts the result contains standard diff3 conflict markers:
 *   <<<<<<< local … ======= … >>>>>>> confluence
 */
export function mergeMarkdown(base: string, local: string, remote: string): MergeResult {
  const chunks = diff3Merge(
    local.split('\n'),
    base.split('\n'),
    remote.split('\n'),
    { excludeFalseConflicts: true }
  );

  const lines: string[] = [];
  let hasConflicts = false;

  for (const chunk of chunks) {
    if ('ok' in chunk) {
      lines.push(...chunk.ok);
    } else {
      hasConflicts = true;
      lines.push('<<<<<<< local');
      lines.push(...chunk.conflict.a);
      lines.push('=======');
      lines.push(...chunk.conflict.b);
      lines.push('>>>>>>> confluence');
    }
  }

  return { merged: lines.join('\n'), hasConflicts };
}
