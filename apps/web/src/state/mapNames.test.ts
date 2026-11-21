import { describe, expect, it } from 'vitest';
import { mapsAndLevelsOf, shownName } from './mapNames';

describe('the maps and levels of a game, to rename', () => {
  it('lists each map with its levels when it has several, by the pack names', () => {
    const maps = [
      { id: 'g:map:a', name: 'Isle' },
      { id: 'g:map:b', name: 'Deep' },
      { name: 'No id' },
    ];
    const layers = [
      { id: 'g:layer:a', mapId: 'g:map:a', name: 'Surface' },
      { id: 'g:layer:b1', mapId: 'g:map:b', name: 'Upper' },
      { id: 'g:layer:b2', mapId: 'g:map:b', name: 'Lower' },
    ];
    expect(mapsAndLevelsOf(maps, layers)).toEqual([
      { id: 'g:map:a', name: 'Isle', levels: [] },
      {
        id: 'g:map:b',
        name: 'Deep',
        levels: [
          { id: 'g:layer:b1', name: 'Upper' },
          { id: 'g:layer:b2', name: 'Lower' },
        ],
      },
    ]);
    expect(mapsAndLevelsOf(null, null)).toEqual([]);
  });

  it('shows the person name of a map, else the pack name', () => {
    const names = [{ id: 'g:map:a', name: 'Home', original: 'Isle' }];
    expect(shownName(names, 'g:map:a', 'Isle')).toBe('Home');
    expect(shownName(names, 'g:map:b', 'Deep')).toBe('Deep');
  });
});
