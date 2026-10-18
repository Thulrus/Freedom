/**
 * "Sky islands": floating islands over a sea of cloud.
 *   - Each island has a grassy top and a craggy rock body tapering to a
 *     point, with stalactites hanging beneath.
 *   - Some are bored through by tunnels, and some have a shaft straight
 *     down through the middle: dive in at the top and drop out of the
 *     bottom.
 *   - Neighbouring islands at similar heights are joined by plank rope
 *     bridges or stone arches.
 *   - Golden rings float in the gaps.
 * The cloud sea far below is solid (it stands in for the ground). Like
 * Arches, the world is a 640 m tile that wraps around. Physics is real
 * Earth physics (Training): islands don't make your quad any lighter.
 */
import { Rng, Vec3 } from '../sim';
import { dcos, dsin, PeriodicNoise } from './pnoise';
import { hexToLinear, OP_INTERSECT, OP_SMOOTH_SUBTRACT, OP_SMOOTH_UNION, PRIM_BOX, PRIM_CAPSULE, PRIM_CONE, PRIM_CYLINDER, PRIM_ELLIPSOID, PRIM_TORUS, VolumeWorld } from './volume';

const PERIOD = 640;
const CELL = 80;
const MAT_ROCK = 2;
const MAT_WOOD = 3;
const MAT_ROPE = 4;
const MAT_RING = 5;
const MAT_PAD = 6;

const GRASS = 0x84c76a;
const GRASS_ALT = 0xa8d873;
const DIRT = 0xa07d55;
const ROCK = 0xa8957f;
const UNDER = 0x75677a;
const DEEP = 0x5c5f86;
const PART: Record<number, number> = { [MAT_WOOD]: 0x9c6b40, [MAT_ROPE]: 0x4a3a2a, [MAT_RING]: 0xffc93c, [MAT_PAD]: 0xe8e2d4 };

interface Island {
  x: number;
  z: number;
  top: number;
  R: number;
  spawn: boolean;
}

export class IslandsWorld extends VolumeWorld {
  readonly id = 'islands' as const;
  readonly islands: Island[] = [];
  private readonly arches: { x: number; y: number; z: number; yaw: number }[] = [];
  private readonly pal = new Float32Array(18);
  private readonly tint: PeriodicNoise;

  constructor(seed: number) {
    super(seed, PERIOD, CELL);
    this.yMin = 6;
    this.yMax = 170;
    this.seaY = 0;
    [GRASS, GRASS_ALT, DIRT, ROCK, UNDER, DEEP].forEach((c, i) => hexToLinear(c, this.pal, i * 3));
    this.tint = new PeriodicNoise(seed, PERIOD / 16, 9);
    const rng = new Rng(seed * 2246822519 + 3);

    this.placeIslands(rng, seed);
    for (const isl of this.islands) this.island(rng, isl);
    for (const a of this.arches) this.stoneRing(rng, a.x, a.y, a.z, a.yaw);
    this.finalize();
    this.bridges(rng);
    this.finalize();
    this.rings(rng);
    // A stone launch plinth on the spawn island.
    const home = this.islands[0];
    this.spawn.set(home.x, home.top + 0.6, home.z + 20);
    this.spawnYaw = 0;
    this.begin({ material: MAT_PAD, exact: true });
    this.prim(PRIM_CYLINDER, 0, 0, this.spawn.x, home.top - 0.45, this.spawn.z, 2.4, 1.05, 0);
    this.end();
    this.finalize();
    this.verifyOpenings();
    this.warmUp();
  }

  // ------------------------------------------------------------ layout

