/**
 * Volume worlds: fanciful geography (arches, tunnels, overhangs, floating
 * islands) defined as a signed distance field instead of a heightfield.
 *
 * - The field is a small CSG program: each *feature* (an arch, an island, a
 *   bridge) is a short list of exact SDF primitives combined with unions,
 *   subtractions and smooth blends, plus a little rock noise. Features live
 *   on a coarse grid of cells, so a query only looks at the 3×3 cells around
 *   it.
 * - The world is a seamless tile of `period` metres that repeats in x and z:
 *   fly off one edge and you are back at the other. The geography stays
 *   dense and close (no long empty straights), and the renderer only ever
 *   has to mesh the tile once.
 * - Collision reads this field directly. The renderer meshes the same field
 *   (surface nets, see volumeMesh.ts), so what you see is what you hit, to
 *   within the mesh resolution. Thin parts (planks, ropes, rings) are
 *   "exact": they are meshed from their primitives, not sampled.
 *
 * The query path runs at 500 Hz and follows the sim's rules: no allocation,
 * and doubles never cross non-inlined calls except through typed arrays.
 * The whole field is one function with an inline primitive "interpreter".
 */
import { Vec3, type Hit } from '../sim';
import { PeriodicNoise } from './pnoise';
import type { GameWorld, WorldId } from './recipes';

// Primitive types. Parameters (after type, op, k) are listed per type.
/** center xyz, radius */
export const PRIM_SPHERE = 0;
/** center xyz, radii xyz */
export const PRIM_ELLIPSOID = 1;
/** a xyz, b xyz, radius, 1/|b-a|² (filled in) */
export const PRIM_CAPSULE = 2;
/** center xyz, unit axis xyz, major radius, minor radius */
export const PRIM_TORUS = 3;
/** center xyz, half extents xyz, rounding, cos yaw, sin yaw, cos pitch, sin pitch (local z = forward) */
export const PRIM_BOX = 4;
/** bottom center xyz, bottom radius, top radius, height, (a, b filled in): vertical round cone */
export const PRIM_CONE = 5;
/** center xyz, radius, half height, rounding: vertical cylinder */
export const PRIM_CYLINDER = 6;

/** How a primitive combines with the feature so far (the first one just starts it). */
export const OP_UNION = 0;
export const OP_SMOOTH_UNION = 1;
export const OP_SUBTRACT = 2;
export const OP_SMOOTH_SUBTRACT = 3;
export const OP_INTERSECT = 4;

/** Floats per primitive: type, op, k, then up to 13 parameters. */
export const PRIM_STRIDE = 16;
/** Floats per feature (see F_*). */
const FEAT_STRIDE = 12;
const F_START = 0;
const F_COUNT = 1;
const F_CX = 2;
const F_RADIUS = 5;
const F_EXACT = 6;
const F_NOISE = 7;
const F_JOIN = 8;
const F_MATERIAL = 9;
const F_LEDGE = 10;

/** Material ids (vertex colors and exact-part colors are picked per world). */
export const MAT_GROUND = 0;
export const MAT_SEA = 1;

/** A natural opening to fly through (arch, window, tunnel, ring). Same conventions as a gate. */
export interface Opening {
  x: number;
  y: number;
  z: number;
  /** Fly along ±(sin yaw, 0, cos yaw). */
  yaw: number;
  /** Clear size of the opening (a safe window inside it), m. */
  width: number;
  height: number;
  kind: 'arch' | 'window' | 'tunnel' | 'ring' | 'bridge' | 'skylight' | 'slot';
  /** Must be flown in this direction only (e.g. a skylight shaft: down). Unused for now. */
  oneWay?: boolean;
}

export interface FeatureOptions {
  material: number;
  /** Meshed from its primitives rather than sampled (thin parts). Unions only. */
  exact?: boolean;
  /** Rock noise amplitude, m (0 = smooth). */
  noise?: number;
  /** Smooth-union radius with the rest of the world, m (0 = hard union). */
  join?: number;
  /** Horizontal strata ledges, m of bulge (0 = none). */
  ledge?: number;
}

