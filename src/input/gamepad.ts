/**
 * Gamepad API input: Bluetooth/USB gamepads and radio transmitters in USB
 * joystick mode (EdgeTX/OpenTX/ELRS). Every channel is mapped explicitly and
 * can be calibrated, because radios report axes in arbitrary order and range.
 */
import type { FlightMode } from '../sim';

/** One analog channel. min/max are the raw readings at the two extremes. */
export interface AxisMap {
  index: number;
  /** Raw value at stick left / back / throttle low. */
  min: number;
  /** Raw value at rest (ignored for throttle). */
  center: number;
  /** Raw value at stick right / forward / throttle high. */
  max: number;
  /** Extra manual flip on top of calibration. */
  invert: boolean;
}

/** A switch or button. Axis switches are "on" above +0.5 (after invert). */
export interface SwitchMap {
  kind: 'axis' | 'button';
  index: number;
  invert: boolean;
}

export interface GamepadMapping {
  roll: AxisMap;
  pitch: AxisMap;
  yaw: AxisMap;
  throttle: AxisMap;
  /** Arm: an axis/switch holds the state; a button toggles it. */
  arm: SwitchMap | null;
  /** Mode: a 3-position axis selects low/mid/high; a button cycles. */
  mode: SwitchMap | null;
  /** Modes for switch positions low / mid / high. */
  modePositions: [FlightMode, FlightMode, FlightMode];
  /** Button indices for one-shot actions, or -1. */
  resetButton: number;
  cameraButton: number;
}

const axis = (index: number, invert = false): AxisMap => ({ index, min: -1, center: 0, max: 1, invert });

/** Defaults for a W3C "standard" gamepad (Xbox/PlayStation layout), Mode 2. */
export function standardGamepadMapping(): GamepadMapping {
  return {
    yaw: axis(0),
    // Stick up reads -1 on standard gamepads; throttle uses the full stick travel.
    throttle: { index: 1, min: 1, center: 0, max: -1, invert: false },
    roll: axis(2),
    pitch: { index: 3, min: 1, center: 0, max: -1, invert: false },
    arm: { kind: 'button', index: 9, invert: false }, // Start / Options
    mode: { kind: 'button', index: 3, invert: false }, // Y / Triangle
    modePositions: ['acro', 'horizon', 'angle'],
    resetButton: 8, // Back / Share
    cameraButton: 4, // LB / L1
  };
}

/** Guess for radios in USB joystick mode (AETR channel order, aux on 5/6). Calibrate! */
export function radioMapping(): GamepadMapping {
  return {
    roll: axis(0),
    pitch: axis(1),
    throttle: { index: 2, min: -1, center: 0, max: 1, invert: false },
    yaw: axis(3),
    arm: { kind: 'axis', index: 4, invert: false },
    mode: { kind: 'axis', index: 5, invert: false },
    modePositions: ['acro', 'horizon', 'angle'],
    resetButton: -1,
    cameraButton: -1,
  };
}

export function defaultMappingFor(pad: { mapping: string }): GamepadMapping {
  return pad.mapping === 'standard' ? standardGamepadMapping() : radioMapping();
}

/** Raw axis -> -1..1 using calibrated min/center/max. */
export function normalizeStick(raw: number, m: AxisMap): number {
  const t = raw - m.center;
  const hi = m.max - m.center, lo = m.center - m.min;
  let v: number;
  if (t * hi >= 0) v = hi !== 0 ? t / hi : 0;
  else v = lo !== 0 ? t / lo : 0;
  if (m.invert) v = -v;
  return v < -1 ? -1 : v > 1 ? 1 : v === v ? v : 0;
}

/** Raw axis -> 0..1 between calibrated min (low) and max (high). */
export function normalizeThrottle(raw: number, m: AxisMap): number {
  const span = m.max - m.min;
  let v = span !== 0 ? (raw - m.min) / span : 0;
  if (m.invert) v = 1 - v;
  return v > 0 ? (v < 1 ? v : 1) : 0; // also maps NaN and -0 to 0
}

