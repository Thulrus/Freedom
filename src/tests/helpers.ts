import { defaultSimParams, EMPTY_WORLD, Quad, RcChannels, type SimParams, type WorldQuery } from '../sim';

export const HZ = 500;
export const DT = 1 / HZ;

export function makeQuad(mod?: (p: SimParams) => void, altitude = 100): { quad: Quad; rc: RcChannels } {
  const p = defaultSimParams();
  mod?.(p);
  const quad = new Quad(p, DT);
  quad.reset(0, altitude, 0);
  const rc = new RcChannels();
  return { quad, rc };
}

/** Arm (rising edge, throttle low) and step once. */
export function arm(quad: Quad, rc: RcChannels, world: WorldQuery = EMPTY_WORLD): void {
  rc.throttle = 0;
  rc.arm = true;
  quad.step(rc, world);
}

export function run(quad: Quad, rc: RcChannels, seconds: number, world: WorldQuery = EMPTY_WORLD, each?: (tick: number) => void): void {
  const n = Math.round(seconds * HZ);
  for (let i = 0; i < n; i++) {
    each?.(i);
    quad.step(rc, world);
  }
}

/** Find the throttle with zero net vertical acceleration (closed-loop bisection). */
export function findHoverThrottle(mod?: (p: SimParams) => void): number {
  let lo = 0.1, hi = 0.7;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    const { quad, rc } = makeQuad(mod);
    arm(quad, rc);
    rc.throttle = mid;
    run(quad, rc, 1);
    const v0 = quad.state.vel.y;
    run(quad, rc, 0.5);
    // Net vertical acceleration after motors settle (velocity alone carries the spin-up transient).
    if (quad.state.vel.y - v0 < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** World-frame up vector of the body, y component (1 = level, -1 = inverted). */
export function uprightness(quad: Quad): number {
  const q = quad.state.quat;
  return 1 - 2 * (q.x * q.x + q.z * q.z);
}
