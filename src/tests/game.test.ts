import { describe, expect, it } from 'vitest';
import { defaultSimParams, FixedStepper, Quad, Quat, QuadState, Vec3, type RcChannels } from '../sim';
import { ACTIVITIES, activityById, CourseRun, DiveRun, HoverRun, PowerLoopRun } from '../game/activities';
import { figure8Layout, raceLayout, slalomLayout } from '../game/layouts';
import { buildTrace, FlightRecorder, T } from '../game/recorder';
import { PoseTrack } from '../game/track';
import { crossFraction, type Checkpoint } from '../game/types';
import { OverlayWorld } from '../world/overlay';
import { buildWorld, type GameWorld } from '../world/recipes';

const hills = (seed = 1) => buildWorld('hills', seed);

/** A fake "physics state" we can teleport around. */
function state(): QuadState {
  const s = new QuadState();
  s.armed = true;
  return s;
}

/** Move s through checkpoint c (forwards unless reverse), updating the run before and after. */
function through(run: { update(s: QuadState): void }, s: QuadState, c: Checkpoint, reverse = false, dt = 0.5) {
  const fx = Math.sin(c.yaw) * (reverse ? -1 : 1), fz = Math.cos(c.yaw) * (reverse ? -1 : 1);
  s.time += dt;
  s.pos.set(c.x - fx * 2, c.y, c.z - fz * 2);
  run.update(s);
  s.time += 0.2;
  s.pos.set(c.x + fx * 2, c.y, c.z + fz * 2);
  run.update(s);
}

describe('checkpoint crossing', () => {
  const g: Checkpoint = { x: 0, y: 2, z: 0, yaw: Math.PI, width: 2, height: 2, style: 'gate' }; // forward = -Z
  it('counts forward crossings inside the opening, at the right fraction', () => {
    expect(crossFraction(g, 0, 2, 1, 0, 2, -3)).toBeCloseTo(0.25, 9);
    expect(crossFraction(g, 0.9, 2.9, 1, 0.9, 2.9, -1)).toBeCloseTo(0.5, 9);
  });
  it('ignores backward crossings and misses', () => {
    expect(crossFraction(g, 0, 2, -1, 0, 2, 1)).toBe(-1);
    expect(crossFraction(g, 1.2, 2, 1, 1.2, 2, -1)).toBe(-1); // beside the opening
    expect(crossFraction(g, 0, 3.2, 1, 0, 3.2, -1)).toBe(-1); // above it
    expect(crossFraction(g, 0, 2, 3, 0, 2, 1)).toBe(-1); // hasn't reached it
  });
});

describe('layouts', () => {
  it('race gates are clear of terrain and trees, start ahead of the pad, and are deterministic', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const w = hills(seed);
      const a = raceLayout(w), b = raceLayout(hills(seed));
      expect(a).toEqual(b);
      expect(a.checkpoints.length).toBe(8);
      const g0 = a.checkpoints[0];
      expect(Math.hypot(g0.x, g0.z)).toBeGreaterThan(20);
      expect(Math.hypot(g0.x, g0.z)).toBeLessThan(45);
      expect(g0.z).toBeLessThan(0);
      for (const c of a.checkpoints) {
        expect(w.distance(new Vec3(c.x, c.y, c.z)), `seed ${seed}`).toBeGreaterThan(0.4);
        expect(Math.hypot(c.x, c.z)).toBeLessThan(300);
      }
      expect(a.boxes.length).toBe(32);
    }
  });

  it('gate frames are solid in the overlay world, openings are not', () => {
    const w = hills(2);
    const l = raceLayout(w);
    const o = new OverlayWorld(w, l.boxes);
    const b = l.boxes[2]; // top bar of gate 1
    expect(o.distance(new Vec3(b.cx, b.cy, b.cz))).toBeLessThan(0);
    const c = l.checkpoints[0];
    expect(o.distance(new Vec3(c.x, c.y, c.z))).toBeGreaterThan(0.7);
  });

  it('sandbox races its own gate loop, starting with the gate straight ahead', () => {
    const l = raceLayout(buildWorld('sandbox', 1));
    expect(l.checkpoints[0].style).toBe('existing');
    expect(l.boxes.length).toBe(0);
    expect(Math.abs(l.checkpoints[0].x)).toBeLessThan(1e-9);
    expect(Math.cos(l.checkpoints[0].yaw)).toBeCloseTo(-1, 9); // flown towards -Z
  });

  it('every activity builds a layout on both worlds', () => {
    for (const w of [hills(3), buildWorld('sandbox', 1)]) {
      for (const a of ACTIVITIES) {
        const l = a.layout(w);
        expect(a.start(w, l).phase).toBe('ready');
      }
    }
  });
});

