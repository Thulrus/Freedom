/**
 * Betaflight-style flight controller: rate curves -> setpoint smoothing ->
 * PID + feedforward on angular rate, with Angle and Horizon self-leveling.
 *
 * Axis convention inside the controller is the pilot's: index 0 = roll
 * (positive right), 1 = pitch (positive nose down), 2 = yaw (positive right).
 * Units: deg/s for rates, BF "pidsum" units (0..1000) for PID terms.
 */
import { Pt1, Pt2 } from './filters';
import { clamp, DEG, Quat, RAD, rotateVec, rotateVecInverse, Vec3 } from './math';
import type { AxisPid, ControllerParams } from './params';
import { applyRateCurveInPlace, applyThrottleCurve } from './rates';
import type { RcChannels } from './rc';

// Betaflight PID scaling constants (pid.h).
const PTERM_SCALE = 0.032029;
const ITERM_SCALE = 0.244381;
const DTERM_SCALE = 0.000529;
const FEEDFORWARD_SCALE = 0.013754;

export class FlightController {
  /** Final rate setpoint per axis after smoothing, deg/s. */
  readonly setpoint = new Float64Array(3);
  /** Filtered gyro per axis, deg/s. */
  readonly gyro = new Float64Array(3);
  /** PID terms per axis (BF units), for telemetry. */
  readonly pTerm = new Float64Array(3);
  readonly iTerm = new Float64Array(3);
  readonly dTerm = new Float64Array(3);
  readonly ffTerm = new Float64Array(3);
  /** Output per axis in mixer units (pidsum / 1000). */
  readonly output = new Float64Array(3);
  /** Throttle after the throttle curve, 0..1. */
  throttle = 0;
  airmodeActive = false;

  private p!: ControllerParams;
  private dt = 0.002;
  private readonly gains = [new Float64Array(4), new Float64Array(4), new Float64Array(4)];
  private readonly gyroLpf = [new Pt1(), new Pt1(), new Pt1()];
  private readonly dLpf = [new Pt1(), new Pt1(), new Pt1()];
  private readonly spSmooth = [new Pt2(), new Pt2(), new Pt2()];
  private readonly ffLpf = [new Pt1(), new Pt1(), new Pt1()];
  private readonly relaxLpf = [new Pt1(), new Pt1(), new Pt1()];
  private readonly prevGyro = new Float64Array(3);
  private readonly prevSp = new Float64Array(3);
  private readonly rawSp = new Float64Array(3);
  private readonly levelCorr = new Float64Array(3);

  // Scratch for self-leveling.
  private readonly tmpA = new Vec3();
  private readonly tmpB = new Vec3();
  private readonly tmpF = new Vec3();
  private readonly tmpR = new Vec3();

  constructor(params: ControllerParams, dt: number) {
    this.configure(params, dt);
  }

  configure(params: ControllerParams, dt: number): void {
    this.p = params;
    this.dt = dt;
    const axes: AxisPid[] = [params.pid.roll, params.pid.pitch, params.pid.yaw];
    for (let a = 0; a < 3; a++) {
      const g = this.gains[a];
      g[0] = axes[a].p * PTERM_SCALE;
      g[1] = axes[a].i * ITERM_SCALE;
      g[2] = axes[a].d * DTERM_SCALE;
      g[3] = (axes[a].ff / 100) * FEEDFORWARD_SCALE;
      this.gyroLpf[a].configure(params.gyroLpfHz, dt);
      this.dLpf[a].configure(params.dtermLpfHz, dt);
      this.spSmooth[a].configure(params.rcSmoothingHz, dt);
      this.ffLpf[a].configure(params.ffSmoothingHz, dt);
      this.relaxLpf[a].configure(15, dt);
    }
  }

  reset(): void {
    for (let a = 0; a < 3; a++) {
      this.setpoint[a] = this.gyro[a] = this.output[a] = 0;
      this.pTerm[a] = this.iTerm[a] = this.dTerm[a] = this.ffTerm[a] = 0;
      this.prevGyro[a] = this.prevSp[a] = this.rawSp[a] = 0;
      this.gyroLpf[a].reset();
      this.dLpf[a].reset();
      this.spSmooth[a].reset();
      this.ffLpf[a].reset();
      this.relaxLpf[a].reset();
    }
    this.throttle = 0;
    this.airmodeActive = false;
  }

