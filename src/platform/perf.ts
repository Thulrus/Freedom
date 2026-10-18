/** Rolling frame statistics in preallocated ring buffers (no per-frame garbage). */
export class FrameStats {
  readonly frameMs: Float32Array;
  readonly physicsMs: Float32Array;
  readonly ticks: Uint16Array;
  /** World streaming / generation time per frame, ms. */
  readonly worldMs: Float32Array;
  index = 0;
  count = 0;

  constructor(readonly size = 240) {
    this.frameMs = new Float32Array(size);
    this.physicsMs = new Float32Array(size);
    this.ticks = new Uint16Array(size);
    this.worldMs = new Float32Array(size);
  }

  push(frameMs: number, physicsMs: number, ticks: number, worldMs = 0): void {
    const i = this.index;
    this.worldMs[i] = worldMs;
    this.frameMs[i] = frameMs;
    this.physicsMs[i] = physicsMs;
    this.ticks[i] = ticks;
    this.index = (i + 1) % this.size;
    if (this.count < this.size) this.count++;
  }

  /** Average and max over the last n samples. */
  summary(buf: Float32Array, n = 60): { avg: number; max: number } {
    n = Math.min(n, this.count);
    let sum = 0, max = 0;
    for (let k = 1; k <= n; k++) {
      const v = buf[(this.index - k + this.size) % this.size];
      sum += v;
      if (v > max) max = v;
    }
    return { avg: n ? sum / n : 0, max };
  }
}
