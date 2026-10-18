/** Betaflight-style on-screen display (DOM overlay, updated ~15x per second). */
import type { ArmBlockReason, FlightMode, QuadState } from '../sim';
import { h, setText } from './dom';

export interface OsdInfo {
  state: QuadState;
  mode: FlightMode;
  armBlock: ArmBlockReason;
  armedTime: number;
  throttle: number;
  cells: number;
  source: string;
  camera: string;
}

export class Osd {
  readonly root: HTMLElement;
  private readonly el: Record<string, HTMLElement> = {};
  private nextUpdate = 0;

  constructor() {
    const span = (k: string, cls = '') => (this.el[k] = h('div', { class: `osd-item ${cls}` }));
    this.root = h(
      'div',
      { class: 'osd' },
      h('div', { class: 'osd-tl' }, span('mode'), span('armed')),
      h('div', { class: 'osd-tr' }, span('volt'), span('cell'), span('amps')),
      h('div', { class: 'osd-tc' }, span('warn', 'osd-warn')),
      h('div', { class: 'osd-cross' }),
      h('div', { class: 'osd-bl' }, span('alt'), span('spd')),
      h('div', { class: 'osd-br' }, span('timer'), span('thr')),
      h('div', { class: 'osd-bc' }, span('src', 'osd-dim')),
    );
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  update(now: number, o: OsdInfo): void {
    if (now < this.nextUpdate) return;
    this.nextUpdate = now + 66;
    const s = o.state;
    const e = this.el;
    setText(e.mode, o.mode.toUpperCase());
    setText(e.armed, s.armed ? 'ARMED' : 'DISARMED');
    e.armed.classList.toggle('osd-alert', !s.armed);
    setText(e.volt, `${s.voltage.toFixed(1)}V`);
    const cell = s.voltage / o.cells;
    setText(e.cell, `${cell.toFixed(2)}V/c`);
    e.cell.classList.toggle('osd-alert', cell < 3.5);
    setText(e.amps, `${s.current.toFixed(0)}A`);
    setText(e.alt, `ALT ${(s.pos.y - 0.12).toFixed(1)}m`);
    setText(e.spd, `SPD ${(s.vel.length() * 3.6).toFixed(0)}km/h`);
    const t = Math.floor(o.armedTime);
    setText(e.timer, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    setText(e.thr, `THR ${Math.round(o.throttle * 100)}%`);
    setText(e.src, `${o.source} · ${o.camera} cam · H for help`);
    let warn = '';
    if (s.crashed) warn = 'CRASHED · DISARM TO CLEAR · R TO RESET';
    else if (!s.armed && o.armBlock === 'throttle') warn = 'THROTTLE HIGH · LOWER TO ARM';
    else if (!s.armed && o.armBlock === 'switch') warn = 'TOGGLE ARM SWITCH';
    else if (cell < 3.4 && s.armed) warn = 'LOW BATTERY';
    setText(e.warn, warn);
  }
}
