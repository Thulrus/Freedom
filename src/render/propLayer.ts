/**
 * Trees and rocks for streamed worlds: one instanced mesh per prop kind,
 * repacked from the chunks' prop lists only when the chunk set (or the
 * floating origin) changes. Shared by the terrain and city views.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, PROP_STRIDE, type Chunk, type ChunkBuffer } from '../world/chunks';
import { PROP_PINE, PROP_SHAPE } from '../world/terrain';

/** Props are drawn for chunks up to this ring (fog hides them beyond). */
const PROP_RING = 3;
/** Instance capacity per prop kind. */
const PROP_CAPACITY = 8192;

export interface PropColors {
  pine: number;
  broadleaf: number;
  trunk: number;
  boulder: number;
}

export class PropLayer {
  readonly object = new THREE.Group();
  /** Faceted low-poly props. */
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  private readonly props: THREE.InstancedMesh[];
  private readonly counts = [0, 0, 0];

  constructor(pal: PropColors) {
    this.props = [makePine(pal.pine, pal.trunk), makeBroadleaf(pal.broadleaf, pal.trunk), makeRock(pal.boulder)].map((g) => {
      const m = new THREE.InstancedMesh(g, this.material, PROP_CAPACITY);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PROP_CAPACITY * 3), 3);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.count = 0;
      m.frustumCulled = false;
      this.object.add(m);
      return m;
    });
  }

  get total(): number {
    return this.counts[0] + this.counts[1] + this.counts[2];
  }

  /** Repack the props of all chunks near the focus, relative to the render origin (ox, oz). */
  rebuild<M extends ChunkBuffer>(chunks: Iterable<Chunk<M>>, ox: number, oz: number): void {
    const counts = this.counts;
    counts[0] = counts[1] = counts[2] = 0;
    const mats = this.props.map((p) => p.instanceMatrix.array as Float32Array);
    const cols = this.props.map((p) => p.instanceColor!.array as Float32Array);
    for (const c of chunks) {
      if (!c.propsReady || c.ring > PROP_RING) continue;
      const bx = c.cx * CHUNK_SIZE - ox, bz = c.cz * CHUNK_SIZE - oz;
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

  dispose(): void {
    for (const p of this.props) {
      p.geometry.dispose();
      p.dispose();
    }
    this.material.dispose();
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
export function makePad(): THREE.Group {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(2.2, 32).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0xe9e4d4 }));
  disc.position.y = 0.015;
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff7a3d }));
  ring.position.y = 0.025;
  g.add(disc, ring);
  return g;
}
