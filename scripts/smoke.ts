/**
 * Browser smoke test (headless Chromium, software WebGL).
 * Usage: npm run smoke   (builds, serves dist/ with vite preview, writes screenshots to smoke-out/)
 * Flies with the keyboard, then with a simulated gamepad, runs the radio
 * calibration wizard against scrambled axes, and fails on any console error.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const server = process.env.URL ? null : await preview({ preview: { port: 4173, strictPort: false }, logLevel: 'warn' });
const URL = process.env.URL ?? server!.resolvedUrls!.local[0];
const OUT = process.argv[2] ?? 'smoke-out';
mkdirSync(OUT, { recursive: true });
const exe = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: exe, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
// Fake "standard" gamepad the test can drive through window.__pad.
await page.addInitScript(() => {
  const pad = {
    id: 'Smoke Test Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0,
    axes: [0, 1, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  (window as any).__pad = pad;
  (navigator as any).getGamepads = () => {
    pad.timestamp = performance.now();
    return [pad];
  };
});
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.goto(URL);
await page.waitForFunction(() => (window as any).freedom);
const state = () => page.evaluate(() => { const s = (window as any).freedom.quad.state; return { y: s.pos.y, armed: s.armed, crashed: s.crashed, z: s.pos.z, v: s.voltage }; });
await page.screenshot({ path: `${OUT}/0-help.png` });
await page.keyboard.press('Escape');

await page.keyboard.press('Space'); // arm
await page.waitForTimeout(200);
const armed = await state();
await page.keyboard.down('KeyW');
await page.waitForTimeout(1400);
await page.keyboard.up('KeyW');
await page.waitForTimeout(500);
const climbed = await state();
await page.screenshot({ path: `${OUT}/1-fpv.png` });
await page.keyboard.press('KeyC');
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/2-chase.png` });
await page.keyboard.press('KeyC');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/3-los.png` });
await page.keyboard.press('KeyC');
await page.keyboard.press('KeyG');
await page.keyboard.press('KeyT');
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/4-tuning-debug.png` });
// Gamepad path: reset, arm with Start (button 9), full throttle on left stick up.
await page.keyboard.press('KeyT');
await page.keyboard.press('KeyR');
const press = async (i: number) => {
  await page.evaluate((i) => ((window as any).__pad.buttons[i].value = 1), i);
  await page.waitForTimeout(150);
  await page.evaluate((i) => ((window as any).__pad.buttons[i].value = 0), i);
  await page.waitForTimeout(150);
};
await page.evaluate(() => ((window as any).__pad.axes[1] = 0.999)); // throttle low (stick down)
await page.waitForTimeout(150);
await press(9);
const padArmed = await state();
await page.evaluate(() => ((window as any).__pad.axes[1] = -0.6));
await page.waitForTimeout(1200);
const padClimb = await state();
const source = await page.evaluate(() => (window as any).freedom.input.source);
await page.evaluate(() => (window as any).freedom.openGamepadSetup());
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/5-gamepad-setup.png` });

// Calibration wizard with a "radio" whose axes are scrambled: thr=5 (reversed), roll=1, pitch=0 (reversed), yaw=2, arm switch=4.
const setAxes = (a: number[]) => page.evaluate((a) => ((window as any).__pad.axes = a), a);
const next = async () => {
  await page.waitForTimeout(80);
  await page.click('.wizard .btn.primary');
};
await page.click('button:has-text("Calibration wizard")');
//               ax0(pitch) ax1(roll) ax2(yaw) ax3 ax4(arm) ax5(thr)
await setAxes([0, 0, 0, 0, -1, 0.9]); await next(); // centered, throttle down
await setAxes([0, 0, 0, 0, -1, -0.9]); await next(); // throttle up
await setAxes([0, 1, 0, 0, -1, 0.9]); await next(); // roll right
await setAxes([0, -1, 0, 0, -1, 0.9]); await next(); // roll left
await setAxes([-1, 0, 0, 0, -1, 0.9]); await next(); // pitch forward
await setAxes([1, 0, 0, 0, -1, 0.9]); await next(); // pitch back
await setAxes([0, 0, 1, 0, -1, 0.9]); await next(); // yaw right
await setAxes([0, 0, -1, 0, -1, 0.9]); await next(); // yaw left
await setAxes([0, 0, 0, 0, 1, 0.9]); await next(); // arm switch
await page.waitForTimeout(80);
await page.click('.wizard button:has-text("Skip")'); // mode
await page.waitForTimeout(100);
await page.screenshot({ path: `${OUT}/6-after-wizard.png` });
await page.click('.modal-box button:has-text("Save")');
await setAxes([0, 0, 0, 0, -1, 0.9]); // disarm via switch, throttle low
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
await setAxes([-0.5, 0.3, 0, 0, 1, 0.9]); // arm (switch flips), throttle still low
await page.waitForTimeout(200);
const wiz = await page.evaluate(() => { const f = (window as any).freedom; f.input.armSwitch; return { armed: f.quad.state.armed, mapping: f.input.gamepad.mapping, pitch: f.input.gamepad.pitch, roll: f.input.gamepad.roll, thr: f.input.gamepad.throttle }; });
console.log('wizard', JSON.stringify({ armed: wiz.armed, pitch: wiz.pitch, roll: wiz.roll, thr: wiz.thr, thrAxis: wiz.mapping.throttle.index, arm: wiz.mapping.arm }));
const wizardOk = wiz.armed && Math.abs(wiz.pitch - 0.5) < 1e-6 && Math.abs(wiz.roll - 0.3) < 1e-6 && wiz.thr === 0 && wiz.mapping.throttle.index === 5 && wiz.mapping.arm?.index === 4;
const fps = await page.evaluate(() => new Promise<number>((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
console.log(JSON.stringify({ armed, climbed, padArmed, padClimb, source, fps, errors }, null, 1));
await browser.close();
await server?.close();
if (errors.length || !wizardOk || !armed.armed || climbed.y < 1 || !padArmed.armed || padClimb.y < 1 || source !== 'gamepad') process.exit(1);
console.log('SMOKE OK');
