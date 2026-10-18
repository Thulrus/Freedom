import type { StickShaping } from '../settings';

/** Centered stick (-1..1): deadzone, then expo, then sensitivity. */
export function shapeStick(v: number, s: StickShaping): number {
  if (!(v === v)) return 0; // NaN
  const sign = v < 0 ? -1 : 1;
  let a = Math.min(Math.abs(v), 1);
  if (a <= s.deadzone) return 0;
  a = (a - s.deadzone) / (1 - s.deadzone);
  a = a * (1 - s.expo) + a * a * a * s.expo;
  return sign * a * s.sensitivity;
}

/** Throttle (0..1): deadzone at the bottom, expo, sensitivity scales the top. */
export function shapeThrottle(v: number, s: StickShaping): number {
  if (!(v === v)) return 0;
  let a = v < 0 ? 0 : v > 1 ? 1 : v;
  if (a <= s.deadzone) return 0;
  a = (a - s.deadzone) / (1 - s.deadzone);
  a = a * (1 - s.expo) + a * a * a * s.expo;
  return a * s.sensitivity;
}