interface Draft {
  opts: FeatureOptions;
  prims: number[][];
  /** Bounding sphere of the union-type primitives. */
  bounds: number[][];
}

export abstract class VolumeWorld implements GameWorld {
  abstract readonly id: WorldId;
  /** Launch pad position on the ground, m. */
  readonly spawn = new Vec3();
  spawnYaw = 0;
  /** Natural openings, in the canonical tile [0, period). */
  readonly openings: Opening[] = [];

  /** Meshed height range, m (the mesher samples [yMin, yMax]). */
  yMin = -8;
  yMax = 120;
  /** Solid ground (meshed): height and dune amplitude, m. Disabled when groundAmp < 0. */
  groundY = 0;
  groundAmp = -1;
  /** A flat solid plane that is not meshed (a cloud sea or water drawn separately), m. -Infinity = none. */
  seaY = -Infinity;
  /** Strata pitch for ledges, m. */
  ledgePitch = 4;
  /** The dunes fade to flat ground within flatR0..flatR1 of (flatX, flatZ) (the launch pad). flatR1 = 0: off. */
  flatX = 0;
  flatZ = 0;
  flatR0 = 0;
  flatR1 = 0;

  /**
   * Shared in/out for the field: io[0..2] = point, io[3] = distance,
   * io[4] = material of the nearest surface. Public for the mesher.
   */
  readonly io = new Float64Array(8);

