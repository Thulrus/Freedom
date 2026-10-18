import { describe, expect, it } from 'vitest';
import { applyRateCurve, applyThrottleCurve, maxRate, RATE_PRESETS } from '../sim';

describe('Betaflight rate curves', () => {
  it('Actual rates: center sensitivity and max rate', () => {
    const c = { type: 'actual', center: 70, max: 670, expo: 0 } as const;
    expect(applyRateCurve(c, 0)).toBe(0);
    expect(applyRateCurve(c, 1)).toBeCloseTo(670, 6);
    expect(applyRateCurve(c, -1)).toBeCloseTo(-670, 6);
    expect(applyRateCurve(c, 0.5)).toBeCloseTo(185, 6);
    // Slope at center equals center sensitivity.
    expect(applyRateCurve(c, 1e-5) / 1e-5).toBeCloseTo(70, 1);
  });

  it('Actual rates: expo softens mid-stick but keeps endpoints', () => {
    const lin = { type: 'actual', center: 100, max: 800, expo: 0 } as const;
    const exp = { ...lin, expo: 0.6 };
    expect(applyRateCurve(exp, 1)).toBeCloseTo(800, 6);
    expect(applyRateCurve(exp, 0.5)).toBeLessThan(applyRateCurve(lin, 0.5));
  });

  it('Betaflight (super) rates: 1.0 / 0.7 / 0 -> 667 deg/s', () => {
    const c = { type: 'betaflight', rcRate: 1, superRate: 0.7, expo: 0 } as const;
    expect(applyRateCurve(c, 1)).toBeCloseTo(200 / 0.3, 3);
    expect(applyRateCurve(c, 0.5)).toBeCloseTo((200 * 0.5) / (1 - 0.35), 3);
    // No super rate: linear 200 deg/s * rcRate.
    expect(applyRateCurve({ type: 'betaflight', rcRate: 1.5, superRate: 0, expo: 0 }, 1)).toBeCloseTo(300, 6);
  });

  it('Quick rates: reaches max at full stick, center slope = 200 * rcRate', () => {
    const c = { type: 'quick', rcRate: 1, max: 670, expo: 0 } as const;
    expect(applyRateCurve(c, 1)).toBeCloseTo(670, 3);
    expect(applyRateCurve(c, 1e-5) / 1e-5).toBeCloseTo(200, 1);
  });

  it('is odd-symmetric and clamped to the BF setpoint limit', () => {
    const c = { type: 'betaflight', rcRate: 2.55, superRate: 0.99, expo: 0 } as const;
    expect(applyRateCurve(c, 1)).toBe(1998);
    for (const preset of Object.values(RATE_PRESETS)) {
      const r = preset();
      for (const s of [0.1, 0.37, 0.8, 1]) expect(applyRateCurve(r.roll, -s)).toBeCloseTo(-applyRateCurve(r.roll, s), 9);
      expect(maxRate(r.roll)).toBeGreaterThan(300);
    }
  });

  it('throttle curve: identity at expo 0, fixed points at 0 / mid / 1', () => {
    for (const t of [0, 0.2, 0.5, 0.9, 1]) expect(applyThrottleCurve(t, 0.5, 0)).toBeCloseTo(t, 9);
    expect(applyThrottleCurve(0.3, 0.3, 0.8)).toBeCloseTo(0.3, 9);
    expect(applyThrottleCurve(1, 0.3, 0.8)).toBeCloseTo(1, 9);
    expect(applyThrottleCurve(0, 0.3, 0.8)).toBeCloseTo(0, 9);
    // Expo flattens around mid.
    expect(Math.abs(applyThrottleCurve(0.35, 0.3, 0.8) - 0.3)).toBeLessThan(0.05 * 0.5);
  });
});
