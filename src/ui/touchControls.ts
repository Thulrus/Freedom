/**
 * Touch layer: two stick zones (left/right halves), stick graphics and an
 * on-screen button bar. Uses Pointer Events with pointer capture so each
 * thumb stays bound to its stick, and `pointerrawupdate` where supported
 * (delivers moves at the digitizer rate instead of once per frame).
 */
import type { TouchInput, VirtualStick } from '../input/touch';
import type { LatencyMeter } from '../platform/latency';
import { fullscreenSupported, safeAreaInsets } from '../platform/display';
import type { TouchSettings } from '../settings';
import { h, setText } from './dom';

export interface TouchHost {
  arm(): void;
  mode(): void;
  camera(): void;
  reset(): void;
  tune(): void;
  menu(): void;
  fullscreen(): void;
}

interface StickView {
  stick: VirtualStick;
  zone: HTMLElement;
  base: HTMLElement;
  knob: HTMLElement;
  /** Last drawn state: cx, cy, x, y, active (NaN forces a redraw). */
  last: Float64Array;
}

export class TouchControls {
  readonly root: HTMLElement;
  private readonly views: StickView[];
  private readonly armBtn: HTMLButtonElement;
  private readonly modeBtn: HTMLButtonElement;
  private lastArmed: boolean | null = null;
  private lastMode = '';

  constructor(
    private readonly input: TouchInput,
    private readonly settings: () => TouchSettings,
    private readonly latency: LatencyMeter,
    host: TouchHost,
  ) {
    const mk = (stick: VirtualStick, side: 'left' | 'right'): StickView => {
      const zone = h('div', { class: `touch-zone ${side}` });
      const base = h('div', { class: 'stick-base' });
      const knob = h('div', { class: 'stick-knob' });
      const v: StickView = { stick, zone, base, knob, last: new Float64Array(5).fill(NaN) };
      this.bindZone(v);
      return v;
    };
    this.views = [mk(input.left, 'left'), mk(input.right, 'right')];
    const btn = (label: string, cls: string, onTap: () => void) => {
      const b = h('button', { class: `tbtn ${cls}`, type: 'button' }, label);
      // pointerup instead of click: no 300 ms heuristics, works with other fingers down.
      b.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        onTap();
      });
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };
    this.armBtn = btn('ARM', 'arm', () => host.arm());
    this.modeBtn = btn('ACRO', 'mode', () => host.mode());
    this.root = h(
      'div',
      { class: 'touch' },
      this.views.map((v) => v.zone),
      this.views.map((v) => [v.base, v.knob]),
      h(
        'div',
        { class: 'touch-bar' },
        this.armBtn,
        this.modeBtn,
        btn('CAM', '', () => host.camera()),
        btn('RESET', '', () => host.reset()),
        btn('☰', '', () => host.menu()),
        btn('⚙', '', () => host.tune()),
        fullscreenSupported() ? btn('⛶', '', () => host.fullscreen()) : null,
      ),
    );
    this.layout();
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
    if (!v) this.input.releaseAll();
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  /** Recompute stick geometry (resize, rotation, settings change). */
  layout(): void {
    const w = window.innerWidth, hgt = window.innerHeight;
    const safe = safeAreaInsets();
    this.input.layout(w, hgt, safe);
    const op = String(this.settings().opacity);
    for (const v of this.views) {
      const r = v.stick.radius;
      v.base.style.width = v.base.style.height = `${r * 2}px`;
      v.knob.style.width = v.knob.style.height = `${Math.round(r * 0.62)}px`;
      v.base.style.opacity = op;
      v.knob.style.opacity = String(Math.min(1, +op + 0.25));
      v.last[0] = NaN;
    }
    this.render(false, 'acro');
  }

  /** Per-frame: move knobs (only touches the DOM when something changed). */
  render(armed: boolean, mode: string): void {
    for (const v of this.views) {
      const s = v.stick;
      const l = v.last;
      const act = s.active ? 1 : 0;
      if (l[0] === s.cx && l[1] === s.cy && l[2] === s.x && l[3] === s.y && l[4] === act) continue;
      l[0] = s.cx;
      l[1] = s.cy;
      l[2] = s.x;
      l[3] = s.y;
      l[4] = act;
      const r = s.radius;
      v.base.style.transform = `translate3d(${s.cx - r}px, ${s.cy - r}px, 0)`;
      const kr = r * 0.31;
      v.knob.style.transform = `translate3d(${s.cx + s.x * r - kr}px, ${s.cy - s.y * r - kr}px, 0)`;
      v.knob.classList.toggle('active', s.active);
    }
    if (armed !== this.lastArmed) {
      this.lastArmed = armed;
      this.armBtn.classList.toggle('on', armed);
      setText(this.armBtn, armed ? 'DISARM' : 'ARM');
    }
    if (mode !== this.lastMode) {
      this.lastMode = mode;
      setText(this.modeBtn, mode.toUpperCase());
    }
  }

  private bindZone(v: StickView): void {
    const z = v.zone;
    const s = v.stick;
    z.addEventListener('pointerdown', (e) => {
      if (s.active) return; // one thumb per stick; extra fingers are ignored
      e.preventDefault();
      try {
        z.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events in tests */
      }
      s.down(e.pointerId, e.clientX, e.clientY, this.settings().floating);
      this.latency.mark(e.timeStamp);
    });
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== s.pointerId) return;
      s.move(e.clientX, e.clientY);
      this.latency.mark(e.timeStamp);
    };
    z.addEventListener('pointermove', onMove);
    if ('onpointerrawupdate' in z) z.addEventListener('pointerrawupdate' as 'pointermove', onMove);
    const end = (e: PointerEvent) => {
      if (e.pointerId !== s.pointerId) return;
      s.release();
      this.latency.mark(e.timeStamp);
    };
    z.addEventListener('pointerup', end);
    z.addEventListener('pointercancel', end);
    z.addEventListener('lostpointercapture', end);
  }
}
