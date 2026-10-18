/**
 * Meshes one 128 m tile of a VolumeWorld: surface nets over its signed
 * distance field, plus exact triangles for thin parts (planks, ropes, rings).
 *
 * Cost control: the field is first sampled on a grid 4 cells coarse. Where
 * all 8 corners of a coarse cell agree in sign by more than the field can
 * change across it (Lipschitz bound), the whole cell is filled without
 * evaluating it. Most of the volume is open air or solid rock, so only the
 * shell around the surface is sampled at full resolution.
 *
 * Work is done in small slices (step()), so it can run under a per-frame
 * budget on the main thread or flat out in a worker.
 *
 * Seams: normals and colors come from the global field, so neighbouring
 * tiles match exactly. Coarse LODs extend one cell into their neighbours,
 * which hides the cracks where a coarse tile meets a fine one.
 */
import { Vec3 } from '../sim';
import { CHUNK_SIZE } from './chunks';
import { PRIM_BOX, PRIM_CAPSULE, PRIM_CYLINDER, PRIM_SPHERE, PRIM_STRIDE, PRIM_TORUS, type VolumeWorld } from './volume';

/** Cell size per LOD, m. */
export const VOLUME_LOD_CELL = [2, 4, 8] as const;
/** Border samples around the tile (room for the overlap and the quads on the edge). */
const BORDER = 2;
/** The field may change by at most this much per metre (primitives 1, plus noise and ledges). */
const LIPSCHITZ = 1.7;
const MAX_VERTS = 65536;
const MAX_INDEX = MAX_VERTS * 6;

/** Tiles per period edge. */
export const tilesPerEdge = (period: number): number => Math.round(period / CHUNK_SIZE);
/** One number per (tile, LOD). */
export const tileKey = (tx: number, tz: number, lod: number, period: number): number => (tz * tilesPerEdge(period) + tx) * 3 + lod;
export function decodeTileKey(key: number, period: number): [number, number, number] {
  const n = tilesPerEdge(period), t = Math.floor(key / 3);
  return [t % n, Math.floor(t / n), key % 3];
}

/** A finished tile mesh: chunk-local x/z, absolute y. Built once and cached. */
export class TileMesh {
  handle: unknown = null;
  constructor(
    readonly tx: number,
    readonly tz: number,
    readonly lod: number,
    readonly positions: Float32Array,
    readonly normals: Float32Array,
    readonly colors: Float32Array,
    readonly index: Uint32Array,
    readonly minY: number,
    readonly maxY: number,
  ) {}
  get vertexCount(): number {
    return this.positions.length / 3;
  }
  get triangles(): number {
    return this.index.length / 3;
  }
}

const enum Phase {
  Coarse,
  Fine,
  Verts,
  Quads,
  Shade,
  Exact,
  Done,
}

export class VolumeMesher {
  // Scratch, sized for LOD 0 and reused for every tile.
  private readonly samples: Float32Array;
  private readonly coarse: Float32Array;
  private readonly mixed: Uint8Array;
  private readonly cellVert: Int32Array;
  private readonly pos = new Float32Array(MAX_VERTS * 3);
  private readonly nrm = new Float32Array(MAX_VERTS * 3);
  private readonly col = new Float32Array(MAX_VERTS * 3);
  private readonly idx = new Uint32Array(MAX_INDEX);
  private readonly n = new Vec3();

  // The tile being built.
  private tx = 0;
  private tz = 0;
  private lod = 0;
  private h = 2;
  private nx = 0;
  private ny = 0;
  private ncx = 0;
  private ncy = 0;
  private x0 = 0;
  private z0 = 0;
  private phase = Phase.Done;
  private row = 0;
  private nv = 0;
  private ni = 0;
  private overlap = 0;
  /** Field evaluations for the current tile (stats). */
  evals = 0;
  result: TileMesh | null = null;

  constructor(readonly world: VolumeWorld) {
    const nx = CHUNK_SIZE / VOLUME_LOD_CELL[0] + 2 * BORDER + 1;
    const ny = this.layers(VOLUME_LOD_CELL[0]);
    this.samples = new Float32Array(nx * nx * ny);
    this.cellVert = new Int32Array(nx * nx * ny);
    const nc = (nx - 1) / 4 + 1, ncy = (ny - 1) / 4 + 1;
    this.coarse = new Float32Array(nc * nc * ncy);
    this.mixed = new Uint8Array(nc * nc * ncy);
  }

