import { describe, expect, it } from 'vitest';
import { FlatGround, Rng } from '../sim';
import { arm, makeQuad } from './helpers';

/** Run a seeded random-input flight and return a full state trace. */
function flight(seed: number, ticks = 5000): number[] {
  const { quad, rc } = makeQuad(undefined, 5);
  const world = new FlatGround(0);
  const rng = new Rng(seed);
  arm(quad, rc, world);
  const out: number[] = [];
  for (let i = 0; i < ticks; i++) {
    if (i % 25 === 0) {
      rc.throttle = 0.25 + 0.3 * rng.next();
      rc.roll = rng.signed();
      rc.pitch = rng.signed();
      rc.yaw = rng.signed() * 0.5;
      rc.mode = rng.next() < 0.8 ? 'acro' : 'angle';
    }
    quad.step(rc, world);
    const s = quad.state;
    out.push(s.pos.x, s.pos.y, s.pos.z, s.quat.x, s.quat.y, s.quat.z, s.quat.w, s.omega.x, s.voltage);
  }
  return out;
}

describe('determinism', () => {
  it('same seed + same inputs -> bit-identical trajectory', () => {
    const a = flight(1234);
    const b = flight(1234);
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) throw new Error(`diverged at sample ${i}: ${a[i]} vs ${b[i]}`);
  });

  it('different seeds diverge', () => {
    expect(flight(1, 500)).not.toEqual(flight(2, 500));
  });

  it('reset() fully restores initial state', () => {
    const { quad, rc } = makeQuad(undefined, 5);
    const world = new FlatGround(0);
    const runOnce = () => {
      quad.reset(0, 5, 0);
      rc.arm = false;
      quad.step(rc, world);
      arm(quad, rc, world);
      rc.throttle = 0.5;
      rc.roll = 0.3;
      for (let i = 0; i < 1000; i++) quad.step(rc, world);
      rc.throttle = 0;
      rc.roll = 0;
      const s = quad.state;
      return [s.pos.x, s.pos.y, s.pos.z, s.quat.w, s.voltage];
    };
    expect(runOnce()).toEqual(runOnce());
  });
});
