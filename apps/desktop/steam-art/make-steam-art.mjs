// Builds Atlas's Steam artwork from SVG drawn here. Original art: Atlas's folded-map mark and colours.
// See README.md in this folder: node apps/desktop/steam-art/make-steam-art.mjs [output folder]
// Playwright comes from the web app's dev dependencies; the text needs the Inter and Inter Display fonts installed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const { chromium } = createRequire(new URL('../../web/package.json', import.meta.url))(
  '@playwright/test',
);
const OUT = process.argv[2] || 'out';
fs.mkdirSync(OUT, { recursive: true });

const C = {
  navy: '#16324f',
  deep: '#0b1828',
  paper: '#e8eef4',
  fold: '#c9d6e2',
  red: '#e4572e',
  teal: '#63cdb9',
  gold: '#e6b450',
};

// Seeded random so the art is the same every build.
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

// Concentric wobbly rings: a contour "hill".
function hill(cx, cy, r0, rings, step, seed, stroke, op) {
  const R = rng(seed);
  const ph = [R() * 6.28, R() * 6.28, R() * 6.28];
  const am = [0.18 + R() * 0.1, 0.1 + R() * 0.08, 0.05 + R() * 0.05];
  let s = '';
  for (let k = 0; k < rings; k++) {
    const r = r0 + k * step;
    let d = '';
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * Math.PI * 2;
      const w =
        1 +
        am[0] * Math.sin(2 * t + ph[0] + k * 0.15) +
        am[1] * Math.sin(3 * t + ph[1] - k * 0.1) +
        am[2] * Math.sin(5 * t + ph[2]);
      const x = cx + Math.cos(t) * r * w * 1.25,
        y = cy + Math.sin(t) * r * w;
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    const o = op * (k % 4 === 0 ? 1.6 : 1);
    s += `<path d="${d}Z" fill="none" stroke="${stroke}" stroke-opacity="${o.toFixed(3)}" stroke-width="${k % 4 === 0 ? 2.2 : 1.2}"/>`;
  }
  return s;
}

const pin = (x, y, s, col) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><ellipse cx="0" cy="2" rx="9" ry="3" fill="#000" opacity=".35"/><path d="M0 0C-4-10-16-16-16-28a16 16 0 0 1 32 0C16-16 4-10 0 0Z" fill="${col}"/><circle cx="0" cy="-28" r="6" fill="${C.deep}"/></g>`;
const check = (x, y, s) =>
  `<g transform="translate(${x} ${y}) scale(${s})"><circle r="16" fill="${C.teal}"/><path d="M-7 0l5 5 9-10" fill="none" stroke="${C.deep}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></g>`;

// Folded-map mark, 1024 unit box like the app icon, without the rounded tile.
const mark = (bg = C.navy) => `
  <path d="M232 300 L412 236 L612 300 L792 236 L792 724 L612 788 L412 724 L232 788 Z" fill="${C.paper}"/>
  <path d="M412 236 L412 724 L612 788 L612 300 Z" fill="${C.fold}"/>
  <path d="M512 330 L572 512 L512 694 L452 512 Z" fill="${bg}"/>
  <path d="M512 330 L572 512 L452 512 Z" fill="${C.red}"/>
  <circle cx="512" cy="512" r="22" fill="${C.paper}"/>`;

// The world: background, grid, contours, route, pins. Drawn in a W x H box.
function world(W, H, seed, opts = {}) {
  const R = rng(seed);
  const u = Math.min(W, H);
  let s = `<defs>
    <radialGradient id="bg" cx="${opts.lightX ?? 0.6}" cy="${opts.lightY ?? 0.4}" r="0.9"><stop offset="0" stop-color="#1d4166"/><stop offset=".55" stop-color="${C.navy}"/><stop offset="1" stop-color="${C.deep}"/></radialGradient>
    <radialGradient id="vig" cx=".5" cy=".5" r=".75"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${u * 0.02}"/></filter>
  </defs><rect width="${W}" height="${H}" fill="url(#bg)"/>`;
  const g = u / 7;
  for (let x = (W % g) / 2; x < W; x += g)
    s += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${C.paper}" stroke-opacity=".05" stroke-width="1.5"/>`;
  for (let y = (H % g) / 2; y < H; y += g)
    s += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${C.paper}" stroke-opacity=".05" stroke-width="1.5"/>`;
  const hills = opts.hills ?? 4;
  for (let i = 0; i < hills; i++) {
    const cx = W * (0.1 + R() * 0.8),
      cy = H * (0.1 + R() * 0.8);
    s += hill(
      cx,
      cy,
      u * 0.03,
      14 + Math.floor(R() * 8),
      u * (0.022 + R() * 0.01),
      seed + i * 17,
      i % 2 ? C.teal : C.paper,
      i % 2 ? 0.14 : 0.08,
    );
  }
  // Route through points, dashed red.
  const pts = opts.route ?? [
    [0.12, 0.78],
    [0.3, 0.62],
    [0.46, 0.72],
    [0.64, 0.5],
    [0.86, 0.3],
  ];
  let d = `M${pts[0][0] * W} ${pts[0][1] * H}`;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1],
      [bx, by] = pts[i];
    d += ` Q${((ax + bx) / 2 + (by - ay) * 0.3) * W} ${((ay + by) / 2 - (bx - ax) * 0.3) * H} ${bx * W} ${by * H}`;
  }
  s += `<path d="${d}" fill="none" stroke="${C.red}" stroke-opacity=".85" stroke-width="${u * 0.006}" stroke-dasharray="${u * 0.02} ${u * 0.014}" stroke-linecap="round"/>`;
  const ps = u * 0.0042 * (opts.pinScale ?? 1);
  pts.forEach(([x, y], i) => {
    s +=
      i === pts.length - 1
        ? pin(x * W, y * H, ps * 1.3, C.red)
        : i % 2
          ? check(x * W, y * H, ps * 0.9)
          : pin(x * W, y * H, ps, C.gold);
  });
  (opts.extra ?? []).forEach(([x, y, t]) => {
    s +=
      t === 'c'
        ? check(x * W, y * H, ps * 0.8)
        : pin(x * W, y * H, ps * 0.8, t === 't' ? C.teal : C.gold);
  });
  if (!opts.noVignette) s += `<rect width="${W}" height="${H}" fill="url(#vig)"/>`;
  return s;
}

