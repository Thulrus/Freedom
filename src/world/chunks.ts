/**
 * Chunk streaming for heightfield worlds. Pure logic, no rendering: decides
 * which chunks should exist at which level of detail around a focus point,
 * and runs their build jobs in small slices under a per-frame time budget so
 * generation never causes a hitch.
 *
 * Memory is bounded: mesh buffers and chunk records are pooled and reused,
 * so flying forever in one direction allocates nothing new once the pools
 * have warmed up.
 */

/** Chunk edge length, m. */
export const CHUNK_SIZE = 128;
/** Grid segments per chunk edge for each LOD (LOD 0 = 2 m spacing, the collision grid). */
export const LOD_SEGS = [64, 32, 16, 8] as const;
/** Chebyshev chunk-ring radius that uses each LOD (beyond the last: LOD 3). */
const LOD_RING = [1, 2, 4];
/** The focus must move this far past a chunk edge before the rings re-center, m. */
const HYSTERESIS = 16;

/** Most props one chunk can hold (one candidate per 8 m cell). */
export const MAX_PROPS = (CHUNK_SIZE / 8) * (CHUNK_SIZE / 8);
/** Floats per prop: kind, local x, base y, local z, size a, size b, yaw, tint. */
export const PROP_STRIDE = 8;

/** Whatever a generator builds for one chunk at one LOD (pooled and reused). */
export interface ChunkBuffer {
  readonly lod: number;
  /** Renderer-owned object for this buffer (e.g. a THREE.Mesh), created once. */
  handle: unknown;
}

/** Heightfield vertex + color buffers for one chunk at one LOD. */
export class ChunkMesh implements ChunkBuffer {
  readonly segs: number;
  /** Grid vertices plus one skirt vertex per edge vertex (4 edges). */
  readonly vertexCount: number;
  /** Chunk-local x, absolute y, chunk-local z. */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly colors: Float32Array;
  /**
   * Generator scratch: the height grid with a one-vertex border, (segs + 3)^2
   * samples. `ext` is the drawn surface height, `raw` the unclamped terrain
   * height (water depth for coloring).
   */
  readonly ext: Float64Array;
  readonly raw: Float64Array;
  minY = 0;
  maxY = 0;
  /** Renderer-owned object for this buffer (e.g. a THREE.Mesh), created once. */
  handle: unknown = null;

  constructor(readonly lod: number) {
    const n = (this.segs = LOD_SEGS[lod]) + 1;
    this.vertexCount = n * n + 4 * n;
    this.positions = new Float32Array(this.vertexCount * 3);
    this.normals = new Float32Array(this.vertexCount * 3);
    this.colors = new Float32Array(this.vertexCount * 3);
    this.ext = new Float64Array((n + 2) * (n + 2));
    this.raw = new Float64Array((n + 2) * (n + 2));
  }
}

export class Chunk<M extends ChunkBuffer = ChunkMesh> {
  cx = 0;
  cz = 0;
  key = 0;
  /** Chebyshev distance (in chunks) from the focus chunk. */
  ring = 0;
  /** LOD this chunk should show. */
  want = 0;
  /** Mesh on screen (null until the first build finishes). */
  mesh: M | null = null;
  job: ChunkJob<M> | null = null;
  /** Props (trees, rocks), PROP_STRIDE floats each, positions local to the chunk corner. */
  readonly props = new Float32Array(MAX_PROPS * PROP_STRIDE);
  propCount = 0;
  propsReady = false;
}

export class ChunkJob<M extends ChunkBuffer = ChunkMesh> {
  chunk!: Chunk<M>;
  mesh!: M;
  /** Generator-defined progress counters. */
  phase = 0;
  row = 0;
}

/** World-specific generation, done one bounded slice at a time. */
export interface ChunkGenerator<M extends ChunkBuffer = ChunkMesh> {
  /** Advance the job by one small slice of work. Returns true when the job is finished. */
  step(job: ChunkJob<M>): boolean;
  /** A new (empty) buffer for this LOD; the streamer pools them. */
  createMesh(lod: number): M;
  /** LOD for a ring (Chebyshev chunk distance); defaults to the heightfield rings. */
  lodForRing?(ring: number): number;
}

