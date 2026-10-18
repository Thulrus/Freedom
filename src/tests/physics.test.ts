import { describe, expect, it } from 'vitest';
import { defaultSimParams, FlatGround, terminalVelocityFlat } from '../sim';
import { arm, makeQuad, run } from './helpers';

describe('basic physics sanity', () => {
  it('free fall accelerates at g when disarmed', () => {
    const { quad, rc } = makeQuad();
    quad.step(rc, new FlatGround(-1e6));
    const v0 = quad.state.vel.y;
    run(quad, rc, 0.1, new FlatGround(-1e6));
    const a = (quad.state.vel.y - v0) / 0.1;
    expect(a).toBeCloseTo(-9.81, 0); // drag is tiny at < 1 m/s
    expect(Math.abs(a + 9.81)).toBeLessThan(0.15);
    expect(quad.state.motorSpeed.every((w) => w === 0)).toBe(true);
  });

  it('terminal velocity (flat fall) matches the drag model', () => {
    const { quad, rc } = makeQuad(undefined, 10000);
    run(quad, rc, 20);
    const vt = terminalVelocityFlat(defaultSimParams());
    expect(-quad.state.vel.y).toBeCloseTo(vt, 1);
    expect(vt).toBeGreaterThan(15); // plausible for a 5" quad: ~15-30 m/s
    expect(vt).toBeLessThan(30);
  });

  it('full throttle climb accelerates at roughly (TWR - 1) * g at first', () => {
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    rc.throttle = 1;
    run(quad, rc, 0.15); // motors spin up
    const v0 = quad.state.vel.y;
    run(quad, rc, 0.1);
    const a = (quad.state.vel.y - v0) / 0.1;
    expect(a).toBeGreaterThan(40); // sag + drag make it a bit less than 7.15 g
    expect(a).toBeLessThan(75);
  });

  it('battery sags under load and recovers when unloaded', () => {
    const { quad, rc } = makeQuad();
    arm(quad, rc);
    const rest = quad.state.voltage;
    rc.throttle = 1;
    run(quad, rc, 0.3);
    const loaded = quad.state.voltage;
    expect(quad.state.current).toBeGreaterThan(60); // full punch on 6S: well over 60 A
    expect(rest - loaded).toBeGreaterThan(1);
    rc.throttle = 0;
    run(quad, rc, 0.5);
    expect(quad.state.voltage).toBeGreaterThan(loaded + 1);
  });

  it('wind pushes a hovering quad downwind', () => {
    const { quad, rc } = makeQuad((p) => (p.env.wind = [5, 0, 0]));
    arm(quad, rc);
    rc.throttle = 0.33;
    run(quad, rc, 2);
    expect(quad.state.vel.x).toBeGreaterThan(0.5);
  });
});

describe('arming, contact and crashes', () => {
  it('refuses to arm with throttle up; needs a switch toggle', () => {
    const { quad, rc } = makeQuad();
    rc.throttle = 0.5;
    rc.arm = true;
    quad.step(rc, new FlatGround(0));
    expect(quad.state.armed).toBe(false);
    expect(quad.armBlock).toBe('throttle');
    rc.throttle = 0;
    quad.step(rc, new FlatGround(0));
    expect(quad.state.armed).toBe(false); // still on: must cycle the switch
    rc.arm = false;
    quad.step(rc, new FlatGround(0));
    rc.arm = true;
    quad.step(rc, new FlatGround(0));
    expect(quad.state.armed).toBe(true);
  });

  it('rests on the ground without sinking or sliding', () => {
    const { quad, rc } = makeQuad(undefined, 0);
    run(quad, rc, 2, new FlatGround(0));
    const r = defaultSimParams().quad.collision.radius;
    expect(quad.state.pos.y).toBeGreaterThan(r - 0.01);
    expect(quad.state.vel.length()).toBeLessThan(0.05);
    expect(quad.state.contact).toBe(true);
  });

  it('a hard impact crashes and disarms; a gentle landing does not', () => {
    const ground = new FlatGround(0);
    const hard = makeQuad(undefined, 20);
    arm(hard.quad, hard.rc, ground);
    hard.quad.state.vel.set(0, -15, 0);
    run(hard.quad, hard.rc, 1.5, ground);
    expect(hard.quad.state.crashed).toBe(true);
    expect(hard.quad.state.armed).toBe(false);

    const soft = makeQuad(undefined, 0.5);
    arm(soft.quad, soft.rc, ground);
    soft.rc.throttle = 0.25; // gentle sink
    run(soft.quad, soft.rc, 3, ground);
    expect(soft.quad.state.crashed).toBe(false);
    expect(soft.quad.state.armed).toBe(true);
    expect(soft.quad.state.contact).toBe(true);
  });
});
