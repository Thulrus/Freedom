/**
 * Course layouts fitted to a world around its launch pad. Deterministic for
 * a world + seed. Every placement is checked against the world's own
 * distance field, so gates never sit inside a tree, rock or hillside.
 */
import { Rng, Vec3 } from '../sim';
import { gateFrame, type BoxDef } from '../world/boxes';
import type { GameWorld } from '../world/recipes';
import { SandboxWorld } from '../world/sandbox';
import type { Checkpoint, Layout, Pylon } from './types';

export const GATE_COLORS = [0xff5a36, 0xffc531, 0x2fd3c6, 0xb46cff];
const PYLON_RIGHT = 0xff7a3d;
const PYLON_LEFT = 0x4aa3ff;

const tmp = new Vec3();
const free = (w: GameWorld, x: number, y: number, z: number) => w.distance(tmp.set(x, y, z));

/**
 * A frame around the pad, rotated by heading psi (0 = facing -Z like the
 * quad at spawn): u is metres to the right, v metres forward.
 */
class Frame {
  readonly fx: number;
  readonly fz: number;
  readonly rx: number;
  readonly rz: number;
  constructor(
    readonly world: GameWorld,
    readonly psi: number,
  ) {
    this.fx = -Math.sin(psi);
    this.fz = -Math.cos(psi);
    this.rx = Math.cos(psi);
    this.rz = -Math.sin(psi);
  }
  x(u: number, v: number): number {
    return this.world.spawn.x + u * this.rx + v * this.fx;
  }
  z(u: number, v: number): number {
    return this.world.spawn.z + u * this.rz + v * this.fz;
  }
  ground(u: number, v: number): number {
    return this.world.groundHeight(this.x(u, v), this.z(u, v));
  }
  /** Checkpoint yaw for flying along (du, dv) in this frame. */
  yaw(du: number, dv: number): number {
    return Math.atan2(du * this.rx + dv * this.fx, du * this.rz + dv * this.fz);
  }
  /** Is the air clear (by `margin` m) at heights `hs` above ground over the (u, v) box? */
  clear(u0: number, u1: number, v0: number, v1: number, step: number, hs: number[], margin: number): boolean {
    for (let v = v0; v <= v1; v += step) {
      for (let u = u0; u <= u1; u += step) {
        const x = this.x(u, v), z = this.z(u, v), g = this.world.groundHeight(x, z);
        for (const hgt of hs) if (free(this.world, x, g + hgt, z) < margin) return false;
      }
    }
    return true;
  }
}

/** First heading (straight ahead, then alternating ±20° steps) whose area passes `test`. */
function pickFrame(world: GameWorld, test: (f: Frame) => boolean): Frame {
  for (let k = 0; k < 18; k++) {
    const step = Math.ceil(k / 2) * (k % 2 ? 1 : -1);
    const f = new Frame(world, (step * 20 * Math.PI) / 180);
    if (test(f)) return f;
  }
  return new Frame(world, 0);
}

function pylon(f: Frame, u: number, v: number, height: number, color: number): Pylon {
  return { x: f.x(u, v), y: f.ground(u, v), z: f.z(u, v), height, color };
}

function pylonBoxes(pylons: Pylon[]): BoxDef[] {
  return pylons.map((p) => ({ cx: p.x, cy: p.y - 0.5 + (p.height + 0.5) / 2, cz: p.z, hx: 0.15, hy: (p.height + 0.5) / 2, hz: 0.15, yaw: 0, kind: 'pylon' as const, color: p.color }));
}

/** A window of the given size standing on the ground at (u, v), flown through along (du, dv). */
function window(f: Frame, u: number, v: number, du: number, dv: number, width: number, height: number): Checkpoint {
  return { x: f.x(u, v), y: f.ground(u, v) + height / 2, z: f.z(u, v), yaw: f.yaw(du, dv), width, height, style: 'window' };
}

/** Frame boxes for every 'gate' checkpoint, posts standing on the lower of their two feet. */
function gateBoxes(world: GameWorld, cps: Checkpoint[]): BoxDef[] {
  const out: BoxDef[] = [];
  cps.forEach((c, i) => {
    if (c.style !== 'gate') return;
    const lx = Math.cos(c.yaw) * (c.width / 2 + 0.1), lz = -Math.sin(c.yaw) * (c.width / 2 + 0.1);
    const foot = Math.min(world.groundHeight(c.x - lx, c.z - lz), world.groundHeight(c.x + lx, c.z + lz)) - 0.3;
    out.push(...gateFrame(c, foot, GATE_COLORS[i % GATE_COLORS.length]));
  });
  return out;
}