  /** Sample layers for cell size h (a multiple of 4 cells, plus one). */
  private layers(h: number): number {
    return Math.ceil((this.world.yMax - this.world.yMin) / h / 4) * 4 + 1;
  }

  get busy(): boolean {
    return this.phase !== Phase.Done;
  }

  /** Begin building tile (tx, tz) of the canonical tile grid at an LOD. */
  start(tx: number, tz: number, lod: number): void {
    this.tx = tx;
    this.tz = tz;
    this.lod = lod;
    this.h = VOLUME_LOD_CELL[lod];
    this.nx = CHUNK_SIZE / this.h + 2 * BORDER + 1;
    this.ny = this.layers(this.h);
    this.ncx = (this.nx - 1) / 4 + 1;
    this.ncy = (this.ny - 1) / 4 + 1;
    this.x0 = tx * CHUNK_SIZE;
    this.z0 = tz * CHUNK_SIZE;
    this.overlap = lod > 0 ? 1 : 0;
    this.phase = Phase.Coarse;
    this.row = 0;
    this.nv = this.ni = 0;
    this.evals = 0;
    this.result = null;
  }

  /** Build a whole tile now (tests, workers). */
  build(tx: number, tz: number, lod: number): TileMesh {
    this.start(tx, tz, lod);
    while (!this.step());
    return this.result!;
  }

  /** One slice of work (well under a millisecond on a desktop). Returns true when the tile is done. */
  step(): boolean {
    switch (this.phase) {
      case Phase.Coarse:
        this.coarseRow(this.row);
        if (++this.row >= this.ncx) {
          this.markMixed();
          this.next(Phase.Fine);
        }
        return false;
      case Phase.Fine:
        this.fineRow(this.row);
        if (++this.row >= this.nx) this.next(Phase.Verts);
        return false;
      case Phase.Verts:
        this.vertRow(this.row);
        if (++this.row >= this.nx - 1) this.next(Phase.Quads);
        return false;
      case Phase.Quads:
        this.quadRow(this.row);
        if (++this.row >= this.nx - 1) this.next(Phase.Shade);
        return false;
      case Phase.Shade:
        this.shade(this.row * 128, Math.min(this.nv, this.row * 128 + 128));
        if (++this.row * 128 >= this.nv) this.next(Phase.Exact);
        return false;
      case Phase.Exact:
        if (this.lod < 2) this.exactParts();
        this.finish();
        this.phase = Phase.Done;
        return true;
      default:
        return true;
    }
  }

  private next(p: Phase): void {
    this.phase = p;
    this.row = 0;
  }

  // ------------------------------------------------------------ sampling

  /** Coarse samples for coarse z-row kc. */
  private coarseRow(kc: number): void {
    const w = this.world, io = w.io, h4 = this.h * 4;
    const nc = this.ncx, ncy = this.ncy;
    const z = this.z0 + (kc * 4 - BORDER) * this.h;
    for (let ic = 0; ic < nc; ic++) {
      const x = this.x0 + (ic * 4 - BORDER) * this.h;
      for (let jc = 0; jc < ncy; jc++) {
        io[0] = x;
        io[1] = w.yMin + jc * h4;
        io[2] = z;
        w.sampleMeshed();
        this.coarse[(kc * nc + ic) * ncy + jc] = io[3];
      }
    }
    this.evals += nc * ncy;
  }

  /** Flag coarse cells that may contain surface. */
  private markMixed(): void {
    const nc = this.ncx, ncy = this.ncy, C = this.coarse;
    const thr = 2 * Math.sqrt(3) * this.h * LIPSCHITZ + 0.25;
    for (let kc = 0; kc < nc - 1; kc++) {
      for (let ic = 0; ic < nc - 1; ic++) {
        for (let jc = 0; jc < ncy - 1; jc++) {
          let pos = 0, neg = 0, minAbs = Infinity;
          for (let c = 0; c < 8; c++) {
            const v = C[((kc + (c >> 2)) * nc + ic + ((c >> 1) & 1)) * ncy + jc + (c & 1)];
            if (v < 0) neg++;
            else pos++;
            const a = v < 0 ? -v : v;
            if (a < minAbs) minAbs = a;
          }
          this.mixed[(kc * nc + ic) * ncy + jc] = pos && neg ? 1 : minAbs > thr ? 0 : 1;
        }
      }
    }
  }

