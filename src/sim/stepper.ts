/**
 * Fixed-timestep driver. The renderer calls `advance(frameDt)` once per
 * frame; physics runs in whole ticks of quad.timestep, sampling input every tick, and
 * the renderer interpolates between `prev` and `curr` using `alpha`.
 */
import { Quad, QuadState } from './quad';
import { RcChannels } from './rc';
import type { WorldQuery } from './world';

/** Called once per physics tick to fill rc with the latest input. state.time = sim time. */
export type InputSampler = (rc: RcChannels, state: QuadState) => void;

export class FixedStepper {
  readonly prev = new QuadState();
  readonly curr = new QuadState();
  readonly rc = new RcChannels();
  /** Ticks executed during the last advance() call. */
  lastTicks = 0;
  /** Interpolation factor between prev (0) and curr (1) after the last advance(). */
  alpha = 0;
  /** Total ticks dropped because a frame exceeded maxSubsteps. */
  droppedTicks = 0;
  private acc = 0;

  constructor(
    public quad: Quad,
    public world: WorldQuery,
    public sample: InputSampler,
    /** Max ticks per frame; extra time is dropped (sim slows instead of spiraling). */
    public maxSubsteps = 50,
  ) {
    this.prev.copy(quad.state);
    this.curr.copy(quad.state);
  }

  get dt(): number {
    return this.quad.timestep;
  }

  /**
   * Advance by real elapsed time (s). Sets `alpha` in [0, 1) for rendering.
   * (Stored on a field rather than returned: returning a double allocates in V8.)
   */
  advance(frameDt: number): void {
    const dt = this.dt;
    this.acc += Math.min(Math.max(frameDt, 0), 0.25);
    let ticks = 0;
    while (this.acc >= dt) {
      if (ticks >= this.maxSubsteps) {
        const drop = Math.floor(this.acc / dt);
        this.droppedTicks += drop;
        this.acc -= drop * dt;
        break;
      }
      this.prev.copy(this.quad.state);
      this.sample(this.rc, this.quad.state);
      this.quad.step(this.rc, this.world);
      this.acc -= dt;
      ticks++;
    }
    if (ticks > 0) this.curr.copy(this.quad.state);
    this.lastTicks = ticks;
    this.alpha = this.acc / dt;
  }

  /** Re-sync snapshots after an external reset/teleport. */
  sync(): void {
    this.acc = 0;
    this.prev.copy(this.quad.state);
    this.curr.copy(this.quad.state);
  }
}
