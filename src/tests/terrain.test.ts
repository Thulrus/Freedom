import { describe, expect, it } from 'vitest';
import { defaultSimParams, Quad, RcChannels, Vec3 } from '../sim';
import { CHUNK_SIZE, ChunkStreamer, LOD_SEGS, PROP_STRIDE, type Chunk, type ChunkMesh } from '../world/chunks';
import { buildWorld } from '../world/recipes';
import { GRID, PROP_BROADLEAF, PROP_PINE, PROP_ROCK, PROP_SHAPE, TerrainWorld, WATER_LEVEL } from '../world/terrain';

const hills = (seed = 1) => buildWorld('hills', seed) as TerrainWorld;

/** Streamer that just records what is on screen. */
function streamerFor(world: TerrainWorld) {
  const shown = new Set<ChunkMesh>();
  const s = new ChunkStreamer(world, { show: (_c, m) => shown.add(m), hide: (_c, m) => shown.delete(m) });
  return { s, shown };
}

/** Height of a built mesh at chunk-local (lx, lz), interpolated exactly like the GPU draws it. */
function meshHeight(m: ChunkMesh, lx: number, lz: number): number {
  const N = m.segs, n1 = N + 1, sp = CHUNK_SIZE / N;
  const gx = lx / sp, gz = lz / sp;
  const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
  const y = (ii: number, jj: number) => m.positions[(jj * n1 + ii) * 3 + 1];
  if (fx + fz <= 1) return y(i, j) + (y(i + 1, j) - y(i, j)) * fx + (y(i, j + 1) - y(i, j)) * fz;
  return y(i + 1, j + 1) + (y(i, j + 1) - y(i + 1, j + 1)) * (1 - fx) + (y(i + 1, j) - y(i + 1, j + 1)) * (1 - fz);
}

/** A point well inside a prop's solid. */
function insideProp(c: Chunk, i: number): Vec3 {
  const o = i * PROP_STRIDE, P = c.props;
  const kind = P[o], x = P[o + 1] + c.cx * CHUNK_SIZE, y = P[o + 2], z = P[o + 3] + c.cz * CHUNK_SIZE, a = P[o + 4], b = P[o + 5];
  if (kind === PROP_ROCK) return new Vec3(x, y + PROP_SHAPE.rockCenterY * a, z);
  if (kind === PROP_BROADLEAF) return new Vec3(x, y + PROP_SHAPE.broadCrownY * b, z);
  return new Vec3(x, y + 0.4 * b, z);
}

describe('hills terrain', () => {
  it('is deterministic by seed', () => {
    const a = hills(5), b = hills(5), c = hills(6);
    let same = 0, diff = 0;
    for (let k = 0; k < 200; k++) {
      const x = (k * 7919) % 5000 - 2500, z = (k * 104729) % 7000 - 3500;
      if (a.groundHeight(x, z) === b.groundHeight(x, z)) same++;
      // Lakes are flat water in both worlds, so only compare dry ground.
      if (a.groundHeight(x, z) !== c.groundHeight(x, z) || a.groundHeight(x, z) === WATER_LEVEL) diff++;
    }
    expect(same).toBe(200);
    expect(diff).toBeGreaterThan(190);
  });

  it('has varied, sane terrain: lakes, hills and mountains, no NaN', () => {
    const w = hills(1);
    let water = 0, high = 0, min = Infinity, max = -Infinity;
    for (let k = 0; k < 4000; k++) {
      const h = w.groundHeight((k % 63) * 157 - 5000, Math.floor(k / 63) * 157 - 5000);
      expect(Number.isFinite(h)).toBe(true);
      if (h <= WATER_LEVEL) water++;
      if (h > 60) high++;
      min = Math.min(min, h);
      max = Math.max(max, h);
    }
    expect(min).toBe(WATER_LEVEL);
    expect(water / 4000).toBeGreaterThan(0.03);
    expect(water / 4000).toBeLessThan(0.4);
    expect(high).toBeGreaterThan(20);
    expect(max).toBeLessThan(400);
  });

  it('spawn pad is flat, dry and clear of props', () => {
    for (const seed of [1, 2, 3, 99]) {
      const w = hills(seed);
      expect(w.spawn.y).toBeGreaterThan(WATER_LEVEL);
      for (const [x, z] of [[0, 0], [10, 3], [-8, -12], [0, 15]]) expect(w.groundHeight(x, z)).toBeCloseTo(w.spawnHeight, 9);
      const n = new Vec3();
      w.normal(new Vec3(0, w.spawnHeight + 0.1, 0), n);
      expect(n.y).toBeCloseTo(1, 6);
      expect(w.distance(new Vec3(0, w.spawnHeight + 1, 0))).toBeCloseTo(1, 6);
    }
  });

  it('collision surface equals the LOD 0 mesh (what you see is what you hit)', () => {
    const w = hills(3);
    const { s } = streamerFor(w);
    s.update(900, -1300);
    s.prime();
    const c = [...s.active.values()].find((c) => c.ring === 0)!;
    expect(c.mesh!.lod).toBe(0);
    let maxErr = 0;
    for (let k = 0; k < 2000; k++) {
      const lx = ((k * 37) % 1279) / 10, lz = ((k * 91) % 1277) / 10;
      const err = Math.abs(meshHeight(c.mesh!, lx, lz) - w.groundHeight(c.cx * CHUNK_SIZE + lx, c.cz * CHUNK_SIZE + lz));
      maxErr = Math.max(maxErr, err);
    }
    expect(maxErr).toBeLessThan(1e-3); // float32 rounding of the mesh only
  });

  it('every rendered prop is solid to collision, and the field is signed', () => {
    const w = hills(1);
    const { s } = streamerFor(w);
    s.update(0, 0);
    s.prime();
    let props = 0;
    const kinds = new Set<number>();
    for (const c of s.active.values()) {
      if (c.ring > 2) continue;
      expect(c.propsReady).toBe(true);
      for (let i = 0; i < c.propCount; i++) {
        props++;
        kinds.add(c.props[i * PROP_STRIDE]);
        expect(w.distance(insideProp(c, i))).toBeLessThan(0);
      }
    }
    expect(props).toBeGreaterThan(100);
    expect([...kinds].sort()).toEqual([PROP_PINE, PROP_BROADLEAF, PROP_ROCK]);
    // Above and below the open ground.
    const g = w.groundHeight(500, 500);
    expect(w.distance(new Vec3(500, g - 1, 500))).toBeLessThan(0);
  });

  it('raycast straight down lands on the ground or a prop', () => {
    const w = hills(1);
    for (let k = 0; k < 50; k++) {
      const x = k * 53 - 1300, z = k * 31 - 700;
      const hit = w.raycast(new Vec3(x, 500, z), new Vec3(0, -1, 0), 1000);
      expect(hit).not.toBeNull();
      const y = 500 - hit!.distance;
      expect(y).toBeGreaterThan(w.groundHeight(x, z) - 0.01);
      expect(y).toBeLessThan(w.groundHeight(x, z) + 16);
    }
  });

  it('a quad dropped on a slope comes to rest on the surface', () => {
    const w = hills(1);
    const quad = new Quad(defaultSimParams());
    const rc = new RcChannels();
    quad.reset(300, w.groundHeight(300, 200) + 3, 200);
    for (let i = 0; i < 1500; i++) quad.step(rc, w);
    expect(quad.state.pos.y).toBeGreaterThan(w.groundHeight(quad.state.pos.x, quad.state.pos.z));
    expect(quad.state.pos.y - w.groundHeight(quad.state.pos.x, quad.state.pos.z)).toBeLessThan(0.5);
  });
});

