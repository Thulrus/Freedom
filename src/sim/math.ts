/**
 * Minimal mutable vector/quaternion math for the sim hot loop.
 *
 * All methods mutate `this` (or an explicit `out`) and return it, so the
 * physics step never allocates. Plain doubles, so results are deterministic
 * on a given JS engine.
 *
 * Coordinate conventions (shared with the renderer, Three.js-style):
 *   World: right-handed, +Y up.
 *   Body:  +X right, +Y up (thrust direction), -Z forward (nose).
 */

export class Vec3 {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  add(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Vec3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  addScaled(v: Vec3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  /** this = a x b (safe when this aliases a or b). */
  crossVectors(a: Vec3, b: Vec3): this {
    const x = a.y * b.z - a.z * b.y;
    const y = a.z * b.x - a.x * b.z;
    const z = a.x * b.y - a.y * b.x;
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  normalize(): this {
    const l = this.length();
    if (l > 0) this.scale(1 / l);
    return this;
  }

  lerpVectors(a: Vec3, b: Vec3, t: number): this {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }
}

/** Unit quaternion, body -> world rotation. */
export class Quat {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
    public w = 1,
  ) {}

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q: Quat): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  setFromAxisAngle(ax: number, ay: number, az: number, angle: number): this {
    const h = angle * 0.5;
    const s = Math.sin(h);
    return this.set(ax * s, ay * s, az * s, Math.cos(h));
  }

  /** this = this * q (apply q in the local/body frame). */
  multiply(q: Quat): this {
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    const bx = q.x, by = q.y, bz = q.z, bw = q.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  /** this = q * this (apply q in the parent/world frame). */
  premultiply(q: Quat): this {
    const ax = q.x, ay = q.y, az = q.z, aw = q.w;
    const bx = this.x, by = this.y, bz = this.z, bw = this.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  normalize(): this {
    let l = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (l === 0 || !Number.isFinite(l)) return this.identity();
    l = 1 / l;
    this.x *= l;
    this.y *= l;
    this.z *= l;
    this.w *= l;
    return this;
  }

  /**
   * Integrate a body-frame angular velocity (rad/s) over dt using the exact
   * exponential map: q <- q * exp(omega * dt / 2). Stable at any rate.
   */
  integrateBodyRate(w: Vec3, dt: number): this {
    const wx = w.x, wy = w.y, wz = w.z;
    const mag = Math.sqrt(wx * wx + wy * wy + wz * wz);
    if (mag < 1e-12) return this;
    const h = mag * dt * 0.5;
    const s = Math.sin(h) / mag;
    const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(h);
    const ax = this.x, ay = this.y, az = this.z, aw = this.w;
    this.x = aw * dx + ax * dw + ay * dz - az * dy;
    this.y = aw * dy - ax * dz + ay * dw + az * dx;
    this.z = aw * dz + ax * dy - ay * dx + az * dw;
    this.w = aw * dw - ax * dx - ay * dy - az * dz;
    return this.normalize();
  }

  /** Normalized lerp/slerp between a and b (shortest path). */
  slerpQuats(a: Quat, b: Quat, t: number): this {
    let bx = b.x, by = b.y, bz = b.z, bw = b.w;
    let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
    if (cos < 0) {
      cos = -cos;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    let k0: number, k1: number;
    if (cos > 0.9995) {
      k0 = 1 - t;
      k1 = t;
    } else {
      const theta = Math.acos(cos);
      const sin = Math.sin(theta);
      k0 = Math.sin((1 - t) * theta) / sin;
      k1 = Math.sin(t * theta) / sin;
    }
    this.x = a.x * k0 + bx * k1;
    this.y = a.y * k0 + by * k1;
    this.z = a.z * k0 + bz * k1;
    this.w = a.w * k0 + bw * k1;
    return this.normalize();
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z) && Number.isFinite(this.w);
  }
}

/** out = q * v * q^-1 (body -> world). out may alias v. */
export function rotateVec(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const vx = v.x, vy = v.y, vz = v.z;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** out = q^-1 * v * q (world -> body). out may alias v. */
export function rotateVecInverse(q: Quat, v: Vec3, out: Vec3): Vec3 {
  const qx = -q.x, qy = -q.y, qz = -q.z, qw = q.w;
  const vx = v.x, vy = v.y, vz = v.z;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Deterministic small PRNG (mulberry32). Use for seeded noise in the sim. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Uniform in [-1, 1). */
  signed(): number {
    return this.next() * 2 - 1;
  }
}
