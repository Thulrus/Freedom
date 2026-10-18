import { describe, expect, it } from 'vitest';
import { metrics, stepResponse } from './stepResponse';

describe('rate controller step response', () => {
  for (const [axis, maxRise] of [
    ['roll', 0.05],
    ['pitch', 0.05],
    ['yaw', 0.12],
  ] as const) {
    it(`${axis}: fast, modest overshoot, settles, low cross-coupling`, () => {
      const m = metrics(stepResponse(axis));
      expect(m.target).toBeCloseTo(185, 0); // BF default actual rates at half stick
      expect(m.rise90).toBeLessThan(maxRise);
      expect(m.overshoot).toBeGreaterThan(-0.01);
      expect(m.overshoot).toBeLessThan(0.25);
      expect(m.finalErr).toBeLessThan(0.03);
      expect(m.cross).toBeLessThan(0.05);
    });
  }

  it('full-stick roll reaches the configured max rate (670 deg/s)', () => {
    const tr = stepResponse('roll', 1, 0.4);
    const m = metrics(tr);
    expect(m.target).toBeCloseTo(670, 0);
    expect(m.rise90).toBeLessThan(0.1);
    expect(m.finalErr).toBeLessThan(0.03);
  });

  it('negative stick gives the mirrored response', () => {
    const pos = stepResponse('roll', 0.5, 0.2);
    const neg = stepResponse('roll', -0.5, 0.2);
    for (let i = 0; i < pos.gyro.length; i += 10) expect(neg.gyro[i]).toBeCloseTo(-pos.gyro[i], 0);
  });
});
