/**
 * Generic multirotor mixer (Quad-X by default), following Betaflight's
 * mixer.c: per-motor roll/pitch/yaw factors derived from geometry, plus
 * airmode-style desaturation.
 */
import type { MotorDef } from './params';

export class Mixer {
  readonly count: number;
  readonly rollF: Float64Array;
  readonly pitchF: Float64Array;
  readonly yawF: Float64Array;
  /** True if the last mix had to clip or scale (used for I-term anti-windup). */
  saturated = false;
  private readonly mix: Float64Array;

  constructor(motors: MotorDef[]) {
    this.count = motors.length;
    this.rollF = new Float64Array(this.count);
    this.pitchF = new Float64Array(this.count);
    this.yawF = new Float64Array(this.count);
    this.mix = new Float64Array(this.count);
    let maxX = 0, maxZ = 0;
    for (const m of motors) {
      maxX = Math.max(maxX, Math.abs(m.pos[0]));
      maxZ = Math.max(maxZ, Math.abs(m.pos[2]));
    }
    motors.forEach((m, i) => {
      // Thrust at +x (right) rolls left, so roll-right needs left motors up.
      this.rollF[i] = maxX > 0 ? -m.pos[0] / maxX : 0;
      // Rear motors (+z) up pitches nose down (= stick forward).
      this.pitchF[i] = maxZ > 0 ? m.pos[2] / maxZ : 0;
      // Speeding up CCW props yaws the frame clockwise (= yaw right).
      this.yawF[i] = m.spin;
    });
  }

  /**
   * input = [roll, pitch, yaw] in mixer units (BF pidsum / 1000) and
   * [3] = throttle 0..1. Writes motor commands 0..1 into out.
   * (Array input instead of number args keeps the hot loop allocation-free.)
   */
  apply(input: Float64Array, airmode: boolean, out: Float64Array): void {
    const roll = input[0], pitch = input[1], yaw = input[2], throttle = input[3];
    const n = this.count;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = roll * this.rollF[i] + pitch * this.pitchF[i] + yaw * this.yawF[i];
      this.mix[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min;
    this.saturated = false;
    if (range > 1) {
      const s = 1 / range;
      for (let i = 0; i < n; i++) this.mix[i] *= s;
      min *= s;
      max *= s;
      this.saturated = true;
    }
    let t = throttle;
    if (airmode || t > 0.5) {
      // Shift throttle so the whole mix fits in [0, 1].
      const lo = -min, hi = 1 - max;
      t = t < lo ? lo : t > hi ? hi : t;
    }
    for (let i = 0; i < n; i++) {
      let v = t + this.mix[i];
      if (v < 0) {
        v = 0;
        this.saturated = true;
      } else if (v > 1) {
        v = 1;
        this.saturated = true;
      }
      out[i] = v;
    }
  }
}
