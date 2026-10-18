/**
 * "Arches": a red-rock desert built for flying through, not for realism.
 * A sandy canyon floor is packed (one feature per 80 m cell) with
 *   - free-standing arches,
 *   - sandstone fins pierced by windows,
 *   - buttes bored through by tunnels, with skylight shafts and roofed slots,
 *   - natural bridges between twin pillars,
 *   - arcades (a wall of arches), and
 *   - hoodoo fields to weave through.
 * The world is a 640 m tile that wraps around, so something worth flying
 * through is never more than a few seconds away. Physics is real (Training).
 */
import { Rng } from '../sim';
import { dcos, dsin, PeriodicNoise } from './pnoise';
import {
  hexToLinear,
  MAT_GROUND,
  OP_SMOOTH_SUBTRACT,
  OP_SMOOTH_UNION,
  OP_SUBTRACT,
  PRIM_BOX,
  PRIM_CAPSULE,
  PRIM_CONE,
  PRIM_CYLINDER,
  PRIM_ELLIPSOID,
  PRIM_SPHERE,
  PRIM_TORUS,
  VolumeWorld,
} from './volume';

const PERIOD = 640;
const CELL = 80;
const MAT_ROCK = 2;
const MAT_PALE = 3;

/** Sandstone strata, bottom to top (sRGB). */
const STRATA = [0xb4553a, 0xc8673f, 0xd9824f, 0xc35f3e, 0xe2a06a, 0xcf7246, 0xe9b98a];
const SAND = 0xe3ae78;
const SAND_DARK = 0xcf9562;
const CAPROCK = 0xefd2a4;
const SCRUB = 0x9a9a5c;
const PALE = 0xf0dcc0;

export class ArchesWorld extends VolumeWorld {
  readonly id = 'arches' as const;
  private readonly strata = new Float32Array(STRATA.length * 3);
  private readonly pal = new Float32Array(15);
  private readonly tint: PeriodicNoise;

  constructor(seed: number) {
    super(seed, PERIOD, CELL);
    this.yMin = -6;
    this.yMax = 74;
    this.groundY = 0;
    this.groundAmp = 1.6;
    this.ledgePitch = 3.6;
    STRATA.forEach((c, i) => hexToLinear(c, this.strata, i * 3));
    [SAND, SAND_DARK, CAPROCK, SCRUB, PALE].forEach((c, i) => hexToLinear(c, this.pal, i * 3));
    this.tint = new PeriodicNoise(seed, PERIOD / 20, 9);

    // The pad sits in the middle of an empty cell, with a big arch straight ahead.
    const sx = CELL / 2, sz = CELL / 2;
    this.spawn.set(sx, 0, sz);
    this.spawnYaw = 0;
    this.flatX = sx;
    this.flatZ = sz;
    this.flatR0 = 14;
    this.flatR1 = 40;
    this.generate(new Rng(seed * 2654435761 + 17), sx, sz);
    this.finalize();
    this.verifyOpenings();
    this.warmUp();
  }

  private generate(rng: Rng, sx: number, sz: number): void {
    const NC = PERIOD / CELL;
    // Showcase: a great arch 60 m ahead of the pad (cell (0, -1), wrapped).
    this.arch(sx, sz - 62, 0, 19, 4.6);
    for (let k = 0; k < NC; k++) {
      for (let i = 0; i < NC; i++) {
        if (i === 0 && (k === 0 || k === NC - 1)) continue; // pad cell and the showcase arch
        const cx = (i + 0.5) * CELL + rng.signed() * 10;
        const cz = (k + 0.5) * CELL + rng.signed() * 10;
        const yaw = rng.next() * Math.PI * 2;
        // Keep the pad's clearing open: features near it are pushed out.
        const near = this.spawnDistance(cx, cz, sx, sz) < 75;
        const r = rng.next();
        if (r < 0.22) this.arch(cx, cz, yaw, 10 + rng.next() * 7, 2.8 + rng.next() * 1.6);
        else if (r < 0.4) this.fin(rng, cx, cz, yaw);
        else if (r < 0.6 && !near) this.butte(rng, cx, cz, yaw);
        else if (r < 0.73) this.naturalBridge(rng, cx, cz, yaw);
        else if (r < 0.84 && !near) this.arcade(rng, cx, cz, yaw);
        else this.hoodoos(rng, cx, cz, near ? 18 : 26);
      }
    }
  }

