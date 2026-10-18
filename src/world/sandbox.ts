/**
 * M2 sandbox: flat ground plus a seeded set of boxes (pillars, buildings and
 * a loop of gates). Rendering and collision both read the same box list, so
 * what you see is what you hit.
 */
import { Rng, Vec3, type Hit } from '../sim';
import { BoxSet, gateFrame, type BoxDef, type GateDef } from './boxes';
import type { GameWorld } from './recipes';

export type { BoxDef, BoxKind, GateDef } from './boxes';

export class SandboxWorld implements GameWorld {
  readonly id = 'sandbox' as const;
  readonly spawnYaw = 0;
  readonly groundY = 0;
  readonly boxes: BoxDef[];
  readonly gates: GateDef[];
  readonly spawn = new Vec3(0, 0, 0);
  private readonly set: BoxSet;
  private readonly tmp = new Vec3();
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };

  constructor(
    boxes: BoxDef[],
    gates: GateDef[],
    readonly seed = 1,
  ) {
    this.boxes = boxes;
    this.gates = gates;
    this.set = new BoxSet(boxes);
  }

  distance(p: Vec3): number {
    const io = this.set.io;
    io[0] = p.y - this.groundY;
    this.set.nearest(p);
    return io[0];
  }

  groundHeight(): number {
    return this.groundY;
  }

  /** Gradient of the distance field by central differences. */
  normal(p: Vec3, out: Vec3): Vec3 {
    const e = 1e-3;
    const t = this.tmp;
    t.set(p.x + e, p.y, p.z);
    const xp = this.distance(t);
    t.x = p.x - e;
    const xm = this.distance(t);
    t.set(p.x, p.y + e, p.z);
    const yp = this.distance(t);
    t.y = p.y - e;
    const ym = this.distance(t);
    t.set(p.x, p.y, p.z + e);
    const zp = this.distance(t);
    t.z = p.z - e;
    const zm = this.distance(t);
    out.set(xp - xm, yp - ym, zp - zm);
    const l = out.length();
    return l > 1e-9 ? out.scale(1 / l) : out.set(0, 1, 0);
  }

  /** Sphere-traced raycast. Returns a shared Hit (overwritten by the next call). */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    let t = 0;
    const p = this.hit.point;
    for (let i = 0; i < 160 && t <= maxDist; i++) {
      p.copy(origin).addScaled(dir, t);
      const d = this.distance(p);
      if (d < 1e-3) {
        this.hit.distance = t;
        this.normal(p, this.hit.normal);
        return this.hit;
      }
      t += d;
    }
    return null;
  }
}

const GATE_COLORS = [0xff5a36, 0xffc531, 0x2fd3c6, 0xb46cff];
const PILLAR_COLORS = [0xf0dcb8, 0xe3a98f, 0xb2cfe3, 0xcdbbe8, 0xf4e8cf, 0xa9d6c0];

/** Deterministic sandbox layout from a seed. */
export function buildSandbox(seed = 1): SandboxWorld {
  const rng = new Rng(seed);
  const boxes: BoxDef[] = [];
  const gates: GateDef[] = [];

  // Gate loop: first gate straight ahead of spawn (facing -Z).
  const center = { x: 35, z: -30 };
  const R = 35;
  const count = 8;
  for (let i = 0; i < count; i++) {
    const th = -Math.PI / 2 + (i * 2 * Math.PI) / count;
    const gx = center.x + R * Math.sin(th);
    const gz = center.z + R * Math.cos(th);
    const tx = Math.cos(th), tz = -Math.sin(th); // loop tangent
    const yaw = Math.atan2(tx, tz);
    const color = GATE_COLORS[i % GATE_COLORS.length];
    const w = 1.8, h = 1.8, bottom = i % 2 ? 0.6 : 1.4;
    const gate = { x: gx, y: bottom + h / 2, z: gz, yaw, width: w, height: h };
    gates.push(gate);
    boxes.push(...gateFrame(gate, 0, color));
  }

  const clear = (x: number, z: number, r: number) => {
    if (Math.hypot(x, z) < 12 + r) return false; // spawn
    const ring = Math.hypot(x - center.x, z - center.z);
    if (Math.abs(ring - R) < 6 + r) return false; // gate loop
    return boxes.every((b) => b.kind === 'gate' || Math.hypot(b.cx - x, b.cz - z) > Math.max(b.hx, b.hz) + r + 4);
  };

  // Pillars: freestyle obstacles to dive and orbit.
  for (let n = 0, tries = 0; n < 45 && tries < 2000; tries++) {
    const a = rng.next() * Math.PI * 2, d = 15 + rng.next() * 140;
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    const hx = 0.4 + rng.next() * 1.4, hz = 0.4 + rng.next() * 1.4, hy = 1.5 + rng.next() * 7;
    if (!clear(x, z, Math.max(hx, hz))) continue;
    const color = PILLAR_COLORS[Math.floor(rng.next() * PILLAR_COLORS.length)];
    boxes.push({ cx: x, cy: hy, cz: z, hx, hy, hz, yaw: rng.next() * Math.PI, kind: 'pillar', color });
    n++;
  }

  // Buildings: big silhouettes on the horizon.
  for (let n = 0, tries = 0; n < 14 && tries < 2000; tries++) {
    const a = rng.next() * Math.PI * 2, d = 110 + rng.next() * 220;
    const x = Math.sin(a) * d, z = Math.cos(a) * d;
    const hx = 6 + rng.next() * 12, hz = 6 + rng.next() * 12, hy = 8 + rng.next() * 30;
    if (!clear(x, z, Math.max(hx, hz))) continue;
    const color = [0x8ea0c8, 0xa898c6, 0x9bb8c8, 0xbca9a4][n % 4];
    boxes.push({ cx: x, cy: hy, cz: z, hx, hy, hz, yaw: rng.next() * Math.PI, kind: 'building', color });
    n++;
  }

  return new SandboxWorld(boxes, gates, seed);
}
