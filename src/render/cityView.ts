/**
 * Streaming city renderer: one merged mesh (one draw call) per 128 m chunk,
 * pooled and refilled in place. Windows are not geometry: a small patch to
 * the Lambert shader draws them from per-vertex facade coordinates (metres
 * along the wall, height), so floors line up across the whole city and the
 * pattern fades to an average tone where it would shimmer.
 */
import * as THREE from 'three';
import { CHUNK_SIZE, ChunkStreamer, type Chunk } from '../world/chunks';
import { CityMesh, type CityWorld } from '../world/city';
import type { FloatingOrigin } from './origin';
import { makePad, PropLayer } from './propLayer';
import type { WorldView } from './worldView';

const TREES = { pine: 0x3f7a4a, broadleaf: 0x6aa34a, trunk: 0x7a5a3e, boulder: 0xa29d97 };

/** Lambert + vertex colors + procedural windows on walls (facade.y >= 0). */
export function cityMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 facade;\nvarying vec2 vFacade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vFacade;').replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      if (vFacade.y >= 0.0) {
        vec2 cell = vFacade / vec2(2.6, 3.5);  // window pitch: 2.6 m across, 3.5 m floors
        vec2 g = fract(cell);
        vec2 fw = fwidth(cell);
        vec2 lo = smoothstep(vec2(0.18, 0.28) - fw, vec2(0.18, 0.28) + fw, g);
        vec2 hi = 1.0 - smoothstep(vec2(0.82) - fw, vec2(0.82) + fw, g);
        float win = lo.x * lo.y * hi.x * hi.y * step(1.0, cell.y); // none on the ground floor
        float far = smoothstep(0.25, 0.6, max(fw.x, fw.y));       // too small to resolve: average it
        win = mix(win, 0.3 * step(1.0, cell.y), far);
        float lit = step(0.87, fract(sin(dot(floor(cell), vec2(12.9898, 78.233))) * 43758.5453));
        vec3 glass = mix(vec3(0.09, 0.13, 0.19), vec3(0.95, 0.78, 0.45), lit * (1.0 - far));
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, win * 0.85);
      }`,
    );
  };
  m.customProgramCacheKey = () => 'freedom-city-windows';
  return m;
}

export class CityView implements WorldView {
  readonly object = new THREE.Group();
  private readonly streamer: ChunkStreamer<CityMesh>;
  private readonly material = cityMaterial();
  private readonly props = new PropLayer(TREES);
  private readonly pad: THREE.Group;
  private readonly meshes: THREE.Mesh[] = [];
  private ox = 0;
  private oz = 0;

  constructor(private readonly world: CityWorld) {
    this.streamer = new ChunkStreamer<CityMesh>(world, {
      show: (c, m) => this.show(c, m),
      hide: (_c, m) => {
        (m.handle as THREE.Mesh).visible = false;
      },
    });
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
    return `city #${this.world.seed} · chunks ${visible} (+${s.pending} queued) · trees ${this.props.total}\nworld gen ${s.lastWorkMs.toFixed(2)} ms/frame (peak ${s.peakWorkMs.toFixed(2)}) · ${s.builds} built · ${this.meshes.length} pooled`;
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

  private show(c: Chunk<CityMesh>, cm: CityMesh): void {
    let mesh = cm.handle as THREE.Mesh | null;
    const nv = cm.vertexCount, ni = cm.indexCount;
    if (!mesh) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(cm.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(cm.normals, 3));
      g.setAttribute('color', new THREE.BufferAttribute(cm.colors, 3));
      g.setAttribute('facade', new THREE.BufferAttribute(cm.facade, 2));
      g.setIndex(new THREE.BufferAttribute(cm.index, 1));
      g.boundingSphere = new THREE.Sphere();
      mesh = new THREE.Mesh(g, this.material);
      cm.handle = mesh;
      this.meshes.push(mesh);
      this.object.add(mesh);
    } else {
      // Upload only the part of the pooled buffers this chunk uses.
      const g = mesh.geometry;
      for (const [name, size] of [['position', 3], ['normal', 3], ['color', 3], ['facade', 2]] as const) {
        const a = g.getAttribute(name) as THREE.BufferAttribute;
        a.clearUpdateRanges();
        a.addUpdateRange(0, nv * size);
        a.needsUpdate = true;
      }
      const idx = g.index!;
      idx.clearUpdateRanges();
      idx.addUpdateRange(0, ni);
      idx.needsUpdate = true;
    }
    mesh.geometry.setDrawRange(0, ni);
    const half = CHUNK_SIZE / 2, hy = cm.maxY / 2;
    mesh.geometry.boundingSphere!.center.set(half, hy, half);
    mesh.geometry.boundingSphere!.radius = Math.sqrt(2 * half * half + hy * hy);
    mesh.position.set(c.cx * CHUNK_SIZE - this.ox, 0, c.cz * CHUNK_SIZE - this.oz);
    mesh.visible = true;
  }
}
