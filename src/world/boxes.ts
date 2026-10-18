/**
 * Oriented boxes (yaw only) as a signed distance field, plus gate frames
 * built from them. Shared by the sandbox and by course overlays (race gates,
 * pylons) on any world. Rendering and collision read the same BoxDef list.
 */
import type { Vec3 } from '../sim';

export type BoxKind = 'pillar' | 'building' | 'gate' | 'pylon';

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
  /**
   * Rotation about +Y. The opening faces local ±Z; flying "forward" through
   * it means moving along (sin yaw, 0, cos yaw).
   */
  yaw: number;
  width: number;
  height: number;
}

const STRIDE = 9; // cx cy cz hx hy hz cos sin boundRadius

export class BoxSet {
  readonly boxes: BoxDef[];
  private readonly data: Float64Array;
  /** In/out for nearest(): set io[0] to the current best distance before calling. */
  readonly io = new Float64Array(1);

  constructor(boxes: BoxDef[]) {
    this.boxes = boxes;
    this.data = new Float64Array(boxes.length * STRIDE);
    boxes.forEach((b, i) => {
      this.data.set([b.cx, b.cy, b.cz, b.hx, b.hy, b.hz, Math.cos(b.yaw), Math.sin(b.yaw), Math.hypot(b.hx, b.hy, b.hz)], i * STRIDE);
    });
  }

  /**
   * io[0] = min(io[0], signed distance from p to the nearest box). Results
   * go through io, not arguments/returns: doubles crossing a non-inlined
   * call allocate in V8 (see DEVLOG).
   */
  nearest(p: Vec3): void {
    let best = this.io[0];
    const d = this.data;
    const px = p.x, py = p.y, pz = p.z;
    for (let o = 0; o < d.length; o += STRIDE) {
      const dx = px - d[o], dy = py - d[o + 1], dz = pz - d[o + 2];
      // Cheap reject: bounding sphere can't beat the current best.
      const cd = Math.sqrt(dx * dx + dy * dy + dz * dz) - d[o + 8];
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
    this.io[0] = best;
  }
}

/**
 * The four bars of a gate frame: two posts standing on `footY`, a top bar
 * and a bottom bar, `bar` thick (half thickness).
 */
export function gateFrame(g: GateDef, footY: number, color: number, bar = 0.08): BoxDef[] {
  const out: BoxDef[] = [];
  const top = g.y + g.height / 2;
  const bottom = g.y - g.height / 2;
  const c = Math.cos(g.yaw), s = Math.sin(g.yaw);
  const part = (lx: number, ly: number, hx: number, hy: number) => {
    out.push({ cx: g.x + c * lx, cy: ly, cz: g.z - s * lx, hx, hy, hz: bar, yaw: g.yaw, kind: 'gate', color });
  };
  const post = (top + bar - footY) / 2;
  part(-(g.width / 2 + bar), footY + post, bar, post);
  part(g.width / 2 + bar, footY + post, bar, post);
  part(0, top + bar / 2, g.width / 2, bar / 2);
  part(0, bottom - bar / 2, g.width / 2, bar / 2);
  return out;
}
