import { describe, expect, it } from 'vitest';
import { modeMap, TouchInput, VirtualStick } from '../input/touch';
import { FrameGovernor } from '../platform/quality';
import { LatencyMeter } from '../platform/latency';
import { defaultSettings } from '../settings';

const safe = { left: 0, right: 0, bottom: 0 };

function touchInput(mod?: (t: ReturnType<typeof defaultSettings>['touch']) => void) {
  const s = defaultSettings().touch;
  mod?.(s);
  const t = new TouchInput(s);
  t.layout(800, 400, safe);
  return { t, s };
}

describe('virtual stick', () => {
  it('grabbing never jumps the value (fixed mode)', () => {
    const st = new VirtualStick();
    st.setHome(100, 300, 80);
    st.y = -1; // throttle parked at the bottom
    st.centerY = false;
    st.down(1, 130, 250, false); // thumb lands somewhere else
    st.move(130, 250);
    expect(st.y).toBeCloseTo(-1, 12);
    expect(st.x).toBeCloseTo(0, 12);
    st.move(130, 210); // thumb up 40 px = half travel
    expect(st.y).toBeCloseTo(-0.5, 12);
    st.release();
    expect(st.y).toBeCloseTo(-0.5, 12); // throttle holds
    expect(st.x).toBe(0);
  });

  it('floating mode moves the base under the thumb, value unchanged', () => {
    const st = new VirtualStick();
    st.setHome(100, 300, 80);
    st.x = 0.25;
    st.centerX = false;
    st.down(1, 500, 100, true);
    st.move(500, 100);
    expect(st.x).toBeCloseTo(0.25, 12);
    expect(st.cx).toBeCloseTo(480, 12);
    st.release();
    expect(st.cx).toBe(100); // base returns home
  });

  it('square gate: axes clamp independently (full diagonals)', () => {
    const st = new VirtualStick();
    st.setHome(0, 0, 50);
    st.down(1, 0, 0, false);
    st.move(500, -500);
    expect([st.x, st.y]).toEqual([1, 1]);
  });
});

describe('touch input', () => {
  it('Mode 2: left = throttle/yaw, right = pitch/roll; throttle starts at 0', () => {
    const { t } = touchInput();
    t.update(false, 0.002);
    expect(t.throttle).toBe(0);
    const L = t.left, R = t.right;
    L.down(1, L.cx, L.cy, false);
    L.move(L.cx + L.radius * 0.5, L.cy - L.radius); // throttle +half (from bottom), yaw right half
    R.down(2, R.cx, R.cy, false);
    R.move(R.cx - R.radius, R.cy - R.radius * 0.5); // roll full left, pitch forward half
    t.update(true, 0.002);
    expect(t.throttle).toBeCloseTo(0.5, 9);
    expect(t.yaw).toBeCloseTo(0.5, 9);
    expect(t.roll).toBeCloseTo(-1, 9);
    expect(t.pitch).toBeCloseTo(0.5, 9);
    expect(t.active).toBe(true);
    t.releaseAll(); // e.g. pointercancel / focus loss
    t.update(true, 0.002);
    expect([t.roll, t.pitch, t.yaw]).toEqual([0, 0, 0]);
    expect(t.throttle).toBeCloseTo(0.5, 9); // throttle holds
  });

  it('all four modes put throttle on the non-centering axis', () => {
    for (const mode of [1, 2, 3, 4] as const) {
      const map = modeMap(mode);
      const axes = Object.values(map).map(([s, a]) => `${s}${a}`);
      expect(new Set(axes).size).toBe(4);
      const { t } = touchInput((s) => (s.mode = mode));
      const thr = map.throttle[0] === 'left' ? t.left : t.right;
      expect(thr.centerY).toBe(false);
      expect(thr.y).toBe(-1);
    }
  });

  it('changing opacity/size does not move the sticks; changing mode does', () => {
    const { t, s } = touchInput();
    t.left.y = 0.2; // throttle somewhere mid
    t.apply({ ...s, opacity: 0.9, size: 0.3 });
    expect(t.left.y).toBe(0.2);
    t.apply({ ...s, mode: 1 });
    expect(t.right.y).toBe(-1); // throttle moved to the right stick, at the bottom
    expect(t.left.y).toBe(0);
  });

  it('self-centering throttle: 0 while disarmed, ramps to hover after arming', () => {
    const { t } = touchInput((s) => (s.throttleCentering = true));
    t.hoverThrottle = 0.31;
    t.update(false, 0.002);
    expect(t.throttle).toBe(0);
    for (let i = 0; i < 400; i++) t.update(true, 0.002); // 0.8 s
    expect(t.throttle).toBeCloseTo(0.31, 9);
    t.left.y = 1;
    t.update(true, 0.002);
    expect(t.throttle).toBeCloseTo(1, 9);
  });

  it('layout honors safe areas and size', () => {
    const { t } = touchInput();
    t.layout(800, 400, { left: 40, right: 30, bottom: 20 });
    expect(t.left.cx).toBeCloseTo(40 + 0.16 * 800, 9);
    expect(t.right.cx).toBeCloseTo(800 - 30 - 0.16 * 800, 9);
    expect(t.left.cy).toBeCloseTo(400 - 20 - 0.3 * 400, 9);
    expect(t.left.radius).toBeCloseTo(0.2 * 400, 9);
  });
});