export function readSwitch(s: SwitchMap, axes: ArrayLike<number>, buttons: ArrayLike<number>): number {
  const v = s.kind === 'axis' ? (axes[s.index] ?? 0) : (buttons[s.index] ?? 0) * 2 - 1;
  return s.invert ? -v : v;
}

/** 3-position switch value (-1..1) -> 0 / 1 / 2. */
export function switchPosition(v: number): 0 | 1 | 2 {
  return v < -0.33 ? 0 : v > 0.33 ? 2 : 1;
}

/** Calibration helper: the axis that moved most between two snapshots. */
export function detectAxis(a: ArrayLike<number>, b: ArrayLike<number>): { index: number; from: number; to: number } | null {
  let best = -1, bestD = 0.3; // must move at least 15% of travel
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.abs(b[i] - a[i]);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? null : { index: best, from: a[best], to: b[best] };
}

/** Calibration helper: a switch that changed between two snapshots (axes first, then buttons). */
export function detectSwitch(
  axesA: ArrayLike<number>,
  axesB: ArrayLike<number>,
  btnA: ArrayLike<number>,
  btnB: ArrayLike<number>,
  ignoreAxes: number[] = [],
): SwitchMap | null {
  let best = -1, bestD = 0.5;
  for (let i = 0; i < Math.min(axesA.length, axesB.length); i++) {
    if (ignoreAxes.includes(i)) continue;
    const d = Math.abs(axesB[i] - axesA[i]);
    if (d > bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best >= 0) return { kind: 'axis', index: best, invert: axesB[best] < axesA[best] };
  for (let i = 0; i < Math.min(btnA.length, btnB.length); i++) {
    if (btnB[i] > 0.5 && btnA[i] <= 0.5) return { kind: 'button', index: i, invert: false };
  }
  return null;
}

/** Live reader for one connected gamepad. */
export class GamepadInput {
  readonly axes = new Float32Array(16);
  readonly buttons = new Float32Array(32);
  private readonly prevButtons = new Float32Array(32);
  axisCount = 0;
  buttonCount = 0;
  id = '';
  connected = false;
  mapping: GamepadMapping | null = null;
  roll = 0;
  pitch = 0;
  yaw = 0;
  throttle = 0;
  /** Set when the sticks moved noticeably since the last poll. */
  moved = false;
  /** Gamepad timestamp of the latest sample, ms (for latency measurement). */
  timestamp = 0;

  constructor(private readonly getMapping: (pad: Gamepad) => GamepadMapping) {}

  /** Read the first connected pad. Call once per frame. */
  poll(): void {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      this.connected = false;
      this.moved = false;
      return;
    }
    if (pad.id !== this.id || !this.mapping) {
      this.id = pad.id;
      this.mapping = this.getMapping(pad);
    }
    this.connected = true;
    this.timestamp = pad.timestamp;
    this.prevButtons.set(this.buttons);
    this.axisCount = Math.min(pad.axes.length, 16);
    this.buttonCount = Math.min(pad.buttons.length, 32);
    for (let i = 0; i < this.axisCount; i++) this.axes[i] = pad.axes[i];
    for (let i = 0; i < this.buttonCount; i++) this.buttons[i] = pad.buttons[i].value;
    const m = this.mapping;
    const r = normalizeStick(this.axes[m.roll.index], m.roll);
    const p = normalizeStick(this.axes[m.pitch.index], m.pitch);
    const y = normalizeStick(this.axes[m.yaw.index], m.yaw);
    const t = normalizeThrottle(this.axes[m.throttle.index], m.throttle);
    this.moved = Math.abs(r - this.roll) + Math.abs(p - this.pitch) + Math.abs(y - this.yaw) + Math.abs(t - this.throttle) > 0.02;
    this.roll = r;
    this.pitch = p;
    this.yaw = y;
    this.throttle = t;
  }

  /** Button went down this poll. */
  pressed(index: number): boolean {
    return index >= 0 && this.buttons[index] > 0.5 && this.prevButtons[index] <= 0.5;
  }

  /** Re-read the mapping (after editing or calibration). */
  setMapping(m: GamepadMapping): void {
    this.mapping = m;
  }
}
