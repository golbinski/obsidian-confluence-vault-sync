import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, 'src/__mocks__/obsidian.ts'),
    },
  },
});
