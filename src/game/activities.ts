/**
 * The game modes: a gate race, training drills and their scoring.
 *
 * Runs are updated once per rendered frame with the newest physics state.
 * Crossings are found on the segment between frames and their time is
 * interpolated, so timing is accurate to well under a millisecond.
 */
import { Quat, Vec3, type QuadState } from '../sim';
import type { GameWorld } from '../world/recipes';
import { EMPTY_LAYOUT, figure8Layout, hoverLayout, powerLoopLayout, raceLayout, slalomLayout } from './layouts';
import { PoseTrack } from './track';
import { crossFraction, formatTime, starsFor, type ActivityDef, type ActivityRun, type Checkpoint, type Layout, type RunPhase, type RunResult } from './types';

const kmh = (ms: number) => `${(ms * 3.6).toFixed(0)} km/h`;
/** World-space up component of the body's up axis (1 = level, -1 = inverted). */
const upY = (q: Quat) => 1 - 2 * (q.x * q.x + q.z * q.z);

function failResult(lines: string[]): RunResult {
  return { success: false, score: 0, scoreText: '—', lowerIsBetter: true, stars: 0, lines };
}

function crashReason(s: QuadState): string {
  return s.crashed ? 'Crashed.' : 'Disarmed.';
}

// ---------------------------------------------------------------- courses

interface CourseOptions {
  loop: boolean;
  laps: number;
  /** Average-speed thresholds for 1/2/3 stars, m/s. */
  speedStars: [number, number, number];
  /** Record the best lap for a ghost. */
  ghost: boolean;
  label: string;
}

/** Fly the checkpoints in order (strictly: a missed one must be flown back to). */
export class CourseRun implements ActivityRun {
  phase: RunPhase = 'ready';
  readonly laps: number[] = [];
  /** Best lap of this run that beat `ghostLap` (to be saved), or null. */
  newBest: { lap: number; track: PoseTrack } | null = null;
  /** Ghost to race against and its lap time. */
  ghost: PoseTrack | null = null;
  ghostLap = Infinity;
  private idx = 0;
  private readonly K: number;
  private readonly total: number;
  private startT = 0;
  private lapStart = 0;
  private finishT = 0;
  private fail = '';
  private readonly lapTrack = new PoseTrack();
  private readonly prev = new Vec3();
  private prevT = 0;
  private have = false;
  private readonly length: number;