describe('course runs', () => {
  const w = hills(1);
  const race = activityById('race')!;

  it('times a 3-lap race, lap by lap, in order only', () => {
    const l = race.layout(w);
    const run = race.start(w, l) as CourseRun;
    const s = state();
    const cps = l.checkpoints;
    through(run, s, cps[2]); // out of order: ignored
    expect(run.phase).toBe('ready');
    through(run, s, cps[0], true); // backwards: ignored
    expect(run.phase).toBe('ready');
    for (let lap = 0; lap < 3; lap++) for (let i = 0; i < 8; i++) through(run, s, cps[i]);
    expect(run.phase).toBe('running');
    through(run, s, cps[0]);
    expect(run.phase).toBe('finished');
    expect(run.laps.length).toBe(3);
    run.laps.forEach((t) => expect(t).toBeCloseTo(8 * 0.7, 6));
    const r = run.result()!;
    expect(r.success).toBe(true);
    expect(r.score).toBeCloseTo(3 * 8 * 0.7, 6);
    expect(r.stars).toBeGreaterThanOrEqual(1);
    expect(run.newBest?.lap).toBeCloseTo(5.6, 6);
  });

  it('fails when the quad crashes mid-run', () => {
    const l = race.layout(w);
    const run = race.start(w, l);
    const s = state();
    through(run, s, l.checkpoints[0]);
    s.armed = false;
    s.crashed = true;
    run.update(s);
    expect(run.phase).toBe('failed');
    expect(run.result()!.success).toBe(false);
  });

  it('slalom and figure-8 finish after their checkpoint sequences', () => {
    const sl = slalomLayout(w);
    const r1 = activityById('slalom')!.start(w, sl);
    const s = state();
    for (const c of sl.checkpoints) through(r1, s, c);
    expect(r1.phase).toBe('finished');
    const f8 = figure8Layout(w);
    const r2 = activityById('figure8')!.start(w, f8);
    for (const c of [...f8.checkpoints, f8.checkpoints[0]]) through(r2, s, c);
    expect(r2.phase).toBe('finished');
  });
});

describe('drills', () => {
  const w = hills(1);

  it('hover hold: 10 s inside the box, an exit restarts the hold', () => {
    const a = activityById('hover')!;
    const l = a.layout(w);
    const run = a.start(w, l) as HoverRun;
    const s = state();
    const z = l.zone!;
    const at = (dx: number, t: number) => {
      s.time = t;
      s.pos.set(z.x + dx, z.y, z.z);
      run.update(s);
    };
    for (let t = 0; t < 6; t += 0.1) at(0.2, t);
    at(3, 6.1); // drifted out
    for (let t = 6.2; t < 16; t += 0.1) at(-0.3, t);
    expect(run.phase).toBe('running');
    for (let t = 16; t < 16.6; t += 0.1) at(0, t);
    expect(run.phase).toBe('finished');
    const r = run.result()!;
    expect(r.score).toBeGreaterThan(16);
    expect(r.lines[0]).toMatch(/1 exit/);
  });

  it('power loop: needs to go over the top and inverted between two passes', () => {
    const a = activityById('powerloop')!;
    const l = a.layout(w);
    const g = l.checkpoints[0];
    const run = a.start(w, l) as PowerLoopRun;
    const s = state();
    through(run, s, g);
    through(run, s, g); // straight through twice: not a loop
    expect(run.phase).toBe('running');
    s.time += 0.5;
    s.pos.set(g.x, g.y + 9, g.z);
    s.quat.setFromAxisAngle(1, 0, 0, Math.PI); // upside down at the top
    run.update(s);
    s.quat.set(0, 0, 0, 1);
    through(run, s, g, false, 0.5);
    expect(run.phase).toBe('finished');
    expect(run.result()!.score).toBeGreaterThan(0.5);
  });

  it('dive & recover scores the lowest height and fails on ground contact', () => {
    const dive = (lowest: number) => {
      const run = new DiveRun(w);
      const s = state();
      const g = w.groundHeight(0, 0);
      s.pos.set(0, g + 45, 0);
      run.update(s); // high enough
      s.vel.set(0, -20, 0);
      s.pos.y = g + 30;
      run.update(s); // diving
      s.pos.y = g + lowest;
      run.update(s);
      s.vel.set(0, 1, 0);
      run.update(s); // recovered
      return run;
    };
    const ok = dive(2.5);
    expect(ok.phase).toBe('finished');
    expect(ok.result()!.score).toBeCloseTo(2.5, 6);
    expect(dive(0.05).phase).toBe('failed');
  });
});