  /** Horizontal distance between two points, the short way around the wrap. */
  private spawnDistance(x: number, z: number, sx: number, sz: number): number {
    let dx = x - sx, dz = z - sz;
    dx -= Math.round(dx / PERIOD) * PERIOD;
    dz -= Math.round(dz / PERIOD) * PERIOD;
    return Math.hypot(dx, dz);
  }

  /** A free-standing arch: a sunken torus with flared feet. Fly along yaw. */
  private arch(x: number, z: number, yaw: number, R: number, r: number): void {
    const ax = dsin(yaw), az = dcos(yaw);
    const cy = -R * 0.22;
    this.begin({ material: MAT_ROCK, noise: 0.7, join: 5, ledge: 0.3 });
    this.prim(PRIM_TORUS, 0, 0, x, cy, z, ax, 0, az, R, r);
    this.end();
    const inner = R - r;
    const h = cy + inner - 1.2;
    this.openings.push({ x, y: h * 0.5 + 0.6, z, yaw, width: inner * 1.1, height: h * 0.75, kind: 'arch' });
  }

  /** A sandstone fin with one to three windows through it. */
  private fin(rng: Rng, x: number, z: number, yaw: number): void {
    const L = 34 + rng.next() * 20, T = 6 + rng.next() * 3, H = 20 + rng.next() * 14;
    const c = dcos(yaw), s = dsin(yaw); // fin runs along (s, c)
    this.begin({ material: MAT_ROCK, noise: 0.9, join: 5, ledge: 0.4 });
    this.prim(PRIM_BOX, 0, 0, x, H / 2 - 2, z, T / 2, H / 2 + 2, L / 2, 3, c, s, 1, 0);
    const holes = 1 + Math.floor(rng.next() * 3);
    for (let k = 0; k < holes; k++) {
      const along = holes === 1 ? 0 : (k / (holes - 1) - 0.5) * (L - 16);
      const hr = 4.2 + rng.next() * 2.2;
      const hy = Math.min(H - hr - 3.5, hr + 1 + rng.next() * (H * 0.45));
      const hx = x + s * along, hz = z + c * along;
      this.prim(PRIM_SPHERE, OP_SMOOTH_SUBTRACT, 1.5, hx, hy, hz, hr);
      // Fly through perpendicular to the fin.
      this.openings.push({ x: hx, y: hy, z: hz, yaw: yaw + Math.PI / 2, width: hr * 1.1, height: hr * 1.1, kind: 'window' });
    }
    this.end();
  }

