import { describe, expect, it } from 'vitest';
import {
  FLOOR_PALETTE,
  MAX_FLOORS,
  floorBandAt,
  floorBands,
  floorColour,
  floorColourAt,
  floorShade,
} from './floorColours';
// The Map Maker's 2D style draws with the same colours.
import render from '../../../../tools/gamefiles/atlas_gamefiles/render.py?raw';

/** Lowest first, as `floorsOf` gives them: a cellar, the ground floor and an attic. */
const floors = [
  { heights: [-6, 0] as [number, number] },
  { heights: [0, 5] as [number, number] },
  { heights: [5, 12] as [number, number] },
];

describe('Floor colours', () => {
  it('gives each floor its own colour, in the order of the Map Maker’s "Colour by floor"', () => {
    const bands = floorBands(floors);
    expect(bands.map((band) => band.color)).toEqual(['#0072b2', '#e69f00', '#009e73']);
    expect(floorColour(7)).toBe(floorColour(0));
    // The same colours as the 2D style draws (render.py's FLOOR_PALETTE).
    const block = /FLOOR_PALETTE = \(([\s\S]*?)\n\)/.exec(render)?.[1] ?? '';
    const python = [...block.matchAll(/\((\d+), (\d+), (\d+)\)/g)].map(
      (match) =>
        `#${[match[1], match[2], match[3]].map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`,
    );
    expect(python).toEqual([...FLOOR_PALETTE]);
  });

  it('puts a height on the floor floorAt gives', () => {
    const bands = floorBands(floors);
    expect(floorBandAt(bands, -10)).toBe(0);
    expect(floorBandAt(bands, -3)).toBe(0);
    // A floor's bottom is on it.
    expect(floorBandAt(bands, 0)).toBe(1);
    expect(floorBandAt(bands, 4.9)).toBe(1);
    expect(floorBandAt(bands, 5)).toBe(2);
    expect(floorBandAt(bands, 100)).toBe(2);
    expect(floorBandAt([], 3)).toBe(-1);
  });

  it('shades darker low and lighter high within a floor', () => {
    const [cellar, ground] = floorBands(floors);
    expect(floorShade(ground!, 0)).toBeCloseTo(0.55);
    expect(floorShade(ground!, 2.5)).toBeCloseTo(0.775);
    expect(floorShade(ground!, 5)).toBeCloseTo(1);
    // Below the lowest floor, its darkest.
    expect(floorShade(cellar!, -50)).toBeCloseTo(0.55);
    expect(floorShade({ low: 3, high: 3, color: '#000000' }, 3)).toBeCloseTo(0.775);
    expect(floorColourAt(floorBands(floors), 5 - 1e-9)).toBe('#e69f00');
    expect(floorColourAt(floorBands(floors), 0)).toBe('#7f5700');
    expect(floorColourAt([], 0)).toBeNull();
  });

  it('leaves out floors without heights, and tells apart at most MAX_FLOORS', () => {
    expect(floorBands([{}, ...floors])).toHaveLength(3);
    const many = Array.from({ length: 40 }, (_, i) => ({
      heights: [i, i + 1] as [number, number],
    }));
    expect(floorBands(many)).toHaveLength(MAX_FLOORS);
  });
});