  /** Fine samples for z-row k: evaluated near the surface, filled from the coarse grid elsewhere. */
  private fineRow(k: number): void {
    const w = this.world, io = w.io, h = this.h;
    const nx = this.nx, ny = this.ny, nc = this.ncx, ncy = this.ncy;
    const z = this.z0 + (k - BORDER) * h;
    const k0 = Math.min(nc - 2, k >> 2), k1 = k % 4 === 0 && k > 0 ? k0 - 1 : k0;
    for (let i = 0; i < nx; i++) {
      const i0 = Math.min(nc - 2, i >> 2), i1 = i % 4 === 0 && i > 0 ? i0 - 1 : i0;
      const x = this.x0 + (i - BORDER) * h;
      const base = (k * nx + i) * ny;
      for (let j = 0; j < ny; j++) {
        const j0 = Math.min(ncy - 2, j >> 2), j1 = j % 4 === 0 && j > 0 ? j0 - 1 : j0;
        let near = 0;
        for (let a = k1; a <= k0 && !near; a++) for (let b = i1; b <= i0 && !near; b++) for (let c = j1; c <= j0; c++) if (this.mixed[(a * nc + b) * ncy + c]) near = 1;
        if (near) {
          io[0] = x;
          io[1] = w.yMin + j * h;
          io[2] = z;
          w.sampleMeshed();
          this.samples[base + j] = io[3];
          this.evals++;
        } else {
          // Sign is constant over this coarse cell: copy a corner.
          this.samples[base + j] = this.coarse[(k0 * nc + i0) * ncy + j0];
        }
      }
    }
  }

  // ------------------------------------------------------------ surface nets

  /** One vertex per cell that straddles the surface: the mean of its edge crossings. */
  private vertRow(k: number): void {
    const nx = this.nx, ny = this.ny, S = this.samples, h = this.h, w = this.world;
    const dz = nx * ny, dx = ny;
    for (let i = 0; i < nx - 1; i++) {
      for (let j = 0; j < ny - 1; j++) {
        const c = (k * nx + i) * ny + j;
        this.cellVert[c] = -1;
        const v0 = S[c], v1 = S[c + dx], v2 = S[c + 1], v3 = S[c + dx + 1];
        const v4 = S[c + dz], v5 = S[c + dz + dx], v6 = S[c + dz + 1], v7 = S[c + dz + dx + 1];
        // Corner bits: x = +dx, y = +1, z = +dz.
        let mask = 0;
        if (v0 < 0) mask |= 1;
        if (v1 < 0) mask |= 2;
        if (v2 < 0) mask |= 4;
        if (v3 < 0) mask |= 8;
        if (v4 < 0) mask |= 16;
        if (v5 < 0) mask |= 32;
        if (v6 < 0) mask |= 64;
        if (v7 < 0) mask |= 128;
        if (mask === 0 || mask === 255) continue;
        if (this.nv >= MAX_VERTS) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        // 12 edges: along x (pairs 0-1, 2-3, 4-5, 6-7), y (0-2, 1-3, 4-6, 5-7), z (0-4, 1-5, 2-6, 3-7).
        if ((v0 < 0) !== (v1 < 0)) { sx += v0 / (v0 - v1); sy += 0; sz += 0; cnt++; }
        if ((v2 < 0) !== (v3 < 0)) { sx += v2 / (v2 - v3); sy += 1; cnt++; }
        if ((v4 < 0) !== (v5 < 0)) { sx += v4 / (v4 - v5); sz += 1; cnt++; }
        if ((v6 < 0) !== (v7 < 0)) { sx += v6 / (v6 - v7); sy += 1; sz += 1; cnt++; }
        if ((v0 < 0) !== (v2 < 0)) { sy += v0 / (v0 - v2); cnt++; }
        if ((v1 < 0) !== (v3 < 0)) { sy += v1 / (v1 - v3); sx += 1; cnt++; }
        if ((v4 < 0) !== (v6 < 0)) { sy += v4 / (v4 - v6); sz += 1; cnt++; }
        if ((v5 < 0) !== (v7 < 0)) { sy += v5 / (v5 - v7); sx += 1; sz += 1; cnt++; }
        if ((v0 < 0) !== (v4 < 0)) { sz += v0 / (v0 - v4); cnt++; }
        if ((v1 < 0) !== (v5 < 0)) { sz += v1 / (v1 - v5); sx += 1; cnt++; }
        if ((v2 < 0) !== (v6 < 0)) { sz += v2 / (v2 - v6); sy += 1; cnt++; }
        if ((v3 < 0) !== (v7 < 0)) { sz += v3 / (v3 - v7); sx += 1; sy += 1; cnt++; }
        const o = this.nv * 3;
        this.pos[o] = (i - BORDER + sx / cnt) * h;
        this.pos[o + 1] = w.yMin + (j + sy / cnt) * h;
        this.pos[o + 2] = (k - BORDER + sz / cnt) * h;
        this.cellVert[c] = this.nv++;
      }
    }
  }

