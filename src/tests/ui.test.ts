import { describe, expect, it } from 'vitest';
import { verticalFovFromDiagonal } from '../render/fov';
import { convertRate } from '../ui/tuning';
import { maxRate } from '../sim';
import { defaultSettings, mergeSettings } from '../settings';

describe('camera FOV', () => {
  it('diagonal -> vertical FOV', () => {
    // Square: vertical tan = diagonal tan / sqrt(2).
    const v = verticalFovFromDiagonal(90, 1);
    expect(Math.tan((v * Math.PI) / 360)).toBeCloseTo(1 / Math.SQRT2, 9);
    const wide = verticalFovFromDiagonal(120, 16 / 9);
    expect(wide).toBeGreaterThan(60);
    expect(wide).toBeLessThan(85);
  });
});

describe('rate type conversion keeps max rate', () => {
  it.each(['actual', 'betaflight', 'quick'] as const)('to %s', (t) => {
    const c = convertRate({ type: 'actual', center: 70, max: 670, expo: 0 }, t);
    expect(c.type).toBe(t);
    expect(Math.abs(maxRate(c) - 670) / 670).toBeLessThan(0.02);
  });
});

describe('settings', () => {
  it('merge tolerates junk and keeps gamepad profiles', () => {
    const s = mergeSettings({ camera: { fpvTilt: 40, mode: 'chase' }, input: { gamepads: { 'My Radio': { roll: 1 } } }, nope: 1 });
    expect(s.camera.fpvTilt).toBe(40);
    expect(s.camera.mode).toBe('chase');
    expect(s.input.gamepads['My Radio']).toBeTruthy();
    expect(s.sim).toEqual(defaultSettings().sim);
    expect(mergeSettings(null)).toEqual(defaultSettings());
  });
});
