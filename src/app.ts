/**
 * Wires everything together:
 * input -> RcChannels (per tick) -> sim (fixed 500 Hz) -> interpolated render.
 */
import * as THREE from 'three';
import { FixedStepper, hoverThrottle, Quad, QuadState, Quat, Vec3, type SimParams } from './sim';
import { InputManager } from './input/manager';
import type { GamepadMapping } from './input/gamepad';
import { buildWorld, type GameWorld } from './world/recipes';
import { SceneView } from './render/scene';
import { FloatingOrigin } from './render/origin';
import { DroneModel } from './render/drone';
import { CameraRig } from './render/camera';
import { Osd, type OsdInfo } from './ui/osd';
import { DebugOverlay } from './ui/debug';
import { TuningPanel, type ChangeKind } from './ui/tuning';
import { helpPanel } from './ui/help';
import { GamepadSetup } from './ui/gamepadSetup';
import { isTyping } from './ui/dom';
import { FrameStats } from './platform/perf';
import { LatencyMeter } from './platform/latency';
import { FrameGovernor, PRESETS } from './platform/quality';
import { enterFullscreen, isPortrait, isTouchDevice, suppressBrowserGestures, vibrate } from './platform/display';
import { TouchControls } from './ui/touchControls';
import { h } from './ui/dom';
import { debouncedSaver, loadJson, saveJson } from './platform/storage';
import type { AppSettings, CameraMode } from './settings';
import { OverlayWorld } from './world/overlay';
import { RECIPES } from './world/recipes';
import { ACTIVITIES, CourseRun, HoverRun } from './game/activities';
import { buildTrace, FlightRecorder, T, type Trace } from './game/recorder';
import { PoseTrack } from './game/track';
import type { ActivityDef, ActivityRun, Layout, RunResult } from './game/types';
import { CourseView } from './render/courseView';
import { GameHud, type MarkerInfo } from './ui/gameHud';
import { instructionsPanel, modesPanel, resultsPanel, type BestScore } from './ui/gamePanels';
import { ReplayBar, type ReplayHost } from './ui/replayBar';
import { TelemetryView } from './ui/telemetry';

const SIM_HZ = 500;
/** Main-thread time per frame for world generation, ms (chunks are built in small slices). */
const WORLD_BUDGET_MS = 2;
const CAMERAS: CameraMode[] = ['fpv', 'chase', 'los'];
/** The best-lap ghost is drawn larger than life so it's easy to spot. */
const GHOST_SCALE = 2;

interface ActiveActivity {
  def: ActivityDef;
  layout: Layout;
  run: ActivityRun;
  view: CourseView;
  /** What the physics flies in: the world plus this layout's gates and pylons. */
  world: GameWorld;
}

interface ActiveReplay {
  trace: Trace;
  t: number;
  speed: number;
  playing: boolean;
  bar: ReplayBar;
  tele: TelemetryView;
  /** Reopen the results dialog on exit. */
  backToResults: boolean;
}

interface LastResult {
  def: ActivityDef;
  result: RunResult;
  best: BestScore | null;
  isBest: boolean;
}

export class App {
  world: GameWorld;
  readonly quad: Quad;
  readonly input: InputManager;
  readonly stepper: FixedStepper;
  private readonly view: SceneView;
  private readonly drone: DroneModel;
  private readonly rig = new CameraRig();
  readonly origin = new FloatingOrigin();
  /** Line-of-sight pilot position, world coordinates. */
  private readonly pilot = new Vec3();
  private readonly osd = new Osd();
  private readonly debug = new DebugOverlay();
  private readonly tuning: TuningPanel;
  private readonly stats = new FrameStats();
  private readonly save: () => void;
  private readonly touchUi: TouchControls;
  readonly latency = new LatencyMeter();
  readonly governor = new FrameGovernor();
  private readonly rotateOverlay: HTMLElement;
  private readonly notice: HTMLElement;
  private noticeUntil = 0;
  private modal: HTMLElement | null = null;
  private armedTime = 0;
  private worldMs = 0;
  private hudNext = 0;
  private last = 0;
  private wasArmed = false;
  private wasCrashed = false;
  private readonly touchDevice = isTouchDevice();

