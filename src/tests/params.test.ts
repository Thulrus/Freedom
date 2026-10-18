import { describe, expect, it } from 'vitest';
import { cloneParams, defaultSimParams, mergeParams, Quad, RATE_PRESETS } from '../sim';

describe('params JSON', () => {
  it('round-trips through JSON unchanged', () => {
    const p = defaultSimParams();
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it('merges partial imports over defaults and ignores junk', () => {
    const base = defaultSimParams();
    const merged = mergeParams(base, {
      quad: { mass: 0.7, inertia: [1, 2, 'x'], bogus: 5, battery: { cells: 4 } },
      controller: { pid: { roll: { p: 60 } }, rates: { roll: { type: 'betaflight', rcRate: 1.2, superRate: 0.6, expo: 0.1 } } },
      env: { gravity: 'heavy' },
    });
    expect(merged.quad.mass).toBe(0.7);
    expect(merged.quad.inertia).toEqual(base.quad.inertia); // invalid array rejected
    expect(merged.quad.battery.cells).toBe(4);
    expect(merged.controller.pid.roll.p).toBe(60);
    expect(merged.controller.pid.roll.i).toBe(base.controller.pid.roll.i);
    expect(merged.controller.rates.roll).toEqual({ type: 'betaflight', rcRate: 1.2, superRate: 0.6, expo: 0.1 });
    expect(merged.env.gravity).toBe(9.81);
    expect('bogus' in merged.quad).toBe(false);
    expect(base.quad.mass).toBe(0.65); // base untouched
  });

  it('applyParams takes effect live', () => {
    const p = defaultSimParams();
    const quad = new Quad(p);
    const next = cloneParams(p);
    next.controller.rates = RATE_PRESETS.racing();
    quad.applyParams(next);
    expect(quad.params.controller.rates.roll).toEqual(RATE_PRESETS.racing().roll);
  });
});