  constructor(
    readonly layout: Layout,
    readonly opts: CourseOptions,
  ) {
    const cps = layout.checkpoints;
    this.K = cps.length;
    this.total = opts.loop ? opts.laps * this.K + 1 : this.K;
    let len = 0;
    const n = opts.loop ? this.K : this.K - 1;
    for (let i = 0; i < n; i++) {
      const a = cps[i], b = cps[(i + 1) % this.K];
      len += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    this.length = len;
  }

  private cp(seq: number): Checkpoint {
    return this.layout.checkpoints[seq % this.K];
  }

  update(s: QuadState): void {
    if (this.phase === 'finished' || this.phase === 'failed') return;
    if (this.phase === 'running' && !s.armed) {
      this.phase = 'failed';
      this.fail = crashReason(s);
      return;
    }
    const p = s.pos;
    if (this.have && this.idx < this.total) {
      const u = crossFraction(this.cp(this.idx), this.prev.x, this.prev.y, this.prev.z, p.x, p.y, p.z);
      if (u >= 0) this.pass(this.prevT + (s.time - this.prevT) * u);
    }
    if (this.phase === 'running' && this.opts.ghost) this.lapTrack.push(s.time - this.lapStart, p, s.quat);
    this.prev.copy(p);
    this.prevT = s.time;
    this.have = true;
  }

  private pass(t: number): void {
    const K = this.K;
    if (this.idx === 0) {
      this.phase = 'running';
      this.startT = this.lapStart = t;
      this.lapTrack.clear();
    } else if (this.opts.loop && this.idx % K === 0) {
      const lap = t - this.lapStart;
      this.laps.push(lap);
      const best = this.newBest ? this.newBest.lap : this.ghostLap;
      if (this.opts.ghost && lap < best) this.newBest = { lap, track: new PoseTrack(this.lapTrack.count).copyFrom(this.lapTrack) };
      this.lapStart = t;
      this.lapTrack.clear();
    }
    this.idx++;
    if (this.idx === this.total) {
      this.finishT = t;
      if (!this.opts.loop) this.laps.push(t - this.startT);
      this.phase = 'finished';
    }
  }

  /** Time into the current lap (for the ghost), s. */
  lapTime(s: QuadState): number {
    return s.time - this.lapStart;
  }

  private elapsed(s: QuadState): number {
    return this.phase === 'running' ? s.time - this.startT : this.phase === 'finished' ? this.finishT - this.startT : 0;
  }

  hud(s: QuadState): string {
    if (this.phase === 'ready') return this.opts.label;
    const t = formatTime(this.elapsed(s));
    if (this.opts.loop && this.opts.laps > 1) return `LAP ${Math.min(this.laps.length + 1, this.opts.laps)}/${this.opts.laps} · ${t}`;
    return `${this.opts.label} · ${t}`;
  }

  hint(): string {
    if (this.phase === 'failed') return this.fail;
    if (this.phase === 'ready') return this.K > 0 ? 'Fly through the highlighted gate to start' : '';
    const n = (this.idx % this.K) + 1;
    const what = this.cp(this.idx).style === 'window' ? 'Checkpoint' : 'Gate';
    const last = this.idx === this.total - 1 ? ' · FINISH' : '';
    const ghost = this.ghost && Number.isFinite(this.ghostLap) ? ` · best lap ${formatTime(this.ghostLap)}` : '';
    return `${what} ${n}/${this.K}${last}${ghost}`;
  }

  target(): { x: number; y: number; z: number } | null {
    return this.idx < this.total ? this.cp(this.idx) : null;
  }

  nextCheckpoint(): number {
    return this.idx < this.total ? this.idx % this.K : -1;
  }

  result(): RunResult | null {
    if (this.phase === 'failed') {
      const done = Math.max(0, this.idx - 1);
      return failResult([this.fail, this.idx === 0 ? 'You never reached the start.' : `You made it through ${done} of ${this.total - 1} after the start.`]);
    }
    if (this.phase !== 'finished') return null;
    const total = this.finishT - this.startT;
    const dist = this.length * (this.opts.loop ? this.opts.laps : 1);
    const speed = dist / Math.max(total, 1e-3);
    const lines = [`Average speed ${kmh(speed)} (gate to gate).`];
    if (this.opts.loop && this.laps.length > 1) {
      const best = Math.min(...this.laps);
      lines.push(`Laps: ${this.laps.map((l) => (l === best ? `[${l.toFixed(2)}]` : l.toFixed(2))).join(' · ')}`);
      const spread = Math.max(...this.laps) - best;
      lines.push(spread < 1 ? 'Very consistent laps.' : `Laps varied by ${spread.toFixed(1)} s: smooth lines beat fast mistakes.`);
    }
    const stars = Math.max(1, starsFor(speed, this.opts.speedStars, false));
    if (stars < 3) lines.push(`For ${stars + 1} stars, average ${kmh(this.opts.speedStars[stars])}.`);
    return { success: true, score: total, scoreText: formatTime(total), lowerIsBetter: true, stars, lines };
  }
}

// ------------------------------------------------------------------ hover

const HOLD = 10;

export class HoverRun implements ActivityRun {
  phase: RunPhase = 'ready';
  private startT = 0;
  private inSince = -1;
  private exits = 0;
  private errSum = 0;
  private errN = 0;
  private finishT = 0;
  private fail = '';
  private hold = 0;

  constructor(readonly layout: Layout) {}

  update(s: QuadState): void {
    if (this.phase === 'finished' || this.phase === 'failed') return;
    const z = this.layout.zone!;
    if (this.phase === 'running' && !s.armed) {
      this.phase = 'failed';
      this.fail = crashReason(s);
      return;
    }
    const dx = s.pos.x - z.x, dy = s.pos.y - z.y, dz = s.pos.z - z.z;
    const inside = Math.abs(dx) <= z.half && Math.abs(dy) <= z.half && Math.abs(dz) <= z.half;
    if (inside && s.armed) {
      if (this.phase === 'ready') {
        this.phase = 'running';
        this.startT = s.time;
      }
      if (this.inSince < 0) {
        this.inSince = s.time;
        this.errSum = this.errN = 0;
      }
      this.errSum += Math.sqrt(dx * dx + dy * dy + dz * dz);
      this.errN++;
      this.hold = s.time - this.inSince;
      if (this.hold >= HOLD) {
        this.phase = 'finished';
        this.finishT = s.time;
      }
    } else if (this.inSince >= 0) {
      this.inSince = -1;
      this.hold = 0;
      this.exits++;
    }
  }

  get inside(): boolean {
    return this.inSince >= 0;
  }

  hud(): string {
    return this.phase === 'ready' ? 'HOVER HOLD' : `HOLD ${this.hold.toFixed(1)} / ${HOLD} s`;
  }

  hint(): string {
    if (this.phase === 'failed') return this.fail;
    if (this.phase === 'ready') return `Fly into the box and stay inside for ${HOLD} s`;
    return this.inside ? 'Steady… small corrections' : `Back in the box (left it ${this.exits}×)`;
  }

  target() {
    return this.layout.zone;
  }

