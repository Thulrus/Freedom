/**
 * "Low-poly city" training world: an endless seeded street grid with
 * districts (downtown towers, mid-rise blocks, residential streets, parks)
 * and a big open plaza around the launch pad.
 *
 * Every block is generated from (seed, block x, block z) by one function,
 * genBlock(), as a short list of axis-aligned boxes and trees. Collision
 * and rendering both call it, so what you see is what you hit. Buildings
 * are boxes (exact signed distance), alleys are at least 4 m wide, and some
 * downtown towers are joined by skybridges you can fly under.
 *
 * The collision query runs at 500 Hz and follows the sim's rules: no
 * allocation, doubles cross non-inlined calls only through typed arrays.
 */
import { Vec3, type Hit } from '../sim';
import { CHUNK_SIZE, MAX_PROPS, PROP_STRIDE, type ChunkBuffer, type ChunkGenerator, type ChunkJob } from './chunks';
import { mixSeed, Noise } from './noise';
import type { GameWorld } from './recipes';
import { PROP_BROADLEAF, PROP_SHAPE } from './terrain';

/** Street grid pitch (block + street), m. Roads run along x = k·PITCH and z = k·PITCH. */
export const PITCH = 64;
/** Half road width, m. */
export const ROAD_HALF = 6;
/** Sidewalk width, m (lots start at ROAD_HALF + WALK from the road centre). */
const WALK = 3;
/** Curb / sidewalk height, m. */
export const CURB = 0.15;
const LOT0 = ROAD_HALF + WALK; // 9
const LOT_SPAN = PITCH - 2 * LOT0; // 46

/** Item kinds in a block list. */
export const ITEM_BUILDING = 0;
export const ITEM_SLAB = 1;
export const ITEM_TREE = 2;
export const ITEM_BRIDGE = 3;
/** Floats per item: kind, x0, y0, z0, x1, y1, z1, color (for a tree: kind, x, y, z, height, -, -, tint). */
export const ITEM_STRIDE = 8;
export const MAX_ITEMS = 24;
/**
 * The collision cache holds the 3×3 blocks around a centre block and is kept
 * while the query point stays within this margin of that block, so samples
 * straddling a block edge (e.g. flying down the middle of a street) don't
 * rebuild it on every call.
 */
const CACHE_MARGIN = 16;
/** Nothing outside the cached blocks can be closer than this, m. */
const BOUND = PITCH - CACHE_MARGIN;

const DISTRICT_RES = 0;
const DISTRICT_MID = 1;
const DISTRICT_DOWN = 2;

const PALETTES: number[][] = [
  [0xf2d9c4, 0xe8b8a0, 0xcfe0e8, 0xf4ecd0, 0xd8c8e8, 0xc9dcc0], // residential pastels
  [0xd9b38c, 0xc98f6a, 0xb7a58f, 0xe0cfb1, 0xa3887a, 0xcab49a], // mid-rise brick and stone
  [0x8fa7bf, 0x9db7c4, 0x7d8ea3, 0xb3c3cf, 0x6f8799, 0xa8b0b8], // downtown glass and steel
];
const SLAB_COLOR = 0xb9b4aa;
const PARK_COLOR = 0x86b062;
const PLAZA_COLOR = 0xe2d6bd;
const SPIRE_COLOR = 0xd7dde3;
const BRIDGE_COLOR = 0x9fc3d6;

/** The open plaza around the launch pad (blocks x -1..0, z -2..0): room for every drill. */
export const isPlaza = (bx: number, bz: number): boolean => bx >= -1 && bx <= 0 && bz >= -2 && bz <= 0;