  private placeIslands(rng: Rng, seed: number): void {
    const NC = PERIOD / CELL;
    const hn = new PeriodicNoise(seed, 2, 5);
    for (let k = 0; k < NC; k++) {
      for (let i = 0; i < NC; i++) {
        const spawn = i === 0 && k === 0;
        if (!spawn && rng.next() < 0.12) {
          // A gap in the archipelago, with a giant stone ring floating in it.
          this.arches.push({ x: (i + 0.5) * CELL + rng.signed() * 8, z: (k + 0.5) * CELL + rng.signed() * 8, y: 50 + rng.next() * 70, yaw: rng.next() * Math.PI * 2 });
          continue;
        }
        // Heights drift smoothly across the map, so neighbours are often bridgeable.
        hn.io[0] = i / 4;
        hn.io[1] = 0.5;
        hn.io[2] = k / 4;
        hn.sample();
        this.islands.push({
          x: spawn ? CELL / 2 : (i + 0.5) * CELL + rng.signed() * 12,
          z: spawn ? CELL / 2 : (k + 0.5) * CELL + rng.signed() * 12,
          top: spawn ? 60 : Math.min(150, Math.max(34, 82 + hn.io[3] * 60 + rng.signed() * 12)),
          R: spawn ? 44 : 12 + rng.next() * 16,
          spawn,
        });
      }
    }
    // Keep at least 14 m of air between neighbours (the spawn island never shrinks).
    for (let pass = 0; pass < 3; pass++) {
      for (const a of this.islands) {
        for (const b of this.islands) {
          if (a === b || b.R <= 0) continue;
          const gap = this.horiz(a, b) - a.R - b.R;
          if (gap >= 14) continue;
          const v = a.spawn ? b : b.spawn ? a : a.R > b.R ? a : b;
          v.R = Math.max(0, v.R - (14 - gap));
        }
      }
    }
    const kept = this.islands.filter((s) => s.R >= 10);
    this.islands.length = 0;
    this.islands.push(...kept.sort((a, b) => (b.spawn ? 1 : 0) - (a.spawn ? 1 : 0)));
  }

  /** Horizontal distance, the short way around the wrap. */
  private horiz(a: { x: number; z: number }, b: { x: number; z: number }): number {
    const v = this.wrapDelta(a, b);
    return Math.hypot(v[0], v[1]);
  }

  /** b - a, the short way around the wrap. */
  private wrapDelta(a: { x: number; z: number }, b: { x: number; z: number }): [number, number] {
    let dx = b.x - a.x, dz = b.z - a.z;
    dx -= Math.round(dx / PERIOD) * PERIOD;
    dz -= Math.round(dz / PERIOD) * PERIOD;
    return [dx, dz];
  }

  private island(rng: Rng, s: Island): void {
    const { x, z, top } = s;
    const R = (s.R = Math.min(s.R, (top - 12) / 1.1));
    // Every island is a cap plus a rock body, but proportions vary a lot:
    // shallow plates, deep teardrops, and lopsided twin-keeled rocks.
    const depth = Math.min(top - 12, R * (1.0 + rng.next() * 1.6));
    const cap = 0.28 + rng.next() * 0.25;
    const body = 0.6 + rng.next() * 0.32;
    this.begin({ material: MAT_ROCK, noise: s.spawn ? 0.3 : 0.8 + rng.next() * 0.6 });
    // Grassy cap, flattened on top.
    this.prim(PRIM_ELLIPSOID, 0, 0, x, top - 0.18 * R, z, R, cap * R, R * (0.85 + rng.next() * 0.3));
    // Rock body tapering to a point (sometimes two keels).
    const keels = s.spawn || rng.next() < 0.65 ? 1 : 2;
    for (let k = 0; k < keels; k++) {
      const a = rng.next() * Math.PI * 2, off = keels === 1 ? R * 0.12 * rng.next() : R * 0.3;
      const d = keels === 1 ? depth : depth * (0.7 + rng.next() * 0.3);
      this.prim(PRIM_CONE, OP_SMOOTH_UNION, R * 0.3, x + dcos(a) * off, top - d, z + dsin(a) * off, 1.2 + rng.next() * 1.5, R * (keels === 1 ? body : body * 0.7), d - R * 0.25);
    }
    // Stalactites.
    const n = 1 + Math.floor(rng.next() * 4);
    for (let k = 0; k < n; k++) {
      const a = rng.next() * Math.PI * 2, d = R * (0.25 + rng.next() * 0.35);
      const tip = Math.max(9, top - depth * (0.6 + rng.next() * 0.5));
      this.prim(PRIM_CONE, OP_SMOOTH_UNION, 3, x + dcos(a) * d, tip, z + dsin(a) * d, 0.6, R * (0.12 + rng.next() * 0.12), (top - R * 0.3 - tip) * 0.8);
    }
    this.prim(PRIM_BOX, OP_INTERSECT, 0, x, top - 80, z, R + 10, 80, R + 10, 0, 1, 0, 1, 0);
    if (!s.spawn && R >= 18 && rng.next() < 0.4) {
      // A tunnel straight through.
      const yaw = rng.next() * Math.PI * 2, fx = dsin(yaw), fz = dcos(yaw);
      const tr = 3.6 + rng.next() * 1.2, ty = top - 0.35 * R - 2;
      this.prim(PRIM_CAPSULE, OP_SMOOTH_SUBTRACT, 1.5, x - fx * (R + 6), ty, z - fz * (R + 6), x + fx * (R + 6), ty, z + fz * (R + 6), tr);
      this.openings.push({ x, y: ty, z, yaw, width: tr * 1.1, height: tr * 1.1, kind: 'tunnel' });
    }
    if (!s.spawn && R >= 15 && rng.next() < 0.3) {
      // A shaft down through the middle: in at the top, out of the bottom.
      this.prim(PRIM_CAPSULE, OP_SMOOTH_SUBTRACT, 1.5, x, top - depth - 6, z, x, top + 8, z, 3.6 + rng.next() * 0.8);
    }
    this.end();
  }

