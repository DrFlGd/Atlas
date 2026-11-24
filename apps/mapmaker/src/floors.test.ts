import { describe, expect, it } from 'vitest';
import {
  addCut,
  bandOf,
  canAddCut,
  checkMarker,
  cutNear,
  deleteFloor,
  entryOf,
  floorBands,
  floorColour,
  headCut,
  fromBase64,
  heightTicks,
  lookOf,
  markerTypeText,
  moveCut,
  northText,
  paintSection,
  removeCut,
  renameFloor,
  sameDraft,
  shippedDraft,
  startDraft,
  suggestedCut,
  tipPlace,
  walkableBetween,
} from './floors';
import {
  canAdjustFloors,
  cutsLine,
  floorRangeText,
  heightText,
  MAP_STYLES,
  mapStyleLabel,
  waitingCuts,
  type HeightProfile,
  type MadeArea,
  type MadeFloor,
} from './report';

// A made-up area: 100 m² of floor at 0 m, 40 m² at 9 m, 10 m² at 15 m.
const profile: HeightProfile = {
  low: 0,
  high: 16,
  step: 0.5,
  areas: Array.from({ length: 32 }, (_, i) => (i === 0 ? 100 : i === 18 ? 40 : i === 30 ? 10 : 0)),
};

function area(overrides: Partial<MadeArea> = {}): MadeArea {
  return {
    id: 'm15_01_00_00',
    key: 'm15_01',
    name: 'Made-up Castle',
    geometry: { used: 'collision' },
    mainFloor: 0,
    floorPlan: {
      cuts: [4.5],
      cutList: [{ height: 4.5, by: 'automatic' }],
      profile,
      overrides: { from: 'shipped', names: ['Ground', 'Roof'] },
      shipped: { cuts: [4.5], names: ['Ground', 'Roof'] },
    },
    ...overrides,
  };
}

describe('the floors between the cuts', () => {
  it('splits the heights at each cut', () => {
    expect(floorBands([], 0, 16)).toEqual([{ index: 0, from: 0, to: 16 }]);
    expect(floorBands([4.5, 12], 0, 16)).toEqual([
      { index: 0, from: 0, to: 4.5 },
      { index: 1, from: 4.5, to: 12 },
      { index: 2, from: 12, to: 16 },
    ]);
  });

  it('adds up the walkable floor between two heights, part bars in part', () => {
    expect(walkableBetween(profile, 0, 16)).toBe(150);
    expect(walkableBetween(profile, 4.5, 16)).toBe(50);
    expect(walkableBetween(profile, 0, 0.25)).toBe(50);
  });

  it('suggests a cut in the middle of the floor with the most walkable floor', () => {
    expect(suggestedCut(profile, [])).toBe(8);
    expect(suggestedCut(profile, [4.5])).toBe(2.3);
    expect(suggestedCut(profile, [0.4, 4.5])).toBe(0.2);
    expect(suggestedCut(profile, [8, 12])).toBe(4);
  });

  it('gives each floor a colour, as the side views draw them', () => {
    expect(floorColour(0)).toBe('#4fc1b2');
    expect(floorColour(6)).toBe(floorColour(0));
  });
});