/** Vertex buffers for one city chunk (variable size: drawn with a draw range). */
export class CityMesh implements ChunkBuffer {
  readonly lod = 0;
  handle: unknown = null;
  static readonly MAX_VERTS = 2048;
  static readonly MAX_INDEX = 3072;
  readonly positions = new Float32Array(CityMesh.MAX_VERTS * 3);
  readonly normals = new Float32Array(CityMesh.MAX_VERTS * 3);
  readonly colors = new Float32Array(CityMesh.MAX_VERTS * 3);
  /** Facade coordinates for the window shader: metres along the wall, height. (-1, -1) = no windows. */
  readonly facade = new Float32Array(CityMesh.MAX_VERTS * 2);
  readonly index = new Uint16Array(CityMesh.MAX_INDEX);
  vertexCount = 0;
  indexCount = 0;
  maxY = 0;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export class CityWorld implements GameWorld, ChunkGenerator<CityMesh> {
  readonly id = 'city' as const;
  readonly spawn = new Vec3(0, 0, 0);
  readonly spawnYaw = 0;

  private readonly noise: Noise;
  private readonly seedMix: number;
  /** The current block's random numbers (see seedRng). */
  private readonly rnd = new Float64Array(160);
  /** Collision cache: items of the 3×3 blocks around the last query point. */
  private readonly cache = new Float64Array(9 * MAX_ITEMS * ITEM_STRIDE);
  private cacheN = 0;
  private cacheBx = 0;
  private cacheBz = 0;
  private cacheValid = false;
  /** Scratch for chunk building (never the collision cache). */
  private readonly build = new Float64Array(MAX_ITEMS * ITEM_STRIDE);
  /** Per-lot scratch for skybridges: x0, z0, x1, z1, top of the lowest tier. */
  private readonly lots = new Float64Array(9 * 5);
  private readonly r = new Float64Array(1);
  /** One item being written by genBlock (see emit). */
  private readonly it = new Float64Array(ITEM_STRIDE);
  private readonly tmp = new Vec3();
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };
  /** sRGB hex -> linear RGB cache for vertex colors. */
  private readonly lin = new Map<number, [number, number, number]>();

  constructor(readonly seed: number) {
    this.noise = new Noise(seed + 7777);
    this.seedMix = mixSeed(seed, 31);
    // The cache refill runs only when the drone crosses a block: too rarely for
    // V8 to optimize it by itself. Exercise it once so physics stays garbage-free.
    for (let i = 0; i < 300; i++) this.fillCache((i % 20) * 3 - 30, Math.floor(i / 20) * 3 - 20);
    this.cacheValid = false;
  }

  // ------------------------------------------------------------ WorldQuery

  distance(p: Vec3): number {
    this.computeDistance(p);
    return this.r[0];
  }

