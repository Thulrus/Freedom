/**
 * Streaming terrain renderer. The ChunkStreamer (world/) decides what to
 * build; this turns its pooled buffers into pooled THREE meshes (one draw
 * call per chunk, shared material and per-LOD index buffers), and draws all
 * trees and rocks with one instanced mesh per prop kind.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, ChunkStreamer, LOD_SEGS, PROP_STRIDE, type Chunk, type ChunkMesh } from '../world/chunks';
import { chunkIndices, PROP_PINE, PROP_SHAPE, type TerrainWorld } from '../world/terrain';
import type { FloatingOrigin } from './origin';
import type { WorldView } from './worldView';

/** Props are drawn for chunks up to this ring (fog hides them beyond). */
const PROP_RING = 3;
/** Instance capacity per prop kind. */
const PROP_CAPACITY = 8192;

export class TerrainView implements WorldView {
  readonly object = new THREE.Group();
  private readonly streamer: ChunkStreamer;
  /** Smooth-shaded terrain (normals come from the global height grid, so chunk seams are invisible). */
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  /** Faceted low-poly props. */
  private readonly propMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly indices: THREE.BufferAttribute[];
  private readonly props: THREE.InstancedMesh[];
  private readonly propCounts = [0, 0, 0];
  private readonly pad: THREE.Group;
  private readonly meshes: THREE.Mesh[] = [];
  private ox = 0;
  private oz = 0;

  constructor(private readonly world: TerrainWorld) {
    this.streamer = new ChunkStreamer(world, {
      show: (c, m) => this.show(c, m),
      hide: (_c, m) => {
        (m.handle as THREE.Mesh).visible = false;
      },
    });
    this.indices = LOD_SEGS.map((n) => new THREE.BufferAttribute(chunkIndices(n), 1));
    const pal = world.palette;
    this.props = [makePine(pal.pine, pal.trunk), makeBroadleaf(pal.broadleaf, pal.trunk), makeRock(pal.boulder)].map((g) => {
      const m = new THREE.InstancedMesh(g, this.propMaterial, PROP_CAPACITY);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PROP_CAPACITY * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.object.add(m);
      return m;
    });
    this.pad = makePad();
    this.object.add(this.pad);
  }

  update(focusX: number, focusZ: number, origin: FloatingOrigin, budgetMs: number): void {
    const rebased = this.syncOrigin(origin);
    this.streamer.update(focusX, focusZ);
    this.streamer.work(budgetMs);
    if (rebased || this.streamer.propsDirty) this.rebuildProps();
  }

  prime(focusX: number, focusZ: number, origin: FloatingOrigin): void {
    this.syncOrigin(origin);
    this.streamer.update(focusX, focusZ);
    this.streamer.prime();
    this.rebuildProps();
  }

  setDrawDistance(d: number): void {
    this.streamer.setDrawDistance(d);
  }

  status(): string {
    const s = this.streamer;
    const visible = this.meshes.reduce((n, m) => n + (m.visible ? 1 : 0), 0);
    const props = this.propCounts[0] + this.propCounts[1] + this.propCounts[2];
    return `hills #${this.world.seed} · chunks ${visible} (+${s.pending} queued) · props ${props}\nworld gen ${s.lastWorkMs.toFixed(2)} ms/frame (peak ${s.peakWorkMs.toFixed(2)}) · ${s.builds} built · ${this.meshes.length} pooled`;
  }

  dispose(): void {
    this.streamer.clear();
    for (const m of this.meshes) m.geometry.dispose();
    for (const p of this.props) {
      p.geometry.dispose();
      p.dispose();
    }
    this.pad.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.material.dispose();
    this.propMaterial.dispose();
  }

  // ------------------------------------------------------------- internals

  /** Re-place everything after the floating origin moved. */
  private syncOrigin(origin: FloatingOrigin): boolean {
    const sp = this.world.spawn;
    this.pad.position.set(sp.x - origin.x, sp.y, sp.z - origin.z);
    if (origin.x === this.ox && origin.z === this.oz) return false;
    this.ox = origin.x;
    this.oz = origin.z;
    for (const c of this.streamer.active.values()) {
      if (c.mesh) (c.mesh.handle as THREE.Mesh).position.set(c.cx * CHUNK_SIZE - this.ox, 0, c.cz * CHUNK_SIZE - this.oz);
    }
    return true;
  }

