/**
 * App-level settings (everything persisted). The sim's own params live in
 * `sim` and are the same JSON the tuning panel exports.
 */
import { defaultSimParams, mergeParams, type SimParams } from './sim';
import type { GamepadMapping } from './input/gamepad';

export type CameraMode = 'fpv' | 'chase' | 'los';

export interface CameraSettings {
  mode: CameraMode;
  /** FPV camera uptilt, degrees (0..60). */
  fpvTilt: number;
  /** FPV field of view, degrees, measured on the screen diagonal. */
  fpvFov: number;
  /** Chase camera distance behind / height above the quad, m. */
  chaseDistance: number;
  chaseHeight: number;
  /** Line-of-sight camera vertical FOV, degrees. */
  losFov: number;
}

export interface StickShaping {
  /** Fraction of travel ignored around center (0..0.3). */
  deadzone: number;
  /** Extra expo applied before the sim's rates (0..1). */
  expo: number;
  /** Output scale (0.2..1). */
  sensitivity: number;
}

export interface InputSettings {
  shaping: { roll: StickShaping; pitch: StickShaping; yaw: StickShaping; throttle: StickShaping };
  /** Saved gamepad / radio mappings keyed by Gamepad.id. */
  gamepads: Record<string, GamepadMapping>;
  /** Keyboard: how fast held keys move the virtual sticks (full travel per second). */
  keyboardStickSpeed: number;
  /** Keyboard: throttle change per second while W/S is held. */
  keyboardThrottleSpeed: number;
}

export interface GraphicsSettings {
  /** Max device pixel ratio used for rendering. */
  maxPixelRatio: number;
  antialias: boolean;
}

export interface AppSettings {
  version: 1;
  sim: SimParams;
  camera: CameraSettings;
  input: InputSettings;
  graphics: GraphicsSettings;
  ui: { osd: boolean; debug: boolean; helpSeen: boolean };
}

const noShaping = (): StickShaping => ({ deadzone: 0.02, expo: 0, sensitivity: 1 });

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    sim: defaultSimParams(),
    camera: { mode: 'fpv', fpvTilt: 30, fpvFov: 120, chaseDistance: 2.2, chaseHeight: 0.7, losFov: 50 },
    input: {
      shaping: { roll: noShaping(), pitch: noShaping(), yaw: noShaping(), throttle: { deadzone: 0, expo: 0, sensitivity: 1 } },
      gamepads: {},
      keyboardStickSpeed: 5,
      keyboardThrottleSpeed: 0.6,
    },
    graphics: { maxPixelRatio: 2, antialias: true },
    ui: { osd: true, debug: false, helpSeen: false },
  };
}

/** Merge saved/imported settings over defaults (tolerates old or partial data). */
export function mergeSettings(incoming: unknown): AppSettings {
  const base = defaultSettings();
  const merged = mergeParams(base, incoming);
  // Gamepad mappings are keyed by device id, so merge them separately.
  const gp = (incoming as { input?: { gamepads?: unknown } } | null)?.input?.gamepads;
  if (gp && typeof gp === 'object' && !Array.isArray(gp)) merged.input.gamepads = JSON.parse(JSON.stringify(gp));
  return merged;
}
