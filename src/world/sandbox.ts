/**
 * M2 sandbox: flat ground plus a seeded set of boxes (pillars, buildings and
 * a loop of gates). Rendering and collision both read the same box list, so
 * what you see is what you hit.
 */
import { Rng, Vec3, type Hit, type WorldQuery } from '../sim';

export type BoxKind = 'pillar' | 'building' | 'gate';

export interface BoxDef {
  /** Center, m. */
  cx: number;
  cy: number;
  cz: number;
  /** Half extents, m. */
  hx: number;
  hy: number;
  hz: number;
  /** Rotation about +Y, radians. */
  yaw: number;
  kind: BoxKind;
  /** Display color, 0xRRGGBB. */
  color: number;
}

export interface GateDef {
  /** Center of the opening, m. */
  x: number;
  y: number;
  z: number;
  /** Rotation about +Y; the opening faces local +/-Z. */
  yaw: number;
  width: number;
  height: number;
}

const STRIDE = 9; // cx cy cz hx hy hz cos sin boundRadius

export class SandboxWorld implements WorldQuery {
  readonly groundY = 0;
  readonly boxes: BoxDef[];
  readonly gates: GateDef[];
  readonly spawn = new Vec3(0, 0, 0);
  private readonly data: Float64Array;
  private readonly tmp = new Vec3();
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };

  constructor(boxes: BoxDef[], gates: GateDef[]) {
    this.boxes = boxes;
    this.gates = gates;
    this.data = new Float64Array(boxes.length * STRIDE);
    boxes.forEach((b, i) => {
      const o = i * STRIDE;
      this.data.set([b.cx, b.cy, b.cz, b.hx, b.hy, b.hz, Math.cos(b.yaw), Math.sin(b.yaw), Math.hypot(b.hx, b.hy, b.hz)], o);
    });
  }

  distance(p: Vec3): number {
    let best = p.y - this.groundY;
    const d = this.data;
    const px = p.x, py = p.y, pz = p.z;
    for (let o = 0; o < d.length; o += STRIDE) {
      const dx = px - d[o], dy = py - d[o + 1], dz = pz - d[o + 2];
      // Cheap reject: bounding sphere can't beat the current best.
      const r = d[o + 8];
      const cd = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
      if (cd >= best) continue;
      // Into box space (inverse yaw rotation).
      const c = d[o + 6], s = d[o + 7];
      const lx = c * dx - s * dz;
      const lz = s * dx + c * dz;
      const qx = Math.abs(lx) - d[o + 3];
      const qy = Math.abs(dy) - d[o + 4];
      const qz = Math.abs(lz) - d[o + 5];
      const ox = qx > 0 ? qx : 0, oy = qy > 0 ? qy : 0, oz = qz > 0 ? qz : 0;
      const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
      const m = qx > qy ? (qx > qz ? qx : qz) : qy > qz ? qy : qz;
      const dist = outside + (m < 0 ? m : 0);
      if (dist < best) best = dist;
    }
    return best;
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
    const w = 1.8, h = 1.8, bottom = i % 2 ? 0.6 : 1.4, bar = 0.08;
    gates.push({ x: gx, y: bottom + h / 2, z: gz, yaw, width: w, height: h });
    const top = bottom + h;
    const part = (lx: number, ly: number, hx: number, hy: number) => {
      const c = Math.cos(yaw), s = Math.sin(yaw);
      boxes.push({ cx: gx + c * lx, cy: ly, cz: gz - s * lx, hx, hy, hz: bar, yaw, kind: 'gate', color });
    };
    part(-(w / 2 + bar), (top + bar) / 2, bar, (top + bar) / 2); // left post, from ground
    part(w / 2 + bar, (top + bar) / 2, bar, (top + bar) / 2); // right post
    part(0, top + bar / 2, w / 2, bar / 2); // top bar
    part(0, bottom - bar / 2, w / 2, bar / 2); // bottom bar
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

  return new SandboxWorld(boxes, gates);
}
