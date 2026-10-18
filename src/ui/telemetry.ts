/**
 * Flight telemetry plots for a replay, centred on the playback cursor:
 * sticks, gyro vs setpoint per axis, motor outputs, altitude and speed.
 * Reads straight from the re-simulated trace (100 Hz).
 */
import { T, type Trace } from '../game/recorder';
import { h } from './dom';

const WINDOW = 8; // seconds shown
const C = { roll: '#ff6b5a', pitch: '#7fd36b', yaw: '#4aa3ff', thr: '#ffc531', sp: 'rgba(255,255,255,0.85)', grid: 'rgba(255,255,255,0.12)', text: '#c9d1d9' };
const MOTOR = ['#ff6b5a', '#ffc531', '#7fd36b', '#4aa3ff'];

interface Line {
  field: number;
  color: string;
  /** Map raw value before plotting. */
  map?: (v: number) => number;
  dash?: boolean;
}

interface Lane {
  name: string;
  lines: Line[];
  /** Fixed range, or null to auto-scale symmetric around 0 (min ±minRange). */
  range: [number, number] | null;
  minRange?: number;
  unit?: string;
}

export class TelemetryView {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly lanes: Lane[];
  private readonly homeY: number;

  constructor(
    private readonly trace: Trace,
    homeY: number,
  ) {
    this.homeY = homeY;
    this.canvas = h('canvas', { class: 'tele-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.root = h(
      'div',
      { class: 'tele' },
      this.canvas,
      h(
        'div',
        { class: 'tele-key' },
        h('span', { style: { color: C.roll } }, 'roll'),
        h('span', { style: { color: C.pitch } }, 'pitch'),
        h('span', { style: { color: C.yaw } }, 'yaw'),
        h('span', { style: { color: C.thr } }, 'throttle'),
        h('span', null, 'white = setpoint'),
      ),
    );
    this.lanes = [
      {
        name: 'sticks',
        range: [-1, 1],
        lines: [
          { field: T.sticks, color: C.roll },
          { field: T.sticks + 1, color: C.pitch },
          { field: T.sticks + 2, color: C.yaw },
          { field: T.sticks + 3, color: C.thr, map: (v) => v * 2 - 1 },
        ],
      },
      { name: 'roll °/s', range: null, minRange: 200, lines: [{ field: T.setpoint, color: C.sp, dash: true }, { field: T.gyro, color: C.roll }] },
      { name: 'pitch °/s', range: null, minRange: 200, lines: [{ field: T.setpoint + 1, color: C.sp, dash: true }, { field: T.gyro + 1, color: C.pitch }] },
      { name: 'yaw °/s', range: null, minRange: 200, lines: [{ field: T.setpoint + 2, color: C.sp, dash: true }, { field: T.gyro + 2, color: C.yaw }] },
      { name: 'motors', range: [0, 1], lines: MOTOR.map((c, i) => ({ field: T.motors + i, color: c })) },
      { name: 'altitude m', range: null, minRange: 5, lines: [{ field: T.pos + 1, color: '#e6edf3', map: (v) => v - this.homeY }] },
    ];
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  draw(t: number): void {
    if (!this.visible) return;
    const cv = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = cv.clientWidth, H = cv.clientHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const tr = this.trace;
    const t0 = t - WINDOW / 2, t1 = t + WINDOW / 2;
    const i0 = tr.index(Math.max(0, t0)), i1 = tr.index(t1);
    const xOf = (time: number) => ((time - t0) / WINDOW) * W;
    const laneH = H / this.lanes.length;
    g.font = '11px ui-monospace, monospace';
    this.lanes.forEach((lane, li) => {
      const top = li * laneH;
      // Range.
      let lo: number, hi: number;
      if (lane.range) [lo, hi] = lane.range;
      else {
        let m = lane.minRange ?? 1;
        let mn = Infinity, mx = -Infinity;
        for (let i = i0; i <= i1; i++)
          for (const l of lane.lines) {
            const v = l.map ? l.map(tr.value(i, l.field)) : tr.value(i, l.field);
            if (v > mx) mx = v;
            if (v < mn) mn = v;
          }
        if (lane.name.startsWith('alt')) {
          lo = Math.min(0, mn);
          hi = Math.max(lo + m, mx);
        } else {
          m = Math.max(m, Math.abs(mn), Math.abs(mx));
          lo = -m;
          hi = m;
        }
      }
      const yOf = (v: number) => top + 4 + (1 - (v - lo) / (hi - lo || 1)) * (laneH - 8);
      g.strokeStyle = C.grid;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, top + laneH);
      g.lineTo(W, top + laneH);
      if (lo < 0 && hi > 0) {
        g.moveTo(0, yOf(0));
        g.lineTo(W, yOf(0));
      }
      g.stroke();
      for (const l of lane.lines) {
        g.strokeStyle = l.color;
        g.lineWidth = l.dash ? 1 : 1.5;
        g.setLineDash(l.dash ? [4, 3] : []);
        g.beginPath();
        for (let i = i0; i <= i1; i++) {
          const v = l.map ? l.map(tr.value(i, l.field)) : tr.value(i, l.field);
          const x = xOf(tr.value(i, T.time)), y = yOf(v);
          if (i === i0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
      g.setLineDash([]);
      g.fillStyle = C.text;
      g.fillText(`${lane.name}  ${hi.toFixed(lane.range ? 0 : hi < 20 ? 1 : 0)}`, 6, top + 13);
    });
    // Cursor.
    g.strokeStyle = '#ffffff';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(W / 2, 0);
    g.lineTo(W / 2, H);
    g.stroke();
  }
}
