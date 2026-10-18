/**
 * Betaflight rate curves, ported from betaflight/src/main/fc/rc.c.
 * Input: stick in [-1, 1]. Output: rate setpoint in deg/s.
 */
import type { RateCurve } from './params';

/** BF SETPOINT_RATE_LIMIT. */
export const SETPOINT_RATE_LIMIT = 1998;
const RC_RATE_INCREMENTAL = 14.54;

export function applyRateCurve(c: RateCurve, stick: number): number {
  SCRATCH[0] = stick;
  applyRateCurveInPlace(c, SCRATCH, 0);
  return SCRATCH[0];
}
const SCRATCH = new Float64Array(1);

/**
 * Hot-loop variant: reads the stick from io[i] and writes the rate back.
 * (Passing/returning doubles through non-inlined calls makes V8 box them,
 * which allocates; typed-array slots don't.)
 */
export function applyRateCurveInPlace(c: RateCurve, io: Float64Array, i: number): void {
  const stick = io[i];
  const s = stick < -1 ? -1 : stick > 1 ? 1 : stick;
  const a = Math.abs(s);
  let rate = 0;
  switch (c.type) {
    case 'actual': {
      // expof = |x| * (x^5 * expo + x * (1 - expo))
      const s5 = s * s * s * s * s;
      const expof = a * (s5 * c.expo + s * (1 - c.expo));
      const stickMovement = Math.max(0, c.max - c.center);
      rate = s * c.center + stickMovement * expof;
      break;
    }
    case 'betaflight': {
      let cmd = s;
      if (c.expo) cmd = s * a * a * a * c.expo + s * (1 - c.expo);
      let rcRate = c.rcRate;
      if (rcRate > 2) rcRate += RC_RATE_INCREMENTAL * (rcRate - 2);
      rate = 200 * rcRate * cmd;
      if (c.superRate) {
        const f = 1 - a * c.superRate;
        rate *= 1 / (f < 0.01 ? 0.01 : f > 1 ? 1 : f);
      }
      break;
    }
    case 'quick': {
      const rcRate = c.rcRate * 200;
      const maxDps = Math.max(c.max, rcRate);
      const superFactorConfig = (maxDps / rcRate - 1) / (maxDps / rcRate);
      const curve = a * a * a * c.expo + a * (1 - c.expo);
      const f = 1 - curve * superFactorConfig;
      const superFactor = 1 / (f < 0.01 ? 0.01 : f > 1 ? 1 : f);
      rate = s * rcRate * superFactor;
      break;
    }
  }
  // Literal on purpose: a module-level binding here makes V8 box the result (allocation per call).
  io[i] = rate < -1998 ? -1998 : rate > 1998 ? 1998 : rate;
}

/** Max rate (deg/s) at full stick, handy for UI readouts. */
export function maxRate(c: RateCurve): number {
  return applyRateCurve(c, 1);
}

/** BF throttle curve (thr_mid / thr_expo), continuous version of the lookup table. */
export function applyThrottleCurve(t: number, mid: number, expo: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  const d = x - mid;
  const y = d > 0 ? 1 - mid : mid;
  if (y <= 0) return x;
  const r = d / y;
  return mid + d * (1 - expo + expo * r * r);
}
