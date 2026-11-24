import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADE,
  isShade,
  lookShown,
  rampAt,
  rampOf,
  RAMP_STOPS,
  SHADE_PRESETS,
  shadedColourAt,
  shadeRamp,
  shadeSwatch,
  SLOPE_SHADE,
  slopeShade,
  STRONG_SLOPE_SHADE,
  texturedReason,
} from './looks';
// The Map Maker colours a model it makes from collision with these.
import render from '../../../../tools/gamefiles/atlas_gamefiles/render.py?raw';
import scenePy from '../../../../tools/gamefiles/atlas_gamefiles/scene.py?raw';

const toHex = (r: string, g: string, b: string) =>
  `#${[r, g, b].map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`;

describe('the looks of the 3D view', () => {
  it('shades in teal at first, with the Map Maker’s own height ramp and slope shades', () => {
    expect(DEFAULT_SHADE).toBe(SHADE_PRESETS[0]!.id);
    const block = /RAMP = \(([\s\S]*?)\n\)/.exec(render)?.[1] ?? '';
    const stops = [...block.matchAll(/\(([\d.]+), \((\d+), (\d+), (\d+)\)\)/g)];
    expect(stops.map((stop) => Number(stop[1]))).toEqual([...RAMP_STOPS]);
    expect(stops.map((stop) => toHex(stop[2]!, stop[3]!, stop[4]!))).toEqual([
      ...shadeRamp('teal'),
    ]);
    const slopes = /SLOPE_SHADE = \((.*)\)\n/.exec(scenePy)?.[1] ?? '';
    const python = [...slopes.matchAll(/\(([\d.]+), ([\d.]+)\)/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(python).toEqual(SLOPE_SHADE.map((entry) => [...entry]));
  });

  it('offers a few colours, each with a ramp dark low and light high', () => {
    expect(SHADE_PRESETS.map((preset) => preset.name)).toEqual([
      'Teal',
      'Stone grey',
      'Sand',
      'Slate blue',
      'Light',
    ]);
    const light = (colour: string) =>
      colour
        .slice(1)
        .match(/../g)!
        .reduce((sum, pair) => sum + parseInt(pair, 16), 0);
    for (const preset of SHADE_PRESETS) {
      const lightness = preset.ramp.map(light);
      expect([...lightness].sort((a, b) => a - b)).toEqual(lightness);
      expect(isShade(preset.id)).toBe(true);
    }
  });

  it('makes a ramp of a colour of the person’s own', () => {
    expect(rampOf('#8040c0')).toEqual(['#331a4d', '#5a2d86', '#8040c0', '#b996dc']);
    expect(shadeRamp('#8040C0')).toEqual(rampOf('#8040c0'));
    expect(shadeSwatch('#8040c0')).toBe('#8040c0');
    expect(shadeSwatch('teal')).toBe('#68b2a4');
    // Anything else: teal.
    expect(shadeRamp('plum')).toEqual(shadeRamp('teal'));
    expect(isShade('#8040c0')).toBe(true);
    expect(isShade('#8040c')).toBe(false);
    expect(isShade('plum')).toBe(false);
    expect(isShade(3)).toBe(false);
  });

  it('shades by height and by slope, more with darker walls', () => {
    expect(rampAt(0, 10, -5)).toBe(0);
    expect(rampAt(0, 10, 4.5)).toBeCloseTo(0.45);
    expect(rampAt(0, 10, 50)).toBe(1);
    expect(rampAt(3, 3, 3)).toBe(0.5);
    expect(slopeShade(SLOPE_SHADE, 10)).toBe(1);
    expect(slopeShade(SLOPE_SHADE, 60)).toBe(0.78);
    expect(slopeShade(SLOPE_SHADE, 90)).toBe(0.55);
    expect(slopeShade(STRONG_SLOPE_SHADE, 90)).toBeLessThan(0.55);
    const teal = shadeRamp('teal');
    expect(shadedColourAt(teal, 0, 1)).toBe('#2e4856');
    expect(shadedColourAt(teal, 0.45, 1)).toBe('#3c767c');
    expect(shadedColourAt(teal, 1, 1)).toBe('#ace0d2');
    expect(shadedColourAt(teal, 0.9, 1)).toBe('#8ac9bb');
    // A wall at the top, darker.
    expect(shadedColourAt(teal, 1, 0.5)).toBe('#567069');
  });

  it('is textured only where the model has textures of its own, and says why not', () => {
    expect(lookShown('textured', true)).toBe('textured');
    expect(lookShown('textured', false)).toBe('shaded');
    expect(lookShown('shaded', true)).toBe('shaded');
    expect(texturedReason(true)).toBeNull();
    expect(texturedReason(false)).toBe('This 3D map has no textures');
    expect(texturedReason(null)).toBe('The 3D map is still loading');
  });
});