describe('replay', () => {
  function liveFlight(world: GameWorld, armOnAtReset: boolean) {
    const p = defaultSimParams();
    p.quad.collision.disarmOnCrash = false; // keep flying through scrapes: more varied flight to reproduce
    const quad = new Quad(p, 1 / 500);
    const rec = new FlightRecorder();
    let armSwitch = armOnAtReset;
    if (armOnAtReset) {
      // Arm switch already on when the quad is reset: it must be cycled before arming.
      const rc0 = { roll: 0, pitch: 0, yaw: 0, throttle: 0, arm: true, mode: 'acro' } as RcChannels;
      quad.step(rc0, world);
    }
    const sp = world.spawn;
    quad.reset(sp.x, sp.y, sp.z, 0);
    rec.begin(quad, world, sp.x, sp.y, sp.z, 0);
    let t = 0;
    const stepper = new FixedStepper(quad, world, (rc) => {
      t++;
      if (t === 300) armSwitch = false;
      if (t === 400) armSwitch = true;
      rc.arm = armSwitch;
      rc.throttle = t < 500 ? 0 : 0.5 + 0.12 * Math.sin(t * 0.003);
      rc.roll = 0.4 * Math.sin(t * 0.0021);
      rc.pitch = 0.3 * Math.sin(t * 0.0013) + 0.2;
      rc.yaw = 0.3 * Math.cos(t * 0.0017);
      rc.mode = t > 9000 ? 'horizon' : 'angle';
      rec.capture(rc);
    });
    for (let f = 0; f < 60 * 25; f++) stepper.advance(1 / 60);
    return { quad, rec };
  }

  it('re-simulates a 25 s flight over terrain with gates exactly, with telemetry', () => {
    const base = hills(1);
    const world = new OverlayWorld(base, raceLayout(base).boxes);
    const { quad, rec } = liveFlight(world, false);
    expect(quad.state.armed || quad.state.crashed).toBe(true);
    const trace = buildTrace(rec, quad.state);
    expect(trace.diverged).toBe(false);
    expect(trace.duration).toBeCloseTo(25, 1);
    // Telemetry came along: the motors were spinning and the gyro saw rotation mid-flight.
    const i = trace.index(10);
    expect(trace.value(i, T.flags) & 1).toBe(1);
    expect(trace.value(i, T.motors)).toBeGreaterThan(0.05);
    let maxRate = 0;
    for (let k = 0; k < trace.count; k++) maxRate = Math.max(maxRate, Math.abs(trace.value(k, T.gyro)));
    expect(maxRate).toBeGreaterThan(20);
    // Interpolated playback lands on the recorded path.
    const s = new QuadState();
    trace.fill(trace.duration, s);
    expect(s.pos.x).toBeCloseTo(quad.state.pos.x, 2);
    expect(s.pos.z).toBeCloseTo(quad.state.pos.z, 2);
  });

  it('restores the arm-switch history (switch already on at reset)', () => {
    const { quad, rec } = liveFlight(buildWorld('sandbox', 1), true);
    expect(rec.start.armLatched).toBe(true);
    expect(buildTrace(rec, quad.state).diverged).toBe(false);
  });
});

describe('ghost track', () => {
  it('interpolates poses and survives a save/load round trip', () => {
    const t = new PoseTrack(100);
    const q = new Quat();
    for (let i = 0; i < 50; i++) t.push(i * 0.1, new Vec3(i, 2, -i), q.setFromAxisAngle(0, 1, 0, i * 0.05));
    const back = PoseTrack.decode(t.encode())!;
    expect(back.count).toBe(50);
    const p = new Vec3(), r = new Quat();
    expect(back.sample(2.05, p, r)).toBe(true);
    expect(p.x).toBeCloseTo(20.5, 4);
    expect(back.sample(10, p, r)).toBe(false);
  });
});
