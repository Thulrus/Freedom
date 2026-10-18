import { describe, expect, it } from 'vitest';
import { defaultSimParams, Quad, RcChannels, Vec3 } from '../sim';
import { ChunkStreamer } from '../world/chunks';
import { CityMesh, CityWorld, ITEM_BRIDGE, ITEM_BUILDING, ITEM_STRIDE, MAX_ITEMS, PITCH } from '../world/city';
import { buildWorld } from '../world/recipes';

const city = (seed = 1) => buildWorld('city', seed) as CityWorld;

type Box = { kind: number; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number };
function boxes(w: CityWorld, bx: number, bz: number): Box[] {
  const it = w.blockItems(bx, bz);
  const out: Box[] = [];
  for (let k = 0; k < it.length; k += ITEM_STRIDE) out.push({ kind: it[k], x0: it[k + 1], y0: it[k + 2], z0: it[k + 3], x1: it[k + 4], y1: it[k + 5], z1: it[k + 6] });
  return out;
}

describe('city world', () => {
  it('is deterministic by seed', () => {
    expect([...city(3).blockItems(5, -7)]).toEqual([...city(3).blockItems(5, -7)]);
    expect([...city(3).blockItems(5, -7)]).not.toEqual([...city(4).blockItems(5, -7)]);
  });

  it('spawns on an open plaza with room for the drills', () => {
    const w = city(1);
    expect(w.distance(new Vec3(0, 1, 0))).toBeCloseTo(1, 9);
    for (let a = 0; a < 24; a++) {
      for (const r of [5, 18, 30]) {
        const x = Math.cos(a) * r * 1.1, z = Math.sin(a) * r - 25; // the drills use about 45 m around the pad
        for (const y of [1, 5, 15]) expect(w.distance(new Vec3(x, y, z)), `${x},${y},${z}`).toBeGreaterThan(0.8);
      }
    }
  });

  it('buildings are solid, the field is exact next to walls, and blocks fit their item budget', () => {
    const w = city(2);
    let buildings = 0, bridges = 0, tall = 0;
    for (let bx = -12; bx <= 12; bx += 3) {
      for (let bz = -12; bz <= 12; bz += 3) {
        const list = boxes(w, bx, bz);
        expect(list.length).toBeLessThan(MAX_ITEMS);
        for (const b of list) {
          if (b.kind !== ITEM_BUILDING && b.kind !== ITEM_BRIDGE) continue;
          if (b.kind === ITEM_BRIDGE) bridges++;
          else buildings++;
          if (b.y1 > 50) tall++;
          const cy = (b.y0 + b.y1) / 2;
          expect(w.distance(new Vec3((b.x0 + b.x1) / 2, cy, (b.z0 + b.z1) / 2))).toBeLessThan(0);
          // 0.3 m outside a wall: never more than 0.3 (a lower bound), and > 0 unless inside another box.
          const d = w.distance(new Vec3(b.x1 + 0.3, cy, (b.z0 + b.z1) / 2));
          expect(d).toBeLessThanOrEqual(0.3 + 1e-9);
        }
      }
    }
    expect(buildings).toBeGreaterThan(200);
    expect(bridges).toBeGreaterThan(0);
    expect(tall).toBeGreaterThan(3);
  });

  it('alleys between buildings are wide enough to fly (≥ 4 m)', () => {
    const w = city(5);
    let pairs = 0;
    for (let bx = -10; bx <= 10; bx++) {
      for (let bz = -10; bz <= 10; bz++) {
        const bs = boxes(w, bx, bz).filter((b) => b.kind === ITEM_BUILDING);
        for (let i = 0; i < bs.length; i++) {
          for (let j = i + 1; j < bs.length; j++) {
            const a = bs[i], b = bs[j];
            const gx = Math.max(a.x0 - b.x1, b.x0 - a.x1), gz = Math.max(a.z0 - b.z1, b.z0 - a.z1);
            if (gx < 0 && gz < 0) continue; // stacked tiers / spire of one building
            pairs++;
            expect(Math.max(gx, gz)).toBeGreaterThanOrEqual(4 - 1e-9);
          }
        }
      }
    }
    expect(pairs).toBeGreaterThan(500);
  });

  it('a raycast down onto a building lands on its roof', () => {
    const w = city(2);
    let n = 0;
    for (let bx = 2; bx < 8; bx++) {
      const top = boxes(w, bx, 3).filter((b) => b.kind === ITEM_BUILDING).sort((a, b) => b.y1 - a.y1)[0];
      if (!top) continue;
      const cx = (top.x0 + top.x1) / 2, cz = (top.z0 + top.z1) / 2;
      const hit = w.raycast(new Vec3(cx, 400, cz), new Vec3(0, -1, 0), 1000)!;
      expect(400 - hit.distance).toBeGreaterThanOrEqual(top.y1 - 1e-3);
      expect(hit.normal.y).toBeCloseTo(1, 3);
      n++;
    }
    expect(n).toBeGreaterThan(3);
  });

  it('a quad flown into a wall stops at it', () => {
    const w = city(2);
    const b = boxes(w, 3, 3).filter((b) => b.kind === ITEM_BUILDING)[0];
    const quad = new Quad(defaultSimParams());
    const rc = new RcChannels();
    quad.reset(b.x1 + 5, 4, (b.z0 + b.z1) / 2);
    quad.state.vel.set(-15, 0, 0);
    for (let i = 0; i < 500; i++) quad.step(rc, w);
    expect(quad.state.pos.x).toBeGreaterThan(b.x1 + 0.1);
  });
});

describe('city streaming', () => {
  it('flies 12 minutes across the city: no holes, bounded memory and work, meshes within capacity', () => {
    const w = city(7);
    const s = new ChunkStreamer<CityMesh>(w, { show: () => {}, hide: () => {} });
    s.setDrawDistance(600);
    s.update(0, 0);
    s.prime();
    const work: number[] = [];
    let holes = 0, maxVerts = 0, snapshot = '';
    for (let f = 0; f < 12 * 3600; f++) {
      const d = (f / 60) * 40;
      s.update(d * 0.8, -d * 0.6);
      s.work(2);
      work.push(s.lastWorkMs);
      const c = s.active.get((Math.floor((d * 0.8) / 128) + (1 << 20)) * 2097152 + (Math.floor((-d * 0.6) / 128) + (1 << 20)));
      if (!c?.mesh) holes++;
      for (const ch of s.active.values()) if (ch.mesh) maxVerts = Math.max(maxVerts, ch.mesh.vertexCount);
      if (f === 3 * 3600) snapshot = JSON.stringify(s.created);
    }
    work.sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(`city: ${s.builds} builds, work p99 ${work[Math.floor(work.length * 0.99)].toFixed(2)} ms, max verts ${maxVerts}/${CityMesh.MAX_VERTS}, pools ${JSON.stringify(s.created)}`);
    expect(holes).toBe(0);
    expect(JSON.stringify(s.created)).toBe(snapshot);
    expect(maxVerts).toBeLessThan(CityMesh.MAX_VERTS);
    expect(work[Math.floor(work.length * 0.99)]).toBeLessThan(2.5);
    expect(PITCH * 2).toBe(128);
  });
});
