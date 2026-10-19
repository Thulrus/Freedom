import { describe, expect, it } from 'vitest';
import { shapeStick, shapeThrottle } from '../input/shaping';
import { KeyboardInput } from '../input/keyboard';
import { detectAnalog, detectAxis, detectSwitch, isHeldSwitch, normalizeStick, normalizeThrottle, radioMapping, readAnalog, readSwitch, standardGamepadMapping, switchPosition } from '../input/gamepad';

const flat = { deadzone: 0, expo: 0, sensitivity: 1 };

describe('stick shaping', () => {
  it('is identity with no shaping', () => {
    for (const v of [-1, -0.3, 0, 0.42, 1]) expect(shapeStick(v, flat)).toBeCloseTo(v, 12);
    for (const v of [0, 0.3, 1]) expect(shapeThrottle(v, flat)).toBeCloseTo(v, 12);
  });
  it('deadzone zeroes the center and still reaches full deflection', () => {
    const s = { deadzone: 0.1, expo: 0, sensitivity: 1 };
    expect(shapeStick(0.08, s)).toBe(0);
    expect(shapeStick(-0.1, s)).toBe(0);
    expect(shapeStick(1, s)).toBeCloseTo(1, 12);
    expect(shapeStick(0.55, s)).toBeCloseTo(0.5, 12); // rescaled, no jump at the edge
  });
  it('expo softens the middle, sensitivity scales the end, NaN is safe', () => {
    expect(shapeStick(0.5, { deadzone: 0, expo: 0.5, sensitivity: 1 })).toBeLessThan(0.5);
    expect(shapeStick(1, { deadzone: 0, expo: 0, sensitivity: 0.6 })).toBeCloseTo(0.6, 12);
    expect(shapeStick(NaN, flat)).toBe(0);
    expect(shapeThrottle(NaN, flat)).toBe(0);
    expect(shapeStick(5, flat)).toBe(1);
  });
});

describe('keyboard virtual sticks', () => {
  it('slews toward deflection, recenters, and throttle holds', () => {
    const k = new KeyboardInput(5, 0.6);
    k.key('ArrowRight', true);
    k.key('KeyW', true);
    for (let i = 0; i < 50; i++) k.update(0.002); // 0.1 s
    expect(k.roll).toBeCloseTo(0.5, 6);
    expect(k.throttle).toBeCloseTo(0.06, 6);
    expect(k.active).toBe(true);
    k.key('ArrowRight', false);
    k.key('KeyW', false);
    for (let i = 0; i < 100; i++) k.update(0.002);
    expect(k.roll).toBe(0);
    expect(k.throttle).toBeCloseTo(0.06, 6); // non-centering
    expect(k.active).toBe(false);
  });
  it('ignores non-stick keys and releases on focus loss', () => {
    const k = new KeyboardInput();
    expect(k.key('KeyQ', true)).toBe(false);
    k.key('ArrowUp', true);
    k.releaseAll();
    k.update(0.1);
    expect(k.pitch).toBe(0);
  });
});

describe('gamepad / radio mapping', () => {
  it('standard gamepad: stick up = throttle high and pitch forward', () => {
    const m = standardGamepadMapping();
    expect(normalizeThrottle(-1, m.throttle)).toBe(1);
    expect(normalizeThrottle(1, m.throttle)).toBe(0);
    expect(normalizeThrottle(0, m.throttle)).toBeCloseTo(0.5, 12);
    expect(normalizeStick(-1, m.pitch)).toBe(1);
    expect(normalizeStick(0.5, m.roll)).toBe(0.5);
  });
  it('calibrated asymmetric radio axis maps to -1..1 around its center', () => {
    const a = { index: 0, min: -0.8, center: 0.05, max: 0.9, invert: false };
    expect(normalizeStick(0.05, a)).toBe(0);
    expect(normalizeStick(0.9, a)).toBeCloseTo(1, 12);
    expect(normalizeStick(-0.8, a)).toBeCloseTo(-1, 12);
    expect(normalizeStick(0.475, a)).toBeCloseTo(0.5, 12);
    expect(normalizeStick(2, a)).toBe(1);
    expect(normalizeStick(0.9, { ...a, invert: true })).toBeCloseTo(-1, 12);
    // Reversed axis (forward reads negative) handled by calibration alone.
    const r = { index: 0, min: 0.9, center: 0, max: -0.9, invert: false };
    expect(normalizeStick(-0.9, r)).toBeCloseTo(1, 12);
  });
  it('switches: axis threshold, button, 3-position', () => {
    const axes = [0, 0, 0, 0, 1, -0.02];
    const btn = [0, 1];
    expect(readSwitch({ kind: 'axis', index: 4, invert: false }, axes, btn)).toBe(1);
    expect(readSwitch({ kind: 'axis', index: 4, invert: true }, axes, btn)).toBe(-1);
    expect(readSwitch({ kind: 'button', index: 1, invert: false }, axes, btn)).toBe(1);
    expect([switchPosition(-1), switchPosition(0), switchPosition(1)]).toEqual([0, 1, 2]);
    expect(radioMapping().arm?.kind).toBe('axis');
  });
  it('calibration detection finds the moved axis / flipped switch', () => {
    expect(detectAxis([0, 0, -1, 0], [0.01, 0, 0.98, 0.05])).toEqual({ index: 2, from: -1, to: 0.98 });
    expect(detectAxis([0, 0], [0.1, -0.1])).toBeNull(); // noise only
    expect(detectSwitch([0, 0, 0, 0, -1], [0, 0, 0, 0, 1], [0], [0])).toEqual({ kind: 'axis', index: 4, invert: false });
    expect(detectSwitch([0, 0, 0, 0, 1], [0, 0, 0, 0, -1], [0], [0])).toEqual({ kind: 'axis', index: 4, invert: true });
    expect(detectSwitch([0.9, 0], [-0.9, 0], [0, 0], [0, 1], [0])).toEqual({ kind: 'button', index: 1, invert: false });
  });
  it('Firefox/Linux radio: throttle and switches arriving as analog trigger buttons', () => {
    // Firefox maps a radio's Z (CH3) to button 6 and Rz (CH6) to button 7, 0..1.
    const axes = [0, 0, 0, 0];
    const d = detectAnalog(axes, axes, [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 1, 0]);
    expect(d).toEqual({ button: true, index: 6, from: -1, to: 1 });
    const thr = { index: 6, button: true, min: -1, center: 0, max: 1, invert: false };
    expect(normalizeThrottle(readAnalog(thr, axes, [0, 0, 0, 0, 0, 0, 0.25]), thr)).toBeCloseTo(0.25, 6);
    expect(readAnalog({ index: 2 }, [0, 0, 0.5], [])).toBe(0.5);
    // Axes win over buttons when both moved.
    expect(detectAnalog([0, -1], [0, 1], [0], [1])?.button).toBe(false);
    // A 3-position switch on a trigger moving low -> mid is a held switch, not a press.
    const s = detectSwitch(axes, axes, [0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0.5]);
    expect(s).toEqual({ kind: 'button', index: 7, invert: false, analog: true });
    expect(isHeldSwitch(s!)).toBe(true);
    expect(switchPosition(readSwitch(s!, axes, [0, 0, 0, 0, 0, 0, 0, 0.5]))).toBe(1);
    // Buttons used by sticks are ignored.
    expect(detectSwitch(axes, axes, [0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 1], [], [6])).toBeNull();
  });
});