  /** Quads across every sign-changing grid edge this tile owns, for samples in z-row k. */
  private quadRow(k: number): void {
    const nx = this.nx, ny = this.ny, S = this.samples, V = this.cellVert;
    const lo = BORDER - this.overlap, hi = BORDER + CHUNK_SIZE / this.h - 1 + this.overlap;
    if (k < lo || k > hi) return;
    const dz = nx * ny, dx = ny;
    for (let i = lo; i <= hi; i++) {
      for (let j = 0; j < ny - 1; j++) {
        const s = (k * nx + i) * ny + j;
        const inside = S[s] < 0;
        // Edge along +x: cells (i, j-1|j, k-1|k).
        if (j > 0 && inside !== S[s + dx] < 0) this.quad(V[s - 1 - dz], V[s - dz], V[s], V[s - 1], inside);
        // Edge along +y: cells (i-1|i, j, k-1|k).
        if (inside !== S[s + 1] < 0) this.quad(V[s - dx - dz], V[s - dx], V[s], V[s - dz], inside);
        // Edge along +z: cells (i-1|i, j-1|j, k).
        if (j > 0 && inside !== S[s + dz] < 0) this.quad(V[s - dx - 1], V[s - 1], V[s], V[s - dx], inside);
      }
    }
  }

  /** a, b, c, d go counter-clockwise around the edge seen from its +axis end; flip if the inside is at the far end. */
  private quad(a: number, b: number, c: number, d: number, inside: boolean): void {
    if (a < 0 || b < 0 || c < 0 || d < 0 || this.ni + 6 > MAX_INDEX) return;
    const I = this.idx, o = this.ni;
    if (inside) {
      I[o] = a; I[o + 1] = b; I[o + 2] = c;
      I[o + 3] = a; I[o + 4] = c; I[o + 5] = d;
    } else {
      I[o] = a; I[o + 1] = c; I[o + 2] = b;
      I[o + 3] = a; I[o + 4] = d; I[o + 5] = c;
    }
    this.ni += 6;
  }

  /** Normals from the field gradient (smooth and seam-free), colors from the world's palette. */
  private shade(v0: number, v1: number): void {
    const w = this.world, io = w.io, n = this.n;
    for (let v = v0; v < v1; v++) {
      const o = v * 3;
      const x = this.pos[o] + this.x0, y = this.pos[o + 1], z = this.pos[o + 2] + this.z0;
      w.gradient(x, y, z, 1, n);
      this.nrm[o] = n.x;
      this.nrm[o + 1] = n.y;
      this.nrm[o + 2] = n.z;
      io[0] = x;
      io[1] = y;
      io[2] = z;
      w.sampleMeshed();
      w.shade(x, y, z, n.x, n.y, n.z, io[4], this.col, o);
    }
    this.evals += (v1 - v0) * 7;
  }

  // ------------------------------------------------------------ exact parts

