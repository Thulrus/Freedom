import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SIM_DIR = join(__dirname, '..', 'sim');
const FORBIDDEN_GLOBALS = /\b(window|document|navigator|requestAnimationFrame|localStorage|performance|HTMLElement|Date\.now|Math\.random)\b/;

describe('sim/ module boundary', () => {
  const files = readdirSync(SIM_DIR).filter((f) => f.endsWith('.ts'));

  it('only imports from inside sim/', () => {
    for (const f of files) {
      const src = readFileSync(join(SIM_DIR, f), 'utf8');
      for (const m of src.matchAll(/(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/g)) {
        expect(m[1], `${f} imports ${m[1]}`).toMatch(/^\.\/[\w-]+$/);
      }
    }
  });

  it('uses no browser globals or nondeterministic sources', () => {
    for (const f of files) {
      const code = readFileSync(join(SIM_DIR, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(FORBIDDEN_GLOBALS.exec(code)?.[0], `${f}`).toBeUndefined();
    }
  });
});
