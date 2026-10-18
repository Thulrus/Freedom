/**
 * Periodic 3D gradient noise for wrap-around worlds, plus deterministic
 * sin/cos for world generation.
 *
 * - The lattice repeats every `period` cells along x and z, so a world built
 *   from it tiles seamlessly (y is not periodic).
 * - Same rules as noise.ts: doubles travel through `io`, and only
 *   + - * / floor are used, so a seed gives bit-identical worlds on any engine.
 */
import { mixSeed } from './noise';

/** 12 gradient directions: the edges of a cube. */
const GX = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0]);
const GY = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1]);
const GZ = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1]);

function hash12(ix: number, iy: number, iz: number, s: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x1b873593) ^ Math.imul(iz, 0x165667b1) ^ s;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) % 12;
}

export class PeriodicNoise {
  /** In: io[0..2] = x, y, z in lattice units. Out: io[3] = value, roughly [-1, 1]. */
  readonly io = new Float64Array(4);
  private readonly seed: number;

  /** `period`: lattice cells before the pattern repeats along x and z. `salt` picks an independent field. */
  constructor(
    seed: number,
    readonly period: number,
    salt = 0,
  ) {
    this.seed = mixSeed(seed, 977 + salt * 7919);
  }

  /** One octave of gradient noise at io[0..2] into io[3]. Gradient magnitude ≤ ~2.5 per lattice unit. */
  sample(): void {
    const N = this.period;
    const x = this.io[0], y = this.io[1], z = this.io[2];
    const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
    const fx = x - x0, fy = y - y0, fz = z - z0;
    const ix = (x0 - Math.floor(x0 / N) * N) | 0;
    const iz = (z0 - Math.floor(z0 / N) * N) | 0;
    const iy = y0 | 0;
    const ix1 = ix + 1 === N ? 0 : ix + 1;
    const iz1 = iz + 1 === N ? 0 : iz + 1;
    const s = this.seed;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
    let g = hash12(ix, iy, iz, s);
    const n000 = GX[g] * fx + GY[g] * fy + GZ[g] * fz;
    g = hash12(ix1, iy, iz, s);
    const n100 = GX[g] * (fx - 1) + GY[g] * fy + GZ[g] * fz;
    g = hash12(ix, iy + 1, iz, s);
    const n010 = GX[g] * fx + GY[g] * (fy - 1) + GZ[g] * fz;
    g = hash12(ix1, iy + 1, iz, s);
    const n110 = GX[g] * (fx - 1) + GY[g] * (fy - 1) + GZ[g] * fz;
    g = hash12(ix, iy, iz1, s);
    const n001 = GX[g] * fx + GY[g] * fy + GZ[g] * (fz - 1);
    g = hash12(ix1, iy, iz1, s);
    const n101 = GX[g] * (fx - 1) + GY[g] * fy + GZ[g] * (fz - 1);
    g = hash12(ix, iy + 1, iz1, s);
    const n011 = GX[g] * fx + GY[g] * (fy - 1) + GZ[g] * (fz - 1);
    g = hash12(ix1, iy + 1, iz1, s);
    const n111 = GX[g] * (fx - 1) + GY[g] * (fy - 1) + GZ[g] * (fz - 1);
    const a = n000 + (n100 - n000) * u, b = n010 + (n110 - n010) * u;
    const c = n001 + (n101 - n001) * u, d = n011 + (n111 - n011) * u;
    const e = a + (b - a) * v, f = c + (d - c) * v;
    this.io[3] = e + (f - e) * w;
  }
}

const TAU = 6.283185307179586;

/** sin(x) using only + - * / floor (bit-identical everywhere). Construction-time use only. */
export function dsin(x: number): number {
  // Reduce to [-pi, pi], then a Taylor series (error < 1e-15).
  let r = x - Math.floor(x / TAU + 0.5) * TAU;
  // Fold to [-pi/2, pi/2] where the series converges fast.
  if (r > 1.5707963267948966) r = 3.141592653589793 - r;
  else if (r < -1.5707963267948966) r = -3.141592653589793 - r;
  const r2 = r * r;
  let term = r, sum = r;
  for (let k = 1; k < 12; k++) {
    term *= -r2 / ((2 * k) * (2 * k + 1));
    sum += term;
  }
  return sum;
}

export function dcos(x: number): number {
  return dsin(x + 1.5707963267948966);
}
