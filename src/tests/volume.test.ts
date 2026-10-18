import { describe, expect, it } from 'vitest';
import { defaultSimParams, Quad, RcChannels, Rng, Vec3 } from '../sim';
import { raceLayout } from '../game/layouts';
import { dcos, dsin, PeriodicNoise } from '../world/pnoise';
import { buildWorld } from '../world/recipes';
import type { VolumeWorld } from '../world/volume';
import { VOLUME_LOD_CELL, VolumeMesher } from '../world/volumeMesh';

const IDS = ['arches', 'islands'] as const;
const vol = (id: string, seed = 1) => buildWorld(id, seed) as VolumeWorld;
// One world per id for the read-only checks (building takes ~0.1 s).
const W = Object.fromEntries(IDS.map((id) => [id, vol(id)])) as Record<(typeof IDS)[number], VolumeWorld>;

describe('deterministic helpers', () => {
  it('dsin/dcos match Math.sin/cos', () => {
    for (let x = -20; x < 20; x += 0.137) {
      expect(dsin(x)).toBeCloseTo(Math.sin(x), 12);
      expect(dcos(x)).toBeCloseTo(Math.cos(x), 12);
    }
  });

  it('periodic noise repeats along x and z, not y', () => {
    const n = new PeriodicNoise(5, 12);
    const at = (x: number, y: number, z: number) => {
      n.io[0] = x;
      n.io[1] = y;
      n.io[2] = z;
      n.sample();
      return n.io[3];
    };
    let spread = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.731, y = i * 0.173, z = i * 0.377;
      expect(at(x + 12, y, z)).toBeCloseTo(at(x, y, z), 12);
      expect(at(x, y, z - 24)).toBeCloseTo(at(x, y, z), 12);
      spread += Math.abs(at(x, y + 12, z) - at(x, y, z));
    }
    expect(spread).toBeGreaterThan(5);
  });
});

