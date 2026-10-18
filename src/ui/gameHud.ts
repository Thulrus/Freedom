/**
 * In-flight game HUD: status line (laps, time), a hint line, and a target
 * marker: a ring on the next checkpoint when it's on screen, an arrow at
 * the screen edge pointing to it when it's not.
 */
import { h, setText } from './dom';

export interface MarkerInfo {
  /** Normalized device coordinates of the target (-1..1, y up). */
  x: number;
  y: number;
  /** Target is behind the camera. */
  behind: boolean;
  /** Distance to it, m. */
  dist: number;
}

export class GameHud {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly ring: HTMLElement;
  private readonly ringLabel: HTMLElement;
  private readonly arrow: HTMLElement;

  constructor() {
    this.title = h('div', { class: 'ghud-title' });
    this.sub = h('div', { class: 'ghud-sub' });
    this.ringLabel = h('div', { class: 'ghud-dist' });
    this.ring = h('div', { class: 'ghud-ring' }, this.ringLabel);
    this.arrow = h('div', { class: 'ghud-arrow' }, '➤');
    this.root = h('div', { class: 'ghud' }, h('div', { class: 'ghud-top' }, this.title, this.sub), this.ring, this.arrow);
    this.visible = false;
  }

  set visible(v: boolean) {
    this.root.style.display = v ? '' : 'none';
  }

  get visible(): boolean {
    return this.root.style.display !== 'none';
  }

  /** Status and hint text (call at ~15 Hz; the strings are rebuilt each time). */
  text(title: string, sub: string): void {
    setText(this.title, title);
    setText(this.sub, sub);
  }

  /** Target marker (every frame). */
  update(marker: MarkerInfo | null): void {
    const W = window.innerWidth, H = window.innerHeight;
    const onScreen = marker && !marker.behind && Math.abs(marker.x) < 0.95 && Math.abs(marker.y) < 0.95;
    this.ring.style.display = onScreen ? '' : 'none';
    this.arrow.style.display = marker && !onScreen ? '' : 'none';
    if (!marker) return;
    if (onScreen) {
      this.ring.style.transform = `translate(${((marker.x + 1) / 2) * W}px, ${((1 - marker.y) / 2) * H}px)`;
      setText(this.ringLabel, `${marker.dist.toFixed(0)} m`);
    } else {
      // Direction from the screen centre; behind the camera the projection is mirrored.
      let dx = marker.x, dy = marker.y;
      if (marker.behind) {
        dx = -dx;
        dy = -dy;
      }
      if (Math.abs(dx) < 1e-3 && Math.abs(dy) < 1e-3) dy = -1;
      const a = Math.atan2(-dy, dx);
      const r = Math.min(W, H) * 0.36;
      this.arrow.style.transform = `translate(${W / 2 + Math.cos(a) * r}px, ${H / 2 + Math.sin(a) * r}px) rotate(${a}rad)`;
    }
  }
}