  // Game modes and replays.
  readonly recorder = new FlightRecorder();
  private act: ActiveActivity | null = null;
  private replay: ActiveReplay | null = null;
  private lastResult: LastResult | null = null;
  private resultShown = false;
  private readonly hud = new GameHud();
  private readonly ghost: DroneModel;
  private ghostCache: { key: string; lap: number; track: PoseTrack } | null = null;
  private bests: Record<string, BestScore>;
  private readonly replayState = new QuadState();
  private readonly ghostPos = new Vec3();
  private readonly ghostQuat = new Quat();
  private readonly qa = new Quat();
  private readonly qb = new Quat();
  private readonly markerVec = new THREE.Vector3();
  private readonly markerCam = new THREE.Vector3();
  private readonly marker: MarkerInfo = { x: 0, y: 0, behind: false, dist: 0 };
  // Per-frame scratch (no allocation in the loop).
  private readonly qInterp = new Quat();
  private readonly renderPos = new THREE.Vector3();
  private readonly renderQuat = new THREE.Quaternion();
  private readonly osdInfo: OsdInfo;

  constructor(
    private settings: AppSettings,
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: HTMLElement,
  ) {
    this.save = debouncedSaver('settings', () => this.settings);
    this.world = buildWorld(settings.world.recipe, settings.world.seed);
    this.quad = new Quad(settings.sim, 1 / SIM_HZ);
    this.input = new InputManager(settings.input, settings.touch, 1 / SIM_HZ, {
      reset: () => this.reset(),
      cycleCamera: () => this.cycleCamera(),
    });
    // Every tick: read the sticks, then log them for replays.
    this.stepper = new FixedStepper(this.quad, this.world, (rc, s) => {
      this.input.sampler(rc, s);
      this.recorder.capture(rc);
    });
    this.bests = (loadJson('bests') as Record<string, BestScore> | null) ?? {};
    this.view = new SceneView(canvas, { antialias: settings.graphics.antialias });
    this.view.setWorld(this.world);
    this.rig.ground = (x, z) => this.world.groundHeight(x + this.origin.x, z + this.origin.z);
    this.drone = new DroneModel(settings.sim.quad);
    this.view.scene.add(this.drone.group, this.drone.shadow);
    this.ghost = new DroneModel(settings.sim.quad, { ghost: true });
    this.ghost.group.scale.setScalar(GHOST_SCALE);
    this.ghost.group.visible = false;
    this.view.scene.add(this.ghost.group);
    this.tuning = new TuningPanel({
      settings: () => this.settings,
      onChange: (k) => this.onSettingsChange(k),
      replaceSim: (p) => this.replaceSim(p),
      openGamepadSetup: () => this.openGamepadSetup(),
      gamepadStatus: () => this.gamepadStatus(),
    });
    this.touchUi = new TouchControls(this.input.touch, () => this.settings.touch, this.latency, {
      arm: () => this.input.toggleArm(),
      mode: () => this.input.cycleMode(),
      camera: () => this.cycleCamera(),
      reset: () => this.reset(),
      tune: () => this.tuning.toggle(),
      menu: () => this.showMenu(),
      fullscreen: () => void enterFullscreen().then(() => this.resize()),
    });
    this.input.touch.hoverThrottle = hoverThrottle(settings.sim);
    this.rotateOverlay = h('div', { class: 'rotate' }, h('div', { class: 'rotate-icon' }, '⟳'), h('div', null, 'Turn your phone sideways to fly'));
    this.notice = h('div', { class: 'notice' });
    this.osdInfo = { state: this.quad.state, mode: 'acro', armBlock: 'none', armedTime: 0, throttle: 0, cells: settings.sim.quad.battery.cells, source: '', camera: '', homeY: 0 };

    ui.append(this.touchUi.root, this.osd.root, this.hud.root, this.debug.root, this.tuning.root, this.notice, this.rotateOverlay);
    if (this.touchDevice) suppressBrowserGestures();
    this.osd.visible = settings.ui.osd;
    this.debug.visible = settings.ui.debug;
    this.resize(); // sets the draw distance before the world is first built
    this.reset();
    this.bindEvents();
    if (!settings.ui.helpSeen) this.showHelp();
  }