export interface ChunkListener<M extends ChunkBuffer = ChunkMesh> {
  /** A freshly built mesh should now be drawn for this chunk. */
  show(chunk: Chunk<M>, mesh: M): void;
  /** This mesh is no longer drawn (replaced by another LOD, or the chunk left range). */
  hide(chunk: Chunk<M>, mesh: M): void;
}

const KEY_OFFSET = 1 << 20;
export const chunkKey = (cx: number, cz: number): number => (cx + KEY_OFFSET) * 2097152 + (cz + KEY_OFFSET);

export function lodForRing(ring: number): number {
  for (let i = 0; i < LOD_RING.length; i++) if (ring <= LOD_RING[i]) return i;
  return LOD_RING.length;
}

export class ChunkStreamer<M extends ChunkBuffer = ChunkMesh> {
  readonly active = new Map<number, Chunk<M>>();
  /** Set whenever the set of chunks with props (or their rings) changed. Cleared by the renderer. */
  propsDirty = true;
  /** Focus chunk (rings are centered on it). */
  fcx = 0;
  fcz = 0;
  /** Work time used by the last work() call, ms. */
  lastWorkMs = 0;
  /** Peak work time over the recent past (slowly decays), ms. */
  peakWorkMs = 0;
  /** Jobs completed since creation. */
  builds = 0;

  private readonly jobs: ChunkJob<M>[] = [];
  private readonly meshPool: M[][] = LOD_SEGS.map(() => []);
  private readonly chunkPool: Chunk<M>[] = [];
  private readonly jobPool: ChunkJob<M>[] = [];
  /** Totals ever created (for the "no memory growth" test and the debug overlay). */
  readonly created = { meshes: [0, 0, 0, 0], chunks: 0, jobs: 0 };
  private drawDistance = 600;
  private focusValid = false;
  private needDesired = true;
  private focusX = 0;
  private focusZ = 0;

