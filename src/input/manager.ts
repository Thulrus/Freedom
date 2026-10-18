/**
 * Combines keyboard and gamepad/radio into the sim's RcChannels.
 * The sim calls `sampler` once per physics tick; `pollFrame` reads the
 * Gamepad API once per frame (browsers only refresh it per frame anyway).
 */
import type { FlightMode, QuadState, RcChannels } from '../sim';
import type { InputSettings } from '../settings';
import { defaultMappingFor, GamepadInput, readSwitch, switchPosition, type GamepadMapping } from './gamepad';
import { KeyboardInput } from './keyboard';
import { shapeStick, shapeThrottle } from './shaping';

export type InputSource = 'keyboard' | 'gamepad';

export interface InputActions {
  reset(): void;
  cycleCamera(): void;
}

const MODES: FlightMode[] = ['acro', 'angle', 'horizon'];

export class InputManager {
  readonly keyboard: KeyboardInput;
  readonly gamepad: GamepadInput;
  /** Virtual arm switch shared by all sources. */
  armSwitch = false;
  mode: FlightMode = 'acro';
  source: InputSource = 'keyboard';
  /** Shaped stick values of the last tick (for the debug overlay). */
  readonly last = { roll: 0, pitch: 0, yaw: 0, throttle: 0 };
  private lastArmAxis: boolean | null = null;
  private lastModePos = -1;

  constructor(
    private settings: InputSettings,
    private readonly tickDt: number,
    private readonly actions: InputActions,
  ) {
    this.keyboard = new KeyboardInput(settings.keyboardStickSpeed, settings.keyboardThrottleSpeed);
    this.gamepad = new GamepadInput((pad) => this.mappingFor(pad));
  }

  /** Saved mapping for this device, or a sensible default. */
  mappingFor(pad: { id: string; mapping: string }): GamepadMapping {
    return this.settings.gamepads[pad.id] ?? defaultMappingFor(pad);
  }

  applySettings(s: InputSettings): void {
    this.settings = s;
    this.keyboard.stickSpeed = s.keyboardStickSpeed;
    this.keyboard.throttleSpeed = s.keyboardThrottleSpeed;
    if (this.gamepad.id) this.gamepad.setMapping(s.gamepads[this.gamepad.id] ?? this.gamepad.mapping!);
  }

  toggleArm(): void {
    this.armSwitch = !this.armSwitch;
  }

  setMode(m: FlightMode): void {
    this.mode = m;
  }

  cycleMode(): void {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
  }

  /** Safe state: disarm and drop held keys (focus loss, tab hidden). */
  failsafe(): void {
    this.armSwitch = false;
    this.keyboard.releaseAll();
  }

  /** After a sim reset: disarmed, keyboard throttle at zero. */
  onReset(): void {
    this.armSwitch = false;
    this.keyboard.throttle = 0;
  }

  pollFrame(): void {
    const g = this.gamepad;
    g.poll();
    if (!g.connected || !g.mapping) {
      this.lastArmAxis = null;
      this.lastModePos = -1;
      if (this.source === 'gamepad') this.source = 'keyboard';
      return;
    }
    if (g.moved) this.source = 'gamepad';
    const m = g.mapping;
    if (m.arm) {
      if (m.arm.kind === 'axis') {
        const on = readSwitch(m.arm, g.axes, g.buttons) > 0.5;
        // Follow the physical switch only when it changes, so keyboard toggles still work.
        if (on !== this.lastArmAxis) this.armSwitch = on;
        this.lastArmAxis = on;
      } else if (g.pressed(m.arm.index)) this.toggleArm();
    }
    if (m.mode) {
      if (m.mode.kind === 'axis') {
        const pos = switchPosition(readSwitch(m.mode, g.axes, g.buttons));
        if (pos !== this.lastModePos) this.mode = m.modePositions[pos];
        this.lastModePos = pos;
      } else if (g.pressed(m.mode.index)) this.cycleMode();
    }
    if (g.pressed(m.resetButton)) this.actions.reset();
    if (g.pressed(m.cameraButton)) this.actions.cycleCamera();
  }

  /** Per-physics-tick sampler for FixedStepper. */
  readonly sampler = (rc: RcChannels, _state: QuadState): void => {
    const kb = this.keyboard;
    kb.update(this.tickDt);
    if (kb.active) this.source = 'keyboard';
    const sh = this.settings.shaping;
    const useGp = this.source === 'gamepad' && this.gamepad.connected;
    const src = useGp ? this.gamepad : kb;
    rc.roll = shapeStick(src.roll, sh.roll);
    rc.pitch = shapeStick(src.pitch, sh.pitch);
    rc.yaw = shapeStick(src.yaw, sh.yaw);
    rc.throttle = shapeThrottle(src.throttle, sh.throttle);
    rc.arm = this.armSwitch;
    rc.mode = this.mode;
    const l = this.last;
    l.roll = rc.roll;
    l.pitch = rc.pitch;
    l.yaw = rc.yaw;
    l.throttle = rc.throttle;
  };
}