  normal(p: Vec3, out: Vec3): Vec3 {
    const e = 1e-3;
    const t = this.tmp, r = this.r;
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

  /** Sphere trace (the field is a true lower bound). Returns a shared Hit. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    const p = this.hit.point;
    let t = 0;
    for (let i = 0; i < 512 && t <= maxDist; i++) {
      p.copy(origin).addScaled(dir, t);
      this.computeDistance(p);
      const d = this.r[0];
      if (d < 1e-3) {
        this.hit.distance = t;
        this.normal(p, this.hit.normal);
        return this.hit;
      }
      t += d;
    }
    return null;
  }

  /** Street or sidewalk height under (x, z) (ignores buildings), m. */
  groundHeight(x: number, z: number): number {
    const lx = x - Math.floor(x / PITCH) * PITCH, lz = z - Math.floor(z / PITCH) * PITCH;
    return lx >= ROAD_HALF && lx <= PITCH - ROAD_HALF && lz >= ROAD_HALF && lz <= PITCH - ROAD_HALF ? CURB : 0;
  }

  private computeDistance(p: Vec3): void {
    const px = p.x, py = p.y, pz = p.z;
    let best = py; // the street plane
    const cx0 = this.cacheBx * PITCH, cz0 = this.cacheBz * PITCH;
    if (
      !this.cacheValid ||
      px < cx0 - CACHE_MARGIN ||
      px > cx0 + PITCH + CACHE_MARGIN ||
      pz < cz0 - CACHE_MARGIN ||
      pz > cz0 + PITCH + CACHE_MARGIN
    )
      this.fillCache(Math.floor(px / PITCH), Math.floor(pz / PITCH));
    const c = this.cache;
    const S = PROP_SHAPE;
    for (let i = 0, o = 0; i < this.cacheN; i++, o += ITEM_STRIDE) {
      let d = 0;
      if (c[o] === ITEM_TREE) {
        const dx = px - c[o + 1], dy = py - c[o + 2], dz = pz - c[o + 3], b = c[o + 4];
        const q2 = dx * dx + dz * dz;
        const top = S.broadTrunkTop * b;
        const ty = dy < 0 ? dy : dy > top ? dy - top : 0;
        d = Math.sqrt(q2 + ty * ty) - S.broadTrunkRadius * b;
        const cy = dy - S.broadCrownY * b;
        const dc = Math.sqrt(q2 + cy * cy) - S.broadCrownRadius * b * 0.95;
        if (dc < d) d = dc;
      } else {
        // Axis-aligned box: exact signed distance.
        const qx = c[o + 1] - px > px - c[o + 4] ? c[o + 1] - px : px - c[o + 4];
        const qy = c[o + 2] - py > py - c[o + 5] ? c[o + 2] - py : py - c[o + 5];
        const qz = c[o + 3] - pz > pz - c[o + 6] ? c[o + 3] - pz : pz - c[o + 6];
        const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
        const m = qx > qy ? (qx > qz ? qx : qz) : qy > qz ? qy : qz;
        d = Math.sqrt(ox * ox + oy * oy + oz * oz) + (m < 0 ? m : 0);
      }
      if (d < best) best = d;
    }
    this.r[0] = best < BOUND ? best : BOUND;
  }

  private fillCache(bx: number, bz: number): void {
    let n = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) n += this.genBlock(bx + dx, bz + dz, this.cache, n * ITEM_STRIDE);
    this.cacheN = n;
    this.cacheBx = bx;
    this.cacheBz = bz;
    this.cacheValid = true;
  }

  // ------------------------------------------------------- block generator

