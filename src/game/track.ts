/**
 * A recorded flight path: time, position and attitude samples (about one per
 * rendered frame). Used for the best-lap ghost and saved with the best lap.
 * Float32 is plenty: courses stay within a few hundred metres of the pad.
 */
import type { Quat, Vec3 } from '../sim';

const STRIDE = 8; // t, x, y, z, qx, qy, qz, qw

export class PoseTrack {
  data: Float32Array;
  count = 0;
  private cursor = 0;

  constructor(capacity = 60 * 60 * 3) {
    this.data = new Float32Array(capacity * STRIDE);
  }

  get capacity(): number {
    return this.data.length / STRIDE;
  }

  get duration(): number {
    return this.count ? this.data[(this.count - 1) * STRIDE] : 0;
  }

  clear(): void {
    this.count = 0;
    this.cursor = 0;
  }

  push(t: number, p: Vec3, q: Quat): void {
    if (this.count >= this.capacity) return;
    const o = this.count++ * STRIDE, d = this.data;
    d[o] = t;
    d[o + 1] = p.x;
    d[o + 2] = p.y;
    d[o + 3] = p.z;
    d[o + 4] = q.x;
    d[o + 5] = q.y;
    d[o + 6] = q.z;
    d[o + 7] = q.w;
  }

  copyFrom(o: PoseTrack): this {
    if (this.data.length < o.count * STRIDE) this.data = new Float32Array(o.data.length);
    this.data.set(o.data.subarray(0, o.count * STRIDE));
    this.count = o.count;
    this.cursor = 0;
    return this;
  }

  /** Interpolated pose at time t. Returns false outside the recording. */
  sample(t: number, p: Vec3, q: Quat): boolean {
    const d = this.data, n = this.count;
    if (n < 2 || t < d[0] || t > d[(n - 1) * STRIDE]) return false;
    let i = Math.min(this.cursor, n - 2);
    while (i > 0 && d[i * STRIDE] > t) i--;
    while (i < n - 2 && d[(i + 1) * STRIDE] < t) i++;
    this.cursor = i;
    const a = i * STRIDE, b = a + STRIDE;
    const span = d[b] - d[a];
    const u = span > 0 ? (t - d[a]) / span : 0;
    p.set(d[a + 1] + (d[b + 1] - d[a + 1]) * u, d[a + 2] + (d[b + 2] - d[a + 2]) * u, d[a + 3] + (d[b + 3] - d[a + 3]) * u);
    // Normalized lerp is plenty between samples a frame apart.
    let qx = d[a + 4] + (d[b + 4] - d[a + 4]) * u, qy = d[a + 5] + (d[b + 5] - d[a + 5]) * u;
    let qz = d[a + 6] + (d[b + 6] - d[a + 6]) * u, qw = d[a + 7] + (d[b + 7] - d[a + 7]) * u;
    if (d[a + 4] * d[b + 4] + d[a + 5] * d[b + 5] + d[a + 6] * d[b + 6] + d[a + 7] * d[b + 7] < 0) {
      qx = d[a + 4] - (d[b + 4] + d[a + 4]) * u;
      qy = d[a + 5] - (d[b + 5] + d[a + 5]) * u;
      qz = d[a + 6] - (d[b + 6] + d[a + 6]) * u;
      qw = d[a + 7] - (d[b + 7] + d[a + 7]) * u;
    }
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw) || 1;
    q.x = qx / l;
    q.y = qy / l;
    q.z = qz / l;
    q.w = qw / l;
    return true;
  }

  /** Base64 of the used samples (for localStorage). */
  encode(): string {
    const bytes = new Uint8Array(this.data.buffer, 0, this.count * STRIDE * 4);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  static decode(b64: string): PoseTrack | null {
    try {
      const s = atob(b64);
      if (s.length % (STRIDE * 4) !== 0) return null;
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
      const t = new PoseTrack(s.length / (STRIDE * 4));
      t.data = new Float32Array(bytes.buffer);
      t.count = t.data.length / STRIDE;
      return t;
    } catch {
      return null;
    }
  }
}
