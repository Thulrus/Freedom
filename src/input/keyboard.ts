/**
 * Keyboard "virtual sticks" for desktop development. Held keys push a stick
 * toward full deflection at a fixed slew rate; releasing returns it to center.
 * Throttle is non-centering (W/S nudge it up/down).
 *
 *   Arrows: pitch / roll    A / D: yaw    W / S: throttle up / down
 */
const STICK_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS', 'KeyA', 'KeyD']);

export class KeyboardInput {
  roll = 0;
  pitch = 0;
  yaw = 0;
  throttle = 0;
  /** True while any stick key is held. */
  active = false;
  private readonly down = new Set<string>();

  constructor(
    public stickSpeed = 5,
    public throttleSpeed = 0.6,
  ) {}

  /** Feed key events. Returns true if the key is a stick key (caller may preventDefault). */
  key(code: string, pressed: boolean): boolean {
    if (!STICK_KEYS.has(code)) return false;
    if (pressed) this.down.add(code);
    else this.down.delete(code);
    return true;
  }

  /** Release everything (window blur, focus loss). */
  releaseAll(): void {
    this.down.clear();
  }

  /** Advance the virtual sticks by dt seconds. Call once per physics tick. */
  update(dt: number): void {
    const d = this.down;
    this.roll = slew(this.roll, (d.has('ArrowRight') ? 1 : 0) - (d.has('ArrowLeft') ? 1 : 0), this.stickSpeed * dt);
    this.pitch = slew(this.pitch, (d.has('ArrowUp') ? 1 : 0) - (d.has('ArrowDown') ? 1 : 0), this.stickSpeed * dt);
    this.yaw = slew(this.yaw, (d.has('KeyD') ? 1 : 0) - (d.has('KeyA') ? 1 : 0), this.stickSpeed * dt);
    const t = (d.has('KeyW') ? 1 : 0) - (d.has('KeyS') ? 1 : 0);
    this.throttle = Math.min(1, Math.max(0, this.throttle + t * this.throttleSpeed * dt));
    this.active = d.size > 0;
  }
}

/** Move toward target by at most step; returning to center is twice as fast. */
function slew(v: number, target: number, step: number): number {
  const s = target === 0 ? step * 2 : step;
  if (v < target) return Math.min(target, v + s);
  if (v > target) return Math.max(target, v - s);
  return v;
}
