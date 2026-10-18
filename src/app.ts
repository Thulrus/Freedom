/**
 * Wires everything together:
 * input -> RcChannels (per tick) -> sim (fixed 500 Hz) -> interpolated render.
 */
import * as THREE from 'three';
import { FixedStepper, hoverThrottle, Quad, Quat, Vec3, type SimParams } from './sim';
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
import { debouncedSaver } from './platform/storage';
import type { AppSettings, CameraMode } from './settings';

const SIM_HZ = 500;
/** Main-thread time per frame for world generation, ms (chunks are built in small slices). */
const WORLD_BUDGET_MS = 2;
const CAMERAS: CameraMode[] = ['fpv', 'chase', 'los'];

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
  private last = 0;
  private wasArmed = false;
  private wasCrashed = false;
  private readonly touchDevice = isTouchDevice();

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
    this.stepper = new FixedStepper(this.quad, this.world, this.input.sampler);
    this.view = new SceneView(canvas, { antialias: settings.graphics.antialias });
    this.view.setWorld(this.world);
    this.rig.ground = (x, z) => this.world.groundHeight(x + this.origin.x, z + this.origin.z);
    this.drone = new DroneModel(settings.sim.quad);
    this.view.scene.add(this.drone.group, this.drone.shadow);
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
      fullscreen: () => void enterFullscreen().then(() => this.resize()),
    });
    this.input.touch.hoverThrottle = hoverThrottle(settings.sim);
    this.rotateOverlay = h('div', { class: 'rotate' }, h('div', { class: 'rotate-icon' }, '⟳'), h('div', null, 'Turn your phone sideways to fly'));
    this.notice = h('div', { class: 'notice' });
    this.osdInfo = { state: this.quad.state, mode: 'acro', armBlock: 'none', armedTime: 0, throttle: 0, cells: settings.sim.quad.battery.cells, source: '', camera: '', homeY: 0 };

    ui.append(this.touchUi.root, this.osd.root, this.debug.root, this.tuning.root, this.notice, this.rotateOverlay);
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

    // Interpolate between the last two physics states (world coordinates).
    const { prev, curr, alpha } = this.stepper;
    const wx = prev.pos.x + (curr.pos.x - prev.pos.x) * alpha;
    const wy = prev.pos.y + (curr.pos.y - prev.pos.y) * alpha;
    const wz = prev.pos.z + (curr.pos.z - prev.pos.z) * alpha;
    // Stream the world around the drone, then draw everything relative to the floating origin.
    const origin = this.origin;
    origin.update(wx, wz);
    const t1 = performance.now();
    this.view.update(wx, wz, origin, WORLD_BUDGET_MS);
    const worldMs = performance.now() - t1;
    const groundY = this.world.groundHeight(wx, wz);
    const p = this.renderPos.set(wx - origin.x, wy, wz - origin.z);
    this.rig.pilotPos.set(this.pilot.x - origin.x, this.pilot.y, this.pilot.z - origin.z);
    const qi = this.qInterp.slerpQuats(prev.quat, curr.quat, alpha);
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

    this.stats.push(frameMs, physMs, this.stepper.lastTicks, worldMs);
    const o = this.osdInfo;
    o.mode = this.input.mode;
    o.armBlock = this.quad.armBlock;
    o.armedTime = this.armedTime;
    o.throttle = this.input.last.throttle;
    o.cells = this.settings.sim.quad.battery.cells;
    o.source = this.input.source;
    o.camera = cam.mode.toUpperCase();
    this.osd.update(now, o);
    if (this.debug.visible) {
      const info = this.view.renderer.info.render;
      const gp = this.input.gamepad;
      this.debug.update(now, {
        stats: this.stats,
        drawCalls: info.calls,
        triangles: info.triangles,
        simHz: SIM_HZ,
        droppedTicks: this.stepper.droppedTicks,
        sticks: this.input.last,
        gyro: this.quad.fc.gyro,
        setpoint: this.quad.fc.setpoint,
        motors: s.motorCmd,
        inputLatencyMs: gp.connected ? performance.now() - gp.timestamp : null,
        latency: this.latency.sampleCount ? this.latency.stats() : null,
        renderScale: this.governor.scale,
        pixelRatio: this.view.renderer.getPixelRatio(),
        vsyncMs: this.governor.vsync,
        quality: g.quality,
        world: this.view.worldStatus,
        origin,
      });
    }
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
  }

  /** Build the world in settings.world and put the quad on its launch pad. */
  loadWorld(): void {
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
    const want = (t === 'on' || (t === 'auto' && this.touchDevice)) && this.input.source !== 'gamepad';
    if (want !== this.touchUi.visible) this.touchUi.visible = want;
  }

  private cycleCamera(): void {
    const c = this.settings.camera;
    c.mode = CAMERAS[(CAMERAS.indexOf(c.mode) + 1) % CAMERAS.length];
    this.save();
  }

  private onSettingsChange(kind: ChangeKind): void {
    if (kind === 'sim') {
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