  constructor(
    private readonly gen: ChunkGenerator<M>,
    private readonly listener: ChunkListener<M>,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  get pending(): number {
    return this.jobs.length;
  }

  setDrawDistance(d: number): void {
    if (d !== this.drawDistance) {
      this.drawDistance = d;
      this.needDesired = true;
    }
  }

  /** Move the focus (usually the drone), m. Re-plans chunks when it crosses a chunk edge. */
  update(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    const S = CHUNK_SIZE;
    if (
      !this.focusValid ||
      x < this.fcx * S - HYSTERESIS ||
      x > (this.fcx + 1) * S + HYSTERESIS ||
      z < this.fcz * S - HYSTERESIS ||
      z > (this.fcz + 1) * S + HYSTERESIS
    ) {
      this.fcx = Math.floor(x / S);
      this.fcz = Math.floor(z / S);
      this.focusValid = true;
      this.needDesired = true;
    }
    if (this.needDesired) this.plan();
  }

  /** Run build jobs until the budget (ms) is used up. Highest priority first. */
  work(budgetMs: number): void {
    const t0 = this.clock();
    let t = t0;
    while (this.jobs.length > 0 && t - t0 < budgetMs) {
      const job = this.jobs[0];
      if (this.gen.step(job)) {
        this.jobs.shift();
        this.finish(job);
      }
      t = this.clock();
    }
    this.lastWorkMs = t - t0;
    this.peakWorkMs = Math.max(this.lastWorkMs, this.peakWorkMs * 0.98);
  }

  /** Build everything that is pending, ignoring the budget (world load, teleport). */
  prime(): void {
    while (this.jobs.length > 0) this.work(1e9);
    // A deliberate one-off; the stats should show steady-state streaming only.
    this.lastWorkMs = this.peakWorkMs = 0;
  }

  /** True when the chunk under the focus shows full detail (LOD 0). */
  focusReady(): boolean {
    const c = this.active.get(chunkKey(Math.floor(this.focusX / CHUNK_SIZE), Math.floor(this.focusZ / CHUNK_SIZE)));
    return !!c && !!c.mesh && c.mesh.lod === 0;
  }

  /** Drop every chunk (world change). */
  clear(): void {
    for (const c of [...this.active.values()]) this.remove(c);
    this.focusValid = false;
  }

  // ------------------------------------------------------------- internals

  /** Ring (Chebyshev distance from the focus chunk) if chunk (cx, cz) should exist, else -1. */
  private ringOf(cx: number, cz: number): number {
    const S = CHUNK_SIZE, D = this.drawDistance;
    const ring = Math.max(Math.abs(cx - this.fcx), Math.abs(cz - this.fcz));
    if (ring <= 1) return ring; // the near rings always exist
    // Beyond that, keep chunks that reach into the draw-distance circle.
    const fx = this.focusX, fz = this.focusZ;
    const nx = Math.max(cx * S, Math.min(fx, (cx + 1) * S));
    const nz = Math.max(cz * S, Math.min(fz, (cz + 1) * S));
    return (nx - fx) * (nx - fx) + (nz - fz) * (nz - fz) > D * D ? -1 : ring;
  }

  private plan(): void {
    this.needDesired = false;
    // Free what left range first, so its buffers are reused right away (a teleport doesn't grow the pools).
    for (const c of this.active.values()) if (this.ringOf(c.cx, c.cz) < 0) this.remove(c);
    const R = Math.ceil(this.drawDistance / CHUNK_SIZE) + 1;
    for (let cz = this.fcz - R; cz <= this.fcz + R; cz++) {
      for (let cx = this.fcx - R; cx <= this.fcx + R; cx++) {
        const ring = this.ringOf(cx, cz);
        if (ring < 0) continue;
        const key = chunkKey(cx, cz);
        let c = this.active.get(key);
        if (!c) {
          c = this.chunkPool.pop() ?? (this.created.chunks++, new Chunk<M>());
          c.cx = cx;
          c.cz = cz;
          c.key = key;
          c.mesh = null;
          c.job = null;
          c.propCount = 0;
          c.propsReady = false;
          this.active.set(key, c);
        }
        if (c.ring !== ring) this.propsDirty = true;
        c.ring = ring;
        c.want = this.gen.lodForRing ? this.gen.lodForRing(ring) : lodForRing(ring);
        const shown = c.mesh ? c.mesh.lod : -1;
        if (c.job && c.job.mesh.lod !== c.want) this.cancel(c);
        if (!c.job && shown !== c.want) this.enqueue(c, c.want);
      }
    }
    // Holes first (chunks with nothing on screen), then nearest first.
    this.jobs.sort((a, b) => (a.chunk.mesh ? 1 : 0) - (b.chunk.mesh ? 1 : 0) || a.chunk.ring - b.chunk.ring);
  }

  private enqueue(c: Chunk<M>, lod: number): void {
    const job = this.jobPool.pop() ?? (this.created.jobs++, new ChunkJob<M>());
    job.chunk = c;
    job.mesh = this.meshPool[lod].pop() ?? (this.created.meshes[lod]++, this.gen.createMesh(lod));
    job.phase = 0;
    job.row = 0;
    c.job = job;
    this.jobs.push(job);
  }

  private cancel(c: Chunk<M>): void {
    const job = c.job!;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.meshPool[job.mesh.lod].push(job.mesh);
    this.jobPool.push(job);
    c.job = null;
  }

  private finish(job: ChunkJob<M>): void {
    const c = job.chunk;
    const old = c.mesh;
    c.mesh = job.mesh;
    c.job = null;
    this.jobPool.push(job);
    this.builds++;
    this.listener.show(c, c.mesh);
    if (old) {
      this.listener.hide(c, old);
      this.meshPool[old.lod].push(old);
    }
    if (!old) this.propsDirty = true;
  }

  private remove(c: Chunk<M>): void {
    if (c.job) this.cancel(c);
    if (c.mesh) {
      this.listener.hide(c, c.mesh);
      this.meshPool[c.mesh.lod].push(c.mesh);
      c.mesh = null;
    }
    if (c.propCount > 0) this.propsDirty = true;
    this.active.delete(c.key);
    this.chunkPool.push(c);
  }
}
