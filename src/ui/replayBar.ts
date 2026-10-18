/** Replay transport: restart, play/pause, speed, scrub, telemetry, camera, exit. */
import { formatTime } from '../game/types';
import { h, setText } from './dom';

export interface ReplayHost {
  playing: boolean;
  speed: number;
  readonly duration: number;
  seek(t: number): void;
  toggleTelemetry(): void;
  camera(): void;
  exit(): void;
}

const SPEEDS = [0.25, 0.5, 1, 2];

export class ReplayBar {
  readonly root: HTMLElement;
  private readonly play: HTMLButtonElement;
  private readonly speedBtn: HTMLButtonElement;
  private readonly scrub: HTMLInputElement;
  private readonly time: HTMLElement;
  private dragging = false;

  constructor(private readonly host: ReplayHost, warning: string) {
    const btn = (label: string, on: () => void, title = '') => h('button', { class: 'btn', type: 'button', onclick: on, title }, label);
    this.play = btn('⏸', () => (host.playing = !host.playing), 'Play / pause (Space)');
    this.speedBtn = btn('1×', () => {
      host.speed = SPEEDS[(SPEEDS.indexOf(host.speed) + 1) % SPEEDS.length];
    });
    this.scrub = h('input', { type: 'range', min: 0, max: host.duration, step: 0.01, value: 0, class: 'replay-scrub' });
    this.scrub.addEventListener('input', () => {
      this.dragging = true;
      host.seek(parseFloat(this.scrub.value));
    });
    this.scrub.addEventListener('change', () => (this.dragging = false));
    this.time = h('span', { class: 'replay-time' });
    this.root = h(
      'div',
      { class: 'replay-bar' },
      h('span', { class: 'replay-tag' }, 'REPLAY'),
      btn('⏮', () => host.seek(0), 'Restart'),
      this.play,
      this.speedBtn,
      this.scrub,
      this.time,
      btn('Graphs', () => host.toggleTelemetry(), 'Telemetry'),
      btn('CAM', () => host.camera(), 'Camera (C)'),
      btn('✕', () => host.exit(), 'Exit replay (Esc)'),
      warning ? h('div', { class: 'replay-warn' }, warning) : null,
    );
  }

  update(t: number): void {
    setText(this.play, this.host.playing ? '⏸' : '▶');
    setText(this.speedBtn, `${this.host.speed}×`);
    if (!this.dragging) this.scrub.value = String(t);
    setText(this.time, `${formatTime(t)} / ${formatTime(this.host.duration)}`);
  }
}
