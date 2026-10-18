/**
 * Browser smoke test (headless Chromium, software WebGL).
 * Usage: npm run smoke   (builds, serves dist/ with vite preview, writes screenshots to smoke-out/)
 * Flies with the keyboard, then with a simulated gamepad, runs the radio
 * calibration wizard against scrambled axes, teleports 50 km out over the
 * streaming terrain (floating origin), switches worlds, and fails on any
 * console error.
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
const y0 = (await state()).y; // spawn pad height (terrain worlds aren't at y = 0)

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
// Terrain: teleport 50 km out, which needs a floating-origin rebase and fresh chunks.
const far = await page.evaluate(() => {
  const f = (window as any).freedom;
  f.settings.world = { recipe: 'hills', seed: 1 };
  f.loadWorld();
  const x = 40000, z = -30000;
  f.quad.reset(x, f.world.groundHeight(x, z) + 25, z, 0.8);
  f.stepper.sync();
  f.origin.update(x, z);
  f.view.prime(x, z, f.origin);
  return { origin: [f.origin.x, f.origin.z], status: f.view.worldStatus };
});
await page.keyboard.press('KeyG');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/7-far-terrain.png` });
// Fly it forward fast for a few seconds: chunks must stream in (budgeted) without errors.
const streamed = await page.evaluate(async () => {
  const f = (window as any).freedom;
  const before = f.view.worldStatus;
  const s = f.quad.state;
  const t0 = performance.now();
  await new Promise<void>((res) => {
    const tick = () => {
      s.pos.x += 3; // ~180 m/s at 60 fps: worst case for streaming
      s.vel.set(0, 0, 0);
      if (performance.now() - t0 < 3000) requestAnimationFrame(tick);
      else res();
    };
    tick();
  });
  return { before, after: f.view.worldStatus, x: s.pos.x };
});
await page.screenshot({ path: `${OUT}/8-streamed.png` });
await page.keyboard.press('KeyC');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/9-terrain-chase.png` });
await page.keyboard.press('KeyC');
await page.keyboard.press('KeyC');
await page.keyboard.press('KeyG');
const sandbox = await page.evaluate(() => {
  const f = (window as any).freedom;
  f.settings.world = { recipe: 'sandbox', seed: 1 };
  f.loadWorld();
  return f.world.id;
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/10-sandbox.png` });
console.log('terrain', JSON.stringify({ far, streamed, sandbox }));

// M5 loop: pick a world, open the menu, fly a race, see the score, watch the replay with telemetry.
const F = (code: string) => page.evaluate(`(() => { const f = window.freedom; ${code} })()`);
await F(`f.settings.world = { recipe: 'hills', seed: 1 }; f.loadWorld();`);
await page.keyboard.press('KeyM');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/11-menu.png` });
await page.click('.mode-card:has-text("Gate race")');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/12-race-instructions.png` });
await page.click('.modal-box .btn.primary');
await page.keyboard.press('Space'); // arm
await page.keyboard.down('KeyW');
await page.waitForTimeout(700);
await page.keyboard.up('KeyW');
await page.keyboard.press('KeyC'); // chase cam to see the gates
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/13-race-flying.png` });
// Teleport through every gate in order (3 laps + finish) — tests timing and the results flow, not piloting.
const race = await page.evaluate(
  () =>
    new Promise<{ phase: string; laps: number[]; modal: boolean }>((res) => {
      const f = (window as any).freedom;
      const cps = f.act.layout.checkpoints;
      const seq = [...cps, ...cps, ...cps, cps[0]];
      let k = 0, step = 0;
      const tick = () => {
        const c = seq[k], s = f.quad.state;
        const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), d = step < 2 ? -2 : 2;
        s.pos.set(c.x + fx * d, c.y, c.z + fz * d);
        s.vel.set(fx * 15, 0, fz * 15);
        f.stepper.sync();
        if (++step === 4) {
          step = 0;
          k++;
        }
        if (k < seq.length && f.act.run.phase !== 'failed') requestAnimationFrame(tick);
        else setTimeout(() => res({ phase: f.act.run.phase, laps: f.act.run.laps, modal: !!document.querySelector('.result-score') }), 300);
      };
      tick();
    }),
);
await page.screenshot({ path: `${OUT}/14-results.png` });
await page.click('.modal-box button:has-text("Telemetry")');
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/15-replay-telemetry.png` });
const replayOn = await page.evaluate(() => !!(window as any).freedom.replay);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const backToResults = await page.evaluate(() => !!document.querySelector('.result-score'));
await page.click('.modal-box button:has-text("Free flight")');
// A real (keyboard) flight must replay bit-exactly.
await page.keyboard.press('Space');
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(1500);
await page.keyboard.up('KeyW');
await page.keyboard.up('ArrowUp');
await page.waitForTimeout(500);
await page.keyboard.press('KeyP');
await page.waitForTimeout(300);
const replay = await page.evaluate(() => { const r = (window as any).freedom.replay; return r ? { diverged: r.trace.diverged, duration: r.trace.duration } : null; });
await page.screenshot({ path: `${OUT}/16-replay.png` });
await page.keyboard.press('Escape');
console.log('m5', JSON.stringify({ race, replayOn, backToResults, replay }));

// M6: the city. Views from the plaza, from above, and low down a street; then the street-circuit race.
const pose = (x: number, y: number, z: number, yaw: number) =>
  page.evaluate(([x, y, z, yaw]) => {
    const f = (window as any).freedom;
    f.quad.reset(x, y, z, yaw);
    f.stepper.sync();
    f.origin.update(x, z);
    f.view.prime(x, z, f.origin);
  }, [x, y, z, yaw]);
await F(`f.settings.world = { recipe: 'city', seed: 1 }; f.loadWorld(); f.settings.camera.mode = 'fpv';`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/17-city-pad.png` });
await pose(0, 70, 30, 0);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/18-city-above.png` });
await pose(64 * 3, 6, -64 * 2 - 20, -Math.PI / 2);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/19-city-street.png` });
const cityStatus = await page.evaluate(() => (window as any).freedom.view.worldStatus);
await page.keyboard.press('KeyM');
await page.click('.mode-card:has-text("Gate race")');
await page.click('.modal-box .btn.primary');
await page.keyboard.press('KeyC');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/20-city-race.png` });
await page.keyboard.press('KeyC');
await page.keyboard.press('KeyC');
console.log('m6', JSON.stringify({ cityStatus }));
const m5Ok = race.phase === 'finished' && race.laps.length === 3 && race.modal && replayOn && backToResults && !!replay && !replay.diverged && replay.duration > 1;
const fps = await page.evaluate(() => new Promise<number>((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else res(n); }; requestAnimationFrame(f); }));
console.log(JSON.stringify({ armed, climbed, padArmed, padClimb, source, fps, errors }, null, 1));
await browser.close();
await server?.close();
// Origin snaps to the 128 m chunk grid nearest the drone.
const farOk = far.origin[0] === 40064 && far.origin[1] === -29952 && sandbox === 'sandbox';
if (errors.length || !wizardOk || !farOk || !m5Ok || !armed.armed || climbed.y - y0 < 1 || !padArmed.armed || padClimb.y - y0 < 1 || source !== 'gamepad') process.exit(1);
console.log('SMOKE OK');
