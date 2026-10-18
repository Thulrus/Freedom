import { EMPTY_WORLD } from '../sim';
import { arm, DT, findHoverThrottle, makeQuad, run } from './helpers';

export type Axis = 'roll' | 'pitch' | 'yaw';
export interface StepTrace {
  t: number[];
  setpoint: number[];
  gyro: number[];
  /** Gyro on the other two axes, for cross-coupling checks. */
  other: number[][];
}

const AX: Record<Axis, number> = { roll: 0, pitch: 1, yaw: 2 };

/** Hover, then apply a stick step on one axis and record the rate response. */
export function stepResponse(axis: Axis, stick = 0.5, seconds = 0.5): StepTrace {
  const thr = findHoverThrottle();
  const { quad, rc } = makeQuad();
  arm(quad, rc);
  rc.throttle = thr;
  run(quad, rc, 1);
  const a = AX[axis];
  const others = [0, 1, 2].filter((i) => i !== a);
  const tr: StepTrace = { t: [], setpoint: [], gyro: [], other: [[], []] };
  rc[axis] = stick;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    quad.step(rc, EMPTY_WORLD);
    tr.t.push((i + 1) * DT);
    tr.setpoint.push(quad.fc.setpoint[a]);
    tr.gyro.push(quad.fc.gyro[a]);
    tr.other[0].push(quad.fc.gyro[others[0]]);
    tr.other[1].push(quad.fc.gyro[others[1]]);
  }
  return tr;
}

export function metrics(tr: StepTrace) {
  const target = tr.setpoint[tr.setpoint.length - 1];
  const i90 = tr.gyro.findIndex((g) => g >= 0.9 * target);
  const peak = Math.max(...tr.gyro);
  const last = tr.gyro.slice(-50);
  const finalErr = Math.max(...last.map((g) => Math.abs(g - target))) / target;
  const cross = Math.max(...tr.other.flat().map(Math.abs)) / target;
  return { target, rise90: i90 < 0 ? Infinity : tr.t[i90], overshoot: peak / target - 1, finalErr, cross };
}
