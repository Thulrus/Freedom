/** Closed-form sanity numbers used by tests and the tuning panel. */
import type { SimParams } from './params';
import { applyThrottleCurve } from './rates';

/** Total max thrust / weight on a full battery. */
export function thrustToWeight(p: SimParams): number {
  return (p.quad.maxThrustPerMotor * p.quad.motors.length) / (p.quad.mass * p.env.gravity);
}

/**
 * Stick throttle (0..1) needed to hover at a given pack voltage scale
 * (loaded voltage / full voltage). Inverts motor idle and the throttle curve.
 */
export function hoverThrottle(p: SimParams, voltageScale = 1): number {
  const perMotor = (p.quad.mass * p.env.gravity) / p.quad.motors.length;
  // thrust = Tmax * (cmd * vScale)^2
  const cmd = Math.sqrt(perMotor / p.quad.maxThrustPerMotor) / voltageScale;
  const idle = p.controller.motorIdle;
  const curveOut = (cmd - idle) / (1 - idle);
  // Invert the (monotonic) throttle curve by bisection.
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (applyThrottleCurve(mid, p.controller.throttleMid, p.controller.throttleExpo) < curveOut) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Terminal fall speed (m/s) for a flat, motors-off fall along body Y. */
export function terminalVelocityFlat(p: SimParams): number {
  const mg = p.quad.mass * p.env.gravity;
  const a = p.quad.dragQuadratic[1], b = p.quad.dragLinear[1];
  // a v^2 + b v - mg = 0
  return a > 0 ? (-b + Math.sqrt(b * b + 4 * a * mg)) / (2 * a) : mg / b;
}
