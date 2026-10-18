import type { FlightMode } from './params';

/**
 * Normalized RC channels: what every input device (touch, gamepad, radio,
 * keyboard, replay log) produces. Sampled once per physics tick.
 *
 * Sign convention (pilot view): positive = stick right / stick forward.
 */
export class RcChannels {
  /** 0 (stick down) .. 1 (stick up). Non-centering. */
  throttle = 0;
  /** -1 .. 1, positive = roll right. */
  roll = 0;
  /** -1 .. 1, positive = stick forward = nose down. */
  pitch = 0;
  /** -1 .. 1, positive = yaw right (nose turns right). */
  yaw = 0;
  /** Arm switch position. Arming needs a rising edge with throttle low. */
  arm = false;
  mode: FlightMode = 'acro';

  copy(o: RcChannels): this {
    this.throttle = o.throttle;
    this.roll = o.roll;
    this.pitch = o.pitch;
    this.yaw = o.yaw;
    this.arm = o.arm;
    this.mode = o.mode;
    return this;
  }

  centerSticks(): this {
    this.throttle = 0;
    this.roll = 0;
    this.pitch = 0;
    this.yaw = 0;
    return this;
  }
}
