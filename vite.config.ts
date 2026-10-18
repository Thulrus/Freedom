import { defineConfig } from 'vitest/config';

export default defineConfig({
  // three.js is ~155 kB gzipped; fine for now (see DEVLOG).
  build: { chunkSizeWarningLimit: 700 },
  test: {
    include: ['src/tests/**/*.test.ts'],
    // Real processes, so the allocation test can use node:inspector.
    pool: 'forks',
  },
});
