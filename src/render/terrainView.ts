/**
 * Streaming terrain renderer. The ChunkStreamer (world/) decides what to
 * build; this turns its pooled buffers into pooled THREE meshes (one draw
 * call per chunk, shared material and per-LOD index buffers). Trees and
 * rocks are drawn by a PropLayer.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, ChunkStreamer, LOD_SEGS, type Chunk, type ChunkMesh } from '../world/chunks';
import { chunkIndices, type TerrainWorld } from '../world/terrain';
import type { FloatingOrigin } from './origin';
import { makePad, PropLayer } from './propLayer';
import type { WorldView } from './worldView';

export class TerrainView implements WorldView {
  readonly object = new THREE.Group();
  private readonly streamer: ChunkStreamer;
  /** Smooth-shaded terrain (normals come from the global height grid, so chunk seams are invisible). */
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly indices: THREE.BufferAttribute[];
  private readonly props: PropLayer;
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
    this.props = new PropLayer(world.palette);
    this.pad = makePad();
    this.object.add(this.props.object, this.pad);
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
    return `hills #${this.world.seed} · chunks ${visible} (+${s.pending} queued) · props ${this.props.total}\nworld gen ${s.lastWorkMs.toFixed(2)} ms/frame (peak ${s.peakWorkMs.toFixed(2)}) · ${s.builds} built · ${this.meshes.length} pooled`;
  }

  dispose(): void {
    this.streamer.clear();
    for (const m of this.meshes) m.geometry.dispose();
    this.props.dispose();
    this.pad.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.material.dispose();
  }

  // ------------------------------------------------------------- internals

  private rebuildProps(): void {
    this.streamer.propsDirty = false;
    this.props.rebuild(this.streamer.active.values(), this.ox, this.oz);
  }
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
}
