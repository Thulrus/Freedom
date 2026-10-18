import { describe, expect, it } from 'vitest';
import { FlatGround, Quad, RcChannels, Rng, defaultSimParams, type QuadState } from '../sim';
import { arm, makeQuad } from './helpers';

function finite(s: QuadState): boolean {
  return (
    s.pos.isFinite() &&
    s.vel.isFinite() &&
    s.quat.isFinite() &&
    s.omega.isFinite() &&
    Number.isFinite(s.voltage) &&
    Number.isFinite(s.current) &&
    s.motorSpeed.every(Number.isFinite)
  );
}

describe('robustness under extreme inputs', () => {
  it('bang-bang stick slamming for 60 s stays finite with a unit quaternion', () => {
    const { quad, rc } = makeQuad(undefined, 50);
    const world = new FlatGround(0);
    const rng = new Rng(99);
    arm(quad, rc, world);
    for (let i = 0; i < 30000; i++) {
      if (i % 7 === 0) {
        rc.throttle = rng.next() < 0.5 ? 0 : 1;
        rc.roll = rng.next() < 0.5 ? -1 : 1;
        rc.pitch = rng.next() < 0.5 ? -1 : 1;
        rc.yaw = rng.next() < 0.5 ? -1 : 1;
        rc.mode = (['acro', 'angle', 'horizon'] as const)[i % 3];
        if (!quad.state.armed && rng.next() < 0.1) {
          rc.arm = false; // re-arm after a crash
          quad.step(rc, world);
          arm(quad, rc, world);
        }
      }
      quad.step(rc, world);
      if (!finite(quad.state)) throw new Error(`non-finite state at tick ${i}`);
    }
    const q = quad.state.quat;
    expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    expect(quad.state.pos.y).toBeGreaterThan(0); // never tunnels through the ground
  });

  it('garbage stick values (NaN, Infinity, out of range) do not poison the state', () => {
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    const bad = [NaN, Infinity, -Infinity, 1e9, -1e9];
    for (let i = 0; i < 2000; i++) {
      rc.roll = bad[i % 5];
      rc.pitch = bad[(i + 1) % 5];
      rc.yaw = bad[(i + 2) % 5];
      rc.throttle = bad[(i + 3) % 5];
      quad.step(rc, { distance: () => Infinity, normal: (_p, o) => o.set(0, 1, 0) });
      if (!finite(quad.state)) throw new Error(`non-finite at tick ${i}`);
    }
  });

  it('survives absurd parameters (tiny inertia, huge thrust, 1 kHz)', () => {
    const p = defaultSimParams();
    p.quad.inertia = [1e-6, 1e-6, 1e-6];
    p.quad.maxThrustPerMotor = 200;
    p.controller.pid.roll.p = 200;
    const quad = new Quad(p, 1 / 1000);
    quad.reset(0, 10, 0);
    const rc = new RcChannels();
    arm(quad, rc);
    rc.throttle = 1;
    rc.roll = 1;
    for (let i = 0; i < 5000; i++) quad.step(rc, new FlatGround(0));
    expect(finite(quad.state)).toBe(true);
  });
});
