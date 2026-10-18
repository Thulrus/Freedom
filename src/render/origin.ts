/**
 * Floating origin. GPUs work in float32, which only resolves ~2 mm at 20 km
 * from the origin: far from spawn, vertices and the camera would jitter.
 * So everything is drawn relative to (x, z), and that point jumps to the
 * camera whenever the camera gets more than `threshold` metres away. Jumps
 * are snapped to the chunk grid, so chunk offsets stay exact integers.
 *
 * Physics is unaffected: it keeps world coordinates in doubles. Height (y)
 * is never rebased; altitudes stay small.
 */
export class FloatingOrigin {
  x = 0;
  z = 0;
  rebases = 0;

  constructor(
    readonly threshold = 1024,
    readonly snap = 128,
  ) {}

  /** Follow the camera (world coordinates). Returns true when the origin moved. */
  update(x: number, z: number): boolean {
    if (Math.abs(x - this.x) <= this.threshold && Math.abs(z - this.z) <= this.threshold) return false;
    this.x = Math.round(x / this.snap) * this.snap;
    this.z = Math.round(z / this.snap) * this.snap;
    this.rebases++;
    return true;
  }

  reset(): void {
    this.x = 0;
    this.z = 0;
  }
}