describe('changing the cuts', () => {
  const draft = { cuts: [4.5], names: ['Ground', 'Roof'] };

  it('adds a floor: the floor split keeps its name below the cut', () => {
    expect(addCut(draft, 12)).toEqual({ cuts: [4.5, 12], names: ['Ground', 'Roof', ''] });
    expect(addCut(draft, 2.004)).toEqual({ cuts: [2, 4.5], names: ['Ground', '', 'Roof'] });
    expect(canAddCut(draft, 12, 0, 16)).toBe(true);
    expect(canAddCut(draft, 4.8, 0, 16)).toBe(false);
    expect(canAddCut(draft, 16, 0, 16)).toBe(false);
    expect(canAddCut(draft, Number.NaN, 0, 16)).toBe(false);
  });

  it('deletes a floor into the one below, or the lowest into the one above', () => {
    const three = { cuts: [4.5, 12], names: ['Ground', 'Roof', 'Tower'] };
    expect(deleteFloor(three, 2)).toEqual({ cuts: [4.5], names: ['Ground', 'Roof'] });
    expect(deleteFloor(three, 1)).toEqual({ cuts: [12], names: ['Ground', 'Tower'] });
    expect(deleteFloor(three, 0)).toEqual({ cuts: [12], names: ['Roof', 'Tower'] });
    expect(deleteFloor({ cuts: [], names: ['Only'] }, 0)).toEqual({ cuts: [], names: ['Only'] });
  });

  it('removes a cut: the floors on each side become one, named as the lower', () => {
    expect(removeCut(draft, 0)).toEqual({ cuts: [], names: ['Ground'] });
    expect(removeCut({ cuts: [4.5], names: ['', 'Roof'] }, 0)).toEqual({
      cuts: [],
      names: ['Roof'],
    });
    expect(removeCut(draft, 3)).toBe(draft);
  });

  it('moves a cut, kept between its neighbours and inside the area', () => {
    const three = { cuts: [4.5, 12], names: [] };
    expect(moveCut(three, 0, 6.123, 0, 16).cuts).toEqual([6.12, 12]);
    expect(moveCut(three, 0, 20, 0, 16).cuts).toEqual([11.5, 12]);
    expect(moveCut(three, 1, 99, 0, 16).cuts).toEqual([4.5, 15.9]);
    expect(moveCut(three, 0, -5, 0, 16).cuts).toEqual([0.1, 12]);
    expect(moveCut(three, 0, 4.5, 0, 16)).toBe(three);
    expect(moveCut(three, 0, Number.NaN, 0, 16)).toBe(three);
  });

  it('renames a floor', () => {
    expect(renameFloor(draft, 1, 'Rooftops').names).toEqual(['Ground', 'Rooftops']);
    expect(renameFloor({ cuts: [1], names: [] }, 1, 'x'.repeat(100)).names[1]).toHaveLength(80);
  });
});

describe('the entry saved in the floor cuts file', () => {
  it('starts from the area as made, with the names given by hand', () => {
    expect(startDraft(area())).toEqual({ cuts: [4.5], names: ['Ground', 'Roof'] });
    const plain = area({ floorPlan: { cuts: [3, 9], overrides: null } });
    expect(startDraft(plain)).toEqual({ cuts: [3, 9], names: ['', '', ''] });
  });

  it('goes back to the area’s floors without the player’s cuts', () => {
    expect(shippedDraft(area(), [5])).toEqual({ cuts: [5], names: ['Ground', 'Roof'] });
    expect(shippedDraft(area())).toEqual({ cuts: [4.5], names: ['Ground', 'Roof'] });
  });

  it('holds every cut, and the names only when one is given', () => {
    expect(entryOf({ cuts: [4.567, 9], names: [' Ground ', ''] })).toEqual({
      cuts: [4.57, 9],
      names: ['Ground', '', ''],
    });
    expect(entryOf({ cuts: [], names: ['', ''] })).toEqual({ cuts: [] });
    expect(sameDraft({ cuts: [1], names: [] }, { cuts: [1], names: ['', ''] })).toBe(true);
    expect(sameDraft({ cuts: [1], names: [] }, { cuts: [2], names: [] })).toBe(false);
  });

  it('puts round heights on the axis', () => {
    expect(heightTicks(0, 16)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16]);
    expect(heightTicks(-3.2, 250)).toEqual([0, 50, 100, 150, 200, 250]);
  });
});

describe('the cuts in the report', () => {
  it('says where each cut is and who set it', () => {
    expect(cutsLine(area())).toBe('Cut at 4.5 m (automatic)');
    const yours = area({
      floorPlan: {
        cuts: [-2, 12.25],
        cutList: [
          { height: -2, by: 'yours' },
          { height: 12.25, by: 'shipped' },
        ],
      },
    });
    expect(cutsLine(yours)).toBe('Cuts at −2 m (set by you) and 12.25 m (set in the Map Maker)');
    expect(cutsLine(area({ floorPlan: { cuts: [], cutList: [] } }))).toBe('No cut: one floor');
    expect(cutsLine(area({ geometry: { used: null } }))).toBeNull();
    expect(heightText(6.3)).toBe('6.3 m');
  });

  it('says where each floor lies between the cuts', () => {
    const floor = (between: [number | null, number | null]) =>
      ({ between }) as unknown as MadeFloor;
    expect(floorRangeText(floor([null, 4.5]))).toBe('up to 4.5 m');
    expect(floorRangeText(floor([4.5, 12]))).toBe('4.5 to 12 m');
    expect(floorRangeText(floor([12, null]))).toBe('from 12 m');
    expect(floorRangeText(floor([null, null]))).toBe('');
  });

  it('offers Adjust floors for areas drawn from geometry, and notes cuts not in the map yet', () => {
    expect(canAdjustFloors(area())).toBe(true);
    expect(canAdjustFloors(area({ skipped: 'a debug map' }))).toBe(false);
    expect(canAdjustFloors(area({ geometry: { used: null } }))).toBe(false);
    expect(waitingCuts(area(), undefined, false)).toBe(false);
    expect(waitingCuts(area(), { cuts: [6] }, false)).toBe(true);
    const mine = area({
      floorPlan: { cuts: [6], overrides: { from: 'yours', cuts: [6] } },
    });
    expect(waitingCuts(mine, { cuts: [6] }, true)).toBe(false);
    expect(waitingCuts(mine, { cuts: [7] }, true)).toBe(true);
    expect(waitingCuts(mine, undefined, true)).toBe(true);
  });
});