  nextCheckpoint(): number {
    return -1;
  }

  result(): RunResult | null {
    if (this.phase === 'failed') return failResult([this.fail]);
    if (this.phase !== 'finished') return null;
    const total = this.finishT - this.startT;
    const err = this.errSum / Math.max(this.errN, 1);
    const stars = Math.max(1, starsFor(total, [40, 25, 14], true));
    const lines = [
      `Held ${HOLD} s after ${this.exits === 0 ? 'no' : this.exits} ${this.exits === 1 ? 'exit' : 'exits'}.`,
      `Average distance from the centre during the hold: ${err.toFixed(2)} m.`,
      err < 0.4 ? 'Rock solid.' : 'Try smaller, earlier corrections: anticipate the drift instead of chasing it.',
    ];
    return { success: true, score: total, scoreText: formatTime(total), lowerIsBetter: true, stars, lines };
  }
}

// ------------------------------------------------------------- power loop

const LOOP_TIMEOUT = 8;

export class PowerLoopRun implements ActivityRun {
  phase: RunPhase = 'ready';
  private looping = false;
  private t1 = 0;
  private maxY = -Infinity;
  private inverted = false;
  private attempts = 0;
  private note = '';
  private score = 0;
  private height = 0;
  private fail = '';
  private readonly prev = new Vec3();
  private prevT = 0;
  private have = false;

  constructor(readonly layout: Layout) {}

  private get gate(): Checkpoint {
    return this.layout.checkpoints[0];
  }

  update(s: QuadState): void {
    if (this.phase === 'finished' || this.phase === 'failed') return;
    if (this.phase === 'running' && !s.armed) {
      this.phase = 'failed';
      this.fail = crashReason(s);
      return;
    }
    const p = s.pos, g = this.gate;
    if (this.looping) {
      if (p.y > this.maxY) this.maxY = p.y;
      if (upY(s.quat) < -0.3) this.inverted = true;
      if (s.time - this.t1 > LOOP_TIMEOUT) {
        this.looping = false;
        this.note = 'Too slow: fly through again and loop straight back over the top.';
      }
    }
    if (this.have) {
      const u = crossFraction(g, this.prev.x, this.prev.y, this.prev.z, p.x, p.y, p.z);
      if (u >= 0) {
        const tc = this.prevT + (s.time - this.prevT) * u;
        const top = g.y + g.height / 2;
        if (this.looping && this.inverted && this.maxY >= top + 2) {
          this.phase = 'finished';
          this.score = tc - this.t1;
          this.height = this.maxY - top;
        } else {
          if (this.looping) this.note = this.inverted ? 'Go higher over the gate.' : "That wasn't a loop: pull up and over the top.";
          this.phase = 'running';
          this.looping = true;
          this.attempts++;
          this.t1 = tc;
          this.maxY = -Infinity;
          this.inverted = false;
        }
      }
    }
    this.prev.copy(p);
    this.prevT = s.time;
    this.have = true;
  }

  hud(s: QuadState): string {
    return this.looping ? `LOOP ${(s.time - this.t1).toFixed(1)} s` : 'POWER LOOP';
  }

  hint(): string {
    if (this.phase === 'failed') return this.fail;
    if (this.looping) return 'Pull up, over the top, and back through the gate';
    return this.note || 'Fly through the gate, then loop back over it and through again';
  }

  target() {
    return this.gate;
  }

  nextCheckpoint(): number {
    return 0;
  }

  result(): RunResult | null {
    if (this.phase === 'failed') return failResult([this.fail]);
    if (this.phase !== 'finished') return null;
    const stars = Math.max(1, starsFor(this.score, [4, 3, 2.2], true));
    const lines = [
      `Loop time ${this.score.toFixed(2)} s, ${this.height.toFixed(1)} m above the gate.`,
      this.attempts > 1 ? `Took ${this.attempts} attempts.` : 'First try!',
      this.height > 8 ? 'Big loop: punch less, or pull harder at the top, for a tighter one.' : 'Nice tight loop.',
    ];
    return { success: true, score: this.score, scoreText: `${this.score.toFixed(2)} s`, lowerIsBetter: true, stars, lines };
  }
}

// ---------------------------------------------------------- dive & recover

const DIVE_START_AGL = 40;
const DIVE_SPEED = 12;

export class DiveRun implements ActivityRun {
  phase: RunPhase = 'ready';
  private high = false;
  private minAgl = Infinity;
  private maxSpeed = 0;
  private fail = '';
  private agl = 0;

  constructor(private readonly world: GameWorld) {}

