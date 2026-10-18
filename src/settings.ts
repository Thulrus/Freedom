/**
 * App-level settings (everything persisted). The sim's own params live in
 * `sim` and are the same JSON the tuning panel exports.
 */
import { defaultSimParams, mergeParams, type SimParams } from './sim';
import type { GamepadMapping } from './input/gamepad';
import type { WorldId } from './world/recipes';

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

export type QualityPreset = 'low' | 'medium' | 'high';

export interface GraphicsSettings {
  /** Low / Medium / High: pixel-ratio cap, draw distance. */
  quality: QualityPreset;
  /** Lower render resolution automatically when frames are missed. */
  dynamicResolution: boolean;
  /** Drop the quality preset if dynamic resolution alone can't hold the frame rate. */
  autoDowngrade: boolean;
  /** Battery / thermal saver: never render above 60 fps, lower resolution. Physics is unchanged. */
  batterySaver: boolean;
  /** Hard cap on device pixel ratio, on top of the preset. */
  maxPixelRatio: number;
  /** Needs a reload to change (WebGL context option). */
  antialias: boolean;
}

export type StickMode = 1 | 2 | 3 | 4;

export interface TouchSettings {
  /** Show touch sticks: auto = on touch devices. */
  enabled: 'auto' | 'on' | 'off';
  /** Transmitter mode. Mode 2 = throttle/yaw on the left. */
  mode: StickMode;
  /** Floating sticks re-center under your thumb where you touch. */
  floating: boolean;
  /** Beginner option: throttle springs back to hover when released. */
  throttleCentering: boolean;
  /** Stick travel radius as a fraction of the screen's short side. */
  size: number;
  /** Stick center distance from the left/right edge, fraction of screen width. */
  insetX: number;
  /** Stick center distance from the bottom, fraction of screen height. */
  insetY: number;
  /** Stick graphics opacity 0..1. */
  opacity: number;
  /** Vibrate on arm/disarm and crashes (Android). */
  haptics: boolean;
  /** Per-channel shaping for touch (separate from gamepad/radio). */
  shaping: { roll: StickShaping; pitch: StickShaping; yaw: StickShaping; throttle: StickShaping };
}

export interface WorldSettings {
  /** World recipe (see world/recipes.ts). */
  recipe: WorldId;
  /** Same seed = same world. */
  seed: number;
}

export interface AppSettings {
  version: 1;
  sim: SimParams;
  world: WorldSettings;
  camera: CameraSettings;
  input: InputSettings;
  graphics: GraphicsSettings;
  touch: TouchSettings;
  ui: { osd: boolean; debug: boolean; helpSeen: boolean };
}

const noShaping = (): StickShaping => ({ deadzone: 0.02, expo: 0, sensitivity: 1 });

export function defaultSettings(): AppSettings {
  return {
    version: 1,
    sim: defaultSimParams(),
    world: { recipe: 'hills', seed: 1 },
    camera: { mode: 'fpv', fpvTilt: 30, fpvFov: 120, chaseDistance: 2.2, chaseHeight: 0.7, losFov: 50 },
    input: {
      shaping: { roll: noShaping(), pitch: noShaping(), yaw: noShaping(), throttle: { deadzone: 0, expo: 0, sensitivity: 1 } },
      gamepads: {},
      keyboardStickSpeed: 5,
      keyboardThrottleSpeed: 0.6,
    },
    graphics: { quality: 'high', dynamicResolution: true, autoDowngrade: true, batterySaver: false, maxPixelRatio: 2, antialias: true },
    touch: {
      enabled: 'auto',
      mode: 2,
      floating: false,
      throttleCentering: false,
      size: 0.2,
      insetX: 0.16,
      insetY: 0.3,
      opacity: 0.55,
      haptics: true,
      shaping: {
        roll: { deadzone: 0.03, expo: 0.2, sensitivity: 1 },
        pitch: { deadzone: 0.03, expo: 0.2, sensitivity: 1 },
        yaw: { deadzone: 0.05, expo: 0.2, sensitivity: 1 },
        throttle: { deadzone: 0, expo: 0, sensitivity: 1 },
      },
    },
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
