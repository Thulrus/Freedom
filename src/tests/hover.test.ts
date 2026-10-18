import { describe, expect, it } from 'vitest';
import { hoverThrottle, thrustToWeight, defaultSimParams } from '../sim';
import { arm, findHoverThrottle, makeQuad, run, uprightness } from './helpers';

describe('hover equilibrium', () => {
  it('default quad is a freestyle build (TWR 6..10)', () => {
    const twr = thrustToWeight(defaultSimParams());
    expect(twr).toBeGreaterThan(6);
    expect(twr).toBeLessThan(10);
  });

  it('closed-loop hover throttle matches the analytic estimate', () => {
    const measured = findHoverThrottle();
    const analytic = hoverThrottle(defaultSimParams());
    // Realistic 5" hover is ~25-40% throttle.
    expect(measured).toBeGreaterThan(0.2);
    expect(measured).toBeLessThan(0.45);
    // Analytic ignores sag and drag, so allow a few percent.
    expect(Math.abs(measured - analytic)).toBeLessThan(0.03);
  });

  it('holds altitude and attitude at hover throttle (acro, no inputs)', () => {
    const thr = findHoverThrottle();
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    rc.throttle = thr;
    run(quad, rc, 1.5);
    const v0 = quad.state.vel.y;
    run(quad, rc, 3);
    const s = quad.state;
    // Only slow sink from battery drain (voltage drops as charge is used).
    expect(Math.abs(s.vel.y - v0)).toBeLessThan(0.3);
    expect(Math.abs(s.vel.x) + Math.abs(s.vel.z)).toBeLessThan(0.05);
    expect(uprightness(quad)).toBeGreaterThan(0.9999);
    expect(s.omega.length()).toBeLessThan(1e-3);
  });

  it('battery-off hover has zero net vertical acceleration', () => {
    const mod = (p: ReturnType<typeof defaultSimParams>) => (p.quad.battery.enabled = false);
    const thr = findHoverThrottle(mod);
    const { quad, rc } = makeQuad(mod);
    arm(quad, rc);
    rc.throttle = thr;
    run(quad, rc, 2);
    const v0 = quad.state.vel.y;
    run(quad, rc, 3);
    // Zero net acceleration: vertical speed stays put (to < 2 cm/s over 3 s).
    expect(Math.abs(quad.state.vel.y - v0)).toBeLessThan(0.02);
  });
});