describe('chunk streaming', () => {
  it('flies 12 minutes in one direction: no holes, bounded memory, bounded work per frame', () => {
    const w = hills(7);
    const { s, shown } = streamerFor(w);
    s.setDrawDistance(600);
    const speed = 40; // m/s, a fast 5" cruise
    const frames = 12 * 60 * 60;
    const dirX = 0.6, dirZ = -0.8;
    s.update(0, 0);
    s.prime();
    const work: number[] = [];
    let holes = 0, snapshot = '', maxActive = 0;
    for (let f = 0; f < frames; f++) {
      const d = (f / 60) * speed;
      s.update(d * dirX, d * dirZ);
      s.work(2);
      work.push(s.lastWorkMs);
      if (!s.focusReady()) holes++;
      maxActive = Math.max(maxActive, s.active.size);
      if (f === 3 * 60 * 60) snapshot = JSON.stringify(s.created);
    }
    work.sort((a, b) => a - b);
    const p99 = work[Math.floor(work.length * 0.99)];
    // eslint-disable-next-line no-console
    console.log(`streamed ${s.builds} chunk builds over ${((frames / 60) * speed) / 1000} km; work p99 ${p99.toFixed(2)} ms, max ${work[work.length - 1].toFixed(2)} ms; pools ${JSON.stringify(s.created)}; active ≤ ${maxActive}`);
    expect(holes).toBe(0);
    expect(JSON.stringify(s.created)).toBe(snapshot); // nothing allocated after minute 3
    expect(shown.size).toBe([...s.active.values()].filter((c) => c.mesh).length);
    expect(maxActive).toBeLessThan(140);
    expect(p99).toBeLessThan(2.5);
    expect(s.created.meshes[0]).toBeLessThan(20);
    expect(LOD_SEGS[0] * GRID).toBe(CHUNK_SIZE);
  });
});

describe('chunk streaming: teleports', () => {
  it('reuses buffers on a 50 km teleport instead of growing the pools', () => {
    const { s } = streamerFor(hills(2));
    s.update(0, 0);
    s.prime();
    const before = structuredClone(s.created);
    s.update(40000, -30000);
    s.prime();
    expect(s.focusReady()).toBe(true);
    // The draw-distance circle covers a few more or fewer chunks at the new spot, but nothing doubles.
    const after = s.created;
    expect(after.chunks).toBeLessThanOrEqual(before.chunks + 4);
    expect(after.jobs).toBeLessThanOrEqual(before.jobs + 4);
    after.meshes.forEach((n, lod) => expect(n).toBeLessThanOrEqual(before.meshes[lod] + 4));
  });
});

describe('floating origin', () => {
  it('keeps render coordinates small (float32-safe) on a 50 km flight, with exact chunk-aligned jumps', async () => {
    const { FloatingOrigin } = await import('../render/origin');
    const o = new FloatingOrigin();
    let maxRel = 0;
    for (let d = 0; d <= 50000; d += 5) {
      const x = d * 0.8, z = -d * 0.6;
      o.update(x, z);
      maxRel = Math.max(maxRel, Math.abs(x - o.x), Math.abs(z - o.z));
      expect(Math.abs(o.x % CHUNK_SIZE)).toBe(0);
      expect(Math.abs(o.z % CHUNK_SIZE)).toBe(0);
    }
    expect(maxRel).toBeLessThanOrEqual(1024 + 5);
    expect(o.rebases).toBeGreaterThan(30);
    // float32 resolution at the largest render coordinate stays sub-millimetre.
    expect(Math.fround(maxRel + 0.0001) - Math.fround(maxRel)).toBeLessThan(0.001);
  });
});