  private show(c: Chunk, cm: ChunkMesh): void {
    let mesh = cm.handle as THREE.Mesh | null;
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(cm.positions, 3));
      g.setAttribute('color', new THREE.BufferAttribute(cm.colors, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(cm.normals, 3));
      g.setIndex(this.indices[cm.lod]);
      g.boundingSphere = new THREE.Sphere();
      mesh = new THREE.Mesh(g, this.material);
      cm.handle = mesh;
      this.meshes.push(mesh);
      this.object.add(mesh);
    } else {
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate = true;
    }
    const half = CHUNK_SIZE / 2;
    const hy = (cm.maxY - cm.minY) / 2;
    mesh.geometry.boundingSphere!.center.set(half, cm.minY + hy, half);
    mesh.geometry.boundingSphere!.radius = Math.sqrt(2 * half * half + hy * hy);
    mesh.position.set(c.cx * CHUNK_SIZE - this.ox, 0, c.cz * CHUNK_SIZE - this.oz);
    mesh.visible = true;
  }

  /** Repack all visible props into the instanced meshes (only when the chunk set or origin changed). */
  private rebuildProps(): void {
    this.streamer.propsDirty = false;
    const counts = this.propCounts;
    counts[0] = counts[1] = counts[2] = 0;
    const mats = this.props.map((p) => p.instanceMatrix.array as Float32Array);
    const cols = this.props.map((p) => p.instanceColor!.array as Float32Array);
    for (const c of this.streamer.active.values()) {
      if (!c.propsReady || c.ring > PROP_RING) continue;
      const bx = c.cx * CHUNK_SIZE - this.ox, bz = c.cz * CHUNK_SIZE - this.oz;
      const P = c.props;
      for (let i = 0; i < c.propCount; i++) {
        const o = i * PROP_STRIDE;
        const kind = P[o];
        const n = counts[kind];
        if (n >= PROP_CAPACITY) continue;
        counts[kind] = n + 1;
        const a = P[o + 4], b = P[o + 5];
        const sx = kind === PROP_PINE ? a : b, sy = b;
        const cs = Math.cos(P[o + 6]), sn = Math.sin(P[o + 6]);
        const m = mats[kind], k = n * 16;
        // Column-major: rotate about Y, then scale (sx, sy, sx), then translate.
        m[k] = cs * sx; m[k + 1] = 0; m[k + 2] = -sn * sx; m[k + 3] = 0;
        m[k + 4] = 0; m[k + 5] = sy; m[k + 6] = 0; m[k + 7] = 0;
        m[k + 8] = sn * sx; m[k + 9] = 0; m[k + 10] = cs * sx; m[k + 11] = 0;
        m[k + 12] = bx + P[o + 1]; m[k + 13] = P[o + 2]; m[k + 14] = bz + P[o + 3]; m[k + 15] = 1;
        // Per-instance tint: slight brightness and hue variation.
        const t = P[o + 7];
        const col = cols[kind], j = n * 3;
        col[j] = 0.82 + 0.3 * t;
        col[j + 1] = 0.9 + 0.18 * (1 - t);
        col[j + 2] = 0.85 + 0.15 * t;
      }
    }
    this.props.forEach((p, kind) => {
      p.count = counts[kind];
      p.instanceMatrix.needsUpdate = true;
      p.instanceColor!.needsUpdate = true;
    });
  }
}

// ------------------------------------------------------------ prop meshes

/** Non-indexed copy of geo with a constant vertex color. */
function painted(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'color']) {
    const arrays = parts.map((p) => p.attributes[name].array as Float32Array);
    const all = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrays) {
      all.set(a, o);
      o += a.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(all, 3));
  }
  return out;
}

/** Unit pine (scaled by crown radius a horizontally, height b vertically); see PROP_SHAPE. */
function makePine(crown: number, trunk: number): THREE.BufferGeometry {
  const S = PROP_SHAPE;
  const t = new THREE.CylinderGeometry(S.pineTrunkRadius, S.pineTrunkRadius, S.pineTrunkTop, 6, 1, true).translate(0, S.pineTrunkTop / 2, 0);
  const h = 1 - S.pineConeBase;
  const c = new THREE.ConeGeometry(1, h, 7).translate(0, S.pineConeBase + h / 2, 0);
  return merge([painted(t, trunk), painted(c, crown)]);
}

/** Unit broadleaf tree (scaled uniformly by its height). */
function makeBroadleaf(crown: number, trunk: number): THREE.BufferGeometry {
  const S = PROP_SHAPE;
  const t = new THREE.CylinderGeometry(S.broadTrunkRadius, S.broadTrunkRadius, S.broadTrunkTop, 6, 1, true).translate(0, S.broadTrunkTop / 2, 0);
  const c = new THREE.IcosahedronGeometry(S.broadCrownRadius, 1).translate(0, S.broadCrownY, 0);
  return merge([painted(t, trunk), painted(c, crown)]);
}

/** Unit boulder (scaled uniformly by its radius). */
function makeRock(color: number): THREE.BufferGeometry {
  return merge([painted(new THREE.DodecahedronGeometry(1, 0).translate(0, PROP_SHAPE.rockCenterY, 0), color)]);
}

/** Launch pad marker: a pale disc with an orange ring. */
function makePad(): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xe9e4d4 }));
  disc.position.y = 0.015;
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
  ring.position.y = 0.025;
  g.add(disc, ring);
  return g;
}
