import { describe, expect, it } from 'vitest';
import { Vec3, Quad, defaultSimParams, RcChannels } from '../sim';
import { buildSandbox, SandboxWorld } from '../world/sandbox';

describe('sandbox world', () => {
  const one = new SandboxWorld([{ cx: 0, cy: 2, cz: 0, hx: 1, hy: 2, hz: 0.5, yaw: Math.PI / 2, kind: 'pillar', color: 0 }], []);

  it('signed distance: ground, box faces (rotated), inside negative', () => {
    expect(one.distance(new Vec3(10, 3, 10))).toBeCloseTo(3, 9); // ground
    // Yaw 90°: the 1 m half-extent now lies along Z, 0.5 m along X.
    expect(one.distance(new Vec3(2, 2, 0))).toBeCloseTo(1.5, 9);
    expect(one.distance(new Vec3(0, 2, 3))).toBeCloseTo(2, 9);
    expect(one.distance(new Vec3(0, 2, 0))).toBeLessThan(0);
  });

  it('normals point out of the nearest surface', () => {
    const n = new Vec3();
    one.normal(new Vec3(2, 2, 0), n);
    expect(n.x).toBeCloseTo(1, 4);
    one.normal(new Vec3(0, 5, 0), n);
    expect(n.y).toBeCloseTo(1, 4);
    one.normal(new Vec3(30, 0.5, 30), n);
    expect(n.y).toBeCloseTo(1, 4);
  });

  it('raycast hits the box face', () => {
    const hit = one.raycast(new Vec3(10, 2, 0), new Vec3(-1, 0, 0), 50);
    expect(hit?.distance).toBeCloseTo(9.5, 2);
    expect(one.raycast(new Vec3(10, 2, 0), new Vec3(1, 0, 0), 50)).toBeNull();
  });

  it('layout is deterministic by seed and keeps spawn clear', () => {
    const a = buildSandbox(7), b = buildSandbox(7), c = buildSandbox(8);
    expect(a.boxes).toEqual(b.boxes);
    expect(a.boxes).not.toEqual(c.boxes);
    expect(a.gates.length).toBe(8);
    const spawnClear = a.distance(new Vec3(0, 1.5, 0));
    expect(spawnClear).toBeGreaterThan(1);
  });

  it('first gate is straight ahead of spawn and flyable through', () => {
    const w = buildSandbox(1);
    const g = w.gates[0];
    expect(Math.abs(g.x)).toBeLessThan(1e-9);
    expect(g.z).toBeLessThan(-10);
    // Center of the opening is clear by at least ~half the opening size.
    expect(w.distance(new Vec3(g.x, g.y, g.z))).toBeGreaterThan(0.7);
  });

  it('a quad flying into a pillar collides and stops at its surface', () => {
    const quad = new Quad(defaultSimParams());
    quad.reset(0, 2, 6);
    quad.state.vel.set(0, 0, -10); // straight at the box (no thrust, falling a bit)
    const rc = new RcChannels();
    for (let i = 0; i < 400; i++) quad.step(rc, one);
    const s = quad.state;
    expect(s.pos.z).toBeGreaterThan(1 + 0.12 - 0.01); // never inside the face at z = 1
    expect(s.contact || s.pos.y < 0.2).toBe(true);
  });
});
