import { describe, expect, it } from 'vitest';
import theme from './styles/theme.css?raw';
import {
  contrast,
  parseColour,
  readableColour,
  TEXT_CONTRAST,
  THEME_COLOURS,
  type ThemeName,
} from './textColour';

/** The tokens of one theme's block in the style sheet. */
function tokens(name: ThemeName): Record<string, string> {
  const block = new RegExp(`:root\\[data-theme='${name}'\\][^{]*\\{([^}]*)\\}`, 'u').exec(
    theme,
  )![1]!;
  return Object.fromEntries(
    [...block.matchAll(/--atlas-([\w-]+):\s*([^;]+);/gu)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

/** A colour with an alpha laid over another, as the page shows it. */
function over(rgba: string, below: string): string {
  const [r, g, b, a] = /rgba\(([^)]*)\)/u.exec(rgba)![1]!.split(',').map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const base = [1, 3, 5].map((i) => parseInt(below.slice(i, i + 2), 16));
  return `#${[r, g, b]
    .map((c, i) =>
      Math.round(a * c + (1 - a) * base[i]!)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

const hue = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  return Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
};

describe('coloured words', () => {
  it('reads only # and three or six hexadecimal digits', () => {
    expect(parseColour('#B8714A')).toBe('#b8714a');
    expect(parseColour('#f80')).toBe('#ff8800');
    for (const text of ['red', '#ffff', '#12345', '#1234567', 'f80', '#ggg', ' #fff', '#fff;']) {
      expect(parseColour(text), text).toBeNull();
    }
  });

  it('knows the backgrounds and text of each theme as the style sheet has them', () => {
    for (const name of ['dark', 'light'] as const) {
      const t = tokens(name);
      expect(THEME_COLOURS[name]).toEqual({
        text: t.text,
        backgrounds: [
          t.bg,
          t.surface,
          t['surface-raised'],
          t['surface-hover'],
          over(t['accent-soft']!, t.surface!),
        ],
      });
    }
  });

  it('shows a colour as written where it reads, and lighter or darker where it does not', () => {
    // Bright words written for a dark page: as they are in the dark theme, darker in the light one.
    expect(readableColour('#f0d60d', 'dark')).toBe('#f0d60d');
    expect(readableColour('#f0d60d', 'light')).not.toBe('#f0d60d');
    // Dark words written for a light page: lighter in the dark theme.
    expect(readableColour('#000080', 'light')).toBe('#000080');
    expect(readableColour('#000080', 'dark')).not.toBe('#000080');
    const samples = ['#f0d60d', '#90abe6', '#b8714a', '#82c936', '#52f1f4', '#000080', '#ff0000'];
    for (const colour of [...samples, '#ffffff', '#000000', '#808080']) {
      for (const name of ['dark', 'light'] as const) {
        const shown = readableColour(colour, name);
        expect(shown).toMatch(/^#[0-9a-f]{6}$/u);
        for (const background of THEME_COLOURS[name].backgrounds) {
          expect(
            contrast(shown, background),
            `${colour} ${name} ${background}`,
          ).toBeGreaterThanOrEqual(TEXT_CONTRAST);
        }
      }
    }
    // Its hue is kept.
    for (const colour of samples) {
      for (const name of ['dark', 'light'] as const) {
        const turn = Math.abs(hue(readableColour(colour, name)) - hue(colour));
        expect(Math.min(turn, 2 * Math.PI - turn), `${colour} ${name}`).toBeLessThan(0.05);
      }
    }
  });

  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});
