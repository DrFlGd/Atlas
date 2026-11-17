import type { Location, MapLink } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  locationsBySiteId,
  mapLinkId,
  mapLinkIds,
  mapLinkTarget,
  siteIdOfLocation,
} from './mapLinks';

const BY_QUERY: MapLink = { hosts: ['maps.example.org'], address: '/isle/*', query: 'spot' };
const BY_PATH: MapLink = { hosts: ['atlas.example.net'], address: '/m/*/spot/{id}' };

const at = (id: string): Location => ({
  id,
  mapId: 'isle-map:map:world',
  layerId: 'isle-map:layer:world',
  x: 0,
  y: 0,
  categoryId: 'isle-map:cat:chest',
  regionId: null,
  name: id,
  entityIds: [],
  guideId: null,
  since: '1.0.0',
});

describe('the id a web link names', () => {
  it('is the value of the query, on a host of the entry, with or without www.', () => {
    expect(mapLinkId([BY_QUERY], 'https://maps.example.org/isle/harbour?spot=470169')).toBe(
      '470169',
    );
    expect(mapLinkId([BY_QUERY], 'https://www.maps.example.org/isle/harbour/?x=1&spot=17')).toBe(
      '17',
    );
    expect(mapLinkId([BY_QUERY], 'http://maps.example.org/isle/harbour?spot=17#top')).toBe('17');
  });

  it('is the part of the path at {id}', () => {
    expect(mapLinkId([BY_PATH], 'https://atlas.example.net/m/harbour/spot/key-7')).toBe('key-7');
    expect(mapLinkId([BY_PATH], 'https://atlas.example.net/m/harbour/spot/key%2D7/')).toBe('key-7');
  });

  it('is none for a link that fits no entry', () => {
    const none = [
      'https://maps.example.org/isle/harbour',
      'https://maps.example.org/isle/harbour?spot=',
      'https://maps.example.org/isle/harbour/deep?spot=17',
      'https://maps.example.org/Isle/harbour?spot=17',
      'https://other.example.org/isle/harbour?spot=17',
      'https://evil.maps.example.org.example.com/isle/harbour?spot=17',
      'https://name:word@maps.example.org/isle/harbour?spot=17',
      'https://maps.example.org/isle/harbour?spot=a%20b',
      'https://atlas.example.net/m/harbour/spot/',
      'demo:loc:17',
      '/isle/harbour?spot=17',
      'not an address',
    ];
    for (const href of none) expect(mapLinkId([BY_QUERY, BY_PATH], href), href).toBeNull();
    expect(mapLinkId([], 'https://maps.example.org/isle/harbour?spot=17')).toBeNull();
  });

  it('reads several ids with commas between them, and an id that ends with a comma', () => {
    const href = (spot: string) => `https://maps.example.org/isle/harbour?spot=${spot}`;
    expect(mapLinkIds([BY_QUERY], href('17,'))).toEqual(['17']);
    expect(mapLinkId([BY_QUERY], href('17,'))).toBe('17');
    expect(mapLinkIds([BY_QUERY], href('17,18,%2019,17'))).toEqual(['17', '18', '19']);
    expect(mapLinkId([BY_QUERY], href('17,18'))).toBe('17');
    // A part that cannot be an id is left out; a link of only such parts names nothing.
    expect(mapLinkIds([BY_QUERY], href(',a%20b,18'))).toEqual(['18']);
    expect(mapLinkIds([BY_QUERY], href(','))).toEqual([]);
    expect(mapLinkId([BY_QUERY], href(','))).toBeNull();
    expect(mapLinkIds([BY_PATH], 'https://atlas.example.net/m/harbour/spot/key-7,key-8')).toEqual([
      'key-7',
      'key-8',
    ]);
  });

  it('takes the first entry the link fits', () => {
    const wide: MapLink = { hosts: ['maps.example.org'], address: '/**', query: 'at' };
    expect(mapLinkId([wide, BY_QUERY], 'https://maps.example.org/isle/harbour?spot=17&at=9')).toBe(
      '9',
    );
    expect(mapLinkId([wide, BY_QUERY], 'https://maps.example.org/isle/harbour?spot=17')).toBe('17');
  });
});

describe('the location of a site id', () => {
  it('is the local id of a location’s id, never one a person made', () => {
    expect(siteIdOfLocation('isle-map:loc:470169')).toBe('470169');
    expect(siteIdOfLocation('isle-map:loc:key.7')).toBe('key.7');
    expect(siteIdOfLocation('isle-map:loc:own.k3f9a2c1')).toBeNull();
    expect(siteIdOfLocation('not an id')).toBeNull();
  });

  it('is found in the game shown first, then in the other games of its title', () => {
    const shown = [at('isle-map:loc:17'), at('isle-map:loc:18'), at('isle-map:loc:own.17')];
    const other = [at('isle-two:loc:18'), at('isle-two:loc:19')];
    const games = [
      { gameId: 'isle-map', locations: shown },
      { gameId: 'isle-two', locations: other },
    ];
    const href = (spot: string) => `https://maps.example.org/isle/harbour?spot=${spot}`;
    expect(mapLinkTarget([BY_QUERY], href('18'), games)).toEqual({
      gameId: 'isle-map',
      locationId: 'isle-map:loc:18',
    });
    expect(mapLinkTarget([BY_QUERY], href('19'), games)).toEqual({
      gameId: 'isle-two',
      locationId: 'isle-two:loc:19',
    });
    expect(mapLinkTarget([BY_QUERY], href('20'), games)).toBeNull();
    expect(mapLinkTarget([BY_QUERY], href('own.17'), games)).toBeNull();
    expect(mapLinkTarget([], href('18'), games)).toBeNull();
    // An id that ends with a comma; and of several, the first any game has.
    expect(mapLinkTarget([BY_QUERY], href('18,'), games)).toEqual({
      gameId: 'isle-map',
      locationId: 'isle-map:loc:18',
    });
    expect(mapLinkTarget([BY_QUERY], href('20,19,18'), games)).toEqual({
      gameId: 'isle-two',
      locationId: 'isle-two:loc:19',
    });
  });

  it('is looked up in one table per list of locations', () => {
    const locations = [at('isle-map:loc:17')];
    expect(locationsBySiteId(locations)).toBe(locationsBySiteId(locations));
    expect(locationsBySiteId(locations).get('17')).toBe('isle-map:loc:17');
  });
});