  private exactParts(): void {
    const parts = this.world.exactFeaturesIn(this.x0, this.z0, CHUNK_SIZE);
    const rgb = new Float32Array(3);
    for (const part of parts) {
      this.world.partColor(part.material, rgb, 0);
      for (let o = 0; o < part.prims.length; o += PRIM_STRIDE) {
        const R = part.prims, t = R[o];
        if (t === PRIM_BOX) this.box(R, o, rgb);
        else if (t === PRIM_CAPSULE) this.tube(R[o + 3], R[o + 4], R[o + 5], R[o + 6], R[o + 7], R[o + 8], R[o + 9], 6, rgb);
        else if (t === PRIM_CYLINDER) this.tube(R[o + 3], R[o + 4] - R[o + 7], R[o + 5], R[o + 3], R[o + 4] + R[o + 7], R[o + 5], R[o + 6], 10, rgb, true);
        else if (t === PRIM_TORUS) this.torus(R, o, rgb);
        else if (t === PRIM_SPHERE) this.sphere(R[o + 3], R[o + 4], R[o + 5], R[o + 6], rgb);
      }
    }
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, rgb: Float32Array): number {
    const v = this.nv, o = v * 3;
    this.pos[o] = x - this.x0;
    this.pos[o + 1] = y;
    this.pos[o + 2] = z - this.z0;
    this.nrm[o] = nx;
    this.nrm[o + 1] = ny;
    this.nrm[o + 2] = nz;
    this.col[o] = rgb[0];
    this.col[o + 1] = rgb[1];
    this.col[o + 2] = rgb[2];
    this.nv++;
    return v;
  }

  private tri(a: number, b: number, c: number): void {
    const I = this.idx, o = this.ni;
    I[o] = a;
    I[o + 1] = b;
    I[o + 2] = c;
    this.ni += 3;
  }

  private room(verts: number, indices: number): boolean {
    return this.nv + verts <= MAX_VERTS && this.ni + indices <= MAX_INDEX;
  }

