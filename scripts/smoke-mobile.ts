/**
 * Mobile smoke test: emulated landscape phone with real multi-touch (CDP),
 * gesture suppression, portrait prompt, and offline reload via the service worker.
 * Usage: npm run smoke:mobile   (screenshots in smoke-out/mobile-*.png)
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const OUT = process.argv[2] ?? 'smoke-out';
mkdirSync(OUT, { recursive: true });
const server = await preview({ preview: { port: 4174, strictPort: false }, logLevel: 'warn' });
const URL = server.resolvedUrls!.local[0];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const cdp = await context.newCDPSession(page);
const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: { x: number; y: number; id: number }[]) =>
  cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts });
const app = <T>(fn: string) => page.evaluate(`(() => { const f = window.freedom; return ${fn}; })()`) as Promise<T>;
const fail: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) fail.push(what);
};

await page.goto(URL);
await page.waitForFunction(() => (window as any).freedom);
await page.screenshot({ path: `${OUT}/mobile-0-help.png` });
await page.tap('.modal-box button.big'); // "Fly"
await page.waitForTimeout(300);

check(await page.evaluate(() => getComputedStyle(document.querySelector('.touch')!).display !== 'none'), 'touch sticks visible on a touch device');

// Stick geometry from the app.
const geo = await app<{ l: { cx: number; cy: number; r: number }; r: { cx: number; cy: number; r: number } }>(
  '({ l: { cx: f.input.touch.left.cx, cy: f.input.touch.left.cy, r: f.input.touch.left.radius }, r: { cx: f.input.touch.right.cx, cy: f.input.touch.right.cy, r: f.input.touch.right.radius } })',
);

await page.tap('.tbtn.arm');
await page.waitForTimeout(150);
check(await app<boolean>('f.quad.state.armed'), 'ARM button arms with throttle at the bottom');

// Two thumbs down at once, then fly: left thumb pushes throttle up, right thumb rolls a bit.
const L = { x: geo.l.cx + 10, y: geo.l.cy + 20, id: 0 };
const R = { x: geo.r.cx - 15, y: geo.r.cy, id: 1 };
await touch('touchStart', [L, R]);
for (let i = 1; i <= 20; i++) {
  await touch('touchMove', [
    { ...L, y: L.y - (geo.l.r * 1.4 * i) / 20 }, // throttle from 0 to ~70 %
    { ...R, x: R.x + (geo.r.r * 0.15 * i) / 20 },
  ]);
  await page.waitForTimeout(25);
}
const during = await app<{ thr: number; roll: number; src: string }>('({ thr: f.input.last.throttle, roll: f.input.last.roll, src: f.input.source })');
check(during.src === 'touch', `input source is touch (${during.src})`);
check(during.thr > 0.6 && during.thr < 0.8, `throttle follows the left thumb (${during.thr.toFixed(2)})`);
check(during.roll > 0.05, `roll follows the right thumb (${during.roll.toFixed(2)})`);
await page.waitForTimeout(900);
const alt = await app<number>('f.quad.state.pos.y - f.world.spawn.y'); // above the launch pad
check(alt > 2, `quad climbs on touch throttle (${alt.toFixed(1)} m)`);
await page.screenshot({ path: `${OUT}/mobile-1-flying.png` });

// OS cancels the touches (e.g. notification shade): gimbals center, throttle holds.
await touch('touchCancel', []);
await page.waitForTimeout(100);
const after = await app<{ thr: number; roll: number }>('({ thr: f.input.last.throttle, roll: f.input.last.roll })');
check(Math.abs(after.roll) < 1e-6 && after.thr > 0.6, `touch cancel: roll centers, throttle holds (${after.thr.toFixed(2)})`);

// The page must not scroll or zoom from gestures.
await touch('touchStart', [{ x: 400, y: 200, id: 0 }, { x: 450, y: 220, id: 1 }]);
await touch('touchMove', [{ x: 300, y: 100, id: 0 }, { x: 600, y: 350, id: 1 }]);
await touch('touchEnd', []);
const vp = await page.evaluate(() => ({ scrollY: window.scrollY, scale: window.visualViewport?.scale ?? 1 }));
check(vp.scrollY === 0 && vp.scale === 1, `no page scroll/zoom from pinch/drag (scale ${vp.scale})`);

const lat = await app<{ n: number; avg: number; p95: number }>('({ n: f.latency.sampleCount, ...f.latency.stats() })');
check(lat.n > 5, `latency meter collected ${lat.n} samples (avg ${lat.avg.toFixed(1)} ms, p95 ${lat.p95.toFixed(1)} ms)`);

// Tuning drawer opens and scrolls on a phone.
await page.tap('.touch-bar .tbtn:nth-child(5)');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/mobile-2-tuning.png` });
await page.tap('.tune-head .btn');

// Portrait: rotate prompt and paused physics.
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(400);
check(await page.evaluate(() => document.querySelector('.rotate')!.classList.contains('show')), 'portrait shows the rotate prompt');
await page.screenshot({ path: `${OUT}/mobile-3-portrait.png` });
await page.setViewportSize({ width: 844, height: 390 });

// PWA: manifest + service worker + offline reload.
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready;
  return { active: !!reg.active, manifest: !!document.querySelector('link[rel=manifest]') };
});
check(sw.active && sw.manifest, 'service worker active and manifest linked');
await page.waitForTimeout(500); // let precache finish
await context.setOffline(true);
await page.reload();
const offline = await page.waitForFunction(() => (window as any).freedom, null, { timeout: 15000 }).then(() => true, () => false);
check(offline, 'app reloads and runs while offline');
await context.setOffline(false);

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
await browser.close();
await server.close();
if (fail.length) {
  console.log(`\n${fail.length} check(s) failed`);
  process.exit(1);
}
console.log('MOBILE SMOKE OK');