describe.each(IDS)('%s world', (id) => {
  const w = W[id];

  it('is deterministic by seed', () => {
    const a = vol(id, 9), b = vol(id, 9), c = vol(id, 10);
    const p = new Vec3();
    let diff = 0;
    for (let i = 0; i < 300; i++) {
      p.set((i * 13.7) % 640, 2 + ((i * 7.3) % 120), (i * 29.1) % 640);
      expect(a.distance(p)).toBe(b.distance(p));
      diff += Math.abs(a.distance(p) - c.distance(p));
    }
    expect(JSON.stringify(a.openings)).toBe(JSON.stringify(b.openings));
    expect(diff).toBeGreaterThan(10);
  });

  it('wraps around seamlessly every period', () => {
    const p = new Vec3(), q = new Vec3();
    const P = w.period;
    for (let i = 0; i < 400; i++) {
      p.set((i * 13.7) % P, 1 + ((i * 7.3) % 100), (i * 29.1) % P);
      const d = w.distance(p);
      for (const [kx, kz] of [[1, 0], [0, -1], [-3, 2], [40, -71]]) expect(w.distance(q.set(p.x + kx * P, p.y, p.z + kz * P))).toBeCloseTo(d, 6);
    }
  });

  it('is a well-behaved distance field: bounded slope, exact at the surface', () => {
    const rng = new Rng(4);
    const a = new Vec3(), b = new Vec3();
    for (let i = 0; i < 4000; i++) {
      a.set(rng.next() * 640, w.yMin + rng.next() * (w.yMax - w.yMin), rng.next() * 640);
      b.set(a.x + rng.signed() * 0.5, a.y + rng.signed() * 0.5, a.z + rng.signed() * 0.5);
      const ab = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      expect(Math.abs(w.distance(a) - w.distance(b))).toBeLessThanOrEqual(1.7 * ab + 1e-9);
    }
    // Rays down from the sky land on the surface, with an upward-ish normal.
    let hits = 0;
    for (let i = 0; i < 60; i++) {
      const hit = w.raycast(a.set(rng.next() * 640, w.yMax + 10, rng.next() * 640), new Vec3(0, -1, 0), 400);
      if (!hit) continue;
      hits++;
      expect(Math.abs(w.distance(hit.point))).toBeLessThan(0.03);
      expect(hit.normal.y).toBeGreaterThan(-0.2);
    }
    expect(hits).toBeGreaterThan(50);
  });

  it('spawns on a clear, flat pad, and a quad dropped on it comes to rest there', () => {
    const sp = w.spawn;
    expect(w.distance(new Vec3(sp.x, sp.y + 0.5, sp.z))).toBeCloseTo(0.5, 1);
    for (let a = 0; a < 12; a++) for (const r of [3, 8]) for (const y of [1, 3, 6]) expect(w.distance(new Vec3(sp.x + Math.cos(a) * r, sp.y + y, sp.z + Math.sin(a) * r))).toBeGreaterThan(0.8);
    const quad = new Quad(defaultSimParams());
    quad.reset(sp.x, sp.y + 1, sp.z);
    for (let i = 0; i < 1500; i++) quad.step(new RcChannels(), w);
    expect(quad.state.pos.y).toBeGreaterThan(sp.y);
    expect(quad.state.pos.y).toBeLessThan(sp.y + 0.3);
    expect(w.groundHeight(sp.x, sp.z)).toBeCloseTo(sp.y, 1);
  });

  it('has plenty of varied, clear openings to fly through', () => {
    expect(w.openings.length).toBeGreaterThan(30);
    expect(new Set(w.openings.map((o) => o.kind)).size).toBeGreaterThanOrEqual(3);
    const p = new Vec3();
    for (const o of w.openings) {
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw), rx = fz, rz = -fx;
      for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        for (const t of [-4, 0, 4]) {
          p.set(o.x + rx * a * (o.width / 2) + fx * t, o.y + b * (o.height / 2), o.z + rz * a * (o.width / 2) + fz * t);
          expect(w.distance(p), `${o.kind} at ${o.x.toFixed(0)},${o.y.toFixed(0)},${o.z.toFixed(0)}`).toBeGreaterThan(0.5);
        }
      }
    }
  });

  it('a quad flown straight through an opening never touches the rock', () => {
    const o = [...w.openings].sort((a, b) => b.width * b.height - a.width * a.height)[0];
    const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
    const p = defaultSimParams();
    p.env.gravity = 0; // a straight, level line through the window
    const quad = new Quad(p);
    quad.reset(o.x - fx * 6, o.y, o.z - fz * 6);
    quad.state.vel.set(fx * 12, 0, fz * 12);
    let contacts = 0;
    for (let i = 0; i < 500; i++) {
      quad.step(new RcChannels(), w);
      if (quad.state.contact) contacts++;
    }
    expect(contacts).toBe(0);
    expect((quad.state.pos.x - o.x) * fx + (quad.state.pos.z - o.z) * fz).toBeGreaterThan(3);
  });

  it('a quad flown into rock stops at its surface', () => {
    // Find solid rock above the floor, then fly at it horizontally.
    const rng = new Rng(8);
    const p = new Vec3(), q = new Vec3();
    let tries = 0, wallX = 0;
    for (;;) {
      tries++;
      expect(tries).toBeLessThan(20000);
      p.set(rng.next() * 640, 10 + rng.next() * 40, rng.next() * 640);
      if (!(w.distance(p) < -1.5 && w.distance(q.set(p.x + 25, p.y, p.z)) > 3)) continue;
      // A near-vertical wall facing the approach.
      const hit = w.raycast(q, new Vec3(-1, 0, 0), 30);
      if (!hit || hit.normal.x < 0.85) continue;
      wallX = q.x - hit.distance;
      break;
    }
    const quad = new Quad(defaultSimParams());
    quad.reset(wallX + 4, p.y, p.z);
    quad.state.vel.set(-12, 0, 0);
    // It may slide along a sloping wall, but never goes into the rock.
    let contacts = 0, deepest = Infinity;
    for (let i = 0; i < 1000; i++) {
      quad.step(new RcChannels(), w);
      if (quad.state.contact) contacts++;
      deepest = Math.min(deepest, w.distance(quad.state.pos));
    }
    expect(contacts).toBeGreaterThan(0);
    expect(deepest).toBeGreaterThan(0);
  });

  it('meshes match the field and face outwards', () => {
    const m = new VolumeMesher(w);
    const tx = Math.floor(w.spawn.x / 128), tz = Math.floor(w.spawn.z / 128);
    const p = new Vec3();
    for (const lod of [0, 1]) {
      const t = m.build(tx, tz, lod);
      const h = VOLUME_LOD_CELL[lod];
      expect(t.triangles).toBeGreaterThan(500);
      expect(t.vertexCount).toBeLessThan(65536);
      // Surface-net vertices lie near the zero set of the field.
      let sum = 0, n = 0;
      for (let v = 0; v < t.vertexCount; v += 7) {
        p.set(t.positions[v * 3] + tx * 128, t.positions[v * 3 + 1], t.positions[v * 3 + 2] + tz * 128);
        const d = Math.abs(w.distance(p));
        sum += d;
        n++;
      }
      expect(sum / n).toBeLessThan(h * 0.15);
      // Triangle winding agrees with the field normals.
      let agree = 0;
      const P = t.positions, N = t.normals, I = t.index;
      for (let i = 0; i < I.length; i += 3) {
        const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * (N[a] + N[b] + N[c]) + ny * (N[a + 1] + N[b + 1] + N[c + 1]) + nz * (N[a + 2] + N[b + 2] + N[c + 2]) > 0) agree++;
      }
      expect(agree / (I.length / 3)).toBeGreaterThan(0.97);
    }
  });

  it('every tile of the period meshes at every LOD within capacity', () => {
    const m = new VolumeMesher(w);
    const n = w.period / 128;
    let tris = 0;
    for (let tz = 0; tz < n; tz++) for (let tx = 0; tx < n; tx++) tris += m.build(tx, tz, 2).triangles;
    expect(tris).toBeGreaterThan(5000);
    // The busiest full-detail tile still fits the 16-bit-free index and vertex caps.
    const t = m.build(2, 3, 0);
    expect(t.vertexCount).toBeLessThan(60000);
  });

  it('a race loops through natural openings, with short legs', () => {
    const l = raceLayout(w);
    expect(l.checkpoints.length).toBeGreaterThanOrEqual(6);
    expect(l.boxes.length).toBe(0);
    const cps = l.checkpoints;
    for (let i = 0; i < cps.length; i++) {
      const a = cps[i], b = cps[(i + 1) % cps.length];
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(260);
    }
    // The first one is ahead of the pad, and flown through going away from it.
    const sp = w.spawn;
    expect((cps[0].x - sp.x) * -Math.sin(w.spawnYaw) + (cps[0].z - sp.z) * -Math.cos(w.spawnYaw)).toBeGreaterThan(10);
    expect((cps[0].x - sp.x) * Math.sin(cps[0].yaw) + (cps[0].z - sp.z) * Math.cos(cps[0].yaw)).toBeGreaterThan(5);
    expect(JSON.stringify(raceLayout(vol(id)))).toBe(JSON.stringify(l));
  });
});