/** Is a gate of this size at (x, z) clear of terrain and props: opening, approach and posts? */
function gateClear(world: GameWorld, x: number, z: number, yaw: number, bottom: number, w: number, h: number): boolean {
  const g = world.groundHeight(x, z);
  const cy = g + bottom + h / 2;
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = fz, rz = -fx;
  for (const [a, b] of [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (free(world, x + rx * a * (w / 2 - 0.2), cy + b * (h / 2 - 0.2), z + rz * a * (w / 2 - 0.2)) < 0.5) return false;
  }
  for (const k of [-6, -3, 3, 6]) if (free(world, x + fx * k, cy, z + fz * k) < 1) return false;
  for (const side of [-1, 1]) {
    const px = x + rx * side * (w / 2 + 0.1), pz = z + rz * side * (w / 2 + 0.1);
    const pg = world.groundHeight(px, pz);
    for (let y = pg + 0.4; y < cy + h / 2; y += 0.8) if (free(world, px, y, pz) < 0.3) return false;
  }
  return true;
}

/** Gate race: a loop of 8 gates curving right from straight ahead of the pad. */
export function raceLayout(world: GameWorld): Layout {
  if (world instanceof SandboxWorld) {
    // The sandbox already has a gate loop: fly it from gate 1 (straight ahead) the other way round.
    const gs = world.gates;
    const order = [0, ...gs.map((_, i) => gs.length - 1 - i).slice(0, gs.length - 1)];
    const checkpoints = order.map((i) => ({ ...gs[i], yaw: gs[i].yaw + Math.PI, style: 'existing' as const }));
    return { checkpoints, pylons: [], zone: null, boxes: [] };
  }
  const rng = new Rng(world.seed * 7919 + 101);
  const f = new Frame(world, 0);
  const N = 8;
  const Rx = 65 + rng.next() * 25, Rz = 55 + rng.next() * 20;
  const w = 2.0, h = 1.8;
  const pts: { u: number; v: number; bottom: number }[] = [];
  for (let k = 0; k < N; k++) {
    const phi = Math.PI - (k * 2 * Math.PI) / N;
    const jitter = k === 0 ? 1 : 0.85 + rng.next() * 0.3;
    const bottom = k === 0 ? 1 : rng.next() < 0.3 ? 3 + rng.next() * 3 : 0.8 + rng.next() * 0.8;
    // Try the nominal spot first, then nearby radii until the gate is clear.
    let best = { u: 0, v: 0 };
    for (const s of [1, 0.92, 1.08, 0.84, 1.16, 0.96, 1.04, 0.88, 1.12, 0.8, 1.2]) {
      const r = jitter * s;
      const u = Rx + Rx * Math.cos(phi) * r;
      const v = 30 + Rz * Math.sin(phi) * r;
      best = { u, v };
      const tu = Math.sin(phi), tv = -Math.cos(phi); // travel direction (decreasing phi)
      if (gateClear(world, f.x(u, v), f.z(u, v), f.yaw(tu * Rx, tv * Rz), bottom, w, h)) break;
    }
    pts.push({ ...best, bottom });
  }
  const checkpoints: Checkpoint[] = pts.map((p, k) => {
    const a = pts[(k + N - 1) % N], b = pts[(k + 1) % N];
    const x = f.x(p.u, p.v), z = f.z(p.u, p.v);
    return { x, y: world.groundHeight(x, z) + p.bottom + h / 2, z, yaw: f.yaw(b.u - a.u, b.v - a.v), width: w, height: h, style: 'gate' };
  });
  // Gate 1 faces straight away from the pad so the run starts clean.
  checkpoints[0].yaw = f.yaw(0, 1);
  return { checkpoints, pylons: [], zone: null, boxes: gateBoxes(world, checkpoints) };
}

/** Slalom: start line, six pylons to pass on alternating sides, finish line. */
export function slalomLayout(world: GameWorld): Layout {
  const f = pickFrame(world, (fr) => fr.clear(-10, 10, 12, 132, 4, [1.5, 4], 1.2));
  const checkpoints: Checkpoint[] = [window(f, 0, 20, 0, 1, 14, 8)];
  const pylons: Pylon[] = [];
  for (let k = 0; k < 6; k++) {
    const v = 35 + 15 * k, side = k % 2 ? -1 : 1;
    pylons.push(pylon(f, 0, v, 7, side > 0 ? PYLON_RIGHT : PYLON_LEFT));
    checkpoints.push(window(f, side * 5, v, 0, 1, 8, 8));
  }
  checkpoints.push(window(f, 0, 125, 0, 1, 14, 8));
  return { checkpoints, pylons, zone: null, boxes: pylonBoxes(pylons) };
}

/** Figure-8 around two pylons, 30 m apart, starting through the middle. */
export function figure8Layout(world: GameWorld): Layout {
  const f = pickFrame(world, (fr) => fr.clear(-32, 32, 14, 46, 4, [1.5, 4], 1.5));
  const pylons = [pylon(f, -15, 30, 8, PYLON_LEFT), pylon(f, 15, 30, 8, PYLON_RIGHT)];
  const checkpoints: Checkpoint[] = [
    window(f, 0, 30, 1, 0, 10, 8), // through the middle, heading right
    window(f, 23, 30, 0, -1, 10, 8), // round the far side of the right pylon
    window(f, 0, 30, -1, 0, 10, 8), // back through the middle, heading left
    window(f, -23, 30, 0, 1, 10, 8), // round the far side of the left pylon
  ];
  return { checkpoints, pylons, zone: null, boxes: pylonBoxes(pylons) };
}

/** Hover box: a 2 m cube 3 m up, 7 m ahead of the pad. */
export function hoverLayout(world: GameWorld): Layout {
  const f = pickFrame(world, (fr) => fr.clear(-4, 4, 3, 11, 2, [1, 3, 5], 1.5));
  return { checkpoints: [], pylons: [], zone: { x: f.x(0, 7), y: f.ground(0, 7) + 3, z: f.z(0, 7), half: 1 }, boxes: [] };
}

/** Power loop: one tall gate 25 m ahead, with room above and behind it. */
export function powerLoopLayout(world: GameWorld): Layout {
  const f = pickFrame(world, (fr) => fr.clear(-6, 6, 10, 44, 4, [1.5, 5, 10, 15], 2));
  const w = 2.6, h = 2.4, bottom = 1.2;
  const x = f.x(0, 25), z = f.z(0, 25);
  const checkpoints: Checkpoint[] = [{ x, y: world.groundHeight(x, z) + bottom + h / 2, z, yaw: f.yaw(0, 1), width: w, height: h, style: 'gate' }];
  return { checkpoints, pylons: [], zone: null, boxes: gateBoxes(world, checkpoints) };
}

export const EMPTY_LAYOUT: Layout = { checkpoints: [], pylons: [], zone: null, boxes: [] };
