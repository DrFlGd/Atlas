import { ICON_NAMES, resolveIconName, type IconName } from '@atlas/schema';

/**
 * The marker glyph set. Each glyph is drawn on a 24 × 24 grid as SVG path
 * data: `shape` is filled with the glyph colour (non-zero rule), then
 * `holes`, when present, is filled with the badge colour behind the glyph
 * (even-odd rule) to cut details such as eyes or keyholes. The same data is
 * used for canvas sprites (through `Path2D`) and for inline SVG icons.
 */
export interface Glyph {
  shape: string;
  holes?: string;
}

export const GLYPH_GRID = 24;

const n = (value: number) => String(Math.round(value * 100) / 100);

function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0Z`;
}

function rect(x: number, y: number, width: number, height: number): string {
  return `M${n(x)} ${n(y)}h${n(width)}v${n(height)}h${n(-width)}Z`;
}

function polygon(points: readonly (readonly [number, number])[]): string {
  return `${points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('')}Z`;
}

/** A regular polygon with its first corner at `rotation` degrees from straight up. */
function regular(sides: number, cx: number, cy: number, r: number, rotation = 0): string {
  const points: [number, number][] = [];
  for (let i = 0; i < sides; i++) {
    const angle = ((rotation + (360 / sides) * i) * Math.PI) / 180;
    points.push([cx + r * Math.sin(angle), cy - r * Math.cos(angle)]);
  }
  return polygon(points);
}

function star(points: number, cx: number, cy: number, outer: number, inner: number): string {
  const corners: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const angle = (Math.PI / points) * i;
    corners.push([cx + r * Math.sin(angle), cy - r * Math.cos(angle)]);
  }
  return polygon(corners);
}

/** A rectangle of `length` × `width` centred on (cx, cy), its length turned `angle` degrees from horizontal. */
function rotatedRect(cx: number, cy: number, length: number, width: number, angle: number): string {
  const a = (angle * Math.PI) / 180;
  const ux = (Math.cos(a) * length) / 2;
  const uy = (Math.sin(a) * length) / 2;
  const vx = (-Math.sin(a) * width) / 2;
  const vy = (Math.cos(a) * width) / 2;
  return polygon([
    [cx - ux - vx, cy - uy - vy],
    [cx + ux - vx, cy + uy - vy],
    [cx + ux + vx, cy + uy + vy],
    [cx - ux + vx, cy - uy + vy],
  ]);
}

const GLYPHS: Record<IconName, Glyph> = {
  pin: {
    shape:
      'M12 2a7.5 7.5 0 0 0-7.5 7.5C4.5 15 12 22.5 12 22.5S19.5 15 19.5 9.5A7.5 7.5 0 0 0 12 2Z',
    holes: circle(12, 9.5, 3),
  },
  star: { shape: star(5, 12, 13, 10.5, 4.4) },
  diamond: {
    shape: polygon([
      [12, 2],
      [21, 12],
      [12, 22],
      [3, 12],
    ]),
  },
  square: { shape: rect(4, 4, 16, 16) },
  triangle: {
    shape: polygon([
      [12, 3],
      [22, 20.5],
      [2, 20.5],
    ]),
  },
  circle: { shape: circle(12, 12, 9) },
  hexagon: { shape: regular(6, 12, 12, 10, 0) },
  cross: { shape: 'M9 2.5h6v6.5h6.5v6H15v6.5H9V15H2.5V9H9Z' },
  skull: {
    shape:
      'M12 2.5c-4.7 0-8.5 3.4-8.5 8 0 2.7 1.3 4.6 3 5.7V20a1.5 1.5 0 0 0 1.5 1.5h8A1.5 1.5 0 0 0 17.5 20v-3.8c1.7-1.1 3-3 3-5.7 0-4.6-3.8-8-8.5-8Z',
    holes: `${circle(8.6, 11, 2.1)}${circle(15.4, 11, 2.1)}${polygon([
      [12, 13.6],
      [13.3, 16],
      [10.7, 16],
    ])}${rect(9.5, 18, 1.2, 3.5)}${rect(13.3, 18, 1.2, 3.5)}`,
  },
  key: {
    shape: `${circle(7.5, 12, 5.5)}M12.6 10.5H22v3h-2v3.5h-3v-3.5h-1.5v2.5h-3v-2.5h-0.4Z`,
    holes: circle(7.5, 12, 2.2),
  },
  chest: {
    shape: 'M6 3.5h12A3 3 0 0 1 21 6.5V10H3V6.5A3 3 0 0 1 6 3.5ZM3 11.5h18V20.5H3Z',
    holes: rect(10.5, 9, 3, 5),
  },
  flask: {
    shape:
      'M8.5 2h7v2.5H14.5v4.6l5.8 9.6A2.2 2.2 0 0 1 18.4 22H5.6a2.2 2.2 0 0 1-1.9-3.3l5.8-9.6V4.5H8.5Z',
    holes: polygon([
      [7.4, 15],
      [16.6, 15],
      [15.3, 12.8],
      [8.7, 12.8],
    ]),
  },
  scroll: {
    shape:
      'M7 3h12a2.5 2.5 0 0 1 0 5h-1.5v10.5A2.5 2.5 0 0 1 15 21H5a2.5 2.5 0 0 1 0-5h1.5V5.5A2.5 2.5 0 0 1 7 3Z',
    holes: `${rect(9, 8, 6, 1.6)}${rect(9, 11.2, 6, 1.6)}${rect(9, 14.4, 4, 1.6)}`,
  },
  sword: {
    shape: `M10.5 1.5h3l1 3V15h-5V4.5ZM5 15h14v2.5H5ZM10.8 17.5h2.4v3h-2.4Z${circle(12, 21.3, 1.6)}`,
    holes: rect(11.5, 5, 1, 9),
  },
  shield: {
    shape: 'M12 2l8.5 3.2V11c0 5.4-3.6 9.3-8.5 11-4.9-1.7-8.5-5.6-8.5-11V5.2Z',
    holes: 'M12 5.2l5.5 2.1V11c0 3.6-2.2 6.4-5.5 7.8Z',
  },
  gem: {
    shape: polygon([
      [7, 3],
      [17, 3],
      [21.5, 9],
      [12, 21.5],
      [2.5, 9],
    ]),
    holes: `${rect(3.5, 8.6, 17, 1.2)}${polygon([
      [11.4, 9.8],
      [12.6, 9.8],
      [12.3, 18],
      [11.7, 18],
    ])}`,
  },
  flame: {
    shape:
      'M12.5 1.5c1 4.2 6.5 6.3 6.5 12.4A7 7 0 0 1 5 13.9c0-3.4 2-5.6 3.4-6.8 0 2.3 1 3.6 2.4 3.9-.4-3.4.2-6.6 1.7-9.5Z',
    holes: 'M12 13.5c1.2 1.8 3 2.6 3 4.6a3 3 0 0 1-6 0c0-1.7 1.6-2.6 3-4.6Z',
  },
  leaf: {
    shape:
      'M20.5 2.5C11 2.5 4 7 4 14.5c0 1.8.5 3.3 1.3 4.5L2.5 21.8l1.7 1.7 2.8-2.8c1.2.8 2.7 1.3 4.5 1.3 7.5 0 9-9 9-19.5Z',
    holes: 'M7 19.5c3.5-4.5 6.5-8 10.5-12l.9.9c-4 4-7 7.5-10.4 11.9Z',
  },
  person: { shape: `${circle(12, 6.5, 4.2)}M3.5 22c0-5.5 3.8-9.5 8.5-9.5s8.5 4 8.5 9.5Z` },
  door: {
    shape: 'M4.5 22V10a7.5 7.5 0 0 1 15 0v12Z',
    holes: `${circle(15.2, 14.5, 1.3)}${rect(11.4, 3.5, 1.2, 18.5)}`,
  },
  tower: {
    shape: 'M5 2.5h3.2v2.5h2.2V2.5h3.2v2.5h2.2V2.5H19V9l-2 2v11H7V11L5 9Z',
    holes: 'M10.5 22v-4.5a1.5 1.5 0 0 1 3 0V22ZM11 11.5h2v3h-2Z',
  },
  cave: {
    shape: polygon([
      [1.5, 21],
      [8.5, 6],
      [12, 10.5],
      [14.5, 7],
      [22.5, 21],
    ]),
    holes: 'M8 21v-3.5a4 4 0 0 1 8 0V21Z',
  },
  anchor: {
    shape: `${circle(12, 4.5, 2.8)}M10.8 7h2.4v12.6c2.6-.4 4.8-2.1 5.6-4.6l-2-.5 4.2-3.5 1.5 5.3-1.6-.4C19.6 19.3 16 22 12 22S4.4 19.3 3.1 15.9l-1.6.4L3 11l4.2 3.5-2 .5c.8 2.5 3 4.2 5.6 4.6ZM7.5 9.2h9v2.3h-9Z`,
    holes: circle(12, 4.5, 1.1),
  },
  flag: { shape: 'M4.5 2h2.2v20H4.5ZM6.7 3H20l-3.4 4.8L20 12.6H6.7Z' },
  book: {
    shape:
      'M2 4.5c3.3-1.2 6.5-1 9 .9v16c-2.5-1.7-5.7-2-9-.8ZM13 5.4c2.5-1.9 5.7-2.1 9-.9v16.1c-3.3-1.2-6.5-.9-9 .8Z',
  },
  coin: {
    shape: circle(12, 12, 9.5),
    holes: `${circle(12, 12, 6.8)}${circle(12, 12, 5.2)}${rect(11.2, 8.5, 1.6, 7)}`,
  },
  crown: {
    shape: `M2.5 8l5 4.5L12 4.5l4.5 8 5-4.5-2 11.5h-15ZM4.5 20.5h15V22h-15Z`,
    holes: circle(12, 14.5, 1.5),
  },
  eye: {
    shape: 'M1 12c3-5 7-7.5 11-7.5s8 2.5 11 7.5c-3 5-7 7.5-11 7.5S4 17 1 12Z',
    holes: `${circle(12, 12, 4.6)}${circle(12, 12, 2.4)}`,
  },
  paw: {
    shape: `${circle(5.5, 10, 2.3)}${circle(9.5, 5.5, 2.4)}${circle(14.5, 5.5, 2.4)}${circle(18.5, 10, 2.3)}M12 11c3.3 0 6.5 4.3 6.5 7.4a3.2 3.2 0 0 1-3.2 3.1c-1.3 0-2.2-.6-3.3-.6s-2 .6-3.3.6a3.2 3.2 0 0 1-3.2-3.1C5.5 15.3 8.7 11 12 11Z`,
  },
  hammer: {
    shape: `${rotatedRect(8.5, 15.5, 15, 3.2, -45)}${rotatedRect(15.2, 8.8, 14, 6, 45)}`,
  },
};

/** The glyph for an icon name, falling back to `pin` for unknown names. */
export function glyphFor(name: string): Glyph {
  return GLYPHS[resolveIconName(name)];
}

/** Every glyph, in the order of {@link ICON_NAMES}. */
export function allGlyphs(): { name: IconName; glyph: Glyph }[] {
  return ICON_NAMES.map((name) => ({ name, glyph: GLYPHS[name] }));
}

/**
 * The glyph colour that reads best on a badge of the given `#rrggbb` fill:
 * near-black on light fills, near-white on dark ones.
 */
export function glyphColorOn(fill: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!match) return '#101318';
  const value = Number.parseInt(match[1]!, 16);
  const channel = (shift: number) => {
    const c = ((value >> shift) & 0xff) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
  // Picks whichever of the two glyph colours gives the higher contrast ratio.
  const onDark = 1.05 / (luminance + 0.05);
  const onLight = (luminance + 0.05) / (0.0065 + 0.05);
  return onLight >= onDark ? '#101318' : '#f6f7f9';
}
