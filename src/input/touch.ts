/**
 * Virtual sticks for touch screens: pure logic, no DOM (the UI layer feeds
 * pointer positions in screen pixels).
 *
 * Design choices (virtual sticks can't copy spring-loaded gimbals, so we aim
 * to avoid surprises):
 *  - Grabbing never jumps a stick: the knob keeps its value where your thumb
 *    lands and moves relative to it from there. In "fixed" mode the base stays
 *    put; in "floating" mode the base moves under your thumb.
 *  - Gimbal axes spring to center on release. The throttle axis holds its
 *    position (unless the beginner "throttle centering" option is on).
 *  - Square gate: each axis clamps independently, so full diagonals work like a
 *    real gimbal.
 *  - If the OS cancels a touch, the stick is released the same way (sticks
 *    center, throttle holds).
 */
import type { StickMode, TouchSettings } from '../settings';

export class VirtualStick {
  /** Knob position, -1..1 each axis (y up = +1). */
  x = 0;
  y = 0;
  /** Base center and travel radius, px. */
  cx = 0;
  cy = 0;
  radius = 80;
  /** Fixed-mode home position (floating sticks return here when released). */
  homeX = 0;
  homeY = 0;
  pointerId = -1;
  centerX = true;
  centerY = true;
  private grabX = 0;
  private grabY = 0;

  get active(): boolean {
    return this.pointerId !== -1;
  }

  setHome(cx: number, cy: number, radius: number): void {
    this.homeX = cx;
    this.homeY = cy;
    this.radius = radius;
    if (!this.active) {
      this.cx = cx;
      this.cy = cy;
    }
  }

  down(id: number, px: number, py: number, floating: boolean): void {
    this.pointerId = id;
    if (floating) {
      // Move the base so the knob (and its value) stays exactly under the thumb.
      this.cx = px - this.x * this.radius;
      this.cy = py + this.y * this.radius;
      this.grabX = 0;
      this.grabY = 0;
    } else {
      this.grabX = (px - this.cx) / this.radius - this.x;
      this.grabY = -(py - this.cy) / this.radius - this.y;
    }
  }

  move(px: number, py: number): void {
    const x = (px - this.cx) / this.radius - this.grabX;
    const y = -(py - this.cy) / this.radius - this.grabY;
    this.x = x < -1 ? -1 : x > 1 ? 1 : x;
    this.y = y < -1 ? -1 : y > 1 ? 1 : y;
  }

  /** Finger lifted or touch cancelled. */
  release(): void {
    this.pointerId = -1;
    if (this.centerX) this.x = 0;
    if (this.centerY) this.y = 0;
    this.cx = this.homeX;
    this.cy = this.homeY;
  }
}

/** Which axis of which stick drives each channel, per transmitter mode. */
export interface ModeMap {
  throttle: ['left' | 'right', 'x' | 'y'];
  yaw: ['left' | 'right', 'x' | 'y'];
  pitch: ['left' | 'right', 'x' | 'y'];
  roll: ['left' | 'right', 'x' | 'y'];
}

export function modeMap(mode: StickMode): ModeMap {
  switch (mode) {
    case 1:
      return { pitch: ['left', 'y'], yaw: ['left', 'x'], throttle: ['right', 'y'], roll: ['right', 'x'] };
    case 3:
      return { pitch: ['left', 'y'], roll: ['left', 'x'], throttle: ['right', 'y'], yaw: ['right', 'x'] };
    case 4:
      return { throttle: ['left', 'y'], roll: ['left', 'x'], pitch: ['right', 'y'], yaw: ['right', 'x'] };
    default:
      return { throttle: ['left', 'y'], yaw: ['left', 'x'], pitch: ['right', 'y'], roll: ['right', 'x'] };
  }
}

export class TouchInput {
  readonly left = new VirtualStick();
  readonly right = new VirtualStick();
  roll = 0;
  pitch = 0;
  yaw = 0;
  throttle = 0;
  /** True while any thumb is on a stick. */
  active = false;
  /** Hover throttle (0..1), used by the self-centering throttle option. */
  hoverThrottle = 0.3;
  private map: ModeMap = modeMap(2);
  private centering = false;
  /** Ramps throttle in after arming with centering on, so it doesn't jump. */
  private armRamp = 0;
  private configured = false;

  constructor(private settings: TouchSettings) {
    this.apply(settings);
  }

  apply(s: TouchSettings): void {
    const changed = !this.configured || s.mode !== this.settings.mode || s.throttleCentering !== this.centering;
    this.settings = s;
    this.configured = true;
    if (!changed) return; // layout/opacity/shaping edits must not move the sticks
    this.map = modeMap(s.mode);
    this.centering = s.throttleCentering;
    const thr = this.map.throttle[0] === 'left' ? this.left : this.right;
    for (const st of [this.left, this.right]) {
      st.centerX = true;
      st.centerY = st !== thr || this.centering;
      if (!st.active) st.x = st.y = 0;
    }
    // A non-centering throttle starts at the bottom (throttle 0).
    if (!this.centering && !thr.active) thr.y = -1;
  }

  /** Lay out stick bases for a viewport (px), with safe-area insets. */
  layout(width: number, height: number, safe: { left: number; right: number; bottom: number }): void {
    const s = this.settings;
    const r = Math.max(30, s.size * Math.min(width, height));
    const y = height - safe.bottom - s.insetY * height;
    this.left.setHome(safe.left + s.insetX * width, y, r);
    this.right.setHome(width - safe.right - s.insetX * width, y, r);
  }

  /** After a sim reset: a non-centering throttle goes back to the bottom. */
  resetThrottle(): void {
    const thr = this.map.throttle[0] === 'left' ? this.left : this.right;
    if (!this.centering && !thr.active) thr.y = -1;
  }

  /** Release everything (blur, cancel). Gimbal axes center; throttle holds. */
  releaseAll(): void {
    this.left.release();
    this.right.release();
  }

  /** Compute channels. armed/dt drive the centering-throttle ramp. */
  update(armed: boolean, dt: number): void {
    const read = ([side, axis]: ['left' | 'right', 'x' | 'y']) => (side === 'left' ? this.left : this.right)[axis];
    this.roll = read(this.map.roll);
    this.pitch = read(this.map.pitch);
    this.yaw = read(this.map.yaw);
    const t = read(this.map.throttle);
    if (!this.centering) {
      this.throttle = (t + 1) / 2;
    } else {
      // Center = hover; full up = 100%; full down = 0.
      const h = this.hoverThrottle;
      const v = t >= 0 ? h + t * (1 - h) : h * (1 + t);
      if (!armed) {
        this.armRamp = 0;
        this.throttle = 0; // allows arming with the stick centered
      } else {
        this.armRamp = Math.min(1, this.armRamp + dt / 0.6);
        this.throttle = v * this.armRamp;
      }
    }
    this.active = this.left.active || this.right.active;
  }
}
