import { describe, expect, it } from 'vitest';
import { selectShown, shownCount } from './selectShown';

describe('Tick all and Tick none', () => {
  it('tick what is shown and not ticked, and untick what is shown and ticked', () => {
    const selection = selectShown(['a', 'b', 'c', 'd'], new Set(['b', 'd', 'hidden']));
    expect(selection).toEqual({
      shown: 4,
      ticked: 2,
      toTick: ['a', 'c'],
      toUntick: ['b', 'd'],
    });
  });

  it('never act on what the filter or search hides', () => {
    const selection = selectShown(['a'], ['hidden', 'a']);
    expect(selection.toUntick).toEqual(['a']);
    expect(selection.toTick).toEqual([]);
  });

  it('count a key shown twice once', () => {
    expect(selectShown(['a', 'b', 'a'], [])).toEqual({
      shown: 2,
      ticked: 0,
      toTick: ['a', 'b'],
      toUntick: [],
    });
  });

  it('have nothing to do when nothing is shown, everything is ticked, or nothing is', () => {
    expect(selectShown([], ['a'])).toEqual({ shown: 0, ticked: 0, toTick: [], toUntick: [] });
    expect(selectShown(['a', 'b'], ['a', 'b']).toTick).toEqual([]);
    expect(selectShown(['a', 'b'], []).toUntick).toEqual([]);
  });

  it('say how many are shown and ticked', () => {
    expect(shownCount({ shown: 12, ticked: 3 }, 'game', 'games')).toBe(
      '12 games to tick, 3 of them ticked',
    );
    expect(shownCount({ shown: 1, ticked: 0 }, 'page', 'pages')).toBe(
      '1 page to tick, not ticked yet',
    );
    expect(shownCount({ shown: 2500, ticked: 2500 }, 'page', 'pages')).toBe(
      '2,500 pages to tick, all of them ticked',
    );
  });
});
