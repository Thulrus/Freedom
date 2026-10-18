/**
 * Draws a game-mode layout: solid gate frames and pylons (the same boxes the
 * physics collides with), faint outlines for virtual windows, a pulsing
 * highlight around the next checkpoint, and the hover box.
 */
import * as THREE from 'three';
import type { Layout } from '../game/types';
import type { GateDef } from '../world/boxes';
import type { FloatingOrigin } from './origin';

const HIGHLIGHT = 0xffe14d;
const BAR = 0.06;

export class CourseView {
  readonly object = new THREE.Group();
  private readonly highlight = new THREE.Group();
  private readonly zone: THREE.Mesh | null = null;
  private readonly zoneMat: THREE.MeshBasicMaterial | null = null;
  private shown = -2;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly layout: Layout) {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    this.disposables.push(unit);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);

    if (layout.boxes.length) {
      const mat = new THREE.MeshLambertMaterial({ flatShading: true });
      const solid = new THREE.InstancedMesh(unit, mat, layout.boxes.length);
      layout.boxes.forEach((b, i) => {
        m.compose(p.set(b.cx, b.cy, b.cz), q.setFromAxisAngle(up, b.yaw), s.set(b.hx * 2, b.hy * 2, b.hz * 2));
        solid.setMatrixAt(i, m);
        solid.setColorAt(i, col.setHex(b.color));
      });
      solid.computeBoundingSphere();
      this.object.add(solid);
      this.disposables.push(mat, solid);
    }

    // Faint outlines for windows (checkpoints with no physical frame).
    const windows = layout.checkpoints.filter((c) => c.style === 'window');
    if (windows.length) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false });
      const faint = new THREE.InstancedMesh(unit, mat, windows.length * 4);
      let k = 0;
      for (const c of windows) for (const bar of outlineBars(c, 0)) faint.setMatrixAt(k++, bar);
      faint.computeBoundingSphere();
      this.object.add(faint);
      this.disposables.push(mat, faint);
    }

    // Highlight: four glowing bars, moved to whichever checkpoint is next.
    const hmat = new THREE.MeshBasicMaterial({ color: HIGHLIGHT, transparent: true, opacity: 0.9, depthWrite: false });
    for (let i = 0; i < 4; i++) {
      const bar = new THREE.Mesh(unit, hmat);
      bar.matrixAutoUpdate = false;
      this.highlight.add(bar);
    }
    this.highlight.visible = false;
    this.object.add(this.highlight);
    this.disposables.push(hmat);

    if (layout.zone) {
      const z = layout.zone;
      this.zoneMat = new THREE.MeshBasicMaterial({ color: 0xffc531, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide });
      const geo = new THREE.BoxGeometry(z.half * 2, z.half * 2, z.half * 2);
      this.zone = new THREE.Mesh(geo, this.zoneMat);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff }));
      this.zone.add(edges);
      this.zone.position.set(z.x, z.y, z.z);
      this.object.add(this.zone);
      this.disposables.push(geo, this.zoneMat, edges.geometry, edges.material as THREE.Material);
    }
  }

  /** Per frame: follow the floating origin, move/pulse the highlight, color the hover box. */
  update(origin: FloatingOrigin, next: number, now: number, inZone: boolean): void {
    this.object.position.set(-origin.x, 0, -origin.z);
    if (next !== this.shown) {
      this.shown = next;
      const c = this.layout.checkpoints[next];
      this.highlight.visible = !!c;
      if (c) {
        // Around the frame for real gates, on the opening for windows.
        const bars = outlineBars(c, c.style === 'window' ? 0 : 0.22);
        this.highlight.children.forEach((b, i) => b.matrix.copy(bars[i]));
      }
    }
    const mat = (this.highlight.children[0] as THREE.Mesh).material as THREE.MeshBasicMaterial;
    mat.opacity = 0.65 + 0.3 * Math.sin(now * 0.008);
    if (this.zoneMat) this.zoneMat.color.setHex(inZone ? 0x7fd36b : 0xffc531);
  }

  dispose(): void {
    this.object.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

/** Matrices for four thin bars around a checkpoint's opening, `pad` m outside it. */
function outlineBars(c: GateDef, pad: number): THREE.Matrix4[] {
  const w = c.width / 2 + pad, h = c.height / 2 + pad;
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw);
  const cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
  const at = (lx: number, ly: number, sx: number, sy: number) =>
    new THREE.Matrix4().compose(new THREE.Vector3(c.x + cs * lx, c.y + ly, c.z - sn * lx), q, new THREE.Vector3(sx, sy, BAR));
  return [at(-w, 0, BAR, h * 2 + BAR), at(w, 0, BAR, h * 2 + BAR), at(0, h, w * 2 + BAR, BAR), at(0, -h, w * 2 + BAR, BAR)];
}
