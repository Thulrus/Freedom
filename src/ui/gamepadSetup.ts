/**
 * Controller / radio setup: live raw axes, per-channel mapping, and a
 * calibration wizard ("push throttle up", "roll right", ...) that detects
 * axis index, direction and range for any device.
 */
import { defaultMappingFor, detectAxis, detectSwitch, normalizeStick, normalizeThrottle, readSwitch, type AxisMap, type GamepadMapping, type SwitchMap } from '../input/gamepad';
import type { InputManager } from '../input/manager';
import type { FlightMode } from '../sim';
import { h, setText, backdropClose } from './dom';

type Ch = 'roll' | 'pitch' | 'yaw' | 'throttle';
const CHANNELS: Ch[] = ['throttle', 'yaw', 'pitch', 'roll'];

interface WizardStep {
  text: string;
  /** Called with the current snapshot when the user presses Next. Return an error to stay. */
  take(axes: Float32Array, buttons: Float32Array): string | null;
  optional?: boolean;
}

export class GamepadSetup {
  readonly root: HTMLElement;
  private raf = 0;
  private readonly live: (() => void)[] = [];
  private mapping: GamepadMapping | null = null;
  private wizard: { steps: WizardStep[]; i: number; el: HTMLElement } | null = null;

  constructor(
    private readonly input: InputManager,
    private readonly save: (id: string, m: GamepadMapping | null) => void,
    private readonly onClose: () => void,
  ) {
    this.root = h('div', backdropClose(() => this.close()));
  }

