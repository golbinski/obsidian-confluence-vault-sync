declare module 'node-diff3' {
  type MergeChunk =
    | { ok: string[] }
    | {
        conflict: {
          a: string[];
          aIndex: number;
          o: string[];
          oIndex: number;
          b: string[];
          bIndex: number;
        };
      };

  function diff3Merge(
    a: string[],
    o: string[],
    b: string[],
    options?: { excludeFalseConflicts?: boolean }
  ): MergeChunk[];

  export { diff3Merge };
}
