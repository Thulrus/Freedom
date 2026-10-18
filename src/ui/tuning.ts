/**
 * Live tuning panel. Every edit writes straight into the settings object and
 * calls host.onChange(), which applies it to the running sim and saves it.
 */
import { applyRateCurve, cloneParams, defaultSimParams, mergeParams, maxRate, RATE_PRESETS, thrustToWeight, hoverThrottle, type RateCurve, type RatePresetName, type SimParams } from '../sim';
import { defaultSettings, type AppSettings, type StickShaping } from '../settings';
import { downloadText, pickTextFile } from '../platform/storage';
import { h, type Child } from './dom';

export type ChangeKind = 'sim' | 'camera' | 'input' | 'graphics';

export interface TuningHost {
  settings(): AppSettings;
  onChange(kind: ChangeKind): void;
  /** Replace sim params wholesale (import / reset). */
  replaceSim(p: SimParams): void;
  openGamepadSetup(): void;
  gamepadStatus(): string;
}

interface NumOpts {
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
}

export class TuningPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly openSections = new Set<string>(['Rates']);

  constructor(private readonly host: TuningHost) {
    this.body = h('div', { class: 'tune-body' });
    this.root = h(
      'aside',
      { class: 'tune' },
      h('div', { class: 'tune-head' }, h('strong', null, 'Tuning'), h('button', { class: 'btn', onclick: () => this.toggle(false) }, '✕')),
      this.body,
    );
    this.root.style.display = 'none';
    this.rebuild();
  }

  get isOpen(): boolean {
    return this.root.style.display !== 'none';
  }

  toggle(open = !this.isOpen): void {
    this.root.style.display = open ? '' : 'none';
    if (open) this.rebuild();
  }

  rebuild(): void {
    const S = () => this.host.settings();
    const sim = () => S().sim;
    const ch = (k: ChangeKind) => () => this.host.onChange(k);
    const simCh = ch('sim');
    this.body.replaceChildren(
      this.section('Rates', this.ratesSection()),
      this.section('PIDs', this.pidSection()),
      this.section('Flight controller', [
        this.check('Airmode', () => sim().controller.airmode, (v) => (sim().controller.airmode = v), simCh),
        this.num('Throttle mid', () => sim().controller.throttleMid, (v) => (sim().controller.throttleMid = v), simCh, { min: 0, max: 1, step: 0.01 }),
        this.num('Throttle expo', () => sim().controller.throttleExpo, (v) => (sim().controller.throttleExpo = v), simCh, { min: 0, max: 1, step: 0.01 }),
        this.num('Angle limit', () => sim().controller.angleLimit, (v) => (sim().controller.angleLimit = v), simCh, { min: 10, max: 85, step: 1, unit: '°' }),
        this.num('Angle strength', () => sim().controller.angleStrength, (v) => (sim().controller.angleStrength = v), simCh, { min: 10, max: 150, step: 1 }),
        this.num('Horizon strength', () => sim().controller.horizonStrength, (v) => (sim().controller.horizonStrength = v), simCh, { min: 0, max: 150, step: 1 }),
        this.num('Horizon transition', () => sim().controller.horizonTransition, (v) => (sim().controller.horizonTransition = v), simCh, { min: 0.1, max: 1, step: 0.01 }),
        this.num('Motor idle', () => sim().controller.motorIdle, (v) => (sim().controller.motorIdle = v), simCh, { min: 0, max: 0.15, step: 0.005 }),
        this.num('I-term limit', () => sim().controller.itermLimit, (v) => (sim().controller.itermLimit = v), simCh, { min: 0, max: 1000, step: 10 }),
        this.num('I-term relax threshold', () => sim().controller.itermRelaxThreshold, (v) => (sim().controller.itermRelaxThreshold = v), simCh, { min: 0, max: 100, step: 1, unit: '°/s' }),
        this.num('Gyro LPF', () => sim().controller.gyroLpfHz, (v) => (sim().controller.gyroLpfHz = v), simCh, { min: 0, max: 500, step: 5, unit: 'Hz' }),
        this.num('D-term LPF', () => sim().controller.dtermLpfHz, (v) => (sim().controller.dtermLpfHz = v), simCh, { min: 0, max: 300, step: 5, unit: 'Hz' }),
        this.num('RC smoothing', () => sim().controller.rcSmoothingHz, (v) => (sim().controller.rcSmoothingHz = v), simCh, { min: 0, max: 150, step: 1, unit: 'Hz' }),
        this.num('FF smoothing', () => sim().controller.ffSmoothingHz, (v) => (sim().controller.ffSmoothingHz = v), simCh, { min: 0, max: 100, step: 1, unit: 'Hz' }),
      ]),
      this.section('Airframe', [
        h('div', { class: 'tune-info' }, `Thrust/weight ${thrustToWeight(sim()).toFixed(1)} : 1 · hover ≈ ${(hoverThrottle(sim()) * 100).toFixed(0)}% throttle`),
        this.num('Mass', () => sim().quad.mass, (v) => (sim().quad.mass = v), simCh, { min: 0.1, max: 2, step: 0.01, unit: 'kg' }),
        this.num('Max thrust / motor', () => sim().quad.maxThrustPerMotor, (v) => (sim().quad.maxThrustPerMotor = v), simCh, { min: 1, max: 40, step: 0.1, unit: 'N' }),
        this.num('Inertia pitch', () => sim().quad.inertia[0] * 1000, (v) => (sim().quad.inertia[0] = v / 1000), simCh, { min: 0.2, max: 10, step: 0.05, unit: 'g·m²' }),
        this.num('Inertia yaw', () => sim().quad.inertia[1] * 1000, (v) => (sim().quad.inertia[1] = v / 1000), simCh, { min: 0.2, max: 10, step: 0.05, unit: 'g·m²' }),
        this.num('Inertia roll', () => sim().quad.inertia[2] * 1000, (v) => (sim().quad.inertia[2] = v / 1000), simCh, { min: 0.2, max: 10, step: 0.05, unit: 'g·m²' }),
        this.num('Motor spin-up τ', () => sim().quad.motorTauUp * 1000, (v) => (sim().quad.motorTauUp = v / 1000), simCh, { min: 2, max: 100, step: 1, unit: 'ms' }),
        this.num('Motor spin-down τ', () => sim().quad.motorTauDown * 1000, (v) => (sim().quad.motorTauDown = v / 1000), simCh, { min: 2, max: 150, step: 1, unit: 'ms' }),
        this.num('Torque / thrust', () => sim().quad.torqueToThrust, (v) => (sim().quad.torqueToThrust = v), simCh, { min: 0.002, max: 0.05, step: 0.001, unit: 'm' }),
        this.num('Rotor inertia', () => sim().quad.rotorInertia * 1e7, (v) => (sim().quad.rotorInertia = v / 1e7), simCh, { min: 0, max: 200, step: 1, unit: 'g·cm²' }),
        ...(['X (side)', 'Y (vertical)', 'Z (forward)'] as const).flatMap((name, i) => [
          this.num(`Drag lin ${name}`, () => sim().quad.dragLinear[i], (v) => (sim().quad.dragLinear[i] = v), simCh, { min: 0, max: 1, step: 0.01, unit: 'N·s/m' }),
          this.num(`Drag quad ${name}`, () => sim().quad.dragQuadratic[i], (v) => (sim().quad.dragQuadratic[i] = v), simCh, { min: 0, max: 0.05, step: 0.001, unit: 'N·s²/m²' }),
        ]),
      ]),
      this.section('Battery', [
        this.check('Simulate battery', () => sim().quad.battery.enabled, (v) => (sim().quad.battery.enabled = v), simCh),
        this.num('Cells', () => sim().quad.battery.cells, (v) => (sim().quad.battery.cells = Math.round(v)), simCh, { min: 1, max: 8, step: 1, unit: 'S' }),
        this.num('Capacity', () => sim().quad.battery.capacityMah, (v) => (sim().quad.battery.capacityMah = v), simCh, { min: 200, max: 5000, step: 50, unit: 'mAh' }),
        this.num('Internal resistance', () => sim().quad.battery.internalResistance * 1000, (v) => (sim().quad.battery.internalResistance = v / 1000), simCh, { min: 0, max: 200, step: 1, unit: 'mΩ' }),
      ]),
      this.section('Crashes', [
        this.check('Disarm on crash', () => sim().quad.collision.disarmOnCrash, (v) => (sim().quad.collision.disarmOnCrash = v), simCh),
        this.num('Crash speed', () => sim().quad.collision.crashSpeed, (v) => (sim().quad.collision.crashSpeed = v), simCh, { min: 1, max: 30, step: 0.5, unit: 'm/s' }),
        this.num('Bounciness', () => sim().quad.collision.restitution, (v) => (sim().quad.collision.restitution = v), simCh, { min: 0, max: 0.9, step: 0.05 }),
      ]),
      this.section('Wind', [
        this.num('Wind X (east)', () => sim().env.wind[0], (v) => (sim().env.wind[0] = v), simCh, { min: -15, max: 15, step: 0.5, unit: 'm/s' }),
        this.num('Wind Z (south)', () => sim().env.wind[2], (v) => (sim().env.wind[2] = v), simCh, { min: -15, max: 15, step: 0.5, unit: 'm/s' }),
      ]),
      this.section('Camera', [
        this.num('FPV uptilt', () => S().camera.fpvTilt, (v) => (S().camera.fpvTilt = v), ch('camera'), { min: 0, max: 60, step: 1, unit: '°' }),
        this.num('FPV FOV (diagonal)', () => S().camera.fpvFov, (v) => (S().camera.fpvFov = v), ch('camera'), { min: 60, max: 160, step: 1, unit: '°' }),
        this.num('Chase distance', () => S().camera.chaseDistance, (v) => (S().camera.chaseDistance = v), ch('camera'), { min: 0.5, max: 8, step: 0.1, unit: 'm' }),
        this.num('Chase height', () => S().camera.chaseHeight, (v) => (S().camera.chaseHeight = v), ch('camera'), { min: 0, max: 4, step: 0.1, unit: 'm' }),
        this.num('Line-of-sight FOV', () => S().camera.losFov, (v) => (S().camera.losFov = v), ch('camera'), { min: 20, max: 90, step: 1, unit: '°' }),
      ]),
      this.section('Controls', [
        h('div', { class: 'tune-info' }, this.host.gamepadStatus()),
        h('button', { class: 'btn', onclick: () => this.host.openGamepadSetup() }, 'Set up controller / radio…'),
        ...(['roll', 'pitch', 'yaw', 'throttle'] as const).flatMap((axis) => this.shapingRows(axis)),
        this.num('Keyboard stick speed', () => S().input.keyboardStickSpeed, (v) => (S().input.keyboardStickSpeed = v), ch('input'), { min: 1, max: 20, step: 0.5, unit: '/s' }),
        this.num('Keyboard throttle speed', () => S().input.keyboardThrottleSpeed, (v) => (S().input.keyboardThrottleSpeed = v), ch('input'), { min: 0.1, max: 2, step: 0.05, unit: '/s' }),
      ]),
      this.section('Graphics', [
        this.num('Max pixel ratio', () => S().graphics.maxPixelRatio, (v) => (S().graphics.maxPixelRatio = v), ch('graphics'), { min: 0.5, max: 3, step: 0.25 }),
        h('div', { class: 'tune-info' }, 'Antialiasing changes apply after reload.'),
        this.check('Antialiasing', () => S().graphics.antialias, (v) => (S().graphics.antialias = v), ch('graphics')),
      ]),
      this.section('Share / import', this.jsonSection()),
    );
  }

  // ---------------------------------------------------------------- sections

  private ratesSection(): Child[] {
    const sim = () => this.host.settings().sim;
    const presetSel = h(
      'select',
      {
        onchange: (e: Event) => {
          const name = (e.target as HTMLSelectElement).value as RatePresetName;
          if (!name) return;
          sim().controller.rates = RATE_PRESETS[name]();
          this.host.onChange('sim');
          this.rebuild();
        },
      },
      h('option', { value: '' }, 'Load preset…'),
      ...Object.keys(RATE_PRESETS).map((k) => h('option', { value: k }, k)),
    );
    return [
      h('div', { class: 'tune-row' }, h('label', null, 'Preset'), presetSel),
      ...(['roll', 'pitch', 'yaw'] as const).map((axis) => this.rateAxis(axis)),
      h('div', { class: 'tune-info' }, 'Enter numbers exactly as shown in Betaflight Configurator.'),
    ];
  }

  private rateAxis(axis: 'roll' | 'pitch' | 'yaw'): HTMLElement {
    const rates = () => this.host.settings().sim.controller.rates;
    const box = h('div', { class: 'rate-axis' });
    const canvas = h('canvas', { width: 120, height: 80, class: 'rate-curve' });
    const readout = h('span', { class: 'tune-dim' });
    const redraw = () => {
      const c = rates()[axis];
      readout.textContent = `max ${maxRate(c).toFixed(0)}°/s`;
      drawCurve(canvas, c);
    };
    const changed = () => {
      this.host.onChange('sim');
      redraw();
    };
    const render = () => {
      const c = rates()[axis];
      const fields: HTMLElement[] = [];
      const field = (label: string, key: string, o: NumOpts) =>
        fields.push(this.num(label, () => (rates()[axis] as unknown as Record<string, number>)[key], (v) => ((rates()[axis] as unknown as Record<string, number>)[key] = v), changed, o));
      if (c.type === 'actual') {
        field('Center sensitivity', 'center', { min: 10, max: 1000, step: 5, unit: '°/s' });
        field('Max rate', 'max', { min: 10, max: 1998, step: 10, unit: '°/s' });
        field('Expo', 'expo', { min: 0, max: 1, step: 0.01 });
      } else if (c.type === 'betaflight') {
        field('RC rate', 'rcRate', { min: 0.01, max: 2.55, step: 0.01 });
        field('Super rate', 'superRate', { min: 0, max: 0.99, step: 0.01 });
        field('RC expo', 'expo', { min: 0, max: 1, step: 0.01 });
      } else {
        field('RC rate', 'rcRate', { min: 0.01, max: 2.55, step: 0.01 });
        field('Max rate', 'max', { min: 10, max: 1998, step: 10, unit: '°/s' });
        field('Expo', 'expo', { min: 0, max: 1, step: 0.01 });
      }
      const typeSel = h(
        'select',
        {
          onchange: (e: Event) => {
            rates()[axis] = convertRate(rates()[axis], (e.target as HTMLSelectElement).value as RateCurve['type']);
            this.host.onChange('sim');
            render();
          },
        },
        ...(['actual', 'betaflight', 'quick'] as const).map((t) => h('option', { value: t, selected: c.type === t }, t)),
      );
      box.replaceChildren(
        h('div', { class: 'rate-head' }, h('strong', null, axis), typeSel, readout),
        h('div', { class: 'rate-grid' }, h('div', null, ...fields), canvas),
      );
      redraw();
    };
    render();
    return box;
  }

  private pidSection(): Child[] {
    const pid = () => this.host.settings().sim.controller.pid;
    const cell = (axis: 'roll' | 'pitch' | 'yaw', k: 'p' | 'i' | 'd' | 'ff') =>
      h('td', null, h('input', {
        type: 'number', min: 0, max: 250, step: 1, value: pid()[axis][k], class: 'pid-in',
        oninput: (e: Event) => {
          const v = parseFloat((e.target as HTMLInputElement).value);
          if (Number.isFinite(v)) {
            pid()[axis][k] = Math.max(0, Math.min(250, v));
            this.host.onChange('sim');
          }
        },
      }));
    return [
      h(
        'table',
        { class: 'pid' },
        h('tr', null, h('th'), h('th', null, 'P'), h('th', null, 'I'), h('th', null, 'D'), h('th', null, 'FF')),
        ...(['roll', 'pitch', 'yaw'] as const).map((a) => h('tr', null, h('th', null, a), cell(a, 'p'), cell(a, 'i'), cell(a, 'd'), cell(a, 'ff'))),
      ),
      h('button', {
        class: 'btn', onclick: () => {
          this.host.settings().sim.controller.pid = defaultSimParams().controller.pid;
          this.host.onChange('sim');
          this.rebuild();
        },
      }, 'Betaflight defaults'),
    ];
  }

  private shapingRows(axis: 'roll' | 'pitch' | 'yaw' | 'throttle'): HTMLElement[] {
    const sh = (): StickShaping => this.host.settings().input.shaping[axis];
    const c = () => this.host.onChange('input');
    return [
      h('div', { class: 'tune-sub' }, `${axis} stick`),
      this.num('Deadzone', () => sh().deadzone, (v) => (sh().deadzone = v), c, { min: 0, max: 0.3, step: 0.01 }),
      this.num('Expo', () => sh().expo, (v) => (sh().expo = v), c, { min: 0, max: 1, step: 0.01 }),
      this.num('Sensitivity', () => sh().sensitivity, (v) => (sh().sensitivity = v), c, { min: 0.2, max: 1, step: 0.01 }),
    ];
  }

  private jsonSection(): Child[] {
    const area = h('textarea', { class: 'json', rows: 6, spellcheck: false, placeholder: 'Paste a tune JSON here, then Import' });
    const status = h('div', { class: 'tune-info' });
    const doImport = (text: string) => {
      try {
        const parsed = JSON.parse(text);
        // Accept either bare SimParams or a full settings export.
        const simJson = parsed && typeof parsed === 'object' && 'sim' in parsed ? parsed.sim : parsed;
        this.host.replaceSim(mergeParams(defaultSimParams(), simJson));
        status.textContent = 'Imported.';
        this.rebuild();
      } catch (err) {
        status.textContent = `Import failed: ${(err as Error).message}`;
      }
    };
    return [
      h('div', { class: 'tune-info' }, 'A tune is the full physics + flight-controller setup. Share it with other pilots.'),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => (area.value = JSON.stringify(this.host.settings().sim, null, 2)) }, 'Show JSON'),
        h('button', {
          class: 'btn', onclick: async () => {
            const text = JSON.stringify(this.host.settings().sim, null, 2);
            area.value = text;
            try {
              await navigator.clipboard.writeText(text);
              status.textContent = 'Copied to clipboard.';
            } catch {
              status.textContent = 'Select the text and copy it.';
            }
          },
        }, 'Copy'),
        h('button', { class: 'btn', onclick: () => downloadText('freedom-tune.json', JSON.stringify(this.host.settings().sim, null, 2)) }, 'Download'),
      ),
      area,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => doImport(area.value) }, 'Import'),
        h('button', { class: 'btn', onclick: async () => { const t = await pickTextFile(); if (t) doImport(t); } }, 'Import file…'),
        h('button', {
          class: 'btn danger', onclick: () => {
            if (!confirm('Reset all physics and flight-controller settings to defaults?')) return;
            this.host.replaceSim(defaultSettings().sim);
            this.rebuild();
          },
        }, 'Reset tune'),
      ),
      status,
    ];
  }

  // ---------------------------------------------------------------- widgets

  private section(title: string, children: Child[]): HTMLElement {
    const d = h('details', { open: this.openSections.has(title) }, h('summary', null, title), ...children);
    d.addEventListener('toggle', () => (d.open ? this.openSections.add(title) : this.openSections.delete(title)));
    return d;
  }

  private num(label: string, get: () => number, set: (v: number) => void, changed: () => void, o: NumOpts): HTMLElement {
    const fmt = (v: number) => String(+v.toFixed(4));
    const range = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: get() });
    const box = h('input', { type: 'number', min: o.min, max: o.max, step: o.step, value: fmt(get()), class: 'num' });
    const apply = (v: number, from: HTMLInputElement) => {
      if (!Number.isFinite(v)) return;
      v = Math.min(o.max, Math.max(o.min, v));
      set(v);
      if (from !== range) range.value = String(v);
      if (from !== box) box.value = fmt(v);
      changed();
    };
    range.addEventListener('input', () => apply(parseFloat(range.value), range));
    box.addEventListener('change', () => apply(parseFloat(box.value), box));
    return h('div', { class: 'tune-row', title: o.hint ?? '' }, h('label', null, label, o.unit ? h('span', { class: 'tune-dim' }, ` ${o.unit}`) : null), range, box);
  }

  private check(label: string, get: () => boolean, set: (v: boolean) => void, changed: () => void): HTMLElement {
    const cb = h('input', { type: 'checkbox', checked: get(), onchange: () => { set(cb.checked); changed(); } });
    return h('label', { class: 'tune-row check' }, cb, label);
  }
}

/** Switch a rate curve to another BF type, keeping roughly the same max rate. */
export function convertRate(c: RateCurve, type: RateCurve['type']): RateCurve {
  if (c.type === type) return cloneParams(c);
  const max = Math.round(maxRate(c));
  switch (type) {
    case 'actual':
      return { type, center: 70, max, expo: 0 };
    case 'betaflight':
      return { type, rcRate: 1, superRate: Math.min(0.99, Math.max(0, +(1 - 200 / max).toFixed(2))), expo: 0 };
    case 'quick':
      return { type, rcRate: 1, max, expo: 0 };
  }
}

function drawCurve(canvas: HTMLCanvasElement, c: RateCurve): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,0.15)';
  g.strokeRect(0.5, 0.5, W - 1, H - 1);
  const top = Math.max(maxRate(c), 100);
  g.strokeStyle = '#ffc531';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const s = i / 40;
    const x = s * (W - 4) + 2;
    const y = H - 2 - (applyRateCurve(c, s) / top) * (H - 4);
    if (i) g.lineTo(x, y);
    else g.moveTo(x, y);
  }
  g.stroke();
}
