/**
 * All tunable parameters for the vehicle and flight controller.
 *
 * Everything here is plain JSON-serializable data so it can be edited in a
 * tuning panel, exported, shared, and re-imported. Units are SI unless noted.
 * Changing params at runtime is allowed; call `quad.applyParams()` afterwards
 * so derived constants are recomputed.
 */

export type FlightMode = 'acro' | 'angle' | 'horizon';

/** Betaflight rate curve for one axis. Enter numbers as shown in BF Configurator. */
export type RateCurve =
  | {
      type: 'actual';
      /** Center sensitivity, deg/s per full stick at center slope. BF default 70. */
      center: number;
      /** Max rate at full stick, deg/s. BF default 670. */
      max: number;
      /** Expo 0..1. BF default 0. */
      expo: number;
    }
  | {
      type: 'betaflight';
      /** "RC Rate", e.g. 1.00. Values above 2.0 get BF's incremental boost. */
      rcRate: number;
      /** "Super Rate", 0..0.99, e.g. 0.70. */
      superRate: number;
      /** "RC Expo", 0..1. */
      expo: number;
    }
  | {
      type: 'quick';
      /** "RC Rate", e.g. 1.00 (center = 200 deg/s per unit). */
      rcRate: number;
      /** Max rate, deg/s. */
      max: number;
      /** Expo 0..1. */
      expo: number;
    };

export interface AxisRates {
  roll: RateCurve;
  pitch: RateCurve;
  yaw: RateCurve;
}

/**
 * PID gains in Betaflight units (same numbers you see in BF Configurator).
 * They are scaled internally by BF's own constants, so the *meaning* matches;
 * whether a given number feels identical depends on how closely the airframe
 * model matches your real quad.
 */
export interface AxisPid {
  p: number;
  i: number;
  d: number;
  /** Feedforward ("F"). */
  ff: number;
}

export interface ControllerParams {
  pid: { roll: AxisPid; pitch: AxisPid; yaw: AxisPid };
  rates: AxisRates;
  /** BF throttle curve: thr_mid (0..1) and thr_expo (0..1). */
  throttleMid: number;
  throttleExpo: number;
  /** Airmode: full PID authority at zero throttle via mixer desaturation. */
  airmode: boolean;
  /** Throttle (0..1) that activates the I-term in airmode after arming. */
  airmodeStartThrottle: number;
  /** I-term clamp, in BF pidsum units (0..1000). BF default 400. */
  itermLimit: number;
  /** I-term relax setpoint threshold, deg/s. 0 disables. BF uses ~40. */
  itermRelaxThreshold: number;
  /** Total pid-sum clamp per axis (roll/pitch), BF units. BF default 500. */
  pidSumLimit: number;
  /** Yaw pid-sum clamp, BF units. BF default 400. */
  pidSumLimitYaw: number;
  /** Gyro low-pass cutoff, Hz (PT1). 0 disables. */
  gyroLpfHz: number;
  /** D-term low-pass cutoff, Hz (PT1). 0 disables. */
  dtermLpfHz: number;
  /** Setpoint (RC) smoothing cutoff, Hz (PT2). Smooths low-rate inputs like touch. */
  rcSmoothingHz: number;
  /** Feedforward smoothing cutoff, Hz (PT1 on setpoint derivative). */
  ffSmoothingHz: number;
  /** Motor idle (dshot_idle_value), 0..1. BF default 0.055. */
  motorIdle: number;
  /** Angle mode: max tilt, degrees. */
  angleLimit: number;
  /** Angle mode: level strength (BF "angle strength"), deg/s per deg / 10. */
  angleStrength: number;
  /** Horizon mode: stick deflection (0..1) at which self-level fades out fully. */
  horizonTransition: number;
  /** Horizon mode: self-level strength (same units as angleStrength). */
  horizonStrength: number;
}

export interface MotorDef {
  /** Motor position in body frame, m. */
  pos: [number, number, number];
  /** +1 = props spin counter-clockwise viewed from above, -1 = clockwise. */
  spin: 1 | -1;
}