  /**
   * @param gyroRaw body rates in pilot convention, deg/s
   * @param attitude body->world orientation (for Angle/Horizon)
   * @param mixerSaturated whether the previous mix clipped (anti-windup)
   */
  update(rc: RcChannels, gyroRaw: Float64Array, attitude: Quat, armed: boolean, mixerSaturated: boolean): void {
    const p = this.p;
    const dt = this.dt;
    this.throttle = applyThrottleCurve(rc.throttle, p.throttleMid, p.throttleExpo);

    if (!armed) {
      this.airmodeActive = false;
    } else if (p.airmode && this.throttle > p.airmodeStartThrottle) {
      this.airmodeActive = true;
    }
    // I-term only runs when it can't wind up on the ground.
    const itermActive = armed && (p.airmode ? this.airmodeActive : this.throttle > 0.05);

    // 1. Stick -> rate setpoint via rate curves.
    const sp0 = this.rawSp;
    sp0[0] = rc.roll;
    sp0[1] = rc.pitch;
    sp0[2] = rc.yaw;
    applyRateCurveInPlace(p.rates.roll, sp0, 0);
    applyRateCurveInPlace(p.rates.pitch, sp0, 1);
    applyRateCurveInPlace(p.rates.yaw, sp0, 2);

    // 2. Self-leveling for Angle / Horizon (roll & pitch only).
    if (rc.mode !== 'acro') {
      const angleMode = rc.mode === 'angle';
      this.computeLevelCorrection(attitude, rc);
      if (angleMode) {
        const g = p.angleStrength / 10;
        this.rawSp[0] = this.levelCorr[0] * g;
        this.rawSp[1] = this.levelCorr[1] * g;
      } else {
        const stick = Math.max(Math.abs(rc.roll), Math.abs(rc.pitch));
        const f = p.horizonTransition > 0 ? clamp(1 - stick / p.horizonTransition, 0, 1) : 0;
        const g = (p.horizonStrength / 10) * f;
        this.rawSp[0] += this.levelCorr[0] * g;
        this.rawSp[1] += this.levelCorr[1] * g;
      }
    }

    // 3. PID per axis.
    for (let a = 0; a < 3; a++) {
      const g = this.gains[a];
      const gyro = this.gyroLpf[a].apply(gyroRaw[a]);
      this.gyro[a] = gyro;

      const sp = this.spSmooth[a].apply(this.rawSp[a]);
      this.setpoint[a] = sp;
      const err = sp - gyro;

      const pT = g[0] * err;

      // I-term relax: suppress accumulation while the setpoint is moving fast.
      let relax = 1;
      if (p.itermRelaxThreshold > 0 && a < 2) {
        const hp = sp - this.relaxLpf[a].apply(sp);
        relax = Math.max(0, 1 - Math.abs(hp) / p.itermRelaxThreshold);
      }
      let iT = this.iTerm[a];
      if (itermActive) {
        const delta = g[1] * err * dt * relax;
        const next = iT + delta;
        // Anti-windup: don't grow the I-term while the mixer is saturated.
        if (!(mixerSaturated && Math.abs(next) > Math.abs(iT))) iT = next;
        iT = clamp(iT, -p.itermLimit, p.itermLimit);
      } else {
        iT = 0;
      }

      // D on measurement (no derivative kick from stick moves).
      const dGyro = this.dLpf[a].apply((gyro - this.prevGyro[a]) / dt);
      const dT = -g[2] * dGyro;
      this.prevGyro[a] = gyro;

      // Feedforward from setpoint derivative.
      const ff = this.ffLpf[a].apply((sp - this.prevSp[a]) / dt) * g[3];
      this.prevSp[a] = sp;

      const lim = a === 2 ? p.pidSumLimitYaw : p.pidSumLimit;
      // BF clamps P+I+D; feedforward rides on top up to the same limit.
      const sum = clamp(clamp(pT + iT + dT, -lim, lim) + ff, -lim, lim);

      this.pTerm[a] = pT;
      this.iTerm[a] = iT;
      this.dTerm[a] = dT;
      this.ffTerm[a] = ff;
      this.output[a] = armed ? sum / 1000 : 0;
    }
  }

  /**
   * Rate (deg/s per deg of error) that rotates the body's up axis onto the
   * target tilt. Uses the shortest rotation, so it also recovers from
   * inverted. Writes [roll, pitch] error in degrees to levelCorr.
   */
  private computeLevelCorrection(q: Quat, rc: RcChannels): void {
    const targetRollDeg = rc.roll * this.p.angleLimit;
    const targetPitchDeg = rc.pitch * this.p.angleLimit;
    const fwd = rotateVec(q, this.tmpF.set(0, 0, -1), this.tmpF);
    fwd.y = 0;
    if (fwd.length() < 0.2) {
      // Nose near vertical: derive heading from the right vector instead.
      const r = rotateVec(q, this.tmpR.set(1, 0, 0), this.tmpR);
      fwd.set(r.z, 0, -r.x);
    }
    fwd.normalize();
    // right = fwd x up
    const right = this.tmpR.set(-fwd.z, 0, fwd.x);
    const phi = targetRollDeg * DEG;
    const theta = targetPitchDeg * DEG;
    const cp = Math.cos(phi);
    const up = this.tmpA
      .set(0, cp * Math.cos(theta), 0)
      .addScaled(right, Math.sin(phi))
      .addScaled(fwd, cp * Math.sin(theta));
    const u = rotateVecInverse(q, up, this.tmpB);
    // axis = (0,1,0) x u = (u.z, 0, -u.x); angle between body up and target up.
    const angle = Math.acos(clamp(u.y, -1, 1));
    const s = Math.sqrt(u.z * u.z + u.x * u.x);
    let wx: number, wz: number;
    if (s < 1e-6) {
      wx = 0;
      wz = angle > 1 ? angle : 0; // exactly inverted: pick roll
    } else {
      wx = (u.z / s) * angle;
      wz = (-u.x / s) * angle;
    }
    // Body rates -> pilot convention: roll = -wz, pitch = -wx.
    this.levelCorr[0] = -wz * RAD;
    this.levelCorr[1] = -wx * RAD;
  }
}
