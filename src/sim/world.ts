/**
 * The contract between the physics and any world. The sim only ever asks
 * these questions, so heightfields, cities, floating islands or impossible
 * geometry all work without touching the physics module.
 */
import { Vec3 } from './math';

export interface Hit {
  distance: number;
  point: Vec3;
  normal: Vec3;
}

export interface WorldQuery {
  /** Signed distance to the nearest solid surface, m (negative = inside). */
  distance(p: Vec3): number;
  /** Surface normal at/near p, written into out. */
  normal(p: Vec3, out: Vec3): Vec3;
  /** Optional raycast (line of sight, gates, camera collision). dir must be unit length. */
  raycast?(origin: Vec3, dir: Vec3, maxDist: number): Hit | null;
}

/** Infinite horizontal plane at height `y`. */
export class FlatGround implements WorldQuery {
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3(0, 1, 0) };

  constructor(public y = 0) {}

  distance(p: Vec3): number {
    return p.y - this.y;
  }

  normal(_p: Vec3, out: Vec3): Vec3 {
    return out.set(0, 1, 0);
  }

  /** Returns a shared Hit object (overwritten on the next call). */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    if (dir.y >= 0) return null;
    const t = (this.y - origin.y) / dir.y;
    if (t < 0 || t > maxDist) return null;
    this.hit.distance = t;
    this.hit.point.copy(origin).addScaled(dir, t);
    return this.hit;
  }
}

/** No collision at all (free-space tests). */
export const EMPTY_WORLD: WorldQuery = {
  distance: () => Infinity,
  normal: (_p, out) => out.set(0, 1, 0),
};