  update(s: QuadState): void {
    if (this.phase === 'finished' || this.phase === 'failed') return;
    const p = s.pos;
    this.agl = p.y - this.world.groundHeight(p.x, p.z);
    if (this.phase === 'running') {
      if (!s.armed || s.contact || this.agl < 0.15) {
        this.phase = 'failed';
        this.fail = s.armed ? 'Touched the ground.' : crashReason(s);
        return;
      }
      if (this.agl < this.minAgl) this.minAgl = this.agl;
      if (-s.vel.y > this.maxSpeed) this.maxSpeed = -s.vel.y;
      if (s.vel.y >= 0) this.phase = 'finished';
      return;
    }
    if (!s.armed) return;
    if (this.agl >= DIVE_START_AGL) this.high = true;
    if (this.high && s.vel.y <= -DIVE_SPEED) {
      this.phase = 'running';
      this.minAgl = this.agl;
      this.maxSpeed = -s.vel.y;
    }
  }

  hud(): string {
    if (this.phase === 'running') return `DIVE · ${this.agl.toFixed(1)} m`;
    return `DIVE · ${this.agl.toFixed(0)} m`;
  }

  hint(): string {
    if (this.phase === 'failed') return this.fail;
    if (this.phase === 'running') return 'Pull out!';
    return this.high ? 'Now dive straight down and pull out as low as you dare' : `Climb above ${DIVE_START_AGL} m (height above the ground)`;
  }

  target() {
    return null;
  }

  nextCheckpoint(): number {
    return -1;
  }

  result(): RunResult | null {
    if (this.phase === 'failed') return failResult([this.fail, 'Start pulling out earlier: the quad keeps sinking while it rotates and spools up.']);
    if (this.phase !== 'finished') return null;
    const stars = Math.max(1, starsFor(this.minAgl, [6, 3, 1.5], true));
    const lines = [
      `Lowest point ${this.minAgl.toFixed(2)} m above the ground.`,
      `Top dive speed ${kmh(this.maxSpeed)}.`,
      this.minAgl > 6 ? 'Safe. Next time hold the dive a little longer before pulling out.' : 'Close to the deck. Nice.',
    ];
    return { success: true, score: this.minAgl, scoreText: `${this.minAgl.toFixed(2)} m`, lowerIsBetter: true, stars, lines };
  }
}

// ---------------------------------------------------------------- registry

export const ACTIVITIES: ActivityDef[] = [
  {
    id: 'race',
    name: 'Gate race',
    blurb: '3 laps of an 8-gate loop. Races your best-lap ghost.',
    instructions: 'Arm, fly through the highlighted gate to start the clock, then follow the highlights. Missed a gate? Go back for it.',
    layout: raceLayout,
    start: (_w, l) => new CourseRun(l, { loop: true, laps: 3, speedStars: [6, 10, 14], ghost: true, label: 'GATE RACE' }),
  },
  {
    id: 'slalom',
    name: 'Slalom',
    blurb: 'Six pylons, alternating sides. Smooth, linked turns.',
    instructions: 'Fly through the start line, pass each pylon on the side of its outline (orange: right, blue: left), then through the finish.',
    layout: slalomLayout,
    start: (_w, l) => new CourseRun(l, { loop: false, laps: 1, speedStars: [5, 8, 11], ghost: false, label: 'SLALOM' }),
  },
  {
    id: 'figure8',
    name: 'Figure-8',
    blurb: 'Around two pylons and back through the middle.',
    instructions: 'Through the middle heading right, round the right pylon, back through the middle, round the left pylon, and through the middle again.',
    layout: figure8Layout,
    start: (_w, l) => new CourseRun(l, { loop: true, laps: 1, speedStars: [4, 7, 10], ghost: false, label: 'FIGURE-8' }),
  },
  {
    id: 'hover',
    name: 'Hover hold',
    blurb: 'Stay inside a 2 m box for 10 seconds.',
    instructions: 'Fly into the box and hold position for 10 s straight. Leaving it restarts the hold. Chase or line-of-sight view makes this easier to learn.',
    layout: hoverLayout,
    start: (_w, l) => new HoverRun(l),
  },
  {
    id: 'powerloop',
    name: 'Power loop',
    blurb: 'Through the gate, over the top, and through again.',
    instructions: 'Fly through the gate, punch up and loop backwards over it, and come through again in the same direction. Tighter is better.',
    layout: powerLoopLayout,
    start: (_w, l) => new PowerLoopRun(l),
  },
  {
    id: 'dive',
    name: 'Dive & recover',
    blurb: 'Dive from 40 m and pull out as low as you dare.',
    instructions: 'Climb above 40 m, flip over and dive. Pull out before the ground. Your score is the lowest height you reached.',
    layout: () => EMPTY_LAYOUT,
    start: (w) => new DiveRun(w),
  },
];

export function activityById(id: string): ActivityDef | undefined {
  return ACTIVITIES.find((a) => a.id === id);
}
