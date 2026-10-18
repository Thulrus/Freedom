/**
 * "Rolling hills" training world: a seeded, effectively infinite heightfield
 * with lakes, ridged mountains, forests and boulders.
 *
 * What you see is what you hit:
 * - The collision surface is the triangulated 2 m height grid, the same
 *   vertices and the same triangle split as the finest (LOD 0) mesh, which
 *   always covers the chunks around the drone.
 * - Props (trees, rocks) are placed by one deterministic function per 8 m
 *   cell. The renderer and the collision query both call it.
 *
 * Collision runs at 500 Hz, so the query path is written the same way as
 * the sim: no allocation, and doubles cross non-inlined calls only through
 * typed arrays (see DEVLOG, "Zero-allocation lessons").
 */
import { Vec3, type Hit } from '../sim';
import { CHUNK_SIZE, MAX_PROPS, PROP_STRIDE, type ChunkGenerator, type ChunkJob } from './chunks';
import { Noise } from './noise';
import type { GameWorld, TerrainPalette } from './recipes';

/** Collision / LOD 0 grid spacing, m. */
export const GRID = 2;
/** Lakes are flat solid water at this height, m. */
export const WATER_LEVEL = 0;
/** Prop cell size, m (at most one prop per cell). */
export const PROP_CELL = 8;
const CELLS_PER_CHUNK = CHUNK_SIZE / PROP_CELL;
const GRID_PER_CHUNK = CHUNK_SIZE / GRID;

export const PROP_PINE = 0;
export const PROP_BROADLEAF = 1;
export const PROP_ROCK = 2;

/**
 * Prop shapes as fractions of their size parameters (a, b). The renderer
 * builds its unit meshes from these numbers; collision uses the same ones,
 * shrunk slightly to the faceted mesh's inscribed size.
 *   Pine: a = crown radius, b = height. Trunk to 0.3 b; cone from 0.2 b to b.
 *   Broadleaf: a = b = height. Trunk to 0.55 b; sphere crown centered at 0.62 b.
 *   Rock: a = b = radius. Sphere centered 0.1 a above the base.
 */
export const PROP_SHAPE = {
  pineTrunkTop: 0.3,
  pineTrunkRadius: 0.12, // x crown radius
  pineConeBase: 0.2,
  broadTrunkTop: 0.55,
  broadTrunkRadius: 0.06, // x height
  broadCrownY: 0.62,
  broadCrownRadius: 0.36, // x height
  rockCenterY: 0.1,
} as const;
/** Collision size relative to the mesh's outer size (7-sided cone, icosphere, dodecahedron). */
const CONE_INSET = 0.93;
const SPHERE_INSET = 0.95;
const ROCK_INSET = 0.85;
/** Tallest prop, m (pine at b = 13). */
const MAX_PROP_HEIGHT = 14;
/** Props outside the 3x3 cells around a point are at least this far away, m. */
const PROP_BOUND = 5;

/** Spawn pad: flattened radius, blend radius, and prop-free radius, m. */
const SPAWN_FLAT = 16;
const SPAWN_BLEND = 70;
const SPAWN_CLEAR = 30;