  open(): void {
    this.render();
    const loop = () => {
      this.live.forEach((f) => f());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  close(): void {
    cancelAnimationFrame(this.raf);
    this.root.remove();
    this.onClose();
  }

  private get gp() {
    return this.input.gamepad;
  }

  private render(): void {
    this.live.length = 0;
    const gp = this.gp;
    const box = h('div', { class: 'modal-box wide' });
    this.root.replaceChildren(box);
    box.append(h('h2', null, 'Controller setup'));
    if (!gp.connected) {
      box.append(
        h('p', null, 'No controller detected. Plug in a gamepad or a radio in USB joystick mode, then press any button or move a stick (browsers only expose controllers after an input).'),
        h('button', { class: 'btn', onclick: () => this.render() }, 'Retry'),
        h('button', { class: 'btn primary', onclick: () => this.close() }, 'Close'),
      );
      const wait = () => {
        if (this.gp.connected) this.render();
      };
      this.live.push(wait);
      return;
    }
    this.mapping ??= JSON.parse(JSON.stringify(gp.mapping)) as GamepadMapping;
    const m = this.mapping;
    box.append(h('p', { class: 'tune-dim' }, gp.id));

    if (this.wizard) {
      box.append(this.wizard.el);
      return;
    }

    // Raw axes.
    const raw = h('div', { class: 'raw-axes' });
    for (let i = 0; i < gp.axisCount; i++) {
      const fill = h('div', { class: 'bar-fill' });
      const val = h('span', { class: 'tune-dim' });
      raw.append(h('div', { class: 'raw-row' }, h('span', null, `axis ${i}`), h('div', { class: 'bar' }, fill), val));
      this.live.push(() => {
        const v = gp.axes[i];
        fill.style.left = `${Math.min(50, 50 + v * 50)}%`;
        fill.style.width = `${Math.abs(v) * 50}%`;
        setText(val, v.toFixed(2));
      });
    }
    const btns = h('div', { class: 'raw-buttons' });
    for (let i = 0; i < gp.buttonCount; i++) {
      const b = h('span', { class: 'raw-btn' }, String(i));
      btns.append(b);
      this.live.push(() => b.classList.toggle('on', gp.buttons[i] > 0.5));
    }

    // Channel mapping.
    const rows = CHANNELS.map((ch) => {
      const a = m[ch];
      const fill = h('div', { class: 'bar-fill out' });
      this.live.push(() => {
        const raw = gp.axes[a.index] ?? 0;
        if (ch === 'throttle') {
          const v = normalizeThrottle(raw, a);
          fill.style.left = '0%';
          fill.style.width = `${v * 100}%`;
        } else {
          const v = normalizeStick(raw, a);
          fill.style.left = `${Math.min(50, 50 + v * 50)}%`;
          fill.style.width = `${Math.abs(v) * 50}%`;
        }
      });
      return h(
        'tr',
        null,
        h('th', null, ch),
        h('td', null, this.axisSelect(a)),
        h('td', null, h('label', null, h('input', { type: 'checkbox', checked: a.invert, onchange: (e: Event) => (a.invert = (e.target as HTMLInputElement).checked) }), ' invert')),
        h('td', null, h('div', { class: 'bar' }, fill)),
      );
    });
    const armState = h('span', { class: 'tune-dim' });
    const modeState = h('span', { class: 'tune-dim' });
    this.live.push(() => {
      setText(armState, m.arm ? (readSwitch(m.arm, gp.axes, gp.buttons) > 0.5 ? 'ON' : 'off') : '');
      setText(modeState, `current: ${this.input.mode}`);
    });

    box.append(
      h('p', { class: 'note' }, 'Radio (EdgeTX/OpenTX): set the model to USB Joystick mode. Run the wizard once; the result is saved for this device.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => this.startWizard() }, 'Calibration wizard'),
        h('button', { class: 'btn', onclick: () => { this.mapping = defaultMappingFor({ mapping: navigator.getGamepads().find((p) => p?.id === gp.id)?.mapping ?? '' }); this.render(); } }, 'Default mapping'),
      ),
      h('table', { class: 'map' }, ...rows,
        h('tr', null, h('th', null, 'arm'), h('td', { colspan: 2 }, this.switchSelect(m.arm, (s) => (m.arm = s))), h('td', null, armState)),
        h('tr', null, h('th', null, 'mode'), h('td', { colspan: 2 }, this.switchSelect(m.mode, (s) => (m.mode = s))), h('td', null, modeState)),
        h('tr', null, h('th', null, 'mode pos'), h('td', { colspan: 3 }, ...([0, 1, 2] as const).map((i) => this.modeSelect(m, i)))),
      ),
      h('details', null, h('summary', null, 'Raw inputs'), raw, btns),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => { this.save(gp.id, m); this.close(); } }, 'Save'),
        h('button', { class: 'btn', onclick: () => this.close() }, 'Cancel'),
        h('button', { class: 'btn danger', onclick: () => { this.save(gp.id, null); this.mapping = null; this.close(); } }, 'Forget device'),
      ),
    );
  }

  private axisSelect(a: AxisMap): HTMLSelectElement {
    const n = Math.max(this.gp.axisCount, a.index + 1);
    return h(
      'select',
      { onchange: (e: Event) => (a.index = parseInt((e.target as HTMLSelectElement).value, 10)) },
      ...Array.from({ length: n }, (_, i) => h('option', { value: i, selected: i === a.index }, `axis ${i}`)),
    );
  }

  private switchSelect(cur: SwitchMap | null, set: (s: SwitchMap | null) => void): HTMLSelectElement {
    const opts: [string, SwitchMap | null][] = [['none', null]];
    for (let i = 0; i < this.gp.axisCount; i++) opts.push([`axis ${i}`, { kind: 'axis', index: i, invert: false }]);
    for (let i = 0; i < this.gp.buttonCount; i++) opts.push([`button ${i}`, { kind: 'button', index: i, invert: false }]);
    const key = (s: SwitchMap | null) => (s ? `${s.kind} ${s.index}` : 'none');
    return h(
      'select',
      {
        onchange: (e: Event) => {
          const found = opts.find(([k]) => k === (e.target as HTMLSelectElement).value);
          set(found ? found[1] : null);
        },
      },
      ...opts.map(([k]) => h('option', { value: k, selected: k === key(cur) }, k)),
    );
  }

  private modeSelect(m: GamepadMapping, i: 0 | 1 | 2): HTMLSelectElement {
    const modes: FlightMode[] = ['acro', 'angle', 'horizon'];
    return h(
      'select',
      { onchange: (e: Event) => (m.modePositions[i] = (e.target as HTMLSelectElement).value as FlightMode) },
      ...modes.map((md) => h('option', { value: md, selected: m.modePositions[i] === md }, `${['low', 'mid', 'high'][i]}: ${md}`)),
    );
  }

  private startWizard(): void {
    const gp = this.gp;
    const m = this.mapping!;
    let base: Float32Array = new Float32Array(16);
    let baseBtn: Float32Array = new Float32Array(32);
    const snap = (a: Float32Array) => a.slice();
    const stick = (ch: Exclude<Ch, 'throttle'>, dir: 'max' | 'min', label: string): WizardStep => ({
      text: label,
      take: (axes) => {
        if (dir === 'max') {
          const d = detectAxis(base, axes);
          if (!d) return 'No stick movement detected. Push the stick all the way and hold it.';
          m[ch] = { index: d.index, center: d.from, max: d.to, min: d.from - (d.to - d.from), invert: false };
        } else {
          const v = axes[m[ch].index];
          if (Math.abs(v - m[ch].center) < 0.3) return 'Push the stick all the way the other way and hold it.';
          m[ch].min = v;
        }
        return null;
      },
    });
    const steps: WizardStep[] = [
      { text: 'Center roll, pitch and yaw. Put the throttle all the way DOWN. Set the arm switch to DISARMED.', take: (a, b) => { base = snap(a); baseBtn = snap(b); return null; } },
      {
        text: 'Push the THROTTLE all the way UP and hold it.',
        take: (axes) => {
          const d = detectAxis(base, axes);
          if (!d) return 'No throttle movement detected.';
          m.throttle = { index: d.index, min: d.from, center: (d.from + d.to) / 2, max: d.to, invert: false };
          return null;
        },
      },
      stick('roll', 'max', 'Hold ROLL fully RIGHT (throttle back down is fine).'),
      stick('roll', 'min', 'Hold ROLL fully LEFT.'),
      stick('pitch', 'max', 'Hold PITCH fully FORWARD (stick up).'),
      stick('pitch', 'min', 'Hold PITCH fully BACK (stick down).'),
      stick('yaw', 'max', 'Hold YAW fully RIGHT.'),
      stick('yaw', 'min', 'Hold YAW fully LEFT.'),
      {
        text: 'Flip your ARM switch to ARMED (or hold the button you want to use for arming). Skip to keep the current arm control.',
        optional: true,
        take: (axes, btn) => {
          const used = [m.roll.index, m.pitch.index, m.yaw.index, m.throttle.index];
          const s = detectSwitch(base, axes, baseBtn, btn, used);
          if (!s) return 'Nothing changed. Flip the switch and hold, or Skip.';
          // Axis switch: invert is set so ARMED reads high. A button toggles arming.
          m.arm = s;
          return null;
        },
      },
      {
        text: 'Move your MODE switch to a different position (or press the button you want for cycling modes). Skip to keep the current mode control.',
        optional: true,
        take: (axes, btn) => {
          const used = [m.roll.index, m.pitch.index, m.yaw.index, m.throttle.index, ...(m.arm?.kind === 'axis' ? [m.arm.index] : [])];
          const s = detectSwitch(base, axes, baseBtn, btn, used);
          if (!s) return 'Nothing changed. Move the switch, or Skip.';
          m.mode = { ...s, invert: false };
          return null;
        },
      },
    ];
    const el = h('div', { class: 'wizard' });
    this.wizard = { steps, i: 0, el };
    const show = (err: string | null = null) => {
      const w = this.wizard!;
      if (w.i >= steps.length) {
        this.wizard = null;
        this.render();
        return;
      }
      const st = steps[w.i];
      el.replaceChildren(
        h('div', { class: 'tune-dim' }, `Step ${w.i + 1} of ${steps.length}`),
        h('p', { class: 'wizard-text' }, st.text),
        h('p', { class: 'wizard-err' }, err ?? ''),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: () => { const e = st.take(gp.axes, gp.buttons); if (e) show(e); else { w.i++; show(); } } }, 'Next'),
          st.optional ? h('button', { class: 'btn', onclick: () => { w.i++; show(); } }, 'Skip') : null,
          h('button', { class: 'btn', onclick: () => { this.wizard = null; this.render(); } }, 'Cancel wizard'),
        ),
      );
    };
    show();
    this.render();
  }
}