describe('frame governor', () => {
  const opts = (o: { preset: 'high' | 'medium' | 'low' }) => ({ dynamic: true, autoDowngrade: true, preset: o.preset, setPreset: (p: 'high' | 'medium' | 'low') => (o.preset = p) });

  it('learns 60 vs 120 Hz', () => {
    const g = new FrameGovernor();
    const o = { preset: 'high' as const };
    for (let i = 0; i < 120; i++) g.frame(8.33 + (i % 3) * 0.1, opts(o));
    expect(1000 / g.vsync).toBeCloseTo(120, 0);
    const g2 = new FrameGovernor();
    for (let i = 0; i < 120; i++) g2.frame(16.7, opts(o));
    expect(1000 / g2.vsync).toBeCloseTo(60, 0);
    expect(g2.scale).toBe(1);
  });

  it('drops resolution on missed frames, recovers when steady, downgrades preset as a last resort', () => {
    const g = new FrameGovernor(0.5);
    const o = { preset: 'high' as 'high' | 'medium' | 'low' };
    for (let i = 0; i < 120; i++) g.frame(16.7, opts(o));
    // Every 5th frame misses vsync.
    for (let i = 0; i < 600; i++) g.frame(i % 5 === 0 ? 33.4 : 16.7, opts(o));
    expect(g.scale).toBeLessThan(1);
    const low = g.scale;
    for (let i = 0; i < 2000; i++) g.frame(16.7, opts(o));
    expect(g.scale).toBeGreaterThan(low);
    // Hopeless: misses forever -> preset drops.
    for (let i = 0; i < 3000 && o.preset === 'high'; i++) g.frame(i % 3 === 0 ? 33.4 : 16.7, opts(o));
    expect(o.preset).toBe('medium');
  });

  it('ignores pauses (tab switch)', () => {
    const g = new FrameGovernor();
    const o = { preset: 'high' as const };
    for (let i = 0; i < 100; i++) g.frame(16.7, opts(o));
    g.frame(5000, opts(o));
    expect(g.missed).toBe(0);
  });
});

describe('latency meter', () => {
  it('measures first unconsumed event to consumption', () => {
    const m = new LatencyMeter();
    m.mark(100);
    m.mark(105); // later events in the same frame don't overwrite the oldest
    m.consume(112);
    m.consume(130); // nothing pending
    m.mark(200);
    m.consume(204);
    expect(m.sampleCount).toBe(2);
    expect(m.stats().avg).toBeCloseTo(8, 9);
    expect(m.stats().p95).toBe(12);
  });
});