  /** Oriented (rounded corners ignored) box: 6 flat faces. */
  private box(R: Float64Array, o: number, rgb: Float32Array): void {
    if (!this.room(24, 36)) return;
    const cx = R[o + 3], cy = R[o + 4], cz = R[o + 5], hx = R[o + 6], hy = R[o + 7], hz = R[o + 8];
    const cyw = R[o + 10], syw = R[o + 11], cp = R[o + 12], sp = R[o + 13];
    // Local axes in world space (see the field's PRIM_BOX).
    const ax = [cyw, 0, -syw], ay = [-sp * syw, cp, -sp * cyw], az = [cp * syw, sp, cp * cyw];
    const axes = [ax, ay, az], half = [hx, hy, hz];
    for (let f = 0; f < 6; f++) {
      const a = f >> 1, s = f & 1 ? -1 : 1;
      const n = axes[a], u = axes[(a + 1) % 3], v = axes[(a + 2) % 3];
      const hn = half[a] * s, hu = half[(a + 1) % 3], hv = half[(a + 2) % 3];
      const base = this.nv;
      for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        this.vert(
          cx + n[0] * hn + u[0] * hu * su + v[0] * hv * sv,
          cy + n[1] * hn + u[1] * hu * su + v[1] * hv * sv,
          cz + n[2] * hn + u[2] * hu * su + v[2] * hv * sv,
          n[0] * s, n[1] * s, n[2] * s, rgb,
        );
      }
      if (s > 0) {
        this.tri(base, base + 1, base + 2);
        this.tri(base, base + 2, base + 3);
      } else {
        this.tri(base, base + 2, base + 1);
        this.tri(base, base + 3, base + 2);
      }
    }
  }

  /** A prism of `sides` around segment a-b (ropes, posts), optionally capped. */
  private tube(ax: number, ay: number, az: number, bx: number, by: number, bz: number, r: number, sides: number, rgb: Float32Array, caps = false): void {
    if (!this.room(sides * 2 + 2, sides * 12)) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // Two unit vectors perpendicular to the axis.
    let px = -uz, py = 0, pz = ux;
    if (Math.abs(uy) > 0.9) {
      px = 1;
      py = 0;
      pz = 0;
    }
    const pl = Math.hypot(px, py, pz);
    px /= pl; py /= pl; pz /= pl;
    const qx = uy * pz - uz * py, qy = uz * px - ux * pz, qz = ux * py - uy * px;
    const base = this.nv;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const nx = px * c + qx * sn, ny = py * c + qy * sn, nz = pz * c + qz * sn;
      this.vert(ax + nx * r, ay + ny * r, az + nz * r, nx, ny, nz, rgb);
      this.vert(bx + nx * r, by + ny * r, bz + nz * r, nx, ny, nz, rgb);
    }
    for (let s = 0; s < sides; s++) {
      const a0 = base + s * 2, a1 = base + ((s + 1) % sides) * 2;
      this.tri(a0, a1, a0 + 1);
      this.tri(a1, a1 + 1, a0 + 1);
    }
    if (caps) {
      const top = this.vert(bx, by, bz, ux, uy, uz, rgb), bot = this.vert(ax, ay, az, -ux, -uy, -uz, rgb);
      for (let s = 0; s < sides; s++) {
        const a0 = base + s * 2, a1 = base + ((s + 1) % sides) * 2;
        this.tri(a0 + 1, a1 + 1, top);
        this.tri(a1, a0, bot);
      }
    }
  }

  private torus(R: Float64Array, o: number, rgb: Float32Array): void {
    const MAJ = 24, MIN = 8;
    if (!this.room(MAJ * MIN, MAJ * MIN * 6)) return;
    const cx = R[o + 3], cy = R[o + 4], cz = R[o + 5], ax = R[o + 6], ay = R[o + 7], az = R[o + 8], rr = R[o + 9], r = R[o + 10];
    let px = -az, py = 0, pz = ax;
    if (Math.abs(ay) > 0.9) {
      px = 1;
      pz = 0;
    }
    const pl = Math.hypot(px, py, pz);
    px /= pl; py /= pl; pz /= pl;
    const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;
    const base = this.nv;
    for (let i = 0; i < MAJ; i++) {
      const a = (i / MAJ) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const ex = px * ca + qx * sa, ey = py * ca + qy * sa, ez = pz * ca + qz * sa;
      for (let j = 0; j < MIN; j++) {
        const b = (j / MIN) * Math.PI * 2, cb = Math.cos(b), sb = Math.sin(b);
        const nx = ex * cb + ax * sb, ny = ey * cb + ay * sb, nz = ez * cb + az * sb;
        this.vert(cx + ex * rr + nx * r, cy + ey * rr + ny * r, cz + ez * rr + nz * r, nx, ny, nz, rgb);
      }
    }
    for (let i = 0; i < MAJ; i++) {
      for (let j = 0; j < MIN; j++) {
        const a = base + i * MIN + j, b = base + ((i + 1) % MAJ) * MIN + j;
        const c = base + ((i + 1) % MAJ) * MIN + ((j + 1) % MIN), d = base + i * MIN + ((j + 1) % MIN);
        this.tri(a, b, c);
        this.tri(a, c, d);
      }
    }
  }

  private sphere(cx: number, cy: number, cz: number, r: number, rgb: Float32Array): void {
    const LON = 10, LAT = 6;
    if (!this.room((LON + 1) * (LAT + 1), LON * LAT * 6)) return;
    const base = this.nv;
    for (let j = 0; j <= LAT; j++) {
      const t = (j / LAT) * Math.PI, st = Math.sin(t), ct = Math.cos(t);
      for (let i = 0; i <= LON; i++) {
        const p = (i / LON) * Math.PI * 2;
        const nx = st * Math.cos(p), ny = ct, nz = st * Math.sin(p);
        this.vert(cx + nx * r, cy + ny * r, cz + nz * r, nx, ny, nz, rgb);
      }
    }
    for (let j = 0; j < LAT; j++) {
      for (let i = 0; i < LON; i++) {
        const a = base + j * (LON + 1) + i, b = a + LON + 1;
        this.tri(a, a + 1, b);
        this.tri(a + 1, b + 1, b);
      }
    }
  }

  private finish(): void {
    const nv = this.nv, ni = this.ni;
    let minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < nv; v++) {
      const y = this.pos[v * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (nv === 0) minY = maxY = 0;
    this.result = new TileMesh(
      this.tx, this.tz, this.lod,
      this.pos.slice(0, nv * 3), this.nrm.slice(0, nv * 3), this.col.slice(0, nv * 3), this.idx.slice(0, ni),
      minY, maxY,
    );
  }
}