  /**
   * Fill this.rnd with the block's random numbers (mulberry32, uniform in
   * [0, 1)). genBlock reads them in order. A batch instead of a rand()
   * method: genBlock is too big for V8 to inline a call into, and a
   * non-inlined call returning a double allocates.
   */
  private seedRng(bx: number, bz: number): void {
    let s = Math.imul(bx, 0x27d4eb2d) ^ Math.imul(bz, 0x165667b1) ^ this.seedMix;
    const R = this.rnd;
    for (let i = 0; i < R.length; i++) {
      let t = (s = (s + 0x6d2b79f5) | 0);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      R[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  }

  /** District of block (bx, bz): 0 residential, 1 mid-rise, 2 downtown; io[2] keeps the raw value. */
  private district(bx: number, bz: number): number {
    const io = this.noise.io;
    io[0] = ((bx + 0.5) * PITCH) / 700;
    io[1] = ((bz + 0.5) * PITCH) / 700;
    this.noise.fbm(3, 21, 0);
    const d = io[2];
    return d > 0.25 ? DISTRICT_DOWN : d > -0.15 ? DISTRICT_MID : DISTRICT_RES;
  }

  /**
   * Write block (bx, bz)'s items into out starting at o (float index).
   * Returns the item count. Deterministic, allocation-free.
   */
  private genBlock(bx: number, bz: number, out: Float64Array, o: number): number {
    let n = 0;
    const x0 = bx * PITCH, z0 = bz * PITCH;
    const it = this.it;
    const R = this.rnd;
    let ri = 0;
    this.seedRng(bx, bz);
    const plaza = isPlaza(bx, bz);
    const district = this.district(bx, bz);
    const raw = this.noise.io[2];
    const park = !plaza && district !== DISTRICT_DOWN && R[ri++] < 0.08;
    // The block's sidewalk slab (raised curb), colored by use.
    { it[0] = ITEM_SLAB; it[1] = x0 + ROAD_HALF; it[2] = -1; it[3] = z0 + ROAD_HALF; it[4] = x0 + PITCH - ROAD_HALF; it[5] = CURB; it[6] = z0 + PITCH - ROAD_HALF; it[7] = plaza ? PLAZA_COLOR : park ? PARK_COLOR : SLAB_COLOR; n = this.emit(out, o, n); }
    if (plaza || park) {
      // Trees: in parks anywhere, on the plaza only far from the pad.
      const count = plaza ? 6 : 8;
      for (let k = 0; k < count; k++) {
        const tx = x0 + LOT0 + 2 + R[ri++] * (LOT_SPAN - 4), tz = z0 + LOT0 + 2 + R[ri++] * (LOT_SPAN - 4);
        const h = 5 + R[ri++] * 4;
        // Plaza trees stay clear of the pad and of the street ahead of it (drill space).
        if (plaza && (tx * tx + tz * tz < 60 * 60 || Math.abs(tx) < 22)) continue;
        { it[0] = ITEM_TREE; it[1] = tx; it[2] = CURB - 0.2; it[3] = tz; it[4] = h; it[5] = 0; it[6] = 0; it[7] = R[ri++]; n = this.emit(out, o, n); }
      }
      return n;
    }
    const pal = PALETTES[district];
    // Split the lot area into nx × nz buildings separated by flyable alleys.
    const nx = district === DISTRICT_RES ? 3 : district === DISTRICT_MID ? 2 + (R[ri++] < 0.5 ? 1 : 0) : 1 + (R[ri++] < 0.65 ? 1 : 0);
    const nz = district === DISTRICT_RES ? 3 : district === DISTRICT_MID ? 2 + (R[ri++] < 0.5 ? 1 : 0) : 1 + (R[ri++] < 0.65 ? 1 : 0);
    const gap = district === DISTRICT_RES ? 4 + R[ri++] * 2 : district === DISTRICT_MID ? 4 + R[ri++] * 4 : 6 + R[ri++] * 6;
    const lx = (LOT_SPAN - gap * (nx - 1)) / nx, lz = (LOT_SPAN - gap * (nz - 1)) / nz;
    const skip = district === DISTRICT_RES ? 0.12 : district === DISTRICT_MID ? 0.08 : 0.04;
    const tall = raw > 0.25 ? (raw - 0.25) / 0.75 : 0; // 0..1 towards the downtown core
    const L = this.lots;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const li = (i * 3 + j) * 5;
        L[li + 4] = 0;
        if (R[ri++] < skip) continue;
        const inset = district === DISTRICT_RES ? 1 + R[ri++] * 2.5 : R[ri++] * 1.5;
        const ax = x0 + LOT0 + i * (lx + gap) + inset, az = z0 + LOT0 + j * (lz + gap) + inset;
        const bx1 = ax + lx - 2 * inset, bz1 = az + lz - 2 * inset;
        const r = R[ri++];
        const h =
          district === DISTRICT_RES ? 5 + r * 7 : district === DISTRICT_MID ? 12 + r * r * 30 : 30 + r * r * (70 + 110 * tall);
        const color = pal[Math.floor(R[ri++] * pal.length) % pal.length];
        let low = h;
        if (h > 28 && R[ri++] < 0.6) {
          // Setback: full-footprint base, narrower tower on top.
          low = h * (0.45 + R[ri++] * 0.25);
          const sx = (bx1 - ax) * (0.12 + R[ri++] * 0.15), sz = (bz1 - az) * (0.12 + R[ri++] * 0.15);
          { it[0] = ITEM_BUILDING; it[1] = ax; it[2] = 0; it[3] = az; it[4] = bx1; it[5] = low; it[6] = bz1; it[7] = color; n = this.emit(out, o, n); }
          { it[0] = ITEM_BUILDING; it[1] = ax + sx; it[2] = low; it[3] = az + sz; it[4] = bx1 - sx; it[5] = h; it[6] = bz1 - sz; it[7] = color; n = this.emit(out, o, n); }
        } else {
          { it[0] = ITEM_BUILDING; it[1] = ax; it[2] = 0; it[3] = az; it[4] = bx1; it[5] = h; it[6] = bz1; it[7] = color; n = this.emit(out, o, n); }
        }
        if (district === DISTRICT_DOWN && h > 70 && R[ri++] < 0.45) {
          const cx = (ax + bx1) / 2, cz = (az + bz1) / 2;
          { it[0] = ITEM_BUILDING; it[1] = cx - 1; it[2] = h; it[3] = cz - 1; it[4] = cx + 1; it[5] = h + 10 + R[ri++] * 20; it[6] = cz + 1; it[7] = SPIRE_COLOR; n = this.emit(out, o, n); }
        }
        L[li] = ax;
        L[li + 1] = az;
        L[li + 2] = bx1;
        L[li + 3] = bz1;
        L[li + 4] = low;
      }
    }
    // Skybridge across an alley between two neighbouring buildings (fly under it).
    if (district !== DISTRICT_RES && nx >= 2 && R[ri++] < 0.45) {
      const j = Math.floor(R[ri++] * nz) % nz;
      const a = j * 5, b = (3 + j) * 5; // lots (0, j) and (1, j)
      const top = L[a + 4] < L[b + 4] ? L[a + 4] : L[b + 4];
      if (top >= 18) {
        const zA = L[a + 1] > L[b + 1] ? L[a + 1] : L[b + 1];
        const zB = L[a + 3] < L[b + 3] ? L[a + 3] : L[b + 3];
        if (zB - zA > 8) {
          const zc = (zA + zB) / 2, y = 8 + R[ri++] * (top * 0.6 - 8);
          { it[0] = ITEM_BRIDGE; it[1] = L[a + 2]; it[2] = y; it[3] = zc - 3; it[4] = L[b]; it[5] = y + 3; it[6] = zc + 3; it[7] = BRIDGE_COLOR; n = this.emit(out, o, n); }
        }
      }
    }
    return n;
  }

