/**
 * Renderer for volume worlds (arches, sky islands).
 *
 * The world repeats every `period` metres, so it is meshed once: one mesh
 * per 128 m tile per LOD (2, 4 and 8 m cells), cached for the session. Each
 * visible chunk around the drone draws the cached geometry of its tile (the
 * same geometry appears again one period further on). Rings of chunks pick
 * an LOD by distance, falling back to whatever is ready so there are never
 * holes.
 *
 * Meshing runs in a Web Worker. Without one, the same mesher runs on the
 * main thread under the per-frame budget.
 */
import * as THREE from 'three';
import { CHUNK_SIZE } from '../world/chunks';
import type { VolumeWorld } from '../world/volume';
import { decodeTileKey, tileKey, tilesPerEdge, VolumeMesher } from '../world/volumeMesh';
import type { FloatingOrigin } from './origin';
import { makePad } from './propLayer';
import type { WorldView } from './worldView';

/** LOD by chunk ring: 2 m cells next to the drone, 4 m in the next ring, 8 m beyond. */
const lodForRing = (ring: number): number => (ring <= 1 ? 0 : ring === 2 ? 1 : 2);
const HYSTERESIS = 16;

interface TileMsg {
  type: 'tile';
  key: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  index: Uint32Array;
}

export class VolumeView implements WorldView {
  readonly object = new THREE.Group();
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly geometries = new Map<number, THREE.BufferGeometry>();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly pad: THREE.Group;
  private readonly sea: THREE.Mesh | null = null;
  private readonly seaMaterial: THREE.MeshLambertMaterial | null = null;
  private readonly n: number;
  private worker: Worker | null = null;
  private inline: VolumeMesher | null = null;
  private inlineKey = -1;
  private queue: number[] = [];
  private requested = '';
  private arrived: TileMsg[] = [];
  private drawDistance = 600;
  private fcx = 0;
  private fcz = 0;
  private fx = 0;
  private fz = 0;
  private planned = false;
  private dirty = true;
  private ox = 0;
  private oz = 0;
  private shown = 0;
  private lastMs = 0;
  private peakMs = 0;

