import { describe, expect, it } from 'vitest';
import { FlatGround, RAD } from '../sim';
import { arm, findHoverThrottle, makeQuad, run, uprightness } from './helpers';

describe('scripted flights', () => {
  it('climb, full roll flip, recover: stable and level afterwards', () => {
    const hover = findHoverThrottle();
    const ground = new FlatGround(0);
    const { quad, rc } = makeQuad(undefined, 0);
    arm(quad, rc, ground);

    // Climb.
    rc.throttle = 0.7;
    run(quad, rc, 1.0, ground);
    const climbAlt = quad.state.pos.y;
    expect(climbAlt).toBeGreaterThan(8);

    // Flip: chop throttle-ish and hold full roll until we've rotated ~360.
    rc.throttle = 0.15;
    rc.roll = 1;
    let rolled = 0;
    let wasInverted = false;
    let ticks = 0;
    while (rolled < 340 && ticks < 2000) {
      quad.step(rc, ground);
      rolled += -quad.state.omega.z * RAD * quad.timestep;
      if (uprightness(quad) < -0.9) wasInverted = true;
      ticks++;
    }
    expect(wasInverted).toBe(true);
    expect(ticks * quad.timestep).toBeLessThan(0.8); // 670 deg/s max rate -> ~0.6 s flip

    // Recover: center sticks, punch out, then hover.
    rc.roll = 0;
    rc.throttle = 0.6;
    run(quad, rc, 0.4, ground);
    rc.throttle = hover;
    run(quad, rc, 2, ground);

    const s = quad.state;
    expect(s.armed).toBe(true);
    expect(s.crashed).toBe(false);
    expect(s.pos.y).toBeGreaterThan(3);
    expect(uprightness(quad)).toBeGreaterThan(0.97); // acro holds the attitude it ended the flip at
    expect(s.omega.length() * RAD).toBeLessThan(5);
  });

  it('Angle mode self-levels from inverted and holds the commanded tilt', () => {
    const hover = findHoverThrottle();
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    rc.mode = 'angle';
    // Start upside down.
    quad.state.quat.setFromAxisAngle(0, 0, 1, Math.PI * 0.97);
    rc.throttle = hover;
    run(quad, rc, 1.5);
    expect(uprightness(quad)).toBeGreaterThan(0.999);

    // Half right stick -> 30 deg right bank (angle limit 60).
    rc.roll = 0.5;
    run(quad, rc, 1.5);
    const tiltDeg = Math.acos(uprightness(quad)) * RAD;
    expect(tiltDeg).toBeGreaterThan(27);
    expect(tiltDeg).toBeLessThan(33);
    expect(quad.state.vel.x).toBeGreaterThan(1); // bank right -> drift right (+X)
  });

  it('Horizon mode levels at center stick and flips at full stick', () => {
    const hover = findHoverThrottle();
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    rc.mode = 'horizon';
    rc.throttle = hover;
    quad.state.quat.setFromAxisAngle(1, 0, 0, 0.6);
    run(quad, rc, 1.5);
    expect(uprightness(quad)).toBeGreaterThan(0.999);

    rc.pitch = 1;
    let inverted = false;
    for (let i = 0; i < 400; i++) {
      quad.step(rc, new FlatGround(-1e6));
      if (uprightness(quad) < -0.9) inverted = true;
    }
    expect(inverted).toBe(true);
  });

  it('pitch forward flies forward (-Z), yaw right turns the nose right', () => {
    const hover = findHoverThrottle();
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    rc.mode = 'angle';
    rc.throttle = hover;
    rc.pitch = 0.5;
    run(quad, rc, 1.5);
    expect(quad.state.vel.z).toBeLessThan(-1);

    rc.pitch = 0;
    rc.yaw = 0.5;
    run(quad, rc, 0.3);
    // Nose (-Z body) rotated toward +X? No: yaw right from facing -Z points the nose to +X.
    const q = quad.state.quat;
    const noseX = -(2 * (q.x * q.z + q.w * q.y));
    expect(noseX).toBeGreaterThan(0.3);
  });
});