export interface QuadParams {
  /** Display name for profiles. */
  name: string;
  /** All-up weight including battery, kg. */
  mass: number;
  /** Diagonal inertia [Ixx (pitch axis), Iyy (yaw axis), Izz (roll axis)], kg*m^2. */
  inertia: [number, number, number];
  /** Motors in Betaflight order: 1 rear-right, 2 front-right, 3 rear-left, 4 front-left. */
  motors: MotorDef[];
  /** Static thrust per motor at full command on a full battery (no sag), N. */
  maxThrustPerMotor: number;
  /** Prop reaction torque / thrust ratio (kQ / kT), m. Drives yaw authority. */
  torqueToThrust: number;
  /** Max motor speed at full command on a full battery, rad/s. */
  maxMotorSpeed: number;
  /** Rotor (prop + bell) inertia, kg*m^2. Adds yaw kick on motor accel. */
  rotorInertia: number;
  /** Motor spin-up time constant, s. */
  motorTauUp: number;
  /** Motor spin-down time constant, s (usually slower than spin-up). */
  motorTauDown: number;
  /** Electrical efficiency (mechanical power / electrical power), 0..1. */
  motorEfficiency: number;
  /** Linear drag per body axis [x, y, z], N/(m/s). */
  dragLinear: [number, number, number];
  /** Quadratic drag per body axis [x, y, z], N/(m/s)^2. */
  dragQuadratic: [number, number, number];
  /** Rotational damping per body axis, N*m/(rad/s). */
  angularDamping: [number, number, number];
  battery: {
    enabled: boolean;
    cells: number;
    /** Capacity, mAh. */
    capacityMah: number;
    /** Pack internal resistance incl. wiring, ohm. */
    internalResistance: number;
    /** Starting state of charge, 0..1. */
    startCharge: number;
  };
  collision: {
    /** Collision sphere radius, m. */
    radius: number;
    /** Normal restitution 0..1. */
    restitution: number;
    /** Tangential velocity damping on contact, 1/s. */
    friction: number;
    /** Impact speed (along normal) that counts as a crash, m/s. */
    crashSpeed: number;
    /** Disarm on crash. */
    disarmOnCrash: boolean;
  };
}

export interface EnvironmentParams {
  /** Gravity, m/s^2 (positive number, acts along -Y). Always 9.81 in Training worlds. */
  gravity: number;
  /** Constant wind velocity in world frame, m/s. */
  wind: [number, number, number];
}

export interface SimParams {
  quad: QuadParams;
  controller: ControllerParams;
  env: EnvironmentParams;
}

/** Quad-X motor layout in Betaflight order with "props in" spin directions. */
export function quadXMotors(armLength: number): MotorDef[] {
  const a = armLength * Math.SQRT1_2;
  return [
    { pos: [a, 0, a], spin: -1 }, // 1 rear-right, CW
    { pos: [a, 0, -a], spin: 1 }, // 2 front-right, CCW
    { pos: [-a, 0, a], spin: 1 }, // 3 rear-left, CCW
    { pos: [-a, 0, -a], spin: -1 }, // 4 front-left, CW
  ];
}

/** A typical 5" 6S freestyle quad, ~650 g with battery, ~8:1 thrust-to-weight. */
export function default5inch(): QuadParams {
  return {
    name: '5" freestyle 6S',
    mass: 0.65,
    inertia: [0.0019, 0.003, 0.0016],
    motors: quadXMotors(0.113),
    maxThrustPerMotor: 13.0,
    torqueToThrust: 0.016,
    maxMotorSpeed: 3500,
    rotorInertia: 2.5e-6,
    motorTauUp: 0.022,
    motorTauDown: 0.04,
    motorEfficiency: 0.8,
    dragLinear: [0.2, 0.12, 0.2],
    dragQuadratic: [0.009, 0.016, 0.007],
    angularDamping: [0.0004, 0.0006, 0.0004],
    battery: {
      enabled: true,
      cells: 6,
      capacityMah: 1300,
      internalResistance: 0.025,
      startCharge: 1,
    },
    collision: {
      radius: 0.12,
      restitution: 0.2,
      friction: 6,
      crashSpeed: 6,
      disarmOnCrash: true,
    },
  };
}

export function defaultController(): ControllerParams {
  return {
    // Betaflight 4.4+ defaults.
    pid: {
      roll: { p: 45, i: 80, d: 40, ff: 120 },
      pitch: { p: 47, i: 84, d: 46, ff: 125 },
      yaw: { p: 45, i: 80, d: 0, ff: 120 },
    },
    rates: RATE_PRESETS.betaflightDefault(),
    throttleMid: 0.5,
    throttleExpo: 0,
    airmode: true,
    airmodeStartThrottle: 0.25,
    itermLimit: 400,
    itermRelaxThreshold: 40,
    pidSumLimit: 500,
    pidSumLimitYaw: 400,
    gyroLpfHz: 250,
    dtermLpfHz: 100,
    rcSmoothingHz: 40,
    ffSmoothingHz: 25,
    motorIdle: 0.055,
    angleLimit: 60,
    angleStrength: 50,
    horizonTransition: 0.75,
    horizonStrength: 50,
  };
}

