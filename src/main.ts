// M1 placeholder: runs the pure sim in the browser and prints a few numbers.
// Replaced by the real app (renderer, input, UI) in M2.
import { defaultSimParams, FlatGround, hoverThrottle, Quad, RAD, RcChannels } from './sim';

const params = defaultSimParams();
const quad = new Quad(params);
const rc = new RcChannels();
const ground = new FlatGround(0);
const lines: string[] = [];

quad.reset(0, 0, 0);
rc.arm = true;
quad.step(rc, ground);
const t0 = performance.now();
const ticks = 5 * 500;
for (let i = 0; i < ticks; i++) {
  const t = i / 500;
  rc.throttle = t < 1 ? 0.7 : hoverThrottle(params);
  rc.roll = t > 1.5 && t < 2.05 ? 1 : 0;
  quad.step(rc, ground);
}
const ms = performance.now() - t0;
const s = quad.state;
lines.push(`simulated 5 s at 500 Hz in ${ms.toFixed(1)} ms (${((ticks / ms) * 1000).toFixed(0)} ticks/s)`);
lines.push(`altitude ${s.pos.y.toFixed(1)} m, battery ${s.voltage.toFixed(2)} V, armed ${s.armed}`);
lines.push(`body rates ${(s.omega.length() * RAD).toFixed(1)} deg/s`);
document.getElementById('out')!.textContent = lines.join('\n');
