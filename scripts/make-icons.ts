/** Renders public/icon.svg to the PNG sizes the web manifest needs. Run once after editing the SVG. */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const svg = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const page = await browser.newPage();
const shots: [string, number, boolean][] = [
  ['public/icon-192.png', 192, false],
  ['public/icon-512.png', 512, false],
  ['public/icon-maskable-512.png', 512, true], // safe zone: content inside the middle 80%
  ['public/apple-touch-icon.png', 180, true],
];
for (const [path, size, maskable] of shots) {
  const inner = maskable ? Math.round(size * 0.72) : size;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:#0d1117;display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body></html>`);
  await page.screenshot({ path, omitBackground: !maskable });
}
await browser.close();
console.log('icons written');
