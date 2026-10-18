/**
 * Writes step-response and scripted-flight plots to docs/plots/*.svg.
 * Run: npm run plots
 * No dependencies: hand-rolled SVG so it works headless anywhere.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { EMPTY_WORLD, RAD } from '../src/sim';
import { arm, findHoverThrottle, makeQuad, uprightness } from '../src/tests/helpers';
import { metrics, stepResponse, type Axis } from '../src/tests/stepResponse';

interface Series {
  name: string;
  color: string;
  y: number[];
  dash?: boolean;
}

function plot(title: string, t: number[], series: Series[], yLabel: string, note = ''): string {
  const W = 760, H = 360, L = 60, R = 20, T = 40, B = 50;
  const all = series.flatMap((s) => s.y);
  let lo = Math.min(0, ...all), hi = Math.max(...all);
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const x = (v: number) => L + ((v - t[0]) / (t[t.length - 1] - t[0])) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const ticks = (a: number, b: number, n: number) => {
    const step = Math.pow(10, Math.floor(Math.log10((b - a) / n)));
    const s = [1, 2, 5, 10].map((m) => m * step).find((m) => (b - a) / m <= n) ?? step * 10;
    const out: number[] = [];
    for (let v = Math.ceil(a / s) * s; v <= b; v += s) out.push(+v.toFixed(6));
    return out;
  };
  const grid = [
    ...ticks(lo, hi, 6).map(
      (v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e5e5e5"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`,
    ),
    ...ticks(t[0], t[t.length - 1], 8).map(
      (v) => `<line y1="${T}" y2="${H - B}" x1="${x(v)}" x2="${x(v)}" stroke="#eeeeee"/><text x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${Math.round(v * 1000)}</text>`,
    ),
  ];
  const lines = series.map((s) => {
    const d = s.y.map((v, i) => `${i ? 'L' : 'M'}${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`).join('');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="6 4"' : ''}/>`;
  });
  const legend = series.filter((s) => s.name).map(
    (s, i) => `<g transform="translate(${L + 10 + i * 150},${T + 12})"><line x1="0" x2="22" y1="0" y2="0" stroke="${s.color}" stroke-width="2"${s.dash ? ' stroke-dasharray="6 4"' : ''}/><text x="28" y="4">${s.name}</text></g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">
<rect width="100%" height="100%" fill="white"/>
<text x="${L}" y="22" font-size="15" font-weight="600">${title}</text>
<text x="${W - R}" y="22" text-anchor="end" fill="#555">${note}</text>
${grid.join('\n')}
<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="#999"/>
${lines.join('\n')}
${legend.join('\n')}
<text x="${(L + W - R) / 2}" y="${H - 12}" text-anchor="middle">time (ms)</text>
<text transform="translate(16,${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>
</svg>`;
}

mkdirSync('docs/plots', { recursive: true });

for (const axis of ['roll', 'pitch', 'yaw'] as Axis[]) {
  const tr = stepResponse(axis, 0.5, 0.4);
  const m = metrics(tr);
  const note = `rise90 ${(m.rise90 * 1000).toFixed(0)} ms · overshoot ${(m.overshoot * 100).toFixed(1)}% · cross-axis ${(m.cross * 100).toFixed(1)}%`;
  const svg = plot(`${axis} step, half stick (BF default rates and PIDs)`, tr.t, [
    { name: 'setpoint', color: '#888', y: tr.setpoint, dash: true },
    { name: 'gyro', color: '#d43f3a', y: tr.gyro },
    { name: 'other axes', color: '#3a7bd4', y: tr.other[0] },
    { name: '', color: '#3a7bd4', y: tr.other[1] },
  ], 'rate (deg/s)', note);
  writeFileSync(`docs/plots/step-${axis}.svg`, svg);
  console.log(`${axis.padEnd(5)} ${note}`);
}

// Scripted flight: climb, full-stick roll flip, recover, hover.
{
  const hover = findHoverThrottle();
  const { quad, rc } = makeQuad(undefined, 0);
  arm(quad, rc, EMPTY_WORLD);
  const t: number[] = [], alt: number[] = [], roll: number[] = [], up: number[] = [], thr: number[] = [];
  const dt = quad.timestep;
  let rolled = 0;
  let recoverAt = Infinity;
  for (let i = 0; i < 2.5 / dt; i++) {
    const time = i * dt;
    if (time < 0.8) {
      rc.throttle = 0.7;
    } else if (rolled < 345) {
      // Full right roll until ~one full turn (stick released a bit early, as pilots do).
      rc.throttle = 0.15;
      rc.roll = 1;
      rolled += -quad.state.omega.z * RAD * dt;
      recoverAt = time;
    } else if (time < recoverAt + 0.3) {
      rc.throttle = 0.6;
      rc.roll = 0;
    } else rc.throttle = hover;
    quad.step(rc, EMPTY_WORLD);
    t.push(time);
    alt.push(quad.state.pos.y);
    roll.push(quad.fc.gyro[0] / 100);
    up.push(uprightness(quad) * 10);
    thr.push(rc.throttle * 10);
  }
  writeFileSync(
    'docs/plots/flight-flip.svg',
    plot('Scripted flight: climb → roll flip → recover → hover', t, [
      { name: 'altitude (m)', color: '#2a9d4b', y: alt },
      { name: 'roll rate (100°/s)', color: '#d43f3a', y: roll },
      { name: 'uprightness ×10', color: '#3a7bd4', y: up },
      { name: 'throttle ×10', color: '#888', y: thr, dash: true },
    ], 'mixed units'),
  );
  console.log(`flip  final alt ${quad.state.pos.y.toFixed(1)} m, upright ${uprightness(quad).toFixed(3)}, |omega| ${(quad.state.omega.length() * RAD).toFixed(2)} deg/s`);
}