export function defaultEnvironment(): EnvironmentParams {
  return { gravity: 9.81, wind: [0, 0, 0] };
}

export function defaultSimParams(): SimParams {
  return { quad: default5inch(), controller: defaultController(), env: defaultEnvironment() };
}

function same(c: RateCurve): AxisRates {
  return { roll: { ...c }, pitch: { ...c }, yaw: { ...c } };
}

export const RATE_PRESETS = {
  /** Gentle, low max rate: for first flights. */
  beginner: (): AxisRates => same({ type: 'actual', center: 100, max: 400, expo: 0.3 }),
  /** Betaflight 4.3+ out-of-the-box rates. */
  betaflightDefault: (): AxisRates => same({ type: 'actual', center: 70, max: 670, expo: 0 }),
  /** Common freestyle setup: soft center, fast flips. */
  freestyle: (): AxisRates => ({
    roll: { type: 'actual', center: 140, max: 800, expo: 0.5 },
    pitch: { type: 'actual', center: 140, max: 800, expo: 0.5 },
    yaw: { type: 'actual', center: 140, max: 600, expo: 0.4 },
  }),
  /** More linear, lower max: precise lines through gates. */
  racing: (): AxisRates => ({
    roll: { type: 'actual', center: 220, max: 650, expo: 0.2 },
    pitch: { type: 'actual', center: 220, max: 650, expo: 0.2 },
    yaw: { type: 'actual', center: 200, max: 500, expo: 0.1 },
  }),
  /** Old Betaflight default (BF rates 1.0 / 0.7 / 0). */
  classic: (): AxisRates => same({ type: 'betaflight', rcRate: 1.0, superRate: 0.7, expo: 0 }),
} as const;

export type RatePresetName = keyof typeof RATE_PRESETS;

/** Deep clone via JSON (params are plain data). */
export function cloneParams<T>(p: T): T {
  return JSON.parse(JSON.stringify(p)) as T;
}

/**
 * Merge an imported (possibly partial or older) params object over defaults.
 * Unknown keys are dropped; wrong-typed values are ignored.
 */
export function mergeParams<T>(base: T, incoming: unknown): T {
  const out = cloneParams(base);
  mergeInto(out as unknown as Record<string, unknown>, incoming);
  return out;
}

function mergeInto(target: Record<string, unknown>, src: unknown): void {
  if (typeof src !== 'object' || src === null || Array.isArray(src)) return;
  const s = src as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    if (!(key in s)) continue;
    const tv = target[key];
    const sv = s[key];
    if (Array.isArray(tv)) {
      if (Array.isArray(sv) && sv.length === tv.length) {
        if (tv.every((x) => typeof x === 'number') && sv.every((x) => typeof x === 'number' && Number.isFinite(x))) {
          target[key] = [...sv];
        } else if (tv.every((x) => typeof x === 'object')) {
          tv.forEach((item, i) => mergeInto(item as Record<string, unknown>, sv[i]));
        }
      } else if (key === 'motors' && Array.isArray(sv) && sv.length >= 3) {
        target[key] = cloneParams(sv); // allow other motor counts later
      }
    } else if (typeof tv === 'object' && tv !== null) {
      // Rate curves are a tagged union: replace wholesale if the type tag is valid.
      const tagged = sv as { type?: unknown } | null;
      if ('type' in (tv as object) && tagged && typeof tagged === 'object' && typeof tagged.type === 'string') {
        if (isRateCurve(sv)) target[key] = cloneParams(sv);
      } else {
        mergeInto(tv as Record<string, unknown>, sv);
      }
    } else if (typeof tv === typeof sv && (typeof sv !== 'number' || Number.isFinite(sv))) {
      target[key] = sv;
    }
  }
}

function isRateCurve(v: unknown): v is RateCurve {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const num = (k: string) => typeof r[k] === 'number' && Number.isFinite(r[k]);
  switch (r.type) {
    case 'actual':
      return num('center') && num('max') && num('expo');
    case 'betaflight':
      return num('rcRate') && num('superRate') && num('expo');
    case 'quick':
      return num('rcRate') && num('max') && num('expo');
    default:
      return false;
  }
}
