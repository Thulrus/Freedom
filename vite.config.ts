import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    // Real processes, so the allocation test can use node:inspector.
    pool: 'forks',
  },
});
