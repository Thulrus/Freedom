/** Low-poly 5" quad model with spinning prop discs and a blob shadow. */
import * as THREE from 'three';
import type { QuadParams } from '../sim';

export class DroneModel {
  readonly group = new THREE.Group();
  readonly shadow: THREE.Mesh;
  private readonly props: THREE.Mesh[] = [];
  private readonly spin: number[] = [];

  constructor(quad: QuadParams) {
    const carbon = new THREE.MeshLambertMaterial({ color: 0x23262b, flatShading: true });
    const metal = new THREE.MeshLambertMaterial({ color: 0x9aa3ad, flatShading: true });
    const accent = new THREE.MeshLambertMaterial({ color: 0xff5a36, flatShading: true });
    const g = this.group;

    // Body stack + battery on top.
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.025, 0.11), carbon);
    g.add(body);
    const batt = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, 0.075), new THREE.MeshLambertMaterial({ color: 0x3a6fd8 }));
    batt.position.set(0, 0.03, 0.005);
    g.add(batt);
    const cam = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.022, 0.02), accent);
    cam.position.set(0, 0.008, -0.06);
    g.add(cam);

    const propMatFront = new THREE.MeshBasicMaterial({ color: 0xff7a3d, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false });
    const propMatRear = new THREE.MeshBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
    const propGeo = new THREE.CircleGeometry(0.0635, 3); // 5" prop disc; 3 sides reads as a blade blur when spinning
    propGeo.rotateX(-Math.PI / 2);

    for (const m of quad.motors) {
      const [x, y, z] = m.pos;
      const len = Math.hypot(x, z);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.006, len), carbon);
      arm.position.set(x / 2, y, z / 2);
      arm.rotation.y = Math.atan2(x, z);
      g.add(arm);
      const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.018, 8), metal);
      motor.position.set(x, y + 0.012, z);
      g.add(motor);
      const prop = new THREE.Mesh(propGeo, z < 0 ? propMatFront : propMatRear);
      prop.position.set(x, y + 0.024, z);
      g.add(prop);
      this.props.push(prop);
      this.spin.push(m.spin);
    }

    // Soft blob shadow on the ground for depth perception in chase/LOS views.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.55)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const sgeo = new THREE.PlaneGeometry(0.5, 0.5);
    sgeo.rotateX(-Math.PI / 2);
    this.shadow = new THREE.Mesh(sgeo, new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    this.shadow.renderOrder = 1;
  }

  /** Spin props from motor speeds (rad/s). Visual only: heavily slowed to avoid aliasing. */
  updateProps(motorSpeed: ArrayLike<number>, dt: number): void {
    for (let i = 0; i < this.props.length; i++) {
      this.props[i].rotation.y += this.spin[i] * Math.min(motorSpeed[i] * 0.02, 25) * dt;
    }
  }

  /** Place the shadow on the ground below the drone, fading with height. */
  updateShadow(x: number, y: number, z: number, groundY: number): void {
    const h = Math.max(y - groundY, 0);
    this.shadow.position.set(x, groundY + 0.01, z);
    const mat = this.shadow.material as THREE.MeshBasicMaterial;
    mat.opacity = Math.max(0, 1 - h / 15);
    this.shadow.scale.setScalar(1 + h * 0.08);
    this.shadow.visible = mat.opacity > 0.02;
  }
}
