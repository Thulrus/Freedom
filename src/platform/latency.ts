/**
 * Input latency meter. Input handlers call mark(event.timeStamp) for the first
 * unconsumed event; the frame loop calls consume(frameTime) right before the
 * physics catch-up that uses it. That gives "input event -> simulated" time.
 * Add about one frame for the result to reach the screen (compositor + scan-out).
 *
 * Both timestamps share the performance.now() timebase in modern browsers.
 */
export class LatencyMeter {
  private pending = 0;
  private readonly samples: Float32Array;
  private index = 0;
  private count = 0;

  constructor(readonly size = 120) {
    this.samples = new Float32Array(size);
  }

  /** Call from input handlers with event.timeStamp. */
  mark(ts: number): void {
    if (this.pending === 0 && ts > 0) this.pending = ts;
  }

  /** Call once per frame before running physics. */
  consume(now: number): void {
    if (this.pending === 0) return;
    const d = now - this.pending;
    this.pending = 0;
    if (d < 0 || d > 500) return; // clock mismatch or tab switch
    this.samples[this.index] = d;
    this.index = (this.index + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  get sampleCount(): number {
    return this.count;
  }

  /** Average and 95th percentile, ms. */
  stats(): { avg: number; p95: number } {
    if (!this.count) return { avg: 0, p95: 0 };
    const a = Array.from(this.samples.subarray(0, this.count)).sort((x, y) => x - y);
    const avg = a.reduce((s, v) => s + v, 0) / a.length;
    return { avg, p95: a[Math.min(a.length - 1, Math.floor(a.length * 0.95))] };
  }
}
