/**
 * Volume-world benchmark: world build time, physics query cost, and tile
 * meshing cost per LOD (what the worker does).
 * Usage: npx vite-node scripts/bench-volume.ts [arches|islands]
 */
import { Vec3 } from '../src/sim';
import { buildWorld } from '../src/world/recipes';
import { VolumeMesher } from '../src/world/volumeMesh';
import type { VolumeWorld } from '../src/world/volume';

const id = process.argv[2] ?? 'arches';
let t = performance.now();
const w = buildWorld(id, 1) as VolumeWorld;
console.log(id, 'build', (performance.now() - t).toFixed(1), 'ms', w.stats, 'openings', w.openings.length);
const p = new Vec3();
t = performance.now();
let s = 0;
for (let i = 0; i < 200000; i++) { p.set((i * 7.31) % 640, (i * 0.37) % 60, (i * 3.17) % 640); s += w.distance(p); }
console.log('distance', ((performance.now() - t) / 200).toFixed(3), 'us/eval');
console.log('spawn', w.spawn, 'd at spawn+1', w.distance(new Vec3(w.spawn.x, w.spawn.y + 1, w.spawn.z)));
const m = new VolumeMesher(w);
for (const lod of [2, 1, 0]) {
  let tris = 0, evals = 0, maxSlice = 0;
  t = performance.now();
  for (let tz = 0; tz < 5; tz++) for (let tx = 0; tx < 5; tx++) {
    m.start(tx, tz, lod);
    for (;;) { const a = performance.now(); const done = m.step(); maxSlice = Math.max(maxSlice, performance.now() - a); if (done) break; }
    tris += m.result!.triangles; evals += m.evals;
  }
  console.log(`lod ${lod}: ${((performance.now() - t) / 25).toFixed(1)} ms/tile, ${(tris / 25 / 1000).toFixed(1)}k tris/tile, ${(evals / 25 / 1000).toFixed(0)}k evals/tile, max slice ${maxSlice.toFixed(2)} ms`);
}
