// Renders the app icons (icons/*.png) from the same flame mark the page uses as its favicon.
// Run once when the mark changes: `node tools/make-icons.mjs` (needs the Playwright Chromium from npm install).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// Maskable icons are cropped to a circle or squircle by the launcher, so the mark sits in the safe
// centre (80%) on a full-bleed background; the ordinary icons keep the rounded square.
const svg = (size, maskable) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
  <rect width="64" height="64" rx="${maskable ? 0 : 14}" fill="#161a22"/>
  <g transform="${maskable ? 'translate(32 32) scale(0.8) translate(-32 -32)' : ''}">
    <path d="M32 10c6 8 12 12 12 22a12 12 0 0 1-24 0c0-5 2-8 4-11 0 5 2 7 4 8 0-9 2-14 4-19z" fill="#f5a524"/>
  </g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, maskable] of [['icon-192.png', 192, false], ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<body style="margin:0;background:transparent">${svg(size, maskable)}</body>`);
  await page.screenshot({ path: path.join(OUT, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log('wrote', path.join('icons', name));
}
await browser.close();