  /**
   * Copy the item in `it` to out as item n (dropped past MAX_ITEMS). Returns
   * the new count. Values travel through `it`, not arguments: doubles passed
   * to a non-inlined call allocate in V8.
   */
  private emit(out: Float64Array, o: number, n: number): number {
    if (n >= MAX_ITEMS) return n;
    const k = o + n * ITEM_STRIDE, it = this.it;
    for (let q = 0; q < ITEM_STRIDE; q++) out[k + q] = it[q];
    return n + 1;
  }

  // ------------------------------------------------------- chunk generation

  createMesh(): CityMesh {
    return new CityMesh();
  }

  /** Cities have one level of detail: geometry is cheap, and fog hides the far edge. */
  lodForRing(): number {
    return 0;
  }

  /** Expose a block's items (tests, layouts). Returns a fresh array. */
  blockItems(bx: number, bz: number): Float64Array {
    const out = new Float64Array(MAX_ITEMS * ITEM_STRIDE);
    const n = this.genBlock(bx, bz, out, 0);
    return out.subarray(0, n * ITEM_STRIDE);
  }

  /**
   * Phase 0: the street surface. Rows 0..3: one block each (2×2 blocks per
   * chunk), with its buildings, slab and trees.
   */
  step(job: ChunkJob<CityMesh>): boolean {
    const m = job.mesh, c = job.chunk;
    const ox = c.cx * CHUNK_SIZE, oz = c.cz * CHUNK_SIZE;
    if (job.row === 0) {
      m.vertexCount = m.indexCount = 0;
      m.maxY = 1;
      c.propCount = 0;
      this.quad(m, 0, 0, 0, 0, 0, CHUNK_SIZE, CHUNK_SIZE, 0, CHUNK_SIZE, CHUNK_SIZE, 0, 0, 0, 1, 0, 0x6b6e73, -1, -1);
    }
    const per = CHUNK_SIZE / PITCH;
    const bx = c.cx * per + (job.row % per), bz = c.cz * per + Math.floor(job.row / per);
    const items = this.build;
    const n = this.genBlock(bx, bz, items, 0);
    for (let i = 0; i < n; i++) {
      const k = i * ITEM_STRIDE;
      const kind = items[k];
      if (kind === ITEM_TREE) {
        if (c.propCount >= MAX_PROPS) continue;
        const p = c.props, q = c.propCount++ * PROP_STRIDE;
        p[q] = PROP_BROADLEAF;
        p[q + 1] = items[k + 1] - ox;
        p[q + 2] = items[k + 2];
        p[q + 3] = items[k + 3] - oz;
        p[q + 4] = p[q + 5] = items[k + 4];
        p[q + 6] = items[k + 7] * 6.283185307179586;
        p[q + 7] = items[k + 7];
        continue;
      }
      this.box(m, items[k + 1] - ox, items[k + 2], items[k + 3] - oz, items[k + 4] - ox, items[k + 5], items[k + 6] - oz, items[k + 7], kind !== ITEM_SLAB);
    }
    if (++job.row < per * per) return false;
    c.propsReady = true;
    return true;
  }

