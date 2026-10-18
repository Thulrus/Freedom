/**
 * Frame-pacing governor: dynamic resolution and automatic preset downgrade.
 *
 * It learns the display's refresh interval from the frame timings (works for
 * 60/90/120 Hz), counts missed vsyncs, lowers the render scale when frames
 * are missed, and slowly raises it again when frames are steady. Physics
 * never changes: only rendering cost is traded for frame rate.
 */
import type { QualityPreset } from '../settings';

export interface PresetSpec {
  /** Pixel-ratio cap. */
  pixelRatio: number;
  /** Fog end / draw distance, m. */
  drawDistance: number;
}

export const PRESETS: Record<QualityPreset, PresetSpec> = {
  high: { pixelRatio: 2, drawDistance: 600 },
  medium: { pixelRatio: 1.5, drawDistance: 420 },
  low: { pixelRatio: 1, drawDistance: 280 },
};

const ORDER: QualityPreset[] = ['high', 'medium', 'low'];

export class FrameGovernor {
  /** Render scale applied on top of the preset's pixel ratio (minScale..1). */
  scale = 1;
  /** Estimated vsync interval, ms. */
  vsync = 16.7;
  /** Missed frames in the current window (for the debug overlay). */
  missed = 0;
  /** Set when a downgrade happened (UI shows a notice, then clears it). */
  downgradedTo: QualityPreset | null = null;

  private readonly intervals = new Float32Array(120);
  private n = 0;
  private windowFrames = 0;
  private steadyFrames = 0;
  private atMinFrames = 0;
  private cooldown = 0;

  constructor(
    public minScale = 0.5,
    /** Frames per evaluation window. */
    private readonly window = 60,
  ) {}

  /**
   * Feed one frame interval (ms). Returns true when the render scale or preset changed.
   * `preset` is mutated through the callback when auto-downgrading.
   */
  frame(intervalMs: number, opts: { dynamic: boolean; autoDowngrade: boolean; preset: QualityPreset; setPreset: (p: QualityPreset) => void }): boolean {
    if (!(intervalMs > 0) || intervalMs > 250) return false; // tab switches, pauses
    this.intervals[this.n++ % this.intervals.length] = intervalMs;
    if (this.n % 30 === 0) this.vsync = this.estimateVsync();
    if (intervalMs > this.vsync * 1.5) this.missed++;
    this.windowFrames++;
    if (this.cooldown > 0) this.cooldown--;
    let changed = false;
    if (this.windowFrames >= this.window) {
      const missedFrac = this.missed / this.windowFrames;
      if (opts.dynamic && missedFrac > 0.05 && this.cooldown === 0) {
        if (this.scale > this.minScale + 1e-6) {
          this.scale = Math.max(this.minScale, +(this.scale - 0.1).toFixed(2));
          changed = true;
          this.cooldown = 30;
        }
        this.steadyFrames = 0;
      }
      if (missedFrac > 0.05 && (!opts.dynamic || this.scale <= this.minScale + 1e-6)) this.atMinFrames += this.windowFrames;
      else this.atMinFrames = 0;
      if (missedFrac === 0) this.steadyFrames += this.windowFrames;
      else this.steadyFrames = 0;
      this.windowFrames = 0;
      this.missed = 0;
    }
    // Climb back slowly after ~5 s of perfect pacing.
    if (opts.dynamic && this.steadyFrames >= 300 && this.scale < 1) {
      this.scale = Math.min(1, +(this.scale + 0.05).toFixed(2));
      this.steadyFrames = 0;
      changed = true;
    }
    // Still missing frames at minimum resolution for ~3 s: drop a preset level.
    if (opts.autoDowngrade && this.atMinFrames >= 180) {
      const i = ORDER.indexOf(opts.preset);
      if (i < ORDER.length - 1) {
        opts.setPreset(ORDER[i + 1]);
        this.downgradedTo = ORDER[i + 1];
        this.scale = 1;
        changed = true;
      }
      this.atMinFrames = 0;
    }
    return changed;
  }

  reset(): void {
    this.scale = 1;
    this.missed = this.windowFrames = this.steadyFrames = this.atMinFrames = 0;
  }

  /** 20th percentile of recent intervals snapped to common refresh rates. */
  private estimateVsync(): number {
    const k = Math.min(this.n, this.intervals.length);
    const a = Array.from(this.intervals.subarray(0, k)).sort((x, y) => x - y);
    const p = a[Math.floor(k * 0.2)];
    for (const hz of [144, 120, 90, 75, 60, 50, 30]) {
      const iv = 1000 / hz;
      if (Math.abs(p - iv) / iv < 0.12) return iv;
    }
    return p;
  }
}
