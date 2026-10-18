/** Debug overlay: frame-time graph, physics cost, renderer counters, stick inputs. */
import type { FrameStats } from '../platform/perf';
import { h, setText } from './dom';

export interface DebugInfo {
  stats: FrameStats;
  drawCalls: number;
  triangles: number;
  simHz: number;
  droppedTicks: number;
  sticks: { roll: number; pitch: number; yaw: number; throttle: number };
  gyro: Float64Array;
  setpoint: Float64Array;
  motors: Float64Array;
  inputLatencyMs: number | null;
}

const W = 240, H = 70;

export class DebugOverlay {
  readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly graph: HTMLCanvasElement;
  private readonly sticks: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly s: CanvasRenderingContext2D;
  private nextText = 0;

  constructor() {
    this.graph = h('canvas', { width: W, height: H });
    this.sticks = h('canvas', { width: W, height: 64 });
    this.text = h('pre', { class: 'debug-text' });
    this.root = h('div', { class: 'debug' }, this.graph, this.sticks, this.text);
    this.g = this.graph.getContext('2d')!;
    this.s = this.sticks.getContext('2d')!;
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  update(now: number, d: DebugInfo): void {
    if (!this.visible) return;
    this.drawGraph(d.stats);
    this.drawSticks(d);
    if (now < this.nextText) return;
    this.nextText = now + 250;
    const f = d.stats.summary(d.stats.frameMs);
    const p = d.stats.summary(d.stats.physicsMs);
    const r = (v: number) => v.toFixed(0).padStart(5);
    setText(
      this.text,
      [
        `fps   ${(1000 / Math.max(f.avg, 0.001)).toFixed(0).padStart(4)}   frame ${f.avg.toFixed(1)} / max ${f.max.toFixed(1)} ms`,
        `phys  ${p.avg.toFixed(2)} ms/frame (max ${p.max.toFixed(2)})  sim ${d.simHz} Hz`,
        `draws ${d.drawCalls}   tris ${d.triangles}   dropped ticks ${d.droppedTicks}`,
        `gyro  ${r(d.gyro[0])}${r(d.gyro[1])}${r(d.gyro[2])} deg/s`,
        `sp    ${r(d.setpoint[0])}${r(d.setpoint[1])}${r(d.setpoint[2])}`,
        `motor ${Array.from(d.motors, (m) => (m * 100).toFixed(0).padStart(4)).join('')} %`,
        d.inputLatencyMs !== null ? `gamepad sample age ${d.inputLatencyMs.toFixed(1)} ms` : '',
      ].join('\n'),
    );
  }

  private drawGraph(st: FrameStats): void {
    const g = this.g;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(0, 0, W, H);
    const scale = H / 50; // 50 ms full height
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.moveTo(0, H - 16.7 * scale);
    g.lineTo(W, H - 16.7 * scale);
    g.stroke();
    const n = st.count;
    for (let k = 0; k < n; k++) {
      const i = (st.index - n + k + st.size) % st.size;
      const x = W - n + k;
      const fm = st.frameMs[i], pm = st.physicsMs[i];
      g.fillStyle = fm > 20 ? '#ff5a36' : '#7fd36b';
      g.fillRect(x, H - fm * scale, 1, fm * scale);
      g.fillStyle = '#4aa3ff';
      g.fillRect(x, H - pm * scale, 1, pm * scale);
    }
  }

  private drawSticks(d: DebugInfo): void {
    const s = this.s;
    s.clearRect(0, 0, W, 64);
    const box = (cx: number, x: number, y: number) => {
      s.strokeStyle = 'rgba(255,255,255,0.5)';
      s.strokeRect(cx - 28, 4, 56, 56);
      s.fillStyle = '#ffc531';
      s.beginPath();
      s.arc(cx + x * 26, 32 - y * 26, 4, 0, Math.PI * 2);
      s.fill();
    };
    box(40, d.sticks.yaw, d.sticks.throttle * 2 - 1);
    box(110, d.sticks.roll, d.sticks.pitch);
    for (let i = 0; i < d.motors.length; i++) {
      s.fillStyle = 'rgba(255,255,255,0.15)';
      s.fillRect(160 + i * 18, 4, 12, 56);
      s.fillStyle = '#4aa3ff';
      s.fillRect(160 + i * 18, 60 - d.motors[i] * 56, 12, d.motors[i] * 56);
    }
  }
}
