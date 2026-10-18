/**
 * Flight recording and deterministic replay.
 *
 * Live, the recorder only logs the sticks, arm switch and flight mode for
 * every physics tick (9 bytes/tick, about 270 kB per minute). A replay
 * re-simulates the flight from the same start with the same inputs: the sim
 * is deterministic, so it reproduces the flight exactly, and that pass also
 * produces the full telemetry (attitude, gyro vs setpoint, motors, battery)
 * without recording any of it live. The final state is compared with the
 * live one as a check.
 */
import { cloneParams, Quad, Quat, RcChannels, type FlightMode, type QuadState, type SimParams, type WorldQuery } from '../sim';

const MODES: FlightMode[] = ['acro', 'angle', 'horizon'];
/** Longest recording, ticks (10 minutes at 500 Hz). */
export const MAX_RECORD_TICKS = 500 * 60 * 10;
/** One trace sample every this many ticks (100 Hz at 500 Hz). */
export const TRACE_EVERY = 5;

export class FlightRecorder {
  readonly roll = new Float32Array(MAX_RECORD_TICKS);
  readonly pitch = new Float32Array(MAX_RECORD_TICKS);
  readonly yaw = new Float32Array(MAX_RECORD_TICKS);
  readonly throttle = new Float32Array(MAX_RECORD_TICKS);
  /** bit 0: arm switch; bits 1-2: flight mode index. */
  readonly flags = new Uint8Array(MAX_RECORD_TICKS);
  ticks = 0;
  /** Why this recording can't be replayed (empty = fine). */
  invalid = '';
  /** Start: the reset() arguments, params, world, arm-switch history, timestep. */
  start = { x: 0, y: 0, z: 0, yaw: 0, armLatched: false, dt: 1 / 500 };
  params: SimParams | null = null;
  world: WorldQuery | null = null;

  /** Call right after quad.reset(x, y, z, yaw). */
  begin(quad: Quad, world: WorldQuery, x: number, y: number, z: number, yaw: number): void {
    this.ticks = 0;
    this.invalid = '';
    this.start = { x, y, z, yaw, armLatched: quad.armSwitchLatched, dt: quad.timestep };
    this.params = cloneParams(quad.params);
    this.world = world;
  }

  /**
   * Log this tick's inputs (call from the stepper's sampler, after the input
   * manager filled rc). Sticks are rounded to float32 first, so the live
   * flight and the replay see bit-identical inputs. Allocation-free.
   */
  capture(rc: RcChannels): void {
    rc.roll = Math.fround(rc.roll);
    rc.pitch = Math.fround(rc.pitch);
    rc.yaw = Math.fround(rc.yaw);
    rc.throttle = Math.fround(rc.throttle);
    const i = this.ticks;
    if (i >= MAX_RECORD_TICKS) return;
    this.roll[i] = rc.roll;
    this.pitch[i] = rc.pitch;
    this.yaw[i] = rc.yaw;
    this.throttle[i] = rc.throttle;
    this.flags[i] = (rc.arm ? 1 : 0) | ((rc.mode === 'angle' ? 1 : rc.mode === 'horizon' ? 2 : 0) << 1);
    this.ticks = i + 1;
  }

  get full(): boolean {
    return this.ticks >= MAX_RECORD_TICKS;
  }

  get seconds(): number {
    return this.ticks * this.start.dt;
  }

  /** Something changed that the replay can't reproduce (e.g. physics tuned mid-flight). */
  invalidate(reason: string): void {
    if (this.ticks > 0 && !this.invalid) this.invalid = reason;
  }
}

// Trace layout: one Float32 row per sample.
export const T = {
  time: 0,
  pos: 1, // x, y, z relative to the start point (y absolute)
  quat: 4, // x, y, z, w
  vel: 8, // world, m/s
  sticks: 11, // roll, pitch, yaw, throttle
  gyro: 15, // roll, pitch, yaw deg/s (filtered, as the FC sees it)
  setpoint: 18, // roll, pitch, yaw deg/s
  motors: 21, // 4 commands 0..1
  voltage: 25,
  current: 26,
  flags: 27, // armed | crashed << 1 | mode << 2
  STRIDE: 28,
} as const;

/** A re-simulated flight, sampled at 100 Hz, for playback and telemetry plots. */
export class Trace {
  readonly data: Float32Array;
  readonly count: number;
  /** Seconds between samples. */
  readonly step: number;
  /** World position the trace's x/z are relative to. */
  readonly originX: number;
  readonly originZ: number;
  /** True when the re-simulation didn't land exactly where the live flight did. */
  diverged = false;

  constructor(data: Float32Array, count: number, step: number, originX: number, originZ: number) {
    this.data = data;
    this.count = count;
    this.step = step;
    this.originX = originX;
    this.originZ = originZ;
  }

  get duration(): number {
    return this.count > 0 ? this.data[(this.count - 1) * T.STRIDE] : 0;
  }