const markAt = (x, y, size, glow = true) =>
  `<g transform="translate(${x - size / 2} ${y - size / 2}) scale(${size / 1024})">${glow ? `<path d="M232 300 L412 236 L612 300 L792 236 L792 724 L612 788 L412 724 L232 788 Z" fill="${C.teal}" opacity=".35" filter="url(#glow)" transform="translate(0 20)"/>` : ''}<g>${mark()}</g></g>`;
const word = (x, y, size, anchor = 'middle', tag = true) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Inter Display" font-weight="800" font-size="${size}" letter-spacing="${size * 0.12}" fill="${C.paper}" style="paint-order:stroke" stroke="${C.deep}" stroke-opacity=".5" stroke-width="${size * 0.04}">ATLAS</text>` +
  (tag
    ? `<text x="${x}" y="${y + size * 0.48}" text-anchor="${anchor}" font-family="Inter" font-weight="600" font-size="${size * 0.2}" letter-spacing="${size * 0.06}" fill="${C.teal}">MAPS · CHECKLISTS · GUIDES</text>`
    : '');

const svg = (W, H, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

const assets = {
  // Library portrait capsule
  'atlas-steam-grid-600x900.jpg': [
    600,
    900,
    svg(
      600,
      900,
      world(600, 900, 11, {
        route: [
          [0.12, 0.94],
          [0.34, 0.84],
          [0.6, 0.93],
          [0.86, 0.82],
        ],
        extra: [
          [0.2, 0.12, 't'],
          [0.82, 0.1, 'c'],
          [0.88, 0.45, 'g'],
        ],
        hills: 5,
        pinScale: 0.75,
      }) +
        markAt(300, 330, 380) +
        word(300, 590, 92),
    ),
  ],
  // Wide capsule (also used for "recent games")
  'atlas-steam-wide-920x430.jpg': [
    920,
    430,
    svg(
      920,
      430,
      world(920, 430, 23, {
        route: [
          [0.4, 0.93],
          [0.58, 0.82],
          [0.76, 0.93],
          [0.93, 0.74],
        ],
        extra: [
          [0.06, 0.12, 't'],
          [0.62, 0.14, 'c'],
          [0.93, 0.16, 'g'],
        ],
        hills: 4,
        lightX: 0.3,
        pinScale: 0.62,
      }) +
        markAt(200, 215, 300) +
        word(560, 225, 104, 'middle'),
    ),
  ],
  // Hero: no text (Steam lays the logo over it)
  'atlas-steam-hero-3840x1240.jpg': [
    3840,
    1240,
    svg(
      3840,
      1240,
      world(3840, 1240, 37, {
        route: [
          [0.04, 0.3],
          [0.18, 0.14],
          [0.34, 0.34],
          [0.5, 0.2],
          [0.64, 0.5],
          [0.78, 0.3],
          [0.95, 0.45],
        ],
        extra: [
          [0.26, 0.6, 't'],
          [0.4, 0.15, 'c'],
          [0.57, 0.85, 'g'],
          [0.88, 0.8, 't'],
          [0.7, 0.12, 'g'],
        ],
        hills: 7,
        pinScale: 0.55,
        lightX: 0.5,
      }) + markAt(3300, 560, 760),
    ),
  ],
  // Logo: transparent, laid over the hero by Steam
  'atlas-steam-logo-1280x720.png': [
    1280,
    720,
    svg(
      1280,
      720,
      `<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter><filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity=".55"/></filter></defs><g filter="url(#sh)">` +
        markAt(215, 360, 390) +
        word(800, 390, 170, 'middle') +
        `</g>`,
    ),
  ],
  // Icon: the app icon itself
  'atlas-steam-icon-512.png': [
    512,
    512,
    svg(
      512,
      512,
      `<g transform="scale(.5)"><rect x="64" y="64" width="896" height="896" rx="200" fill="${C.navy}"/>${mark()}</g>`,
    ),
  ],
};

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, [w, h, s]] of Object.entries(assets)) {
  fs.writeFileSync(`${OUT}/${name.replace(/\.(png|jpg)$/, '.svg')}`, s);
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<html><body style="margin:0;background:transparent">${s}</body></html>`);
  // The pictures without transparency are JPEG (quality 90), which keeps the hero small; the logo and icon stay PNG.
  const jpeg = name.endsWith('.jpg');
  await page.screenshot({
    path: `${OUT}/${name}`,
    omitBackground: !jpeg,
    clip: { x: 0, y: 0, width: w, height: h },
    ...(jpeg ? { type: 'jpeg', quality: 90 } : {}),
  });
  console.log(name);
}
await browser.close();
