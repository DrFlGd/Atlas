import { describe, expect, it } from 'vitest';
import { WITCHER3_WORLDS } from '../witcher3/tuning';
import { mapForWorld, suggestMap } from './worlds';

const maps = [
  { id: 'map-1', name: 'White Orchard' },
  { id: 'map-2', name: 'Velen & Novigrad' },
  { id: 'map-3', name: 'Skellige Isles' },
  { id: 'map-4', name: 'Toussaint' },
  { id: 'map-5', name: 'Kaer Morhen' },
];

describe('suggestMap', () => {
  it('suggests the map whose name names the world', () => {
    expect(suggestMap('novigrad', maps, WITCHER3_WORLDS)).toBe('map-2');
    expect(suggestMap('skellige', maps, WITCHER3_WORLDS)).toBe('map-3');
    expect(suggestMap('prolog_village', maps, WITCHER3_WORLDS)).toBe('map-1');
    expect(suggestMap('prolog_village_winter', maps, WITCHER3_WORLDS)).toBe('map-1');
    expect(suggestMap('bob', maps, WITCHER3_WORLDS)).toBe('map-4');
    expect(suggestMap('kaer_morhen', maps, WITCHER3_WORLDS)).toBe('map-5');
  });

  it('ignores case, accents and punctuation', () => {
    const odd = [{ id: 'x', name: 'NO MAN’S LAND — Velen' }];
    expect(suggestMap('novigrad', odd, WITCHER3_WORLDS)).toBe('x');
    expect(suggestMap('bob', [{ id: 'y', name: 'TOUSSAÏNT' }], WITCHER3_WORLDS)).toBe('y');
  });

  it('suggests nothing when no map names the world', () => {
    expect(suggestMap('island_of_mist', maps, WITCHER3_WORLDS)).toBeNull();
    expect(suggestMap('the_spiral', [], WITCHER3_WORLDS)).toBeNull();
  });

  it('falls back on the world id for worlds it does not know', () => {
    expect(suggestMap('some_place', [{ id: 'z', name: 'Some Place' }], WITCHER3_WORLDS)).toBe('z');
  });
});

describe('mapForWorld', () => {
  it('keeps the person’s choice, a choice of no map included', () => {
    expect(mapForWorld('novigrad', maps, WITCHER3_WORLDS, { novigrad: 'map-4' })).toEqual({
      mapId: 'map-4',
      source: 'chosen',
    });
    expect(mapForWorld('novigrad', maps, WITCHER3_WORLDS, { novigrad: null })).toEqual({
      mapId: null,
      source: 'chosen',
    });
  });

  it('suggests a map when there is no choice, or the chosen map is gone', () => {
    expect(mapForWorld('novigrad', maps, WITCHER3_WORLDS, {})).toEqual({
      mapId: 'map-2',
      source: 'suggested',
    });
    expect(mapForWorld('novigrad', maps, WITCHER3_WORLDS, { novigrad: 'gone' })).toEqual({
      mapId: 'map-2',
      source: 'suggested',
    });
    expect(mapForWorld('the_spiral', maps, WITCHER3_WORLDS, {})).toEqual({
      mapId: null,
      source: 'none',
    });
  });
});