  /** A butte with a tunnel through it, a skylight shaft down into the tunnel, and sometimes a roofed slot. */
  private butte(rng: Rng, x: number, z: number, yaw: number): void {
    const R = 17 + rng.next() * 9, H = 30 + rng.next() * 22;
    const fx = dsin(yaw), fz = dcos(yaw);
    this.begin({ material: MAT_ROCK, noise: 1.3, join: 6, ledge: 0.5 });
    this.prim(PRIM_CYLINDER, 0, 0, x, H / 2 - 3, z, R, H / 2 + 3, 5);
    // Tunnel along yaw.
    const tr = 4.2 + rng.next() * 1.4, ty = tr + 1.5 + rng.next() * 4;
    this.prim(PRIM_CAPSULE, OP_SMOOTH_SUBTRACT, 2, x - fx * (R + 8), ty, z - fz * (R + 8), x + fx * (R + 8), ty, z + fz * (R + 8), tr);
    this.openings.push({ x, y: ty, z, yaw, width: tr * 1.1, height: tr * 1.1, kind: 'tunnel' });
    // Skylight: drop in from the top, out through the tunnel.
    if (rng.next() < 0.6) this.prim(PRIM_CAPSULE, OP_SMOOTH_SUBTRACT, 2, x, ty, z, x, H + 10, z, 4.2);
    // A slot canyon across the butte, roofed near the top.
    if (rng.next() < 0.5) {
      const w = 2.8 + rng.next() * 1.2;
      const roof = H - 6 - rng.next() * 6;
      // Runs across the tunnel, along (fz, -fx).
      this.prim(PRIM_BOX, OP_SUBTRACT, 0, x, roof / 2 - 2, z, w, roof / 2 + 2, R + 6, 1.2, -fx, fz, 1, 0);
      this.openings.push({ x: x + fz * (R * 0.55), y: Math.min(roof * 0.45, 14), z: z - fx * (R * 0.55), yaw: yaw + Math.PI / 2, width: w * 1.2, height: Math.min(roof * 0.6, 12), kind: 'slot' });
    }
    this.end();
  }

  /** Twin pillars joined by a stone bridge high up. Fly under it. */
  private naturalBridge(rng: Rng, x: number, z: number, yaw: number): void {
    const D = 22 + rng.next() * 12, pr = 4.5 + rng.next() * 2.5, H = 18 + rng.next() * 14;
    const c = dcos(yaw), s = dsin(yaw); // pillars along (c, -s), fly along (s, c)
    const ax = x - c * D / 2, az = z + s * D / 2, bx = x + c * D / 2, bz = z - s * D / 2;
    this.begin({ material: MAT_ROCK, noise: 1.0, join: 5, ledge: 0.45 });
    this.prim(PRIM_CONE, 0, 0, ax, -2, az, pr + 2.5, pr, H + 2);
    this.prim(PRIM_CONE, OP_SMOOTH_UNION, 2, bx, -2, bz, pr + 2.5, pr, H + 2);
    const br = 3 + rng.next() * 1.2;
    this.prim(PRIM_CAPSULE, OP_SMOOTH_UNION, 4, ax, H - 1, az, bx, H - 1, bz, br);
    this.end();
    const gap = D - 2 * pr - 3;
    const top = H - 1 - br - 1;
    this.openings.push({ x, y: top * 0.5, z, yaw, width: gap * 0.75, height: top * 0.75, kind: 'bridge' });
  }

  /** A long wall with a row of arches cut through its base. */
  private arcade(rng: Rng, x: number, z: number, yaw: number): void {
    const L = 50 + rng.next() * 14, T = 7 + rng.next() * 3, H = 18 + rng.next() * 8;
    const c = dcos(yaw), s = dsin(yaw); // wall along (s, c)
    this.begin({ material: MAT_ROCK, noise: 0.8, join: 4, ledge: 0.45 });
    this.prim(PRIM_BOX, 0, 0, x, H / 2 - 2, z, T / 2, H / 2 + 2, L / 2, 2.5, c, s, 1, 0);
    const n = 3;
    const span = L / n;
    for (let k = 0; k < n; k++) {
      const along = (k - (n - 1) / 2) * span;
      const hx = x + s * along, hz = z + c * along;
      // A round-topped doorway: a capsule straight through the wall at ground level.
      const rr = Math.min(span * 0.34, H * (0.5 + rng.next() * 0.15));
      this.prim(PRIM_CAPSULE, OP_SMOOTH_SUBTRACT, 1.2, hx - c * T, 0, hz + s * T, hx + c * T, 0, hz - s * T, rr);
      this.openings.push({ x: hx, y: rr * 0.45, z: hz, yaw: yaw + Math.PI / 2, width: rr * 1.2, height: rr * 0.7, kind: 'arch' });
    }
    this.end();
  }

