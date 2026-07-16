import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/__tests__/*.test.ts', 'packages/**/src/__tests__/*.spec.ts'],
    exclude: ['**/.worktrees/**'],
  },
});
