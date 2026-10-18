import { describe, expect, it } from 'vitest';
import { FixedStepper, FlatGround } from '../sim';
import { makeQuad } from './helpers';

describe('fixed-timestep stepper', () => {
  it('runs whole ticks, carries the remainder, returns alpha in [0,1)', () => {
    const { quad } = makeQuad();
    let samples = 0;
    const st = new FixedStepper(quad, new FlatGround(-1e6), () => samples++);
    st.advance(1 / 60); // 8.33 ticks
    const a1 = st.alpha;
    expect(st.lastTicks).toBe(8);
    expect(samples).toBe(8); // input sampled once per tick
    expect(a1).toBeGreaterThanOrEqual(0);
    expect(a1).toBeLessThan(1);
    let total = 8;
    for (let i = 0; i < 59; i++) {
      st.advance(1 / 60);
      total += st.lastTicks;
    }
    expect(total).toBeGreaterThanOrEqual(499);
    expect(total).toBeLessThanOrEqual(500);
    expect(quad.state.time).toBeCloseTo(total / 500, 9);
  });

  it('prev/curr bracket the latest tick for interpolation', () => {
    const { quad } = makeQuad();
    const st = new FixedStepper(quad, new FlatGround(-1e6), () => {});
    st.advance(0.05);
    expect(st.curr.time - st.prev.time).toBeCloseTo(1 / 500, 9);
    expect(st.curr.pos.y).toBeLessThan(st.prev.pos.y); // falling
  });

  it('clamps substeps on a huge frame instead of spiraling', () => {
    const { quad } = makeQuad();
    const st = new FixedStepper(quad, new FlatGround(-1e6), () => {}, 20);
    st.advance(0.2);
    expect(st.lastTicks).toBe(20);
    expect(st.droppedTicks).toBeGreaterThanOrEqual(79); // 0.2 / 0.002 is not exact in floating point
    expect(st.droppedTicks).toBeLessThanOrEqual(80);
    st.advance(1 / 60);
    expect(st.lastTicks).toBeLessThanOrEqual(9);
  });
});
