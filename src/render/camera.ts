/** FPV, chase and line-of-sight cameras driven by the interpolated quad pose. */
import * as THREE from 'three';
import type { CameraMode, CameraSettings } from '../settings';
import { verticalFovFromDiagonal } from './fov';

const X_AXIS = new THREE.Vector3(1, 0, 0);

export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(90, 1, 0.03, 1200);
  /** Where the pilot stands in line-of-sight mode (render coordinates; the app updates it). */
  readonly pilotPos = new THREE.Vector3(0, 1.6, 4);
  /** Ground height under a render-space (x, z), so the chase camera never dips below terrain. */
  ground: (x: number, z: number) => number = () => 0;
  private readonly tilt = new THREE.Quaternion();
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3(0, 0, -1);
  private readonly heading = new THREE.Vector3(0, 0, -1);
  private readonly target = new THREE.Vector3();
  private lastMode: CameraMode | null = null;

  update(s: CameraSettings, pos: THREE.Vector3, quat: THREE.Quaternion, aspect: number, dt: number): void {
    const cam = this.camera;
    const modeChanged = s.mode !== this.lastMode;
    this.lastMode = s.mode;
    let vfov: number;
    switch (s.mode) {
      case 'fpv': {
        vfov = verticalFovFromDiagonal(s.fpvFov, aspect);
        // Camera sits slightly forward of the center of mass, tilted up.
        cam.position.copy(this.tmp.set(0, 0.012, -0.06).applyQuaternion(quat).add(pos));
        this.tilt.setFromAxisAngle(X_AXIS, (s.fpvTilt * Math.PI) / 180);
        cam.quaternion.copy(quat).multiply(this.tilt);
        break;
      }
      case 'chase': {
        vfov = 70;
        // Follow the horizontal heading; hold the last one when pointing straight up/down.
        this.fwd.set(0, 0, -1).applyQuaternion(quat);
        this.fwd.y = 0;
        if (this.fwd.lengthSq() > 0.04) this.heading.copy(this.fwd.normalize());
        this.target.copy(pos).addScaledVector(this.heading, -s.chaseDistance);
        this.target.y += s.chaseHeight;
        if (modeChanged) cam.position.copy(this.target);
        else cam.position.lerp(this.target, 1 - Math.exp(-dt * 10));
        // Never fall further behind than 1.5x the chase distance (fast climbs/dives).
        const lag = cam.position.distanceTo(this.target);
        const maxLag = s.chaseDistance * 0.5;
        if (lag > maxLag) cam.position.lerp(this.target, 1 - maxLag / lag);
        cam.position.y = Math.max(cam.position.y, this.ground(cam.position.x, cam.position.z) + 0.2);
        cam.lookAt(this.tmp.copy(pos).setY(pos.y + 0.15));
        break;
      }
      case 'los': {
        vfov = s.losFov;
        cam.position.copy(this.pilotPos);
        cam.lookAt(pos);
        break;
      }
    }
    if (cam.aspect !== aspect || cam.fov !== vfov) {
      cam.aspect = aspect;
      cam.fov = vfov;
      cam.updateProjectionMatrix();
    }
  }
}
