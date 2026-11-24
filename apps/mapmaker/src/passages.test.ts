import { describe, expect, it } from 'vitest';
import { clampAlignment, compareKey, startAlignment } from './alignment';
import {
  floorAtPixel,
  methodEntry,
  paintSection,
  placeSlots,
  setShow,
  showOf,
  startChoices,
  startMethod,
} from './floors';
import {
  cutsLine,
  floorMethodLabel,
  waitingCuts,
  type MadeArea,
  type PassagePlace,
} from './report';

const bridge: PassagePlace = {
  id: 0,
  x: 29.5,
  z: 29.5,
  area: 160,
  levels: 2,
  heights: [0, 8],
  show: 'upper',
  set: false,
  sheets: 2,
  floors: [0, 1],
};

function madeArea(plan: MadeArea['floorPlan']): MadeArea {
  return {
    id: 'm99_00_00_00',
    key: 'm99_00',
    name: 'Made-up Street',
    geometry: { used: 'collision' },
    floorPlan: plan,
  };
}

describe('automatic passages in Adjust floors', () => {
  it('sets Upper or Lower per overlapping place, writing only Lower', () => {
    expect(showOf(bridge, [])).toBe('upper');
    const lower = setShow([], bridge, 'lower');
    expect(lower).toEqual([{ x: 29.5, z: 29.5, show: 'lower' }]);
    expect(showOf(bridge, lower)).toBe('lower');
    // Back to upper removes the choice; a choice the helper matched to this place is replaced too.
    expect(setShow(lower, bridge, 'upper')).toEqual([]);
    const matched = { ...bridge, set: true, show: 'lower' as const };
    expect(setShow([{ x: 31, z: 28, show: 'lower' }], matched, 'upper')).toEqual([]);
    const far = { x: 500, z: 500, show: 'lower' as const };
    expect(setShow([far], bridge, 'lower')).toEqual([far, { x: 29.5, z: 29.5, show: 'lower' }]);
  });

  it('writes the floor method into the entry', () => {
    const draft = { cuts: [4.567], names: ['', 'Bridge'] };
    expect(methodEntry('cuts', draft, [], 2)).toEqual({
      method: 'cuts',
      cuts: [4.57],
      names: ['', 'Bridge'],
    });
    expect(methodEntry('passages', draft, [{ x: 1, z: 2, show: 'lower' }], 2)).toEqual({
      method: 'passages',
      passages: [{ x: 1, z: 2, show: 'lower' }],
      names: ['', 'Bridge'],
    });
    expect(methodEntry('passages', { cuts: [], names: [] }, [], 3)).toEqual({
      method: 'passages',
      passages: [],
    });
  });

  it('starts from how the area was made', () => {
    const area = madeArea({
      method: 'passages',
      cuts: [],
      overrides: { from: 'yours', method: 'passages', passages: [{ x: 1, z: 2, show: 'lower' }] },
      passages: { sheets: 2, levels: 2, mainLevel: 1, places: [{ ...bridge, set: true }] },
    });
    expect(startMethod(area)).toBe('passages');
    expect(startChoices(area)).toEqual([{ x: 1, z: 2, show: 'lower' }]);
    expect(startMethod(madeArea({ cuts: [3] }))).toBe('cuts');
    expect(cutsLine(area)).toBe('Automatic passages: 1 overlapping spot, 1 set by you');
    expect(cutsLine(madeArea({ method: 'passages', cuts: [] }))).toBe(
      'Automatic passages: nothing overlaps',
    );
    expect(floorMethodLabel('passages')).toBe('Automatic passages');
    expect(floorMethodLabel(undefined)).toBe('Cuts');
    // Saved choices that differ from those the area was made with are waiting for Make this area again.
    expect(
      waitingCuts(area, { method: 'passages', passages: [{ x: 1, z: 2, show: 'lower' }] }, true),
    ).toBe(false);
    expect(waitingCuts(area, { method: 'passages', passages: [] }, true)).toBe(true);
  });

  it('colours side view pixels by their own floor', () => {
    // Two columns, two rows: a walkable pixel of floor 1 over one of floor 0; walls (value 1 to 127) grey.
    const pixels = new Uint8Array([255, 60, 255, 0]);
    const floors = new Uint8Array([1, 255, 0, 255]);
    const out = paintSection(pixels, 2, 2, 0, 10, [], 1, floors);
    const upper = Array.from(out.slice(0, 3));
    const lower = Array.from(out.slice(8, 11));
    expect(upper).not.toEqual(lower);
    expect(Math.max(...upper)).toBeGreaterThan(Math.max(...lower));
    expect(Array.from(out.slice(12, 16))).toEqual([22, 26, 32, 255]);
    expect(floorAtPixel(floors, 2, 2, 0.1, 0.9)).toBe(0);
    expect(floorAtPixel(floors, 2, 2, 0.9, 0.1)).toBeNull();
    expect(floorAtPixel(null, 2, 2, 0, 0)).toBeNull();
  });
});

describe('overlapping places in a section', () => {
  it('puts places seen at the same spot side by side', () => {
    const slots = placeSlots(
      [
        { across: 30, low: 0, high: 8 },
        { across: 30.5, low: 0, high: 8 },
        { across: 30, low: 20, high: 26 },
        { across: 80, low: 0, high: 8 },
      ],
      3,
    );
    expect(slots).toEqual([0, 1, 0, 0]);
    expect(placeSlots([], 3)).toEqual([]);
  });
});

describe('Compare with a picture', () => {
  it('keeps the alignment in range', () => {
    expect(compareKey('bloodborne', 'M24_01_00_00')).toBe('bloodborne:m24_01');
    const start = startAlignment('C:\\Pictures\\made-up.png');
    expect(start).toMatchObject({
      x: 0.5,
      y: 0.5,
      scale: 1,
      turn: 0,
      opacity: 0.5,
      view: 'overlay',
    });
    const wild = clampAlignment({
      ...start,
      x: Number.NaN,
      scale: 1e9,
      turn: 270,
      opacity: -1,
      view: 'side',
    });
    expect(wild).toMatchObject({ x: 0.5, scale: 100, turn: -90, opacity: 0, view: 'side' });
  });
});