  private prims = new Float64Array(0);
  private feats = new Float64Array(0);
  private cellStart = new Int32Array(1);
  private cellFeat = new Int32Array(0);
  private ncell = 1;
  /** Nothing outside the 3×3 cells around a point can be closer than this, m. */
  private bound = 1;
  private drafts: Draft[] = [];
  private current: Draft | null = null;
  private readonly n1: PeriodicNoise;
  private readonly n2: PeriodicNoise;
  private readonly gn: PeriodicNoise;
  private readonly lattice1: number;
  private readonly lattice2: number;
  private readonly groundLattice: number;
  private readonly tmp = new Vec3();
  private readonly down = new Vec3(0, -1, 0);
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };
  private readonly rayP = new Vec3();

  /**
   * @param period tile size, m (a multiple of the 128 m render chunk)
   * @param cell feature grid cell, m (divides period; every feature must fit in a sphere of radius < cell)
   */
  constructor(
    readonly seed: number,
    readonly period: number,
    readonly cell: number,
  ) {
    this.ncell = Math.round(period / cell);
    // Rock noise: two octaves (~14 m and ~6 m) whose lattices divide the period.
    this.lattice1 = period / Math.round(period / 14);
    this.lattice2 = period / Math.round(period / 6.1);
    this.groundLattice = period / Math.round(period / 48);
    this.n1 = new PeriodicNoise(seed, Math.round(period / this.lattice1), 1);
    this.n2 = new PeriodicNoise(seed, Math.round(period / this.lattice2), 2);
    this.gn = new PeriodicNoise(seed, Math.round(period / this.groundLattice), 3);
  }

  // ------------------------------------------------------- construction API

  protected begin(opts: FeatureOptions): void {
    this.current = { opts, prims: [], bounds: [] };
  }

  /** Add a primitive to the current feature. `params` as documented on the PRIM_* constants. */
  protected prim(type: number, op: number, k: number, ...params: number[]): void {
    const d = this.current!;
    const p = params.slice();
    let b: number[];
    switch (type) {
      case PRIM_SPHERE:
        b = [p[0], p[1], p[2], p[3]];
        break;
      case PRIM_ELLIPSOID:
        b = [p[0], p[1], p[2], Math.max(p[3], p[4], p[5])];
        break;
      case PRIM_CAPSULE: {
        const dx = p[3] - p[0], dy = p[4] - p[1], dz = p[5] - p[2];
        const l2 = dx * dx + dy * dy + dz * dz;
        p[7] = l2 > 1e-12 ? 1 / l2 : 0;
        b = [(p[0] + p[3]) / 2, (p[1] + p[4]) / 2, (p[2] + p[5]) / 2, Math.sqrt(l2) / 2 + p[6]];
        break;
      }
      case PRIM_TORUS:
        b = [p[0], p[1], p[2], p[6] + p[7]];
        break;
      case PRIM_BOX:
        b = [p[0], p[1], p[2], Math.hypot(p[3], p[4], p[5])];
        break;
      case PRIM_CONE: {
        // Needs |r1 - r2| < h: clamp the wider end if not.
        if (Math.abs(p[3] - p[4]) > p[5] * 0.9) {
          if (p[3] > p[4]) p[3] = p[4] + p[5] * 0.9;
          else p[4] = p[3] + p[5] * 0.9;
        }
        const bb = (p[3] - p[4]) / p[5];
        p[6] = Math.sqrt(1 - bb * bb);
        p[7] = bb;
        // Inside the hull of the two end spheres.
        b = [p[0], p[1] + p[5] / 2, p[2], p[5] / 2 + Math.max(p[3], p[4])];
        break;
      }
      case PRIM_CYLINDER:
        b = [p[0], p[1], p[2], Math.hypot(p[3], p[4])];
        break;
      default:
        throw new Error(`unknown primitive ${type}`);
    }
    while (p.length < PRIM_STRIDE - 3) p.push(0);
    d.prims.push([type, op, k, ...p]);
    if (d.prims.length === 1 || op === OP_UNION || op === OP_SMOOTH_UNION) d.bounds.push(b);
  }

  protected end(): void {
    const d = this.current!;
    if (d.prims.length) this.drafts.push(d);
    this.current = null;
  }

  /** Pack all features into the query tables. Call once, after adding every feature. */
  protected finalize(): void {
    const P = this.period, C = this.cell, NC = this.ncell;
    const nPrims = this.drafts.reduce((n, d) => n + d.prims.length, 0);
    this.prims = new Float64Array(nPrims * PRIM_STRIDE);
    this.feats = new Float64Array(this.drafts.length * FEAT_STRIDE);
    const lists: number[][] = Array.from({ length: NC * NC }, () => []);
    let pi = 0;
    let maxR = 0;
    this.drafts.forEach((d, fi) => {
      // Bounding sphere: centre of the bounds' AABB, radius covering them all.
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (const [x, y, z, r] of d.bounds) {
        x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); z0 = Math.min(z0, z - r);
        x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); z1 = Math.max(z1, z + r);
      }
      let cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      let cz = (z0 + z1) / 2;
      let r = 0;
      for (const [x, y, z, br] of d.bounds) r = Math.max(r, Math.hypot(x - cx, y - cy, z - cz) + br);
      const o = d.opts;
      r += 1.5 * (o.noise ?? 0) + (o.ledge ?? 0);
      // Move the feature into the canonical tile.
      const sx = -Math.floor(cx / P) * P, sz = -Math.floor(cz / P) * P;
      cx += sx;
      cz += sz;
      const f = fi * FEAT_STRIDE;
      this.feats[f + F_START] = pi;
      this.feats[f + F_COUNT] = d.prims.length;
      this.feats[f + F_CX] = cx;
      this.feats[f + F_CX + 1] = cy;
      this.feats[f + F_CX + 2] = cz;
      this.feats[f + F_RADIUS] = r;
      this.feats[f + F_EXACT] = o.exact ? 1 : 0;
      this.feats[f + F_NOISE] = o.noise ?? 0;
      this.feats[f + F_JOIN] = o.join ?? 0;
      this.feats[f + F_MATERIAL] = o.material;
      this.feats[f + F_LEDGE] = o.ledge ?? 0;
      maxR = Math.max(maxR, r + (o.join ?? 0) * 0.25);
      for (const p of d.prims) {
        p[3] += sx;
        p[5] += sz;
        if (p[0] === PRIM_CAPSULE) {
          p[6] += sx;
          p[8] += sz;
        }
        this.prims.set(p, pi * PRIM_STRIDE);
        pi++;
      }
      const ci = Math.min(NC - 1, Math.floor(cx / C)), ck = Math.min(NC - 1, Math.floor(cz / C));
      lists[ck * NC + ci].push(fi);
    });
    if (maxR > C - 2) throw new Error(`${this.id}: a feature (radius ${maxR.toFixed(1)} m) is too big for ${C} m cells`);
    this.bound = C - maxR;
    this.cellStart = new Int32Array(NC * NC + 1);
    const flat: number[] = [];
    lists.forEach((l, i) => {
      this.cellStart[i] = flat.length;
      flat.push(...l);
    });
    this.cellStart[NC * NC] = flat.length;
    this.cellFeat = new Int32Array(flat);
    // Drafts stay (already shifted into the tile), so a world can query the
    // field, add more features where there is room, and finalize again.
  }

  /**
   * Shrink each opening until its window and approach are clear (by `margin`
   * m), or drop it. Call after the final finalize().
   */
  protected verifyOpenings(margin = 0.8): void {
    const p = new Vec3();
    const ok = (o: Opening): boolean => {
      const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw), rx = fz, rz = -fx;
      for (let a = -2; a <= 2; a++) {
        for (let b = -2; b <= 2; b++) {
          for (const t of [-4, 0, 4]) {
            p.set(o.x + rx * (a / 2) * (o.width / 2) + fx * t, o.y + (b / 2) * (o.height / 2), o.z + rz * (a / 2) * (o.width / 2) + fz * t);
            if (this.distance(p) < margin) return false;
          }
        }
      }
      return true;
    };
    const kept: Opening[] = [];
    for (const o of this.openings) {
      for (let k = 0; k < 6; k++) {
        if (ok(o)) {
          kept.push(o);
          break;
        }
        o.width *= 0.85;
        o.height *= 0.85;
        if (o.width < 2.5 || o.height < 2.5) break;
      }
    }
    this.openings.length = 0;
    this.openings.push(...kept);
  }

  /** Number of features and primitives (debug overlay, tests). */
  get stats(): { features: number; prims: number } {
    return { features: this.feats.length / FEAT_STRIDE, prims: this.prims.length / PRIM_STRIDE };
  }

  // ------------------------------------------------------------ WorldQuery

  distance(p: Vec3): number {
    const io = this.io;
    io[0] = p.x;
    io[1] = p.y;
    io[2] = p.z;
    this.field(0);
    return io[3];
  }

  normal(p: Vec3, out: Vec3): Vec3 {
    this.gradient(p.x, p.y, p.z, 0, out);
    return out;
  }

  /** Sphere trace (the field is a lower bound up to its Lipschitz factor). Returns a shared Hit. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    const p = this.rayP, io = this.io;
    let t = 0;
    for (let i = 0; i < 800 && t <= maxDist; i++) {
      p.copy(origin).addScaled(dir, t);
      io[0] = p.x;
      io[1] = p.y;
      io[2] = p.z;
      this.field(0);
      const d = io[3];
      if (d < 0.02) {
        this.hit.distance = t;
        this.hit.point.copy(p);
        this.normal(p, this.hit.normal);
        return this.hit;
      }
      t += d > 0.05 ? d * 0.65 : 0.03;
    }
    return null;
  }

  /** Height of the first solid surface below (x, y, z), m (shadows, chase camera). */
  floorBelow(x: number, y: number, z: number): number {
    const o = this.tmp.set(x, y, z);
    const limit = Math.max(1, y - Math.max(this.seaY, this.yMin - 50));
    const hit = this.raycast(o, this.down, limit);
    return hit ? y - hit.distance : Math.max(this.seaY, this.yMin);
  }

  /** Top surface under (x, z), m. */
  groundHeight(x: number, z: number): number {
    return this.floorBelow(x, this.yMax + 20, z);
  }

  /** Field gradient (unit) at a point; mode 0 = physics, 1 = meshed surface only. */
  gradient(x: number, y: number, z: number, mode: number, out: Vec3): void {
    const io = this.io, e = 0.02;
    io[0] = x + e; io[1] = y; io[2] = z;
    this.field(mode);
    const xp = io[3];
    io[0] = x - e;
    this.field(mode);
    const xm = io[3];
    io[0] = x; io[1] = y + e;
    this.field(mode);
    const yp = io[3];
    io[1] = y - e;
    this.field(mode);
    const ym = io[3];
    io[1] = y; io[2] = z + e;
    this.field(mode);
    const zp = io[3];
    io[2] = z - e;
    this.field(mode);
    const zm = io[3];
    out.set(xp - xm, yp - ym, zp - zm);
    const l = out.length();
    if (l > 1e-9) out.scale(1 / l);
    else out.set(0, 1, 0);
  }

  /** Meshed-surface field at io[0..2] into io[3] (material in io[4]). For the mesher. */
  sampleMeshed(): void {
    this.field(1);
  }

  // ------------------------------------------------------------ the field

  /**
   * Signed distance at io[0..2] into io[3], nearest material into io[4].
   * mode 0: everything solid (physics). mode 1: only what the surface-net
   * mesher draws (no exact parts, no sea plane).
   */
  private field(mode: number): void {
    const io = this.io;
    const py = io[1];
    const P = this.period;
    const wx = io[0] - Math.floor(io[0] / P) * P;
    const wz = io[2] - Math.floor(io[2] / P) * P;
    let best = 1e9;
    let mat = MAT_GROUND;
    if (this.groundAmp >= 0) {
      const g = this.gn.io;
      g[0] = wx / this.groundLattice;
      g[1] = 0.37;
      g[2] = wz / this.groundLattice;
      this.gn.sample();
      let amp = this.groundAmp;
      if (this.flatR1 > 0) {
        let fx = wx - this.flatX, fz = wz - this.flatZ;
        fx -= Math.floor(fx / P + 0.5) * P;
        fz -= Math.floor(fz / P + 0.5) * P;
        const t = (Math.sqrt(fx * fx + fz * fz) - this.flatR0) / (this.flatR1 - this.flatR0);
        amp *= t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      }
      best = py - (this.groundY + amp * g[3]);
    }
    if (mode === 0 && py - this.seaY < best) {
      best = py - this.seaY;
      mat = MAT_SEA;
    }
    const C = this.cell, NC = this.ncell;
    let ci = Math.floor(wx / C) | 0;
    let ck = Math.floor(wz / C) | 0;
    if (ci >= NC) ci = NC - 1;
    if (ck >= NC) ck = NC - 1;
    const F = this.feats, R = this.prims, start = this.cellStart, list = this.cellFeat;
    for (let dk = -1; dk <= 1; dk++) {
      let kz = ck + dk;
      let qz = wz;
      if (kz < 0) {
        kz += NC;
        qz += P;
      } else if (kz >= NC) {
        kz -= NC;
        qz -= P;
      }
      for (let di = -1; di <= 1; di++) {
        let kx = ci + di;
        let qx = wx;
        if (kx < 0) {
          kx += NC;
          qx += P;
        } else if (kx >= NC) {
          kx -= NC;
          qx -= P;
        }
        const cell = kz * NC + kx;
        for (let j = start[cell], je = start[cell + 1]; j < je; j++) {
          const f = list[j] * FEAT_STRIDE;
          if (mode === 1 && F[f + F_EXACT] === 1) continue;
          const join = F[f + F_JOIN];
          {
            const bx = qx - F[f + F_CX], by = py - F[f + F_CX + 1], bz = qz - F[f + F_CX + 2];
            if (Math.sqrt(bx * bx + by * by + bz * bz) - F[f + F_RADIUS] - join * 0.25 > best) continue;
          }
          let acc = 1e9;
          const p0 = F[f + F_START], pn = F[f + F_COUNT];
          for (let k = 0; k < pn; k++) {
            const o = (p0 + k) * PRIM_STRIDE;
            const type = R[o];
            let d = 0;
            const dx = qx - R[o + 3], dy = py - R[o + 4], dz = qz - R[o + 5];
            if (type === PRIM_SPHERE) {
              d = Math.sqrt(dx * dx + dy * dy + dz * dz) - R[o + 6];
            } else if (type === PRIM_ELLIPSOID) {
              const ax = dx / R[o + 6], ay = dy / R[o + 7], az = dz / R[o + 8];
              const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
              const bx = ax / R[o + 6], by = ay / R[o + 7], bz = az / R[o + 8];
              const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
              d = k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -R[o + 7];
            } else if (type === PRIM_CAPSULE) {
              const ex = R[o + 6] - R[o + 3], ey = R[o + 7] - R[o + 4], ez = R[o + 8] - R[o + 5];
              let h = (dx * ex + dy * ey + dz * ez) * R[o + 10];
              h = h < 0 ? 0 : h > 1 ? 1 : h;
              const rx = dx - ex * h, ry = dy - ey * h, rz = dz - ez * h;
              d = Math.sqrt(rx * rx + ry * ry + rz * rz) - R[o + 9];
            } else if (type === PRIM_TORUS) {
              const a = dx * R[o + 6] + dy * R[o + 7] + dz * R[o + 8];
              let rr = dx * dx + dy * dy + dz * dz - a * a;
              rr = rr > 0 ? Math.sqrt(rr) - R[o + 9] : -R[o + 9];
              d = Math.sqrt(rr * rr + a * a) - R[o + 10];
            } else if (type === PRIM_BOX) {
              const cyw = R[o + 10], syw = R[o + 11], cp = R[o + 12], sp = R[o + 13], rnd = R[o + 9];
              const lx = dx * cyw - dz * syw;
              const ly = -dx * sp * syw + dy * cp - dz * sp * cyw;
              const lz = dx * cp * syw + dy * sp + dz * cp * cyw;
              const qx2 = (lx < 0 ? -lx : lx) - R[o + 6] + rnd;
              const qy2 = (ly < 0 ? -ly : ly) - R[o + 7] + rnd;
              const qz2 = (lz < 0 ? -lz : lz) - R[o + 8] + rnd;
              const ox = qx2 > 0 ? qx2 : 0, oy = qy2 > 0 ? qy2 : 0, oz = qz2 > 0 ? qz2 : 0;
              const m = qx2 > qy2 ? (qx2 > qz2 ? qx2 : qz2) : qy2 > qz2 ? qy2 : qz2;
              d = Math.sqrt(ox * ox + oy * oy + oz * oz) + (m < 0 ? m : 0) - rnd;
            } else if (type === PRIM_CONE) {
              const r1 = R[o + 6], r2 = R[o + 7], hgt = R[o + 8], a = R[o + 9], b = R[o + 10];
              const qr = Math.sqrt(dx * dx + dz * dz);
              const kk = -qr * b + dy * a;
              if (kk < 0) d = Math.sqrt(qr * qr + dy * dy) - r1;
              else if (kk > a * hgt) d = Math.sqrt(qr * qr + (dy - hgt) * (dy - hgt)) - r2;
              else d = qr * a + dy * b - r1;
            } else {
              // PRIM_CYLINDER
              const rnd = R[o + 8];
              const ax = Math.sqrt(dx * dx + dz * dz) - R[o + 6] + rnd;
              const ay = (dy < 0 ? -dy : dy) - R[o + 7] + rnd;
              const mx = ax > ay ? ax : ay;
              const ox = ax > 0 ? ax : 0, oy = ay > 0 ? ay : 0;
              d = (mx < 0 ? mx : 0) + Math.sqrt(ox * ox + oy * oy) - rnd;
            }
            if (k === 0) {
              acc = d;
              continue;
            }
            const op = R[o + 1], sk = R[o + 2];
            if (op === OP_UNION) {
              if (d < acc) acc = d;
            } else if (op === OP_SMOOTH_UNION) {
              const diff = acc - d;
              const hh = sk - (diff < 0 ? -diff : diff);
              acc = (d < acc ? d : acc) - (hh > 0 ? (hh * hh * 0.25) / sk : 0);
            } else if (op === OP_SUBTRACT) {
              if (-d > acc) acc = -d;
            } else if (op === OP_SMOOTH_SUBTRACT) {
              const sum = acc + d;
              const hh = sk - (sum < 0 ? -sum : sum);
              acc = (-d > acc ? -d : acc) + (hh > 0 ? (hh * hh * 0.25) / sk : 0);
            } else if (d > acc) {
              acc = d; // OP_INTERSECT
            }
          }
          // Rock noise, faded out far from the surface (it only matters near it).
          const amp = F[f + F_NOISE];
          if (amp > 0 && acc < amp * 3 + 2) {
            const a = this.n1.io;
            a[0] = qx / this.lattice1;
            a[1] = py / this.lattice1;
            a[2] = qz / this.lattice1;
            this.n1.sample();
            const b = this.n2.io;
            b[0] = qx / this.lattice2;
            b[1] = py / this.lattice2;
            b[2] = qz / this.lattice2;
            this.n2.sample();
            let w = (amp * 3 + 2 - acc) * 0.5;
            w = w > 1 ? 1 : w;
            acc -= amp * (a[3] + 0.4 * b[3]) * w;
          }
          const ledge = F[f + F_LEDGE];
          if (ledge > 0) {
            const t = py / this.ledgePitch;
            const fr = t - Math.floor(t);
            // Rounded ledges, creased where the strata meet.
            acc -= ledge * 4 * fr * (1 - fr);
          }
          if (acc < best) mat = F[f + F_MATERIAL];
          if (join > 0) {
            const diff = best - acc;
            const hh = join - (diff < 0 ? -diff : diff);
            best = (acc < best ? acc : best) - (hh > 0 ? (hh * hh * 0.25) / join : 0);
          } else if (acc < best) {
            best = acc;
          }
        }
      }
    }
    io[3] = best < this.bound ? best : this.bound;
    io[4] = mat;
  }

  /**
   * The field's refills of rarely-seen branches are too cold for V8 to
   * optimize on its own, and unoptimized code boxes every double. Exercise
   * everything up front so the physics path is garbage-free from the start.
   */
  protected warmUp(): void {
    const n = new Vec3();
    for (let i = 0; i < 4000; i++) {
      const x = (i * 37.3) % this.period, z = (i * 91.7) % this.period, y = this.yMin + ((i * 13.1) % (this.yMax - this.yMin));
      this.io[0] = x;
      this.io[1] = y;
      this.io[2] = z;
      this.field(i & 1);
      if (i % 8 === 0) this.gradient(x, y, z, 0, n);
    }
  }

  // ------------------------------------------------------- mesher support

  /** Exact features whose centre lies in [x0, x0+size) × [z0, z0+size) of the canonical tile. */
  exactFeaturesIn(x0: number, z0: number, size: number): { material: number; prims: Float64Array }[] {
    const out: { material: number; prims: Float64Array }[] = [];
    const F = this.feats;
    for (let f = 0; f < F.length; f += FEAT_STRIDE) {
      if (F[f + F_EXACT] !== 1) continue;
      const cx = F[f + F_CX], cz = F[f + F_CX + 2];
      if (cx < x0 || cx >= x0 + size || cz < z0 || cz >= z0 + size) continue;
      const s = F[f + F_START] * PRIM_STRIDE;
      out.push({ material: F[f + F_MATERIAL], prims: this.prims.slice(s, s + F[f + F_COUNT] * PRIM_STRIDE) });
    }
    return out;
  }

  /** Vertex color for a meshed surface point (linear RGB into out[o..o+2]). */
  abstract shade(x: number, y: number, z: number, nx: number, ny: number, nz: number, material: number, out: Float32Array, o: number): void;
  /** Color of an exact part (linear RGB into out[o..o+2]). */
  abstract partColor(material: number, out: Float32Array, o: number): void;
}

/** sRGB hex -> linear RGB into out[o..o+2]. */
export function hexToLinear(hex: number, out: Float32Array | number[], o: number): void {
  for (let k = 0; k < 3; k++) {
    const c = ((hex >> (16 - 8 * k)) & 255) / 255;
    out[o + k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
}