describe('the markers and the section', () => {
  const cuts = [1.75, 6.75];

  it('puts a marker on a floor and points out one near a cut', () => {
    expect(bandOf(cuts, 0)).toBe(0);
    expect(bandOf(cuts, 5)).toBe(1);
    expect(cutNear(cuts, 2.5)).toBe(1.75);
    expect(cutNear(cuts, 4)).toBeNull();
    const nearStairs = checkMarker(cuts, 2.5, { floor: 1, surface: 2.4 });
    expect(nearStairs).toEqual({ floor: 1, nearCut: 1.75, otherFloor: false, noSurface: false });
    expect(lookOf(nearStairs)).toBe(1);
    // On a surface below the cut, though its own height is above it.
    const across = checkMarker(cuts, 7.2, { floor: 1, surface: 6.0 });
    expect(across.otherFloor).toBe(true);
    expect(lookOf(across)).toBe(2);
    expect(checkMarker(cuts, 4, { floor: 1, surface: null }).noSurface).toBe(true);
    expect(checkMarker(cuts, 4, undefined)).toEqual({
      floor: 1,
      nearCut: null,
      otherFloor: false,
      noSurface: false,
    });
    expect(markerTypeText('ring')).toBe('Ring');
    expect(markerTypeText('made-up')).toBe('Other item');
  });

  it('colours the section by the floor of each row', () => {
    // Two rows of two pixels from 10 m down to 0 m: a wall and a floor above the cut at 5 m, nothing and a
    // floor below it.
    const pixels = new Uint8Array([60, 200, 0, 255]);
    const out = paintSection(pixels, 2, 2, 0, 10, [5], 1);
    expect(Array.from(out.slice(8, 12))).toEqual([22, 26, 32, 255]);
    const upper = Array.from(out.slice(4, 7));
    const lower = Array.from(out.slice(12, 15));
    expect(upper).not.toEqual(lower);
    expect(Math.max(...upper)).toBeGreaterThan(Math.max(...Array.from(out.slice(0, 3))));
    expect(Array.from(fromBase64('AAH/'))).toEqual([0, 1, 255]);
  });

  it('turns the floor from above and keeps notes inside the views', () => {
    expect([0, 1, 2, 3, 4, -1].map(northText)).toEqual([
      'north up',
      'north to the right',
      'north down',
      'north to the left',
      'north up',
      'north to the left',
    ]);
    expect(tipPlace(0.5, 0.5)).toBe('translate(-50%, calc(-100% - 12px))');
    expect(tipPlace(0.1, 0.1)).toBe('translate(-8%, 14px)');
    expect(tipPlace(0.9, 0.5)).toBe('translate(-92%, calc(-100% - 12px))');
  });

  it('lists the map styles, the textured ones not yet', () => {
    expect(MAP_STYLES.filter((style) => style.available).map((style) => style.id)).toEqual([
      'shaded',
      'outlines',
      'floors',
    ]);
    expect(mapStyleLabel('outlines')).toBe('Height shaded with outlines');
    expect(mapStyleLabel('floors')).toBe('Colour by floor');
    expect(mapStyleLabel(undefined)).toBe('Height shaded');
  });
});

describe('going to an item in the 3D view', () => {
  it('cuts at head height above it, never above its floor’s top', () => {
    expect(bandOf([4, 9], 5.5)).toBe(1);
    expect(headCut(5.5, 9)).toBeCloseTo(8.5);
    expect(headCut(7, 9)).toBeCloseTo(8.8);
    expect(headCut(8.9, 9)).toBe(9);
    expect(headCut(12, 9)).toBe(15);
    expect(headCut(12, null)).toBe(15);
  });
});
