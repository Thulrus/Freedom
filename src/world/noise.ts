/**
 * Seeded 2D gradient noise and fBm.
 *
 * Written for the physics hot loop (terrain collision calls it every tick):
 * - Doubles go in and out through `io` instead of arguments/return values,
 *   because passing doubles through non-inlined calls allocates in V8 (see
 *   DEVLOG, "Zero-allocation lessons"). Integers passed are always small.
 * - Every constant is a literal and only + - * / floor are used on doubles,
 *   so the same seed gives bit-identical worlds on any JS engine.
 */

const D = 0.7071067811865476;
/** 8 gradient directions (axes + diagonals). */
const GX = new Float64Array([1, -1, 0, 0, D, -D, D, -D]);
const GZ = new Float64Array([0, 0, 1, -1, D, D, -D, -D]);

/** Integer hash of a lattice point -> 0..7. Arguments stay within Smi range. */
function hash8(ix: number, iz: number, s: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ s;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) & 7;
}

/** Scramble a user seed into a 30-bit value (fits a V8 Smi). */
export function mixSeed(seed: number, salt = 0): number {
  let h = Math.imul((seed | 0) ^ 0x5bd1e995, 0x2c1b3c6d) ^ Math.imul(salt | 0, 0x297a2d39);
  h = Math.imul(h ^ (h >>> 13), 0x165667b1);
  return (h ^ (h >>> 16)) & 0x3fffffff;
}

export class Noise {
  /** In: io[0] = x, io[1] = z. Out: io[2] = value. io[3..6]: cellRandom output. */
  readonly io = new Float64Array(7);
  private readonly seed: number;

  constructor(seed: number) {
    this.seed = mixSeed(seed);
  }

  /**
   * Fractal sum of gradient noise at (io[0], io[1]) into io[2].
   * Each octave doubles frequency (with a rotation, to hide lattice
   * artifacts) and halves amplitude. `salt` picks an independent field.
   * ridged = 0: result roughly in [-1, 1]. ridged = 1: sharp ridges, [0, 1].
   */
  fbm(octaves: number, salt: number, ridged: number): void {
    let x = this.io[0];
    let z = this.io[1];
    let s = (this.seed ^ Math.imul(salt, 0x2c9277b5)) & 0x3fffffff;
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const ix = x0 | 0;
      const iz = z0 | 0;
      const fx = x - x0;
      const fz = z - z0;
      const g00 = hash8(ix, iz, s);
      const g10 = hash8(ix + 1, iz, s);
      const g01 = hash8(ix, iz + 1, s);
      const g11 = hash8(ix + 1, iz + 1, s);
      const n00 = GX[g00] * fx + GZ[g00] * fz;
      const n10 = GX[g10] * (fx - 1) + GZ[g10] * fz;
      const n01 = GX[g01] * fx + GZ[g01] * (fz - 1);
      const n11 = GX[g11] * (fx - 1) + GZ[g11] * (fz - 1);
      const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
      const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
      const a = n00 + (n10 - n00) * u;
      const b = n01 + (n11 - n01) * u;
      let n = (a + (b - a) * v) * 1.4142135623730951;
      if (ridged === 1) {
        n = 1 - (n < 0 ? -n : n);
        n = n * n;
      }
      sum += n * amp;
      norm += amp;
      amp *= 0.5;
      // Rotate ~36.87° and scale by 2.03 (non-integer, so octaves don't align).
      const nx = (0.8 * x - 0.6 * z) * 2.03 + 17.17;
      z = (0.6 * x + 0.8 * z) * 2.03 + 31.31;
      x = nx;
      s = (Math.imul(s, 0x5bd1e995) + 0x3c6ef35f) & 0x3fffffff;
    }
    this.io[2] = sum / norm;
  }

  /** Four uniform values in [0, 1) for integer cell (ix, iz) into io[3..6]. */
  cellRandom(ix: number, iz: number, salt: number): void {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ this.seed ^ Math.imul(salt, 0x2c9277b5);
    for (let k = 3; k < 7; k++) {
      h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
      h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
      h ^= h >>> 15;
      this.io[k] = (h & 0xffffff) / 16777216;
      h = (h + 0x6d2b79f5) | 0;
    }
  }
}