  /** A cluster of hoodoos: tapering columns topped with balanced cap rocks. */
  private hoodoos(rng: Rng, x: number, z: number, spread: number): void {
    const n = 4 + Math.floor(rng.next() * 4);
    const pts: number[][] = [];
    for (let tries = 0; pts.length < n && tries < 60; tries++) {
      const a = rng.next() * Math.PI * 2, d = rng.next() * spread;
      const px = x + dcos(a) * d, pz = z + dsin(a) * d;
      if (pts.every(([qx, qz]) => Math.hypot(px - qx, pz - qz) > 9)) pts.push([px, pz]);
    }
    this.begin({ material: MAT_ROCK, noise: 0.5, join: 3, ledge: 0.3 });
    pts.forEach(([px, pz], k) => {
      const h = 9 + rng.next() * 16, r1 = 2.2 + rng.next() * 1.3, r2 = 1.0 + rng.next() * 0.7;
      this.prim(PRIM_CONE, k === 0 ? 0 : OP_SMOOTH_UNION, 1, px, -1, pz, r1, r2, h);
      const cr = 2.6 + rng.next() * 2;
      this.prim(PRIM_ELLIPSOID, OP_SMOOTH_UNION, 1, px, h + 0.4, pz, cr, 1.3 + rng.next() * 0.6, cr * (0.8 + rng.next() * 0.4));
    });
    this.end();
    // A pale boulder or two at the cluster's foot.
    if (rng.next() < 0.6) {
      this.begin({ material: MAT_PALE, noise: 0.4, join: 1.5 });
      this.prim(PRIM_SPHERE, 0, 0, x + rng.signed() * spread, 1, z + rng.signed() * spread, 2.5 + rng.next() * 1.5);
      this.prim(PRIM_SPHERE, OP_SMOOTH_UNION, 1, x + rng.signed() * spread, 0.5, z + rng.signed() * spread, 2 + rng.next());
      this.end();
    }
  }

  // ------------------------------------------------------------ colors

  shade(x: number, y: number, z: number, _nx: number, ny: number, _nz: number, material: number, out: Float32Array, o: number): void {
    const t = this.tint.io;
    t[0] = x / 20;
    t[1] = y / 30;
    t[2] = z / 20;
    this.tint.sample();
    const n = t[3];
    if (material === MAT_GROUND) {
      // Sand, darker in the hollows; scrub here and there.
      const k = Math.min(1, Math.max(0, 0.5 + n * 1.2 + (ny - 0.95) * 4));
      const base = n > 0.38 ? 9 : 0;
      for (let c = 0; c < 3; c++) out[o + c] = this.pal[base + c] * (1 - k * 0.15) + this.pal[3 + c] * k * 0.15;
      return;
    }
    if (material === MAT_PALE) {
      for (let c = 0; c < 3; c++) out[o + c] = this.pal[12 + c];
      return;
    }
    if (ny > 0.9 && y > 6) {
      // Cap rock on top surfaces.
      for (let c = 0; c < 3; c++) out[o + c] = this.pal[6 + c] * (0.92 + n * 0.1);
      return;
    }
    // Strata bands, wobbling a little, with dark desert-varnish streaks on steep walls.
    const band = Math.floor((y + n * 2.5 + 40) / 4.2) % STRATA.length;
    const steep = 1 - Math.min(1, Math.abs(ny) * 2.5);
    t[0] = x / 3;
    t[1] = 0.5;
    t[2] = z / 3;
    this.tint.sample();
    const varnish = 1 - steep * Math.max(0, t[3]) * 0.45;
    const under = ny < -0.3 ? 0.8 : 1;
    for (let c = 0; c < 3; c++) out[o + c] = this.strata[band * 3 + c] * varnish * under;
  }

  partColor(_material: number, out: Float32Array, o: number): void {
    hexToLinear(PALE, out, o);
  }
}