  /** Sample index at or before t. */
  index(t: number): number {
    return Math.max(0, Math.min(this.count - 1, Math.floor(t / this.step)));
  }

  value(i: number, field: number): number {
    return this.data[i * T.STRIDE + field];
  }

  /**
   * Fill a QuadState at time t (interpolated pose, nearest-sample extras),
   * so the OSD, cameras and drone model can show a replay like a live flight.
   */
  fill(t: number, s: QuadState, q0 = new Quat(), q1 = new Quat()): void {
    const d = this.data, S = T.STRIDE;
    const i = this.index(t), j = Math.min(i + 1, this.count - 1);
    const a = i * S, b = j * S;
    const u = j > i ? Math.min(1, Math.max(0, (t - d[a]) / (d[b] - d[a]))) : 0;
    const lerp = (f: number) => d[a + f] + (d[b + f] - d[a + f]) * u;
    s.pos.set(lerp(T.pos) + this.originX, lerp(T.pos + 1), lerp(T.pos + 2) + this.originZ);
    s.vel.set(lerp(T.vel), lerp(T.vel + 1), lerp(T.vel + 2));
    q0.set(d[a + T.quat], d[a + T.quat + 1], d[a + T.quat + 2], d[a + T.quat + 3]);
    q1.set(d[b + T.quat], d[b + T.quat + 1], d[b + T.quat + 2], d[b + T.quat + 3]);
    s.quat.slerpQuats(q0, q1, u);
    for (let k = 0; k < 4; k++) s.motorCmd[k] = d[a + T.motors + k];
    s.voltage = d[a + T.voltage];
    s.current = d[a + T.current];
    const f = d[a + T.flags];
    s.armed = (f & 1) !== 0;
    s.crashed = (f & 2) !== 0;
    s.time = t;
  }

  modeAt(t: number): FlightMode {
    return MODES[(this.data[this.index(t) * T.STRIDE + T.flags] >> 2) & 3] ?? 'acro';
  }
}

/**
 * Re-simulate a recording. Pass the live quad's state (same number of ticks
 * after begin()) to verify that the replay reproduced it exactly.
 */
export function buildTrace(rec: FlightRecorder, live?: QuadState): Trace {
  const st = rec.start;
  const quad = new Quad(cloneParams(rec.params!), st.dt);
  quad.reset(st.x, st.y, st.z, st.yaw);
  quad.setArmSwitchLatched(st.armLatched);
  const world = rec.world!;
  const rc = new RcChannels();
  const n = rec.ticks;
  const count = Math.floor(n / TRACE_EVERY) + 1;
  const data = new Float32Array(count * T.STRIDE);
  const s = quad.state;
  let k = 0;
  const write = () => {
    const o = k++ * T.STRIDE;
    data[o + T.time] = s.time;
    data[o + T.pos] = s.pos.x - st.x;
    data[o + T.pos + 1] = s.pos.y;
    data[o + T.pos + 2] = s.pos.z - st.z;
    data[o + T.quat] = s.quat.x;
    data[o + T.quat + 1] = s.quat.y;
    data[o + T.quat + 2] = s.quat.z;
    data[o + T.quat + 3] = s.quat.w;
    data[o + T.vel] = s.vel.x;
    data[o + T.vel + 1] = s.vel.y;
    data[o + T.vel + 2] = s.vel.z;
    data[o + T.sticks] = rc.roll;
    data[o + T.sticks + 1] = rc.pitch;
    data[o + T.sticks + 2] = rc.yaw;
    data[o + T.sticks + 3] = rc.throttle;
    for (let a = 0; a < 3; a++) {
      data[o + T.gyro + a] = quad.fc.gyro[a];
      data[o + T.setpoint + a] = quad.fc.setpoint[a];
    }
    for (let m = 0; m < 4; m++) data[o + T.motors + m] = s.motorCmd[m];
    data[o + T.voltage] = s.voltage;
    data[o + T.current] = s.current;
    data[o + T.flags] = (s.armed ? 1 : 0) | (s.crashed ? 2 : 0) | (MODES.indexOf(rc.mode) << 2);
  };
  write();
  for (let i = 0; i < n; i++) {
    rc.roll = rec.roll[i];
    rc.pitch = rec.pitch[i];
    rc.yaw = rec.yaw[i];
    rc.throttle = rec.throttle[i];
    const f = rec.flags[i];
    rc.arm = (f & 1) !== 0;
    rc.mode = MODES[(f >> 1) & 3];
    quad.step(rc, world);
    if ((i + 1) % TRACE_EVERY === 0) write();
  }
  const trace = new Trace(data, k, TRACE_EVERY * st.dt, st.x, st.z);
  if (live) {
    const p = live.pos;
    trace.diverged = p.x !== s.pos.x || p.y !== s.pos.y || p.z !== s.pos.z || live.time !== s.time;
  }
  return trace;
}
