import { Session } from 'node:inspector/promises';
import { describe, expect, it } from 'vitest';
import { FixedStepper, FlatGround, type RcChannels, type SimParams, type WorldQuery } from '../sim';
import { buildWorld } from '../world/recipes';
import { arm, makeQuad } from './helpers';

interface ProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number };
  selfSize: number;
  children: ProfileNode[];
}

/**
 * Zero-garbage check using V8's sampling heap profiler with collected
 * objects included, so short-lived garbage counts too. Only allocations made
 * by code in src/sim/ are attributed.
 *
 * Note: V8 allocates when a non-inlined call passes or returns a double, and
 * when a ternary mixes a double with a module-level binding. If this test
 * fails, the message names the function; see DEVLOG.md for the fixes we use.
 */
/** Runs ~125k ticks under the sampling heap profiler; returns bytes/tick allocated by sim/ and world/ code. */
async function profileTicks(world: WorldQuery, spawn: [number, number, number], sampler: (r: RcChannels, t: number) => void, mod?: (p: SimParams) => void) {
  const { quad, rc } = makeQuad(mod, 3);
  quad.reset(...spawn);
  arm(quad, rc, world);
  let t = 0;
  const stepper = new FixedStepper(quad, world, (r) => sampler(r, ++t));
  for (let i = 0; i < 10000; i++) stepper.advance(1 / 60); // JIT warm-up

  const session = new Session();
  session.connect();
  await session.post('HeapProfiler.startSampling', {
    samplingInterval: 64,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const frames = 15000; // ~125k physics ticks
  const ticksBefore = Math.round(quad.state.time * 500);
  let contacts = 0;
  for (let i = 0; i < frames; i++) {
    stepper.advance(1 / 60);
    if (quad.state.contact) contacts++;
  }
  const ticks = Math.round(quad.state.time * 500) - ticksBefore;
  const { profile } = (await session.post('HeapProfiler.stopSampling')) as unknown as { profile: { head: ProfileNode } };
  session.disconnect();

  const bySite = new Map<string, number>();
  const walk = (n: ProfileNode) => {
    if (n.selfSize > 0 && /\/src\/(sim|world)\//.test(n.callFrame.url)) {
      const key = `${n.callFrame.functionName || '(anon)'} (${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1})`;
      bySite.set(key, (bySite.get(key) ?? 0) + n.selfSize);
    }
    n.children.forEach(walk);
  };
  walk(profile.head);
  const report = [...bySite].map(([k, v]) => `${k}: ${(v / ticks).toFixed(2)} B/tick`).join('\n');
  const total = [...bySite.values()].reduce((a, b) => a + b, 0);
  return { ticks, perTick: total / ticks, report, contacts, quad };
}

describe('hot loop allocation', () => {
  it('Quad.step and FixedStepper.advance allocate nothing (all modes, ground contact)', async () => {
    const r = await profileTicks(new FlatGround(0), [0, 3, 0], (r, t) => {
      r.arm = true;
      // Low throttle phases put the quad on the ground (contact path).
      r.throttle = 0.3 + 0.25 * Math.sin(t * 0.002);
      r.roll = 0.6 * Math.sin(t * 0.013);
      r.pitch = 0.6 * Math.cos(t * 0.007);
      r.yaw = 0.3 * Math.sin(t * 0.003);
      const m = (t >> 11) % 3;
      r.mode = m === 0 ? 'angle' : m === 1 ? 'horizon' : 'acro';
    });
    expect(r.ticks).toBeGreaterThan(100000);
    expect(r.contacts).toBeGreaterThan(0);
    // Sampling is statistical; real per-tick garbage shows up as >= 8 B/tick.
    expect(r.perTick, `allocations in sim/:\n${r.report}`).toBeLessThan(0.5);
  });

  it('colliding with procedural terrain and trees allocates nothing', async () => {
    const world = buildWorld('hills', 1);
    // Skim the ground in Angle mode, wandering through a forest (crashes are off).
    const r = await profileTicks(world, [60, world.groundHeight(60, 0) + 0.5, 0], (r, t) => {
      r.arm = true;
      r.mode = 'angle';
      r.throttle = 0.28 + 0.06 * Math.sin(t * 0.004);
      r.pitch = 0.5;
      r.roll = 0.4 * Math.sin(t * 0.0011);
    }, (p) => (p.quad.collision.disarmOnCrash = false));
    expect(r.ticks).toBeGreaterThan(100000);
    expect(r.contacts).toBeGreaterThan(1000);
    expect(r.perTick, `allocations in sim/ + world/:\n${r.report}`).toBeLessThan(0.5);
  });
});
