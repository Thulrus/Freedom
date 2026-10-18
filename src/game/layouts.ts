/**
 * Course layouts fitted to a world around its launch pad. Deterministic for
 * a world + seed. Every placement is checked against the world's own
 * distance field, so gates never sit inside a tree, rock or hillside.
 */
import { Rng, Vec3 } from '../sim';
import { gateFrame, type BoxDef } from '../world/boxes';
import type { GameWorld } from '../world/recipes';
import { CityWorld, PITCH } from '../world/city';
import { SandboxWorld } from '../world/sandbox';
import { VolumeWorld, type Opening } from '../world/volume';
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

/**
 * City race: a street circuit around a 4 × 2 block rectangle, starting
 * straight up the street from the pad and turning right at each corner.
 * Gates sit mid-block (streets are always open; skybridges only cross alleys).
 */
function cityRaceLayout(world: CityWorld): Layout {
  const rng = new Rng(world.seed * 104729 + 7);
  const P = PITCH;
  // [x, z, travel dx, travel dz]
  const route: [number, number, number, number][] = [
    [0, -P / 2, 0, -1],
    [0, -1.5 * P, 0, -1],
    [0, -2.5 * P, 0, -1],
    [0, -3.5 * P, 0, -1],
    [P / 2, -4 * P, 1, 0],
    [1.5 * P, -4 * P, 1, 0],
    [2 * P, -2.5 * P, 0, 1],
    [2 * P, -1 * P, 0, 1],
    [1.5 * P, 0, -1, 0],
  ];
  const w = 2.0, h = 1.8;
  const checkpoints: Checkpoint[] = route.map(([x, z, dx, dz], k) => {
    const high = k > 0 && rng.next() < 0.25;
    const bottom = k === 0 ? 1 : high ? 6 + rng.next() * 8 : 0.8 + rng.next() * 1.6;
    // Shift sideways within the road (±3 m) so the line isn't trivial.
    const side = k === 0 ? 0 : (rng.next() * 2 - 1) * 3;
    const gx = x + dz * side, gz = z - dx * side;
    return { x: gx, y: world.groundHeight(gx, gz) + bottom + h / 2, z: gz, yaw: Math.atan2(dx, dz), width: w, height: h, style: 'gate' };
  });
  return { checkpoints, pylons: [], zone: null, boxes: gateBoxes(world, checkpoints) };
}

/**
 * Natural race for volume worlds: a loop through the world's own arches,
 * windows, tunnels, rings and under its bridges. The rock is the gate; each
 * checkpoint is a virtual window that fits inside its opening.
 *
 * The loop goes around a centre near the pad: the ring around it is cut into
 * 8 sectors, and each sector contributes the opening that is best lined up
 * with the direction of travel (the tangent), at a comfortable radius.
 * Ordered by angle, they close into a circuit by construction. Several
 * centres and both directions are tried; the best loop wins.
 */
function featureRaceLayout(world: VolumeWorld): Layout | null {
  const P = world.period, sp = world.spawn;
  const SECTORS = 8;
  type Cand = { o: Opening; x: number; y: number; z: number };
  const cands: Cand[] = [];
  for (const o of world.openings) {
    for (const sx of [-P, 0, P]) {
      for (const sz of [-P, 0, P]) {
        const x = o.x + sx, z = o.z + sz;
        if (Math.hypot(x - sp.x, z - sp.z) < 320) cands.push({ o, x, y: o.y, z });
      }
    }
  }
  const fx0 = -Math.sin(world.spawnYaw), fz0 = -Math.cos(world.spawnYaw);
  let best: { score: number; route: { c: Cand; yaw: number }[] } | null = null;
  for (const dist of [70, 100, 130]) {
    for (let k = 0; k < 12; k++) {
      const turn = (Math.ceil(k / 2) * (k % 2 ? 1 : -1) * Math.PI) / 6;
      const cs = Math.cos(turn), sn = Math.sin(turn);
      const cx = sp.x + (fx0 * cs - fz0 * sn) * dist, cz = sp.z + (fx0 * sn + fz0 * cs) * dist;
      for (const dir of [1, -1]) {
        const pick: ({ c: Cand; yaw: number; score: number; angle: number } | null)[] = Array(SECTORS).fill(null);
        for (const c of cands) {
          const rx = c.x - cx, rz = c.z - cz, r = Math.hypot(rx, rz);
          if (r < 35 || r > 160) continue;
          const angle = Math.atan2(rz, rx);
          // Travel direction around the centre (counter-clockwise for dir = 1, seen from above).
          const tx = (-rz / r) * dir, tz = (rx / r) * dir;
          let ox = Math.sin(c.o.yaw), oz = Math.cos(c.o.yaw), yaw = c.o.yaw;
          if (ox * tx + oz * tz < 0) {
            ox = -ox;
            oz = -oz;
            yaw += Math.PI;
          }
          const align = ox * tx + oz * tz;
          if (align < 0.45) continue;
          const score = align * 2 - Math.abs(r - 80) / 60 + Math.min(c.o.width, 8) / 16;
          const sector = Math.floor(((angle / (2 * Math.PI) + 1) % 1) * SECTORS) % SECTORS;
          if (!pick[sector] || score > pick[sector]!.score) pick[sector] = { c, yaw, score, angle };
        }
        const got = pick.filter((p): p is NonNullable<typeof p> => !!p);
        if (got.length < 5) continue;
        // In travel order around the centre.
        got.sort((a, b) => (a.angle - b.angle) * dir);
        // Legs: short is good, steep climbs are not; a missing sector leaves a long leg.
        let legs = 0;
        for (let i = 0; i < got.length; i++) {
          const a = got[i].c, b = got[(i + 1) % got.length].c;
          const h = Math.hypot(a.x - b.x, a.z - b.z);
          legs += Math.max(0, h - 110) / 30 + Math.max(0, Math.abs(a.y - b.y) - 0.5 * h) / 10;
        }
        // Start with the one the pilot reaches first: nearest the pad among those ahead of it...
        let first = -1, firstD = Infinity;
        got.forEach((g, i) => {
          const vx = g.c.x - sp.x, vz = g.c.z - sp.z;
          const ahead = vx * fx0 + vz * fz0;
          const d = Math.hypot(vx, vz, g.c.y - sp.y);
          // ...and crossed going away from the pad, not back towards it.
          const away = Math.sin(g.yaw) * vx + Math.cos(g.yaw) * vz;
          if (ahead > 0.5 * d && away > 0.3 * d && d < firstD) {
            firstD = d;
            first = i;
          }
        });
        const start = first < 0 ? -6 : -Math.max(0, firstD - 70) / 25;
        const score = got.reduce((s, g) => s + g.score, 0) + got.length * 1.5 - legs + start;
        if (!best || score > best.score) {
          const f = Math.max(0, first);
          best = { score, route: [...got.slice(f), ...got.slice(0, f)] };
        }
      }
    }
  }
  if (!best) return null;
  const checkpoints: Checkpoint[] = best.route.map(({ c, yaw }) => ({ x: c.x, y: c.y, z: c.z, yaw, width: c.o.width, height: c.o.height, style: 'window' }));
  return { checkpoints, pylons: [], zone: null, boxes: [] };
}

/** Gate race: a loop of 8 gates curving right from straight ahead of the pad (a street circuit in cities, natural openings in volume worlds). */
export function raceLayout(world: GameWorld): Layout {
  if (world instanceof CityWorld) return cityRaceLayout(world);
  if (world instanceof VolumeWorld) {
    const l = featureRaceLayout(world);
    if (l) return l;
  }
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