  start(): void {
    this.last = performance.now();
    const loop = (now: number) => {
      this.frame(now);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ------------------------------------------------------------------ loop

  private frame(now: number): void {
    const g = this.settings.graphics;
    // Battery saver: on >60 Hz displays, process every other vsync (still >= 60 fps).
    if (g.batterySaver && this.governor.vsync < 14 && now - this.last < 14) return;
    const frameMs = now - this.last;
    const dt = Math.min(frameMs / 1000, 0.25);
    this.last = now;
    if (this.governor.frame(frameMs, { dynamic: g.dynamicResolution, autoDowngrade: g.autoDowngrade, preset: g.quality, setPreset: (q) => (g.quality = q) })) {
      if (this.governor.downgradedTo) {
        this.showNotice(`Graphics lowered to ${this.governor.downgradedTo.toUpperCase()} to keep the frame rate`);
        this.governor.downgradedTo = null;
        this.save();
        this.tuning.rebuild();
      }
      this.resize();
    }

    if (this.replay) {
      this.replayFrame(now, dt, frameMs);
      return;
    }

    this.input.pollFrame();
    this.latency.consume(now);
    const t0 = performance.now();
    // Physics pauses while a dialog (help, controller setup) or the rotate prompt is up.
    const paused = !!this.modal || this.rotateOverlay.classList.contains('show');
    if (!paused) this.stepper.advance(dt);
    else this.stepper.lastTicks = 0;
    const physMs = performance.now() - t0;

    const s = this.quad.state;
    if (s.armed) this.armedTime += dt;
    if (this.settings.touch.haptics) {
      if (s.armed !== this.wasArmed) vibrate(s.armed ? 40 : [20, 40, 20]);
      if (s.crashed && !this.wasCrashed) vibrate(120);
    }
    this.wasArmed = s.armed;
    this.wasCrashed = s.crashed;

    const act = this.act;
    if (act && !paused) {
      act.run.update(s);
      if ((act.run.phase === 'finished' || act.run.phase === 'failed') && !this.resultShown) this.showResults();
    }

    // Interpolate between the last two physics states (world coordinates).
    const { prev, curr, alpha } = this.stepper;
    const qi = this.qInterp.slerpQuats(prev.quat, curr.quat, alpha);
    const wx = prev.pos.x + (curr.pos.x - prev.pos.x) * alpha;
    const wz = prev.pos.z + (curr.pos.z - prev.pos.z) * alpha;
    this.origin.update(wx, wz);

    // Best-lap ghost.
    const run = act?.run;
    let ghostOn = false;
    if (run instanceof CourseRun && run.ghost && run.phase === 'running' && run.ghost.sample(run.lapTime(s), this.ghostPos, this.ghostQuat)) {
      const gp = this.ghostPos, gq = this.ghostQuat;
      this.ghost.group.position.set(gp.x - this.origin.x, gp.y, gp.z - this.origin.z);
      this.ghost.group.quaternion.set(gq.x, gq.y, gq.z, gq.w);
      ghostOn = true;
    }
    this.ghost.group.visible = ghostOn;

    act?.view.update(this.origin, act.run.nextCheckpoint(), now, act.run instanceof HoverRun && act.run.inside);
    this.present(now, dt, wx, prev.pos.y + (curr.pos.y - prev.pos.y) * alpha, wz, qi, s);
    // Game HUD and the marker on the next target (after render: needs this frame's camera).
    if (act) {
      this.hud.update(this.projectTarget(act.run.target()));
      if (now >= this.hudNext) {
        this.hudNext = now + 66;
        this.hud.text(act.run.hud(s), act.run.hint(s));
      }
    }

    const o = this.osdInfo;
    o.state = s;
    o.mode = this.input.mode;
    o.armBlock = this.quad.armBlock;
    o.armedTime = this.armedTime;
    o.throttle = this.input.last.throttle;
    o.source = this.input.source;
    this.osd.update(now, o);
    this.finishFrame(now, frameMs, physMs, s, this.input.last);
  }

  /** Draw the world and the drone at a world-space pose (live or replay). */
  private present(now: number, dt: number, wx: number, wy: number, wz: number, qi: Quat, s: QuadState): void {
    // Stream the world around the drone, then draw everything relative to the floating origin.
    const origin = this.origin;
    origin.update(wx, wz);
    const t1 = performance.now();
    this.view.update(wx, wz, origin, WORLD_BUDGET_MS);
    this.worldMs = performance.now() - t1;
    const groundY = this.world.groundHeight(wx, wz);
    const p = this.renderPos.set(wx - origin.x, wy, wz - origin.z);
    this.rig.pilotPos.set(this.pilot.x - origin.x, this.pilot.y, this.pilot.z - origin.z);
    const q = this.renderQuat.set(qi.x, qi.y, qi.z, qi.w);

    const cam = this.settings.camera;
    this.drone.group.position.copy(p);
    this.drone.group.quaternion.copy(q);
    this.drone.group.visible = cam.mode !== 'fpv';
    this.drone.updateShadow(p.x, p.y, p.z, groundY);
    this.drone.updateProps(s.motorSpeed, dt);

    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    this.rig.update(cam, p, q, w / Math.max(hgt, 1), dt);
    this.view.render(this.rig.camera);
    if (this.touchUi.visible) this.touchUi.render(s.armed, this.input.mode);
    if (this.noticeUntil && now > this.noticeUntil) {
      this.notice.classList.remove('show');
      this.noticeUntil = 0;
    }
    this.osdInfo.cells = this.settings.sim.quad.battery.cells;
    this.osdInfo.camera = cam.mode.toUpperCase();
  }

  private finishFrame(now: number, frameMs: number, physMs: number, s: QuadState, sticks: { roll: number; pitch: number; yaw: number; throttle: number }): void {
    this.stats.push(frameMs, physMs, this.stepper.lastTicks, this.worldMs);
    if (!this.debug.visible) return;
    const info = this.view.renderer.info.render;
    const gp = this.input.gamepad;
    this.debug.update(now, {
      stats: this.stats,
      drawCalls: info.calls,
      triangles: info.triangles,
      simHz: SIM_HZ,
      droppedTicks: this.stepper.droppedTicks,
      sticks,
      gyro: this.quad.fc.gyro,
      setpoint: this.quad.fc.setpoint,
      motors: s.motorCmd,
      inputLatencyMs: gp.connected ? performance.now() - gp.timestamp : null,
      latency: this.latency.sampleCount ? this.latency.stats() : null,
      renderScale: this.governor.scale,
      pixelRatio: this.view.renderer.getPixelRatio(),
      vsyncMs: this.governor.vsync,
      quality: this.settings.graphics.quality,
      world: this.view.worldStatus,
      origin: this.origin,
    });
  }

  /** Screen position of a world-space target for the HUD marker. */
  private projectTarget(t: { x: number; y: number; z: number } | null): MarkerInfo | null {
    if (!t) return null;
    const cam = this.rig.camera;
    const v = this.markerVec.set(t.x - this.origin.x, t.y, t.z - this.origin.z);
    const m = this.marker;
    m.dist = v.distanceTo(cam.position);
    m.behind = this.markerCam.copy(v).applyMatrix4(cam.matrixWorldInverse).z > 0;
    v.project(cam);
    m.x = v.x;
    m.y = v.y;
    return m;
  }

  // ---------------------------------------------------------------- replay

  private replayFrame(now: number, dt: number, frameMs: number): void {
    const r = this.replay!;
    if (r.playing) {
      r.t += dt * r.speed;
      if (r.t >= r.trace.duration) {
        r.t = r.trace.duration;
        r.playing = false;
      }
    }
    const s = this.replayState;
    r.trace.fill(r.t, s, this.qa, this.qb);
    this.origin.update(s.pos.x, s.pos.z);
    this.act?.view.update(this.origin, -1, now, false);
    const omega = this.settings.sim.quad.maxMotorSpeed;
    for (let k = 0; k < 4; k++) s.motorSpeed[k] = s.motorCmd[k] * omega;
    this.present(now, dt * r.speed, s.pos.x, s.pos.y, s.pos.z, s.quat, s);
    const i = r.trace.index(r.t);
    const sticks = { roll: r.trace.value(i, T.sticks), pitch: r.trace.value(i, T.sticks + 1), yaw: r.trace.value(i, T.sticks + 2), throttle: r.trace.value(i, T.sticks + 3) };
    const o = this.osdInfo;
    o.state = s;
    o.mode = r.trace.modeAt(r.t);
    o.armBlock = 'none';
    o.armedTime = r.t;
    o.throttle = sticks.throttle;
    o.source = 'replay';
    this.osd.update(now, o);
    r.bar.update(r.t);
    r.tele.draw(r.t);
    this.stepper.lastTicks = 0;
    this.finishFrame(now, frameMs, 0, s, sticks);
  }

  /** Re-simulate the current recording and play it back. */
  startReplay(backToResults = false, telemetry = false): void {
    const why = this.replayBlocker();
    if (why) {
      this.showNotice(why);
      return;
    }
    const rec = this.recorder;
    const trace = buildTrace(rec, rec.full ? undefined : this.quad.state);
    const warning = trace.diverged
      ? 'This replay drifted from the live flight. Please report it (with your tune JSON).'
      : rec.full
        ? 'Replays keep the first 10 minutes of a flight.'
        : '';
    this.closeModal();
    this.tuning.toggle(false);
    const self = this;
    const host: ReplayHost = {
      get playing() {
        return self.replay?.playing ?? false;
      },
      set playing(v: boolean) {
        if (!self.replay) return;
        if (v && self.replay.t >= trace.duration) self.replay.t = 0;
        self.replay.playing = v;
      },
      get speed() {
        return self.replay?.speed ?? 1;
      },
      set speed(v: number) {
        if (self.replay) self.replay.speed = v;
      },
      duration: trace.duration,
      seek: (t) => {
        if (self.replay) self.replay.t = Math.max(0, Math.min(trace.duration, t));
      },
      toggleTelemetry: () => {
        if (self.replay) self.replay.tele.visible = !self.replay.tele.visible;
      },
      camera: () => this.cycleCamera(),
      exit: () => this.exitReplay(),
    };
    const tele = new TelemetryView(trace, this.osdInfo.homeY);
    tele.visible = telemetry;
    const bar = new ReplayBar(host, warning);
    this.replay = { trace, t: 0, speed: 1, playing: true, bar, tele, backToResults };
    this.ui.append(tele.root, bar.root);
    this.touchUi.visible = false;
    this.hud.visible = false;
    this.ghost.group.visible = false;
  }

  private exitReplay(): void {
    const r = this.replay;
    if (!r) return;
    r.bar.root.remove();
    r.tele.root.remove();
    this.replay = null;
    this.osdInfo.state = this.quad.state;
    this.stepper.sync();
    this.last = performance.now();
    this.updateTouchVisibility();
    this.hud.visible = !!this.act;
    if (r.backToResults && this.lastResult) this.openResults();
  }

  /** Why "replay" isn't possible right now ('' if it is). */
  private replayBlocker(): string {
    if (this.recorder.invalid) return `Can't replay: ${this.recorder.invalid}`;
    if (this.recorder.ticks < 100) return 'Nothing to replay yet: fly first.';
    return '';
  }

  // ------------------------------------------------------------ activities

  private bestKey(def: ActivityDef): string {
    return `${def.id}.${this.world.id}.${this.world.seed}`;
  }

  private ghostFor(): { lap: number; track: PoseTrack } | null {
    const key = `ghost.${this.world.id}.${this.world.seed}`;
    if (this.ghostCache?.key === key) return this.ghostCache;
    const saved = loadJson(key) as { lap?: number; data?: string } | null;
    const track = saved?.data ? PoseTrack.decode(saved.data) : null;
    this.ghostCache = track && typeof saved?.lap === 'number' ? { key, lap: saved.lap, track } : null;
    return this.ghostCache;
  }

  showMenu(): void {
    if (this.replay) return;
    this.closeModal();
    this.tuning.toggle(false);
    this.modal = modesPanel(ACTIVITIES, this.act?.def.id ?? null, `${RECIPES[this.world.id].name} #${this.world.seed}`, (d) => this.bests[this.bestKey(d)] ?? null, this.replayBlocker(), {
      free: () => {
        this.closeModal();
        this.endActivity();
        this.reset();
      },
      pick: (d) => this.startActivity(d),
      replay: () => this.startReplay(),
      close: () => this.closeModal(),
    });
    this.ui.append(this.modal);
  }

  startActivity(def: ActivityDef): void {
    this.endActivity();
    const layout = def.layout(this.world);
    const world = layout.boxes.length ? new OverlayWorld(this.world, layout.boxes) : this.world;
    const view = new CourseView(layout);
    this.view.scene.add(view.object);
    this.act = { def, layout, run: def.start(this.world, layout), view, world };
    this.stepper.world = world;
    this.hud.visible = true;
    this.reset();
    this.closeModal();
    this.modal = instructionsPanel(def, this.bests[this.bestKey(def)] ?? null, () => this.closeModal());
    this.ui.append(this.modal);
  }

  private endActivity(): void {
    if (!this.act) return;
    this.act.view.dispose();
    this.act = null;
    this.stepper.world = this.world;
    this.hud.visible = false;
    this.ghost.group.visible = false;
  }

  private showResults(): void {
    const act = this.act!;
    this.resultShown = true;
    const result = act.run.result();
    if (!result) return;
    const key = this.bestKey(act.def);
    const prev = this.bests[key] ?? null;
    const isBest = result.success && (!prev || (result.lowerIsBetter ? result.score < prev.score : result.score > prev.score));
    if (isBest) {
      this.bests[key] = { score: result.score, text: result.scoreText };
      saveJson('bests', this.bests);
    }
    const run = act.run;
    if (run instanceof CourseRun && run.newBest) {
      const key = `ghost.${this.world.id}.${this.world.seed}`;
      if (saveJson(key, { lap: run.newBest.lap, data: run.newBest.track.encode() })) this.ghostCache = { key, ...run.newBest };
      result.lines.unshift(`New best lap: ${run.newBest.lap.toFixed(2)} s. Your ghost will fly it next time.`);
    }
    if (this.settings.touch.haptics && result.success) vibrate([30, 60, 30]);
    this.lastResult = { def: act.def, result, best: isBest ? null : prev, isBest };
    this.openResults();
  }

  private openResults(): void {
    const r = this.lastResult!;
    this.closeModal();
    this.modal = resultsPanel(r.def, r.result, r.best, r.isBest, {
      retry: () => {
        this.closeModal();
        this.reset();
      },
      replay: () => this.startReplay(true),
      telemetry: () => this.startReplay(true, true),
      free: () => {
        this.closeModal();
        this.endActivity();
        this.reset();
      },
    });
    this.ui.append(this.modal);
  }

  // --------------------------------------------------------------- actions

  reset(): void {
    const w = this.world;
    const sp = w.spawn;
    this.quad.reset(sp.x, sp.y, sp.z, w.spawnYaw);
    this.stepper.sync();
    this.input.onReset();
    this.armedTime = 0;
    // The line-of-sight pilot stands 4 m behind the pad, eyes 1.6 m above the ground.
    const px = sp.x + 4 * Math.sin(w.spawnYaw), pz = sp.z + 4 * Math.cos(w.spawnYaw);
    this.pilot.set(px, w.groundHeight(px, pz) + 1.6, pz);
    this.osdInfo.homeY = this.quad.state.pos.y;
    this.origin.update(sp.x, sp.z);
    this.view.prime(sp.x, sp.z, this.origin);
    // Every flight is recorded from the pad, so it can be replayed.
    this.recorder.begin(this.quad, this.stepper.world, sp.x, sp.y, sp.z, w.spawnYaw);
    // A reset restarts the current activity.
    const act = this.act;
    if (act) {
      act.run = act.def.start(this.world, act.layout);
      this.resultShown = false;
      const g = act.run instanceof CourseRun && act.run.opts.ghost ? this.ghostFor() : null;
      if (g && act.run instanceof CourseRun) {
        act.run.ghost = g.track;
        act.run.ghostLap = g.lap;
      }
    }
  }

  /** Build the world in settings.world and put the quad on its launch pad. */
  loadWorld(): void {
    this.endActivity();
    this.world = buildWorld(this.settings.world.recipe, this.settings.world.seed);
    this.stepper.world = this.world;
    this.origin.reset();
    this.view.setWorld(this.world);
    this.reset();
  }

  private showNotice(text: string): void {
    this.notice.textContent = text;
    this.notice.classList.add('show');
    this.noticeUntil = performance.now() + 4000;
  }

  /** Touch UI shows on touch devices (or when forced on), unless a gamepad is in use. */
  private updateTouchVisibility(): void {
    const t = this.settings.touch.enabled;
    const want = (t === 'on' || (t === 'auto' && this.touchDevice)) && this.input.source !== 'gamepad' && !this.replay;
    if (want !== this.touchUi.visible) this.touchUi.visible = want;
  }

  private cycleCamera(): void {
    const c = this.settings.camera;
    c.mode = CAMERAS[(CAMERAS.indexOf(c.mode) + 1) % CAMERAS.length];
    this.save();
  }

  private onSettingsChange(kind: ChangeKind): void {
    if (kind === 'sim') {
      this.recorder.invalidate('physics settings changed during this flight (press R to start a new one)');
      this.quad.applyParams(this.settings.sim);
      this.input.touch.hoverThrottle = hoverThrottle(this.settings.sim);
    }
    if (kind === 'input' || kind === 'touch') this.input.applySettings(this.settings.input, this.settings.touch);
    if (kind === 'touch') {
      this.updateTouchVisibility();
      this.touchUi.layout();
    }
    if (kind === 'ui') {
      this.debug.visible = this.settings.ui.debug;
      this.osd.visible = this.settings.ui.osd;
    }
    if (kind === 'world') this.loadWorld();
    if (kind === 'graphics') {
      this.governor.reset();
      this.resize();
    }
    this.save();
  }

  private replaceSim(p: SimParams): void {
    this.settings.sim = p;
    this.recorder.invalidate('physics settings changed during this flight (press R to start a new one)');
    this.quad.applyParams(p);
    this.input.touch.hoverThrottle = hoverThrottle(p);
    this.save();
  }

  private gamepadStatus(): string {
    const g = this.input.gamepad;
    if (!g.connected) return 'No controller connected (press a button on it to wake it up).';
    const saved = this.settings.input.gamepads[g.id] ? 'saved mapping' : 'default mapping';
    return `Connected: ${g.id} (${saved})`;
  }

  openGamepadSetup(): void {
    const setup = new GamepadSetup(
      this.input,
      (id: string, m: GamepadMapping | null) => {
        if (m) this.settings.input.gamepads[id] = m;
        else delete this.settings.input.gamepads[id];
        this.input.gamepad.setMapping(m ?? this.input.mappingFor({ id, mapping: navigator.getGamepads().find((p) => p?.id === id)?.mapping ?? '' }));
        this.save();
        this.tuning.rebuild();
      },
      () => (this.modal = null),
    );
    this.closeModal();
    this.modal = setup.root;
    this.ui.append(setup.root);
    setup.open();
  }

  private showHelp(): void {
    this.closeModal();
    this.modal = helpPanel(this.touchDevice, () => {
      this.closeModal();
      this.settings.ui.helpSeen = true;
      this.save();
      // "Fly" is a user gesture: the one moment browsers allow fullscreen + orientation lock.
      if (this.touchDevice) void enterFullscreen().then(() => this.resize());
    });
    this.ui.append(this.modal);
  }

  private closeModal(): void {
    this.modal?.remove();
    this.modal = null;
  }

  // ---------------------------------------------------------------- events

  private bindEvents(): void {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (this.replay && this.replayKey(e)) return;
      if (this.input.keyboard.key(e.code, true)) {
        e.preventDefault();
        if (!e.repeat) this.latency.mark(e.timeStamp);
        return;
      }
      if (e.repeat) return;
      const ui = this.settings.ui;
      switch (e.code) {
        case 'Space':
          e.preventDefault();
          this.input.toggleArm();
          break;
        case 'Digit1':
          this.input.setMode('acro');
          break;
        case 'Digit2':
          this.input.setMode('angle');
          break;
        case 'Digit3':
          this.input.setMode('horizon');
          break;
        case 'KeyC':
          this.cycleCamera();
          break;
        case 'KeyR':
          this.reset();
          break;
        case 'KeyT':
          this.tuning.toggle();
          break;
        case 'KeyM':
          if (this.modal) this.closeModal();
          else this.showMenu();
          break;
        case 'KeyP':
          if (!this.modal) this.startReplay();
          break;
        case 'KeyG':
          ui.debug = !ui.debug;
          this.debug.visible = ui.debug;
          this.save();
          break;
        case 'KeyO':
          ui.osd = !ui.osd;
          this.osd.visible = ui.osd;
          this.save();
          break;
        case 'KeyH':
          if (this.modal) this.closeModal();
          else this.showHelp();
          break;
        case 'Escape':
          if (this.modal) this.closeModal();
          else if (this.tuning.isOpen) this.tuning.toggle(false);
          break;
      }
    });
    window.addEventListener('keyup', (e) => this.input.keyboard.key(e.code, false));
    // Failsafes: never leave keys "stuck" or a quad flying in a hidden tab.
    window.addEventListener('blur', () => {
      this.input.keyboard.releaseAll();
      this.input.touch.releaseAll();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.input.failsafe();
    });
    window.addEventListener('resize', () => this.resize());
    window.visualViewport?.addEventListener('resize', () => this.resize());
    screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.resize(), 100));
    // Gamepad picked up / put down: hide or show the touch sticks.
    setInterval(() => this.updateTouchVisibility(), 500);
  }

  /** Keys while a replay plays. Returns true if handled. */
  private replayKey(e: KeyboardEvent): boolean {
    const r = this.replay!;
    switch (e.code) {
      case 'Space':
        if (!r.playing && r.t >= r.trace.duration) r.t = 0;
        r.playing = !r.playing;
        break;
      case 'ArrowLeft':
        r.t = Math.max(0, r.t - 2);
        break;
      case 'ArrowRight':
        r.t = Math.min(r.trace.duration, r.t + 2);
        break;
      case 'Escape':
        this.exitReplay();
        break;
      case 'KeyC':
        this.cycleCamera();
        break;
      case 'KeyG':
        return false; // debug overlay works as usual
      default:
        return true; // swallow flight keys while watching
    }
    e.preventDefault();
    return true;
  }

  private resize(): void {
    const g = this.settings.graphics;
    const preset = PRESETS[g.quality];
    const r = this.view.renderer;
    const base = Math.min(window.devicePixelRatio || 1, g.maxPixelRatio, preset.pixelRatio);
    const ratio = Math.max(0.35, base * this.governor.scale * (g.batterySaver ? 0.75 : 1));
    if (Math.abs(r.getPixelRatio() - ratio) > 1e-3) r.setPixelRatio(ratio);
    r.setSize(window.innerWidth, window.innerHeight, false);
    this.view.setDrawDistance(preset.drawDistance, this.rig.camera);
    this.touchUi.layout();
    this.updateTouchVisibility();
    this.rotateOverlay.classList.toggle('show', this.touchDevice && isPortrait());
  }
}
