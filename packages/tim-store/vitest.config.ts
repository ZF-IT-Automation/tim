import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/*.test.ts', 'src/__tests__/*.spec.ts'],
    environment: 'node',
  },
});
