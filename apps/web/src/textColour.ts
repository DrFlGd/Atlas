/**
 * Coloured words of a guide, `[like this]{color=#b8714a}` (see
 * `markdownMarks.ts`), shown readable in both themes. A colour a page was
 * written with suits the background it was written on, often one darker or
 * lighter than the app's: yellow words chosen for a dark page are not read
 * on a white one. So each theme shows the colour with its hue and
 * saturation, its lightness moved toward the theme's own text until it
 * stands out from every background guide text is shown on in that theme
 * as well as the contrast WCAG asks of text (4.5 to 1). A colour that does
 * already is shown as written.
 *
 * The renderer writes the colour only as an attribute, `data-text-colour`,
 * after checking it is `#` and six hexadecimal digits; the page then sets
 * each element's colours with {@link showTextColours}, through the
 * element's style object. The guide's text never becomes a `style`
 * attribute, which the desktop app's content security policy would refuse
 * anyway.
 */

/** The attribute a coloured part of a guide carries its colour in. */
export const TEXT_COLOUR_ATTRIBUTE = 'data-text-colour';

/** A colour as a guide writes it: `#` and three or six hexadecimal digits. */
const WRITTEN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

/** A colour as the renderer passes it on: `#` and six lowercase hexadecimal digits. */
const PASSED = /^#[0-9a-f]{6}$/u;

/** The colour `text` writes, as `#rrggbb` in lowercase; null when it is not one. */
export function parseColour(text: string): string | null {
  if (!WRITTEN.test(text)) return null;
  const digits = text.slice(1).toLowerCase();
  return digits.length === 3 ? digits.replace(/./gu, '$&$&').replace(/^/u, '#') : `#${digits}`;
}

export type ThemeName = 'dark' | 'light';

/**
 * The text colour of each theme and the backgrounds guide text stands on
 * there (the page, a surface, a raised surface such as a table's headings,
 * one pointed at, and hidden text once shown, its accent laid over a
 * surface), as `styles/theme.css` has them; a test keeps the two the same.
 */
export const THEME_COLOURS: Record<ThemeName, { text: string; backgrounds: readonly string[] }> = {
  dark: {
    text: '#e8ebef',
    backgrounds: ['#0e1115', '#161a20', '#1d222a', '#242a33', '#223738'],
  },
  light: {
    text: '#171c23',
    backgrounds: ['#eef0f3', '#ffffff', '#f6f7f9', '#eceff3', '#e2efed'],
  },
};

/** The contrast text needs with its background (WCAG 2, level AA). */
export const TEXT_CONTRAST = 4.5;

type Rgb = [number, number, number];

const rgbOf = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

const hexOf = (rgb: Rgb): string =>
  `#${rgb
    .map((channel) =>
      Math.round(Math.min(1, Math.max(0, channel)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Relative luminance, as WCAG defines it. */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast of two colours, from 1 (the same) to 21 (black and white). */
export function contrast(a: string, b: string): number {
  const x = luminance(rgbOf(a));
  const y = luminance(rgbOf(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function toHsl([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) / 6
      : max === g
        ? ((b - r) / d + 2) / 6
        : ((r - g) / d + 4) / 6;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)];
}

const readsOn = (colour: string, theme: ThemeName) =>
  THEME_COLOURS[theme].backgrounds.every(
    (background) => contrast(colour, background) >= TEXT_CONTRAST,
  );

/**
 * `colour` (`#rrggbb`) as `theme` shows it: as it is when it reads on each
 * of the theme's backgrounds, or else as light (in the dark theme) or as
 * dark (in the light one) as it must be to read there, its hue kept.
 */
export function readableColour(colour: string, theme: ThemeName): string {
  if (readsOn(colour, theme)) return colour;
  const [h, s, l] = toHsl(rgbOf(colour));
  const step = theme === 'dark' ? 0.01 : -0.01;
  for (let lightness = l + step; lightness >= 0 && lightness <= 1; lightness += step) {
    const shown = hexOf(fromHsl(h, s, lightness));
    if (readsOn(shown, theme)) return shown;
  }
  // White on the dark backgrounds, black on the light ones, always read.
  return theme === 'dark' ? '#ffffff' : '#000000';
}

const shownColours = new Map<string, { dark: string; light: string }>();

/**
 * Sets the colours each coloured part under `root` shows in the two
 * themes, which the app's style sheet picks between. Done again after the
 * page is shown anew; a part already done is left.
 */
export function showTextColours(root: Element): void {
  root.querySelectorAll<HTMLElement>(`[${TEXT_COLOUR_ATTRIBUTE}]`).forEach((element) => {
    const colour = element.getAttribute(TEXT_COLOUR_ATTRIBUTE) ?? '';
    if (!PASSED.test(colour)) return;
    let shown = shownColours.get(colour);
    if (!shown) {
      shown = { dark: readableColour(colour, 'dark'), light: readableColour(colour, 'light') };
      shownColours.set(colour, shown);
    }
    element.style.setProperty('--text-colour-dark', shown.dark);
    element.style.setProperty('--text-colour-light', shown.light);
  });
}
