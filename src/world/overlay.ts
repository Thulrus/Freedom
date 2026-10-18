/**
 * A base world plus extra solid boxes (race gates, pylons). Game modes add
 * their obstacles this way, so any world can host any course and the physics
 * still only sees one WorldQuery.
 */
import { Vec3, type Hit } from '../sim';
import { BoxSet, type BoxDef } from './boxes';
import type { GameWorld } from './recipes';

export class OverlayWorld implements GameWorld {
  readonly set: BoxSet;
  private readonly tmp = new Vec3();
  private readonly hit: Hit = { distance: 0, point: new Vec3(), normal: new Vec3() };

  constructor(
    readonly base: GameWorld,
    boxes: BoxDef[],
  ) {
    this.set = new BoxSet(boxes);
  }

  get id() {
    return this.base.id;
  }
  get seed() {
    return this.base.seed;
  }
  get spawn() {
    return this.base.spawn;
  }
  get spawnYaw() {
    return this.base.spawnYaw;
  }

  groundHeight(x: number, z: number): number {
    return this.base.groundHeight(x, z);
  }

  floorBelow(x: number, y: number, z: number): number {
    return this.base.floorBelow ? this.base.floorBelow(x, y, z) : this.base.groundHeight(x, z);
  }

  distance(p: Vec3): number {
    const io = this.set.io;
    io[0] = this.base.distance(p);
    this.set.nearest(p);
    return io[0];
  }

  normal(p: Vec3, out: Vec3): Vec3 {
    // Whichever surface is nearer decides the normal.
    const io = this.set.io;
    io[0] = Infinity;
    this.set.nearest(p);
    const box = io[0];
    if (!(box < this.base.distance(p))) return this.base.normal(p, out);
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

  /** Sphere trace (steps capped at 4 m, like the terrain's). Returns a shared Hit. */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): Hit | null {
    let t = 0;
    const p = this.hit.point;
    for (let i = 0; i < 1024 && t <= maxDist; i++) {
      p.copy(origin).addScaled(dir, t);
      const d = this.distance(p);
      if (d < 1e-3) {
        this.hit.distance = t;
        this.normal(p, this.hit.normal);
        return this.hit;
      }
      t += d > 4 ? 4 : d < 0.02 ? 0.02 : d;
    }
    return null;
  }
}