  private linear(hex: number): [number, number, number] {
    let c = this.lin.get(hex);
    if (!c) {
      c = [srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255), srgbToLinear((hex & 255) / 255)];
      this.lin.set(hex, c);
    }
    return c;
  }

  /** Five faces of a box (no bottom), local coordinates. Walls get window coordinates. */
  private box(m: CityMesh, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number, windows: boolean): void {
    if (m.vertexCount + 20 > CityMesh.MAX_VERTS || m.indexCount + 30 > CityMesh.MAX_INDEX) return;
    const w = windows ? 1 : -1;
    // Centre the window columns on each wall.
    const cx = ((x1 - x0) % 2.6) / 2, cz = ((z1 - z0) % 2.6) / 2;
    this.quad(m, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0, color, -1, -1, 0.82);
    this.quad(m, x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, 1, 0, 0, color, w * (z1 - z0), -cz, 1, y0, y1);
    this.quad(m, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, color, w * (z1 - z0), -cz, 1, y0, y1);
    this.quad(m, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, color, w * (x1 - x0), -cx, 1, y0, y1);
    this.quad(m, x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1, color, w * (x1 - x0), -cx, 1, y0, y1);
    if (y1 > m.maxY) m.maxY = y1;
  }

  private vertex(m: CityMesh, v: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, lin: [number, number, number], shade: number, fu: number, fv: number): void {
    const i = v * 3, f = v * 2;
    m.positions[i] = x;
    m.positions[i + 1] = y;
    m.positions[i + 2] = z;
    m.normals[i] = nx;
    m.normals[i + 1] = ny;
    m.normals[i + 2] = nz;
    m.colors[i] = lin[0] * shade;
    m.colors[i + 1] = lin[1] * shade;
    m.colors[i + 2] = lin[2] * shade;
    m.facade[f] = fu;
    m.facade[f + 1] = fv;
  }

  /**
   * One quad a, b, c, d (counter-clockwise seen from outside). For walls,
   * `width` > 0 gives facade coordinates u = metres from a towards b (shifted
   * by `shift`), v = height; width <= 0 means no windows.
   */
  private quad(
    m: CityMesh,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number,
    color: number, width: number, shift: number, shade = 1, y0 = 0, y1 = 0,
  ): void {
    const v = m.vertexCount;
    const lin = this.linear(color);
    this.vertex(m, v, ax, ay, az, nx, ny, nz, lin, shade, width > 0 ? shift : -1, width > 0 ? y0 : -1);
    this.vertex(m, v + 1, bx, by, bz, nx, ny, nz, lin, shade, width > 0 ? width + shift : -1, width > 0 ? y0 : -1);
    this.vertex(m, v + 2, cx, cy, cz, nx, ny, nz, lin, shade, width > 0 ? width + shift : -1, width > 0 ? y1 : -1);
    this.vertex(m, v + 3, dx, dy, dz, nx, ny, nz, lin, shade, width > 0 ? shift : -1, width > 0 ? y1 : -1);
    const I = m.index, o = m.indexCount;
    I[o] = v;
    I[o + 1] = v + 1;
    I[o + 2] = v + 2;
    I[o + 3] = v;
    I[o + 4] = v + 2;
    I[o + 5] = v + 3;
    m.vertexCount = v + 4;
    m.indexCount = o + 6;
  }
}