const smooth01 = (t: number): number => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function srgbToLinear(hex: number, out: Float32Array, o: number): void {
  for (let k = 0; k < 3; k++) {
    const c = ((hex >> (16 - 8 * k)) & 255) / 255;
    out[o + k] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
}

export class TerrainWorld implements GameWorld, ChunkGenerator {
  readonly id = 'hills' as const;
  readonly spawn: Vec3;
  readonly spawnYaw = 0;
  /** Terrain height at the spawn pad, m. */
  readonly spawnHeight: number;

  private readonly noise: Noise;
  /** Scratch for rawAt/vertex: [x, z, raw, clamped]. */
  private readonly t = new Float64Array(4);
  /** Scratch for surface: [x, z, h, dh/dx, dh/dz]. */
  private readonly s = new Float64Array(5);
  /** One placed prop: kind, x, baseY, z, a, b, yaw, tint. */
  private readonly p = new Float64Array(PROP_STRIDE);
  /** distance() result. */
  private readonly r = new Float64Array(1);
  /** Props in the 3x3 cells around the last query point. */
  private readonly cache = new Float64Array(9 * PROP_STRIDE);
  private cacheN = 0;
  private cacheCx = 0;
  private cacheCz = 0;
  private cacheValid = false;
  private readonly tmp = new Vec3();
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };
  /** Linear-RGB palette: shallow, deep, sand, grass, grassAlt, rock, snow. */
  private readonly pal = new Float32Array(21);
  /** True only while measuring the natural height at the spawn point. */
  private unflattened = true;

  constructor(
    readonly seed: number,
    readonly palette: TerrainPalette,
  ) {
    this.noise = new Noise(seed);
    const p = palette;
    [p.waterShallow, p.waterDeep, p.sand, p.grass, p.grassAlt, p.rock, p.snow].forEach((hex, i) => srgbToLinear(hex, this.pal, i * 3));
    this.t[0] = 0;
    this.t[1] = 0;
    this.rawAt();
    this.unflattened = false;
    this.spawnHeight = Math.max(this.t[2], WATER_LEVEL + 3);
    this.spawn = new Vec3(0, this.spawnHeight, 0);
    this.warmUp();
  }

  /**
   * The prop cache refills only when the drone crosses an 8 m cell, which is
   * too rare for V8 to optimize that code on its own, and unoptimized code
   * boxes every double it touches. Exercising it here (a few ms, over cells
   * near spawn so every branch is seen) gets it compiled up front, so the
   * physics path stays garbage-free from the first flight.
   */
  private warmUp(): void {
    for (let i = 0; i < 800; i++) this.fillCache((i % 40) * 3 - 60, Math.floor(i / 40) * 3 - 30);
    this.cacheValid = false;
  }

  // ------------------------------------------------------------ WorldQuery

  distance(p: Vec3): number {
    this.computeDistance(p);
    return this.r[0];
  }

  /** Gradient of the distance field by central differences. */
  normal(p: Vec3, out: Vec3): Vec3 {
    const e = 1e-3;
    const t = this.tmp;
    const r = this.r;
    t.set(p.x + e, p.y, p.z);
    this.computeDistance(t);
    const xp = r[0];
    t.x = p.x - e;
    this.computeDistance(t);
    const xm = r[0];
    t.set(p.x, p.y + e, p.z);
    this.computeDistance(t);
    const yp = r[0];
    t.y = p.y - e;
    this.computeDistance(t);
    const ym = r[0];
    t.set(p.x, p.y, p.z + e);
    this.computeDistance(t);
    const zp = r[0];
    t.z = p.z - e;
    this.computeDistance(t);
    const zm = r[0];
    out.set(xp - xm, yp - ym, zp - zm);
    const l = out.length();
    return l > 1e-9 ? out.scale(1 / l) : out.set(0, 1, 0);
  }

  /**
   * Conservative sphere trace (steps capped at 4 m, because the heightfield
   * distance is only exact near the surface), refined by bisection.
   * Returns a shared Hit (overwritten by the next call).
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    const p = this.hit.point;
    let t = 0;
    let prev = 0;
    for (let i = 0; i < 1024 && t <= maxDist; i++) {
      p.copy(origin).addScaled(dir, t);
      this.computeDistance(p);
      const d = this.r[0];
      if (d < 1e-3) {
        if (d < 0) {
          let lo = prev, hi = t;
          for (let k = 0; k < 20; k++) {
            const mid = (lo + hi) / 2;
            p.copy(origin).addScaled(dir, mid);
            this.computeDistance(p);
            if (this.r[0] < 0) hi = mid;
            else lo = mid;
          }
          t = hi;
          p.copy(origin).addScaled(dir, t);
        }
        this.hit.distance = t;
        this.normal(p, this.hit.normal);
        return this.hit;
      }
      prev = t;
      t += d > 4 ? 4 : d < 0.02 ? 0.02 : d * 0.9;
    }
    return null;
  }

  /** Visible ground height (terrain or water surface, ignoring props) at (x, z), m. */
  groundHeight(x: number, z: number): number {
    this.s[0] = x;
    this.s[1] = z;
    this.surface();
    return this.s[2];
  }

  // ------------------------------------------------------------- the field

  /** Unclamped terrain height at (t[0], t[1]) into t[2]. */
  private rawAt(): void {
    const t = this.t;
    const io = this.noise.io;
    const x = t[0], z = t[1];
    io[0] = x / 1800;
    io[1] = z / 1800;
    this.noise.fbm(3, 1, 0);
    const continent = io[2];
    io[0] = x / 320;
    io[1] = z / 320;
    this.noise.fbm(5, 2, 0);
    const hills = io[2];
    io[0] = x / 900;
    io[1] = z / 900;
    this.noise.fbm(5, 3, 1);
    const ridge = io[2];
    // Smoothsteps are written out: a helper call would box its double argument.
    let m = (continent - 0.05) / 0.45;
    m = m <= 0 ? 0 : m >= 1 ? 1 : m * m * (3 - 2 * m);
    const mountains = m;
    let h = 8 + continent * 40 + hills * 18 + ridge * ridge * 230 * mountains;
    if (!this.unflattened) {
      // Flat launch pad at the origin, blended smoothly into the terrain.
      const r = Math.sqrt(x * x + z * z);
      if (r < SPAWN_BLEND) {
        let k = (r - SPAWN_FLAT) / (SPAWN_BLEND - SPAWN_FLAT);
        k = k <= 0 ? 0 : k * k * (3 - 2 * k);
        h = this.spawnHeight + (h - this.spawnHeight) * k;
      }
    }
    t[2] = h;
  }

  /** Grid vertex (ix, iz) (units of GRID): raw height into t[2], surface height into t[3]. */
  private vertex(ix: number, iz: number): void {
    const t = this.t;
    t[0] = ix * GRID;
    t[1] = iz * GRID;
    this.rawAt();
    t[3] = t[2] > WATER_LEVEL ? t[2] : WATER_LEVEL;
  }

  /**
   * Surface height and slope at (s[0], s[1]) on the triangulated grid,
   * exactly as the LOD 0 mesh draws it: s[2] = h, s[3] = dh/dx, s[4] = dh/dz.
   * Each grid cell splits along the (i+1, j) - (i, j+1) diagonal.
   */
  private surface(): void {
    const s = this.s;
    const gx = s[0] / GRID, gz = s[1] / GRID;
    const fx0 = Math.floor(gx), fz0 = Math.floor(gz);
    const ix = fx0, iz = fz0;
    const fx = gx - fx0, fz = gz - fz0;
    const t = this.t;
    this.vertex(ix + 1, iz);
    const hb = t[3];
    this.vertex(ix, iz + 1);
    const hc = t[3];
    if (fx + fz <= 1) {
      this.vertex(ix, iz);
      const ha = t[3];
      s[2] = ha + (hb - ha) * fx + (hc - ha) * fz;
      s[3] = (hb - ha) / GRID;
      s[4] = (hc - ha) / GRID;
    } else {
      this.vertex(ix + 1, iz + 1);
      const hd = t[3];
      s[2] = hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
      s[3] = (hd - hc) / GRID;
      s[4] = (hd - hb) / GRID;
    }
  }

  /**
   * The prop (if any) in cell (cix, ciz), written to this.p with absolute
   * coordinates. Returns its kind, or -1 for an empty cell.
   */
  private placeProp(cix: number, ciz: number): number {
    const io = this.noise.io;
    this.noise.cellRandom(cix, ciz, 7);
    const r0 = io[3], r1 = io[4], r2 = io[5], r3 = io[6];
    const x = cix * PROP_CELL + 1 + r0 * (PROP_CELL - 2);
    const z = ciz * PROP_CELL + 1 + r1 * (PROP_CELL - 2);
    if (x * x + z * z < SPAWN_CLEAR * SPAWN_CLEAR) return -1;
    // Forests and clearings.
    io[0] = x / 260;
    io[1] = z / 260;
    this.noise.fbm(2, 5, 0);
    let f = (io[2] + 0.05) / 0.5;
    f = f <= 0 ? 0 : f >= 1 ? 1 : f * f * (3 - 2 * f);
    const forest = f * 0.6;
    const isTree = r2 < forest;
    const isRock = !isTree && r2 > 0.965;
    if (!isTree && !isRock) return -1;
    const s = this.s;
    s[0] = x;
    s[1] = z;
    this.surface();
    const h = s[2];
    const g2 = s[3] * s[3] + s[4] * s[4];
    const k = r3 * 7 - Math.floor(r3 * 7); // a second, roughly independent random
    const p = this.p;
    let kind = -1;
    if (isTree && h > WATER_LEVEL + 1.5 && g2 < 0.5 && h < 150 + r3 * 30) {
      const pineChance = 0.3 + h / 180;
      if (k < pineChance) {
        kind = PROP_PINE;
        const height = 6 + r3 * 7;
        p[4] = height * (0.22 + 0.08 * k);
        p[5] = height;
      } else {
        kind = PROP_BROADLEAF;
        p[4] = p[5] = 5 + r3 * 4.5;
      }
      p[2] = h - 0.25; // sink the trunk a little on slopes
    } else if (isRock && h > WATER_LEVEL + 0.3 && g2 < 1.2) {
      kind = PROP_ROCK;
      p[4] = p[5] = 0.6 + r3 * r3 * 2.2;
      p[2] = h;
    }
    if (kind < 0) return -1;
    p[0] = kind;
    p[1] = x;
    p[3] = z;
    p[6] = k * 6.283185307179586;
    p[7] = r1 * 13 - Math.floor(r1 * 13);
    return kind;
  }

  private fillCache(cix: number, ciz: number): void {
    let n = 0;
    const c = this.cache, p = this.p;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (this.placeProp(cix + dx, ciz + dz) < 0) continue;
        const o = n * PROP_STRIDE;
        for (let k = 0; k < PROP_STRIDE; k++) c[o + k] = p[k];
        n++;
      }
    }
    this.cacheN = n;
    this.cacheCx = cix;
    this.cacheCz = ciz;
    this.cacheValid = true;
  }

  /** Signed distance at p into r[0]. */
  private computeDistance(p: Vec3): void {
    const px = p.x, py = p.y, pz = p.z;
    const s = this.s;
    s[0] = px;
    s[1] = pz;
    this.surface();
    const h = s[2], gx = s[3], gz = s[4];
    // Distance to the plane of the triangle under p.
    let best = (py - h) / Math.sqrt(1 + gx * gx + gz * gz);

    const cix = Math.floor(px / PROP_CELL), ciz = Math.floor(pz / PROP_CELL);
    if (!this.cacheValid || cix !== this.cacheCx || ciz !== this.cacheCz) this.fillCache(cix, ciz);
    const c = this.cache;
    const S = PROP_SHAPE;
    for (let i = 0; i < this.cacheN; i++) {
      const o = i * PROP_STRIDE;
      const kind = c[o];
      const dx = px - c[o + 1], dy = py - c[o + 2], dz = pz - c[o + 3];
      const a = c[o + 4], b = c[o + 5];
      const q = Math.sqrt(dx * dx + dz * dz);
      let d = 0;
      if (kind === PROP_ROCK) {
        const cy = dy - S.rockCenterY * a;
        d = Math.sqrt(q * q + cy * cy) - a * ROCK_INSET;
      } else if (kind === PROP_BROADLEAF) {
        const top = S.broadTrunkTop * b;
        const ty = dy < 0 ? dy : dy > top ? dy - top : 0;
        d = Math.sqrt(q * q + ty * ty) - S.broadTrunkRadius * b;
        const cy = dy - S.broadCrownY * b;
        const dc = Math.sqrt(q * q + cy * cy) - S.broadCrownRadius * b * SPHERE_INSET;
        if (dc < d) d = dc;
      } else {
        // Pine: trunk capsule plus a cone, as a 2D distance in (q, y).
        const top = S.pineTrunkTop * b;
        const ty = dy < 0 ? dy : dy > top ? dy - top : 0;
        d = Math.sqrt(q * q + ty * ty) - S.pineTrunkRadius * a;
        const y0 = S.pineConeBase * b;
        const R = a * CONE_INSET;
        const H = b - y0;
        const yy = dy - y0;
        // Base disc edge.
        const qc = q < R ? q : R;
        const d1 = (q - qc) * (q - qc) + yy * yy;
        // Slant edge from (R, 0) to (0, H).
        const wq = q - R;
        let u = (-wq * R + yy * H) / (R * R + H * H);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const eq = wq + R * u, ey = yy - H * u;
        const d2 = eq * eq + ey * ey;
        const inside = yy >= 0 && yy <= H && q * H <= R * (H - yy);
        const dc = Math.sqrt(d1 < d2 ? d1 : d2);
        const sd = inside ? -dc : dc;
        if (sd < d) d = sd;
      }
      if (d < best) best = d;
    }
    // Props in cells beyond the 3x3 block can't be closer than this.
    const above = py - h - MAX_PROP_HEIGHT;
    const bound = above > PROP_BOUND ? above : PROP_BOUND;
    this.r[0] = best < bound ? best : bound;
  }

  // ------------------------------------------------------- chunk generation

  /**
   * One slice of chunk work. Phase 0 samples one row of the height grid per
   * call (with a one-vertex border, so normals and slopes at the edges come
   * from the same global samples as the neighbouring chunk's: no seams).
   * Phase 1 writes one row of vertices, normals and colors per call, then
   * the skirts. Phase 2 places one row of prop cells per call (only the
   * first time a chunk is built). Every slice is well under 0.1 ms on a
   * desktop, so the per-frame budget is never overshot by much.
   */
  step(job: ChunkJob): boolean {
    const m = job.mesh;
    const c = job.chunk;
    const N = m.segs;
    const stride = GRID_PER_CHUNK / N; // grid units between vertices
    if (job.phase === 0) {
      const e = N + 3;
      const j = job.row; // 0..N+2 = grid rows -1..N+1
      const t = this.t;
      const iz = c.cz * GRID_PER_CHUNK + (j - 1) * stride;
      const ix0 = c.cx * GRID_PER_CHUNK - stride;
      for (let i = 0; i < e; i++) {
        this.vertex(ix0 + i * stride, iz);
        m.raw[j * e + i] = t[2];
        m.ext[j * e + i] = t[3];
      }
      if (++job.row >= e) {
        job.phase = 1;
        job.row = 0;
      }
      return false;
    }
    if (job.phase === 1) {
      this.surfaceRow(job, job.row);
      if (++job.row <= N) return false;
      this.skirts(job);
      job.phase = 2;
      job.row = 0;
      return c.propsReady;
    }
    // Phase 2: props, one row of cells per call.
    const r = job.row;
    if (r === 0) c.propCount = 0;
    const p = this.p;
    const ox = c.cx * CHUNK_SIZE, oz = c.cz * CHUNK_SIZE;
    for (let ci = 0; ci < CELLS_PER_CHUNK; ci++) {
      if (this.placeProp(c.cx * CELLS_PER_CHUNK + ci, c.cz * CELLS_PER_CHUNK + r) < 0) continue;
      if (c.propCount >= MAX_PROPS) break;
      const o = c.propCount++ * PROP_STRIDE;
      const out = c.props;
      for (let k = 0; k < PROP_STRIDE; k++) out[o + k] = p[k];
      out[o + 1] = p[1] - ox;
      out[o + 3] = p[3] - oz;
    }
    if (++job.row >= CELLS_PER_CHUNK) {
      c.propsReady = true;
      return true;
    }
    return false;
  }

  /** Vertices, smooth normals and colors for grid row j, from the sampled height grid. */
  private surfaceRow(job: ChunkJob, j: number): void {
    const m = job.mesh;
    const N = m.segs, n1 = N + 1, e = N + 3;
    const spacing = (GRID_PER_CHUNK / N) * GRID;
    const pos = m.positions, nor = m.normals, col = m.colors, ext = m.ext, raw = m.raw, pal = this.pal;
    const io = this.noise.io;
    const ox = job.chunk.cx * CHUNK_SIZE, oz = job.chunk.cz * CHUNK_SIZE;
    if (j === 0) {
      m.minY = Infinity;
      m.maxY = -Infinity;
    }
    for (let i = 0; i < n1; i++) {
      const v = j * n1 + i;
      const x = (j + 1) * e + (i + 1); // index into the bordered grid
      const y = ext[x];
      const h = raw[x];
      const o = v * 3;
      pos[o] = i * spacing;
      pos[o + 1] = y;
      pos[o + 2] = j * spacing;
      if (y < m.minY) m.minY = y;
      if (y > m.maxY) m.maxY = y;
      const sx = (ext[x + 1] - ext[x - 1]) / (2 * spacing);
      const sz = (ext[x + e] - ext[x - e]) / (2 * spacing);
      const inv = 1 / Math.sqrt(1 + sx * sx + sz * sz);
      nor[o] = -sx * inv;
      nor[o + 1] = inv;
      nor[o + 2] = -sz * inv;
      let r: number, g: number, b: number;
      if (h < WATER_LEVEL) {
        const k = smooth01(-h / 8);
        r = pal[0] + (pal[3] - pal[0]) * k;
        g = pal[1] + (pal[4] - pal[1]) * k;
        b = pal[2] + (pal[5] - pal[2]) * k;
      } else {
        const slope = Math.sqrt(sx * sx + sz * sz);
        io[0] = (ox + pos[o]) / 90;
        io[1] = (oz + pos[o + 2]) / 90;
        this.noise.fbm(1, 9, 0);
        const vary = io[2];
        const kg = smooth01(vary * 1.5 + 0.5);
        r = pal[9] + (pal[12] - pal[9]) * kg;
        g = pal[10] + (pal[13] - pal[10]) * kg;
        b = pal[11] + (pal[14] - pal[11]) * kg;
        // Beach.
        const ks = 1 - smooth01((h - 0.6) / 1.2);
        r += (pal[6] - r) * ks;
        g += (pal[7] - g) * ks;
        b += (pal[8] - b) * ks;
        // Rock on steep slopes.
        const kr = smooth01((slope - 0.55) / 0.35);
        r += (pal[15] - r) * kr;
        g += (pal[16] - g) * kr;
        b += (pal[17] - b) * kr;
        // Snow on high, not-too-steep ground.
        const line = 135 + vary * 25;
        const kw = smooth01((h - line) / 15) * (1 - smooth01((slope - 0.9) / 0.4));
        r += (pal[18] - r) * kw;
        g += (pal[19] - g) * kw;
        b += (pal[20] - b) * kw;
      }
      col[o] = r;
      col[o + 1] = g;
      col[o + 2] = b;
    }
  }

  /**
   * Skirts hang below each edge to hide cracks between chunks and LODs.
   * Same normal and color as the edge, so a crack shows the same shade.
   */
  private skirts(job: ChunkJob): void {
    const m = job.mesh;
    const N = m.segs, n1 = N + 1;
    const pos = m.positions, nor = m.normals, col = m.colors;
    const depth = (GRID_PER_CHUNK / N) * GRID * 1.5 + 1;
    for (let k4 = 0; k4 < 4; k4++) {
      for (let k = 0; k < n1; k++) {
        const src = (k4 === 0 ? k : k4 === 1 ? N * n1 + k : k4 === 2 ? k * n1 : k * n1 + N) * 3;
        const dst = (n1 * n1 + k4 * n1 + k) * 3;
        for (let q = 0; q < 3; q++) {
          pos[dst + q] = pos[src + q];
          nor[dst + q] = nor[src + q];
          col[dst + q] = col[src + q];
        }
        pos[dst + 1] -= depth;
      }
    }
    m.minY -= depth;
  }
}

/** Triangle indices for a chunk mesh at one LOD (shared by every mesh of that LOD). */
export function chunkIndices(segs: number): Uint16Array {
  const N = segs, n1 = N + 1;
  const out = new Uint16Array(N * N * 6 + 4 * N * 12);
  let o = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * n1 + i, b = a + 1, c = a + n1, d = c + 1;
      // Same split as TerrainWorld.surface(): diagonal b-c. Counter-clockwise from above.
      out[o++] = a;
      out[o++] = c;
      out[o++] = b;
      out[o++] = b;
      out[o++] = c;
      out[o++] = d;
    }
  }
  for (let e = 0; e < 4; e++) {
    for (let k = 0; k < N; k++) {
      const src = (q: number) => (e === 0 ? q : e === 1 ? N * n1 + q : e === 2 ? q * n1 : q * n1 + N);
      const a = src(k), b = src(k + 1);
      const sa = n1 * n1 + e * n1 + k, sb = sa + 1;
      // Both windings, so the skirt shows from either side.
      out.set([a, sa, b, b, sa, sb, a, b, sa, b, sb, sa], o);
      o += 12;
    }
  }
  return out;
}