  /** A giant free-floating ring of rock, standing on edge. */
  private stoneRing(rng: Rng, x: number, y: number, z: number, yaw: number): void {
    const R = 11 + rng.next() * 6, r = 2.6 + rng.next() * 1.2;
    this.begin({ material: MAT_ROCK, noise: 0.7 });
    this.prim(PRIM_TORUS, 0, 0, x, y, z, dsin(yaw), 0, dcos(yaw), R, r);
    // A few rocks clinging to the bottom.
    this.prim(PRIM_CONE, OP_SMOOTH_UNION, 2.5, x, y - R - r - 5, z, 0.6, r * 1.3, 6);
    this.end();
    const inner = (R - r) * 1.25;
    this.openings.push({ x, y, z, yaw, width: inner, height: inner, kind: 'arch' });
  }

  /** Bridges between neighbouring islands at similar heights. */
  private bridges(rng: Rng): void {
    const list = this.islands;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        const [dx, dz] = this.wrapDelta(A, B);
        const D = Math.hypot(dx, dz), gap = D - A.R - B.R;
        if (gap > 58 || D > CELL * 1.5 || Math.abs(A.top - B.top) > 22 || rng.next() > 0.6) continue;
        const ux = dx / D, uz = dz / D;
        const ea = A.R * 0.85 - 2, eb = B.R * 0.85 - 2;
        const ax = A.x + ux * ea, az = A.z + uz * ea, bx = A.x + dx - ux * eb, bz = A.z + dz - uz * eb;
        const span = Math.hypot(bx - ax, bz - az);
        const dy = Math.abs(A.top - B.top);
        if (dy > span * 0.5) continue;
        if (dy < span * 0.22 && rng.next() < 0.65) this.ropeBridge(ax, A.top + 0.1, az, bx, B.top + 0.1, bz, span, ux, uz);
        else this.stoneBridge(rng, ax, A.top - 1.6, az, bx, B.top - 1.6, bz, span, ux, uz);
      }
    }
  }

  /** Planks on a sagging curve with rope handrails. Exact geometry (too thin to sample). */
  private ropeBridge(ax: number, ay: number, az: number, bx: number, by: number, bz: number, span: number, ux: number, uz: number): void {
    const sag = span * 0.05;
    const at = (t: number): number[] => [ax + (bx - ax) * t, ay + (by - ay) * t - sag * 4 * t * (1 - t), az + (bz - az) * t];
    const n = Math.max(4, Math.floor(span / 0.95));
    this.begin({ material: MAT_WOOD, exact: true });
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const [x, y, z] = at(t);
      // Slope of the deck here: d/dt of the curve.
      const dy = by - ay - sag * 4 * (1 - 2 * t);
      const len = Math.hypot(span, dy);
      this.prim(PRIM_BOX, 0, 0, x, y, z, 1.2, 0.07, 0.36, 0, uz, ux, span / len, dy / len);
    }
    this.end();
    // Handrails: rope segments between posts.
    this.begin({ material: MAT_ROPE, exact: true });
    const posts = Math.max(2, Math.round(span / 5));
    for (const side of [-1.25, 1.25]) {
      const sx = uz * side, sz = -ux * side;
      for (let k = 0; k < posts; k++) {
        const [x0, y0, z0] = at(k / posts), [x1, y1, z1] = at((k + 1) / posts);
        this.prim(PRIM_CAPSULE, 0, 0, x0 + sx, y0 + 1.0, z0 + sz, x1 + sx, y1 + 1.0, z1 + sz, 0.04);
        this.prim(PRIM_CAPSULE, 0, 0, x0 + sx, y0, z0 + sz, x0 + sx, y0 + 1.0, z0 + sz, 0.05);
      }
      const [x, y, z] = at(1);
      this.prim(PRIM_CAPSULE, 0, 0, x + sx, y, z + sz, x + sx, y + 1.0, z + sz, 0.05);
    }
    this.end();
    const [mx, my, mz] = at(0.5);
    this.openings.push({ x: mx, y: my - 6, z: mz, yaw: Math.atan2(uz, -ux), width: Math.min(span * 0.35, 10), height: 7, kind: 'bridge' });
  }

  /** A natural stone arch between two islands. */
  private stoneBridge(rng: Rng, ax: number, ay: number, az: number, bx: number, by: number, bz: number, span: number, ux: number, uz: number): void {
    const rise = span * (0.06 + rng.next() * 0.06);
    const at = (t: number): number[] => [ax + (bx - ax) * t, ay + (by - ay) * t + rise * 4 * t * (1 - t), az + (bz - az) * t];
    const r = 1.9 + rng.next() * 0.6;
    this.begin({ material: MAT_ROCK, noise: 0.45 });
    const segs = 6;
    for (let k = 0; k < segs; k++) {
      const [x0, y0, z0] = at(k / segs), [x1, y1, z1] = at((k + 1) / segs);
      this.prim(PRIM_CAPSULE, k === 0 ? 0 : OP_SMOOTH_UNION, 1.5, x0, y0, z0, x1, y1, z1, r * (k === 0 || k === segs - 1 ? 1.4 : 1));
    }
    this.end();
    const [mx, my, mz] = at(0.5);
    this.openings.push({ x: mx, y: my - r - 5, z: mz, yaw: Math.atan2(uz, -ux), width: Math.min(span * 0.4, 12), height: 7, kind: 'bridge' });
  }

  /** Golden rings floating in open air, plus one straight ahead of the pad. */
  private rings(rng: Rng): void {
    const home = this.islands[0];
    const placed: number[][] = [];
    const ring = (x: number, y: number, z: number, yaw: number, R: number) => {
      this.begin({ material: MAT_RING, exact: true });
      this.prim(PRIM_TORUS, 0, 0, x, y, z, dsin(yaw), 0, dcos(yaw), R, 0.32);
      this.end();
      placed.push([x, y, z, R]);
      const side = (R - 0.32) * 1.25;
      this.openings.push({ x, y, z, yaw, width: side, height: side, kind: 'ring' });
    };
    ring(home.x, home.top + 7, home.z - home.R - 8, 0, 5);
    const p = new Vec3();
    const NC = PERIOD / CELL;
    for (let k = 0; k < NC; k++) {
      for (let i = 0; i < NC; i++) {
        if (rng.next() > 0.65) continue;
        for (let tries = 0; tries < 10; tries++) {
          const x = (i + rng.next()) * CELL, z = (k + rng.next()) * CELL, y = 30 + rng.next() * 120;
          const R = 3.8 + rng.next() * 2.2, yaw = rng.next() * Math.PI * 2;
          const fx = dsin(yaw), fz = dcos(yaw);
          let clear = this.distance(p.set(x, y, z)) > R + 5;
          for (const t of [-10, 10]) clear = clear && this.distance(p.set(x + fx * t, y, z + fz * t)) > R + 2;
          clear = clear && placed.every(([qx, qy, qz, qr]) => this.horiz({ x, z }, { x: qx, z: qz }) + Math.abs(y - qy) > R + qr + 12);
          if (!clear) continue;
          ring(x, y, z, yaw, R);
          break;
        }
      }
    }
  }

  // ------------------------------------------------------------ colors

  shade(x: number, y: number, z: number, _nx: number, ny: number, _nz: number, _material: number, out: Float32Array, o: number): void {
    const t = this.tint.io;
    t[0] = x / 16;
    t[1] = y / 16;
    t[2] = z / 16;
    this.tint.sample();
    const n = t[3];
    const P = this.pal;
    let a = 0, b = 0, k = 0;
    if (ny > 0.75) {
      const g = n > 0.15 ? 3 : 0; // two grasses
      for (let c = 0; c < 3; c++) out[o + c] = P[g + c] * (0.94 + n * 0.12);
      return;
    }
    if (ny > 0.3) {
      a = 6; b = 0; k = (ny - 0.3 + n * 0.15) / 0.45; // dirt into grass
    } else if (ny > -0.25) {
      a = 9; b = 6; k = (ny - 0.18) / 0.12; // rock, dirt just below the grass
    } else {
      a = 12; b = 15; k = Math.min(1, (-ny - 0.25) * 1.2); // dusky underside, deep blue at the tips
    }
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const streak = 0.9 + n * 0.2;
    for (let c = 0; c < 3; c++) out[o + c] = (P[a + c] * (1 - k) + P[b + c] * k) * streak;
  }

  partColor(material: number, out: Float32Array, o: number): void {
    hexToLinear(PART[material] ?? 0xffffff, out, o);
  }
}