  constructor(private readonly world: VolumeWorld) {
    this.n = tilesPerEdge(world.period);
    this.pad = makePad();
    this.object.add(this.pad);
    if (Number.isFinite(world.seaY)) {
      this.seaMaterial = cloudMaterial();
      this.sea = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), this.seaMaterial);
      this.sea.frustumCulled = false;
      this.object.add(this.sea);
    }
    try {
      this.worker = new Worker(new URL('./volumeWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent) => this.arrived.push(e.data as TileMsg);
      this.worker.onerror = () => this.fallBack();
      this.worker.postMessage({ type: 'init', id: world.id, seed: world.seed });
    } catch {
      this.fallBack();
    }
  }

  private fallBack(): void {
    this.worker?.terminate();
    this.worker = null;
    this.inline ??= new VolumeMesher(this.world);
    this.requested = '';
    this.dirty = true;
  }

  update(focusX: number, focusZ: number, origin: FloatingOrigin, budgetMs: number): void {
    const t0 = performance.now();
    this.syncOrigin(origin);
    this.focus(focusX, focusZ);
    this.receive();
    if (this.inline) this.workInline(budgetMs);
    if (this.dirty) this.plan();
    this.placeSea(focusX, focusZ);
    this.lastMs = performance.now() - t0;
    this.peakMs = Math.max(this.lastMs, this.peakMs * 0.98);
  }

  /** Make sure something is on screen around the focus right away: coarse tiles nearby, built here and now. */
  prime(focusX: number, focusZ: number, origin: FloatingOrigin): void {
    this.syncOrigin(origin);
    this.focus(focusX, focusZ);
    this.receive();
    const mesher = (this.inline ??= new VolumeMesher(this.world));
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const [tx, tz] = this.tileOf(this.fcx + dx, this.fcz + dz);
        const key = tileKey(tx, tz, 2, this.world.period);
        if (!this.hasAny(tx, tz)) this.addTile(key, mesher.build(tx, tz, 2));
      }
    }
    if (this.worker) this.inline = null; // the worker does the rest
    this.plan();
    this.placeSea(focusX, focusZ);
    this.peakMs = this.lastMs = 0;
  }

  setDrawDistance(d: number): void {
    if (d !== this.drawDistance) {
      this.drawDistance = d;
      this.dirty = true;
    }
  }

  status(): string {
    const total = this.n * this.n;
    const count = [0, 0, 0];
    for (const k of this.geometries.keys()) count[k % 3]++;
    const tris = this.meshes.reduce((s, m) => s + (m.visible ? (m.geometry.index?.count ?? 0) / 3 : 0), 0);
    return `${this.world.id} #${this.world.seed} · ${this.world.period} m wrap · chunks ${this.shown} · ${(tris / 1000).toFixed(0)}k tris before culling\ntiles 2 m ${count[0]}/${total} · 4 m ${count[1]}/${total} · 8 m ${count[2]}/${total} · ${this.worker ? 'worker' : 'main thread'} · ${this.queue.length} queued · ${this.lastMs.toFixed(2)} ms/frame (peak ${this.peakMs.toFixed(2)})`;
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const g of this.geometries.values()) g.dispose();
    this.geometries.clear();
    this.material.dispose();
    this.sea?.geometry.dispose();
    this.seaMaterial?.dispose();
    this.pad.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  // ------------------------------------------------------------- internals

  private tileOf(cx: number, cz: number): [number, number] {
    const n = this.n;
    return [((cx % n) + n) % n, ((cz % n) + n) % n];
  }

  private hasAny(tx: number, tz: number): boolean {
    const P = this.world.period;
    return this.geometries.has(tileKey(tx, tz, 0, P)) || this.geometries.has(tileKey(tx, tz, 1, P)) || this.geometries.has(tileKey(tx, tz, 2, P));
  }

  private focus(x: number, z: number): void {
    this.fx = x;
    this.fz = z;
    const S = CHUNK_SIZE;
    if (!this.planned || x < this.fcx * S - HYSTERESIS || x > (this.fcx + 1) * S + HYSTERESIS || z < this.fcz * S - HYSTERESIS || z > (this.fcz + 1) * S + HYSTERESIS) {
      this.fcx = Math.floor(x / S);
      this.fcz = Math.floor(z / S);
      this.planned = true;
      this.dirty = true;
    }
  }

  private syncOrigin(origin: FloatingOrigin): void {
    const sp = this.world.spawn;
    this.pad.position.set(sp.x - origin.x, sp.y, sp.z - origin.z);
    if (origin.x !== this.ox || origin.z !== this.oz) {
      this.ox = origin.x;
      this.oz = origin.z;
      this.dirty = true;
    }
  }

  private receive(): void {
    if (!this.arrived.length) return;
    for (const m of this.arrived) this.addTile(m.key, m);
    this.arrived.length = 0;
  }

  private addTile(key: number, m: { positions: Float32Array; normals: Float32Array; colors: Float32Array; index: Uint32Array }): void {
    if (this.geometries.has(key)) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(m.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(m.colors, 3));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.computeBoundingSphere();
    this.geometries.set(key, g);
    this.dirty = true;
  }

  private workInline(budgetMs: number): void {
    const m = this.inline!;
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!m.busy) {
        const key = this.queue.find((k) => !this.geometries.has(k));
        if (key === undefined) return;
        this.inlineKey = key;
        const [tx, tz, lod] = decodeTileKey(key, this.world.period);
        m.start(tx, tz, lod);
      }
      if (m.step()) this.addTile(this.inlineKey, m.result!);
    }
  }

  /** Assign geometry to every chunk in range, and ask for what's missing. */
  private plan(): void {
    this.dirty = false;
    const S = CHUNK_SIZE, D = this.drawDistance, P = this.world.period;
    const R = Math.ceil(D / S) + 1;
    const holes: number[] = [];
    const wants: { key: number; ring: number }[] = [];
    let used = 0;
    for (let cz = this.fcz - R; cz <= this.fcz + R; cz++) {
      for (let cx = this.fcx - R; cx <= this.fcx + R; cx++) {
        const ring = Math.max(Math.abs(cx - this.fcx), Math.abs(cz - this.fcz));
        if (ring > 1) {
          const nx = Math.max(cx * S, Math.min(this.fx, (cx + 1) * S)), nz = Math.max(cz * S, Math.min(this.fz, (cz + 1) * S));
          if ((nx - this.fx) ** 2 + (nz - this.fz) ** 2 > D * D) continue;
        }
        const [tx, tz] = this.tileOf(cx, cz);
        const want = lodForRing(ring);
        // Best available: the wanted LOD, else the nearest coarser, else finer.
        let g: THREE.BufferGeometry | undefined;
        for (const lod of [want, want + 1, want + 2, want - 1, want - 2]) {
          if (lod < 0 || lod > 2) continue;
          g = this.geometries.get(tileKey(tx, tz, lod, P));
          if (g) break;
        }
        const key = tileKey(tx, tz, want, P);
        if (!this.geometries.has(key)) wants.push({ key, ring });
        if (!g) {
          holes.push(tileKey(tx, tz, 2, P));
          continue;
        }
        let mesh = this.meshes[used];
        if (!mesh) {
          mesh = new THREE.Mesh(g, this.material);
          this.meshes.push(mesh);
          this.object.add(mesh);
        }
        mesh.geometry = g;
        mesh.position.set(cx * S - this.ox, 0, cz * S - this.oz);
        mesh.visible = true;
        used++;
      }
    }
    for (let i = used; i < this.meshes.length; i++) this.meshes[i].visible = false;
    this.shown = used;
    // Holes first (coarse, fast), then the wanted LODs nearest first.
    wants.sort((a, b) => a.ring - b.ring);
    const keys = [...new Set([...holes, ...wants.map((w) => w.key)])];
    this.queue = keys;
    const sig = keys.join(',');
    if (this.worker && sig !== this.requested) {
      this.requested = sig;
      this.worker.postMessage({ type: 'want', keys });
    }
  }

  private placeSea(fx: number, fz: number): void {
    if (!this.sea) return;
    const size = this.drawDistance * 3;
    this.sea.scale.set(size, 1, size);
    this.sea.position.set(fx - this.ox, this.world.seaY, fz - this.oz);
    (this.seaMaterial!.userData.origin as THREE.Vector2).set(this.ox, this.oz);
  }
}

/** A soft cloud sea: Lambert white with a slow world-anchored puff pattern. */
function cloudMaterial(): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xf4f7fb });
  const origin = new THREE.Vector2();
  m.userData.origin = origin;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uOrigin = { value: origin };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCloud;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloud = (modelMatrix * vec4(position, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec2 vCloud;\nuniform vec2 uOrigin;\nfloat cHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nfloat cNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(cHash(i), cHash(i + vec2(1, 0)), f.x), mix(cHash(i + vec2(0, 1)), cHash(i + vec2(1, 1)), f.x), f.y); }').replace(
      '#include <color_fragment>',
      /* glsl */ `#include <color_fragment>
      vec2 cp = (vCloud + uOrigin) / 90.0;
      float c = cNoise(cp) * 0.55 + cNoise(cp * 2.3) * 0.3 + cNoise(cp * 5.1) * 0.15;
      diffuseColor.rgb *= mix(0.82, 1.04, smoothstep(0.3, 0.75, c));`,
    );
  };
  m.customProgramCacheKey = () => 'freedom-cloud-sea';
  return m;
}
