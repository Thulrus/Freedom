import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/**
 * Emits dist/sw.js with a precache list of every built file plus public/.
 * Tiny and dependency-free on purpose (instead of a PWA plugin).
 */
function serviceWorker(): Plugin {
  return {
    name: 'freedom-service-worker',
    apply: 'build',
    generateBundle(_opts, bundle) {
      const publicFiles = readdirSync('public').filter((f) => statSync(join('public', f)).isFile());
      const files = ['./', ...Object.keys(bundle), ...publicFiles].filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of Object.keys(bundle).sort()) {
        const item = bundle[f];
        hash.update(f).update(item.type === 'chunk' ? item.code : typeof item.source === 'string' ? item.source : Buffer.from(item.source));
      }
      for (const f of publicFiles.sort()) hash.update(f).update(readFileSync(join('public', f)));
      const source = readFileSync('src/platform/sw-template.js', 'utf8')
        .replace('__VERSION__', JSON.stringify(hash.digest('hex').slice(0, 12)))
        .replace('__FILES__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative base: the build works from any path (GitHub Pages, a subfolder, file servers).
  base: './',
  plugins: [serviceWorker()],
  // three.js is ~155 kB gzipped; fine for now (see DEVLOG).
  build: { chunkSizeWarningLimit: 700 },
  // Module workers (the volume-world mesher), so they can share code-split chunks.
  worker: { format: 'es' },
  test: {
    include: ['src/tests/**/*.test.ts'],
    // Real processes, so the allocation test can use node:inspector.
    pool: 'forks',
  },
});
