/**
 * Wires everything together:
 * input -> RcChannels (per tick) -> sim (fixed 500 Hz) -> interpolated render.
 */
import * as THREE from 'three';
import { FixedStepper, Quad, Quat, type SimParams } from './sim';
import { InputManager } from './input/manager';
import type { GamepadMapping } from './input/gamepad';
import { buildSandbox, type SandboxWorld } from './world/sandbox';
import { SceneView } from './render/scene';
import { DroneModel } from './render/drone';
import { CameraRig } from './render/camera';
import { Osd, type OsdInfo } from './ui/osd';
import { DebugOverlay } from './ui/debug';
import { TuningPanel, type ChangeKind } from './ui/tuning';
import { helpPanel } from './ui/help';
import { GamepadSetup } from './ui/gamepadSetup';
import { isTyping } from './ui/dom';
import { FrameStats } from './platform/perf';
import { debouncedSaver } from './platform/storage';
import type { AppSettings, CameraMode } from './settings';

const SIM_HZ = 500;
const CAMERAS: CameraMode[] = ['fpv', 'chase', 'los'];

export class App {
  readonly world: SandboxWorld;
  readonly quad: Quad;
  readonly input: InputManager;
  readonly stepper: FixedStepper;
  private readonly view: SceneView;
  private readonly drone: DroneModel;
  private readonly rig = new CameraRig();
  private readonly osd = new Osd();
  private readonly debug = new DebugOverlay();
  private readonly tuning: TuningPanel;
  private readonly stats = new FrameStats();
  private readonly save: () => void;
  private modal: HTMLElement | null = null;
  private armedTime = 0;
  private last = 0;

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
    this.world = buildSandbox(1);
    this.quad = new Quad(settings.sim, 1 / SIM_HZ);
    this.input = new InputManager(settings.input, 1 / SIM_HZ, {
      reset: () => this.reset(),
      cycleCamera: () => this.cycleCamera(),
    });
    this.stepper = new FixedStepper(this.quad, this.world, this.input.sampler);
    this.view = new SceneView(canvas, this.world, { antialias: settings.graphics.antialias });
    this.drone = new DroneModel(settings.sim.quad);
    this.view.scene.add(this.drone.group, this.drone.shadow);
    this.tuning = new TuningPanel({
      settings: () => this.settings,
      onChange: (k) => this.onSettingsChange(k),
      replaceSim: (p) => this.replaceSim(p),
      openGamepadSetup: () => this.openGamepadSetup(),
      gamepadStatus: () => this.gamepadStatus(),
    });
    this.osdInfo = { state: this.quad.state, mode: 'acro', armBlock: 'none', armedTime: 0, throttle: 0, cells: settings.sim.quad.battery.cells, source: '', camera: '' };

    ui.append(this.osd.root, this.debug.root, this.tuning.root);
    this.osd.visible = settings.ui.osd;
    this.debug.visible = settings.ui.debug;
    this.reset();
    this.bindEvents();
    this.resize();
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
    const frameMs = now - this.last;
    const dt = Math.min(frameMs / 1000, 0.25);
    this.last = now;

    this.input.pollFrame();
    const t0 = performance.now();
    // Physics pauses while a dialog (help, controller setup) is open.
    if (!this.modal) this.stepper.advance(dt);
    else this.stepper.lastTicks = 0;
    const physMs = performance.now() - t0;

    const s = this.quad.state;
    if (s.armed) this.armedTime += dt;

    // Interpolate between the last two physics states.
    const { prev, curr, alpha } = this.stepper;
    const p = this.renderPos.set(
      prev.pos.x + (curr.pos.x - prev.pos.x) * alpha,
      prev.pos.y + (curr.pos.y - prev.pos.y) * alpha,
      prev.pos.z + (curr.pos.z - prev.pos.z) * alpha,
    );
    const qi = this.qInterp.slerpQuats(prev.quat, curr.quat, alpha);
    const q = this.renderQuat.set(qi.x, qi.y, qi.z, qi.w);

    const cam = this.settings.camera;
    this.drone.group.position.copy(p);
    this.drone.group.quaternion.copy(q);
    this.drone.group.visible = cam.mode !== 'fpv';
    this.drone.updateShadow(p.x, p.y, p.z, this.world.groundY);
    this.drone.updateProps(s.motorSpeed, dt);

    const w = this.canvas.clientWidth, hgt = this.canvas.clientHeight;
    this.rig.update(cam, p, q, w / Math.max(hgt, 1), dt);
    this.view.render(this.rig.camera);

    this.stats.push(frameMs, physMs, this.stepper.lastTicks);
    const o = this.osdInfo;
    o.mode = this.input.mode;
    o.armBlock = this.quad.armBlock;
    o.armedTime = this.armedTime;
    o.throttle = this.input.last.throttle;
    o.cells = this.settings.sim.quad.battery.cells;
    o.source = this.input.source === 'gamepad' ? 'gamepad' : 'keyboard';
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
      });
    }
  }

  // --------------------------------------------------------------- actions

  reset(): void {
    const sp = this.world.spawn;
    this.quad.reset(sp.x, sp.y, sp.z, 0);
    this.stepper.sync();
    this.input.onReset();
    this.armedTime = 0;
  }

  private cycleCamera(): void {
    const c = this.settings.camera;
    c.mode = CAMERAS[(CAMERAS.indexOf(c.mode) + 1) % CAMERAS.length];
    this.save();
  }

  private onSettingsChange(kind: ChangeKind): void {
    if (kind === 'sim') this.quad.applyParams(this.settings.sim);
    if (kind === 'input') this.input.applySettings(this.settings.input);
    if (kind === 'graphics') this.resize();
    this.save();
  }

  private replaceSim(p: SimParams): void {
    this.settings.sim = p;
    this.quad.applyParams(p);
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
    this.modal = helpPanel(() => {
      this.closeModal();
      this.settings.ui.helpSeen = true;
      this.save();
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
    window.addEventListener('blur', () => this.input.keyboard.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.input.failsafe();
    });
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const r = this.view.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.settings.graphics.maxPixelRatio));
    r.setSize(window.innerWidth, window.innerHeight, false);
  }
}
