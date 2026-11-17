import { describe, expect, it } from 'vitest';
import {
  describePack,
  mapLinkAddressProblem,
  manifestSchema,
  packDataSchema,
  packReadSchemas,
  type MapLink,
} from './index';
import { makeFixturePack } from './testing/fixture';

const BY_QUERY: MapLink = { hosts: ['maps.example.org'], address: '/isle/*', query: 'spot' };
const BY_PATH: MapLink = { hosts: ['maps.example.org'], address: '/isle/*/spot/{id}' };

describe('links to a location of a map, in the manifest', () => {
  it('writes and reads them, and a manifest without them as before', () => {
    const pack = makeFixturePack();
    const manifest = { ...pack.manifest, mapLinks: [BY_QUERY, BY_PATH] };
    expect(manifestSchema.parse(manifest).mapLinks).toEqual([BY_QUERY, BY_PATH]);
    expect(packReadSchemas.manifestSchema.parse(manifest).mapLinks).toEqual([BY_QUERY, BY_PATH]);
    expect(manifestSchema.parse(pack.manifest)).not.toHaveProperty('mapLinks');
    expect(packReadSchemas.manifestSchema.parse(pack.manifest).mapLinks).toBe(undefined);
  });

  it('names the id in exactly one way, strictly when written', () => {
    const pack = makeFixturePack();
    const wrong: unknown[] = [
      { hosts: ['maps.example.org'], address: '/isle/*' },
      { ...BY_PATH, query: 'spot' },
      { ...BY_QUERY, hosts: [] },
      { ...BY_QUERY, hosts: ['www.maps.example.org'] },
      { ...BY_QUERY, hosts: ['Maps.example.org'] },
      { ...BY_QUERY, address: 'isle/*' },
      { ...BY_QUERY, address: '/isle/*?spot=1' },
      { ...BY_QUERY, query: 'a spot' },
      { ...BY_QUERY, colour: 'red' },
    ];
    for (const link of wrong) {
      const manifest = { ...pack.manifest, mapLinks: [link] };
      expect(manifestSchema.safeParse(manifest).success, JSON.stringify(link)).toBe(false);
    }
    expect(manifestSchema.safeParse({ ...pack.manifest, mapLinks: [] }).success).toBe(false);
  });

  it('reads leniently: an entry that cannot be read is left out, the pack still opens', () => {
    const pack = makeFixturePack();
    const read = (mapLinks: unknown) =>
      packReadSchemas.manifestSchema.parse({ ...pack.manifest, mapLinks }).mapLinks;
    expect(read([BY_QUERY, { hosts: ['maps.example.org'], address: '/isle/*' }, 7])).toEqual([
      BY_QUERY,
    ]);
    // A field of a newer app is dropped from an entry that still reads.
    expect(read([{ ...BY_PATH, later: true }])).toEqual([BY_PATH]);
    expect(read('everything')).toBe(undefined);
  });

  it('checks the address of an entry', () => {
    expect(mapLinkAddressProblem('/isle/*/spot/{id}')).toBeNull();
    expect(mapLinkAddressProblem('/maps/**')).toBeNull();
    expect(mapLinkAddressProblem('/isle/{id}/{id}')).toMatch(/twice/u);
    expect(mapLinkAddressProblem('/isle/spot-{id}')).toMatch(/whole part/u);
    expect(mapLinkAddressProblem('/isle/{game}')).toMatch(/only as \{id\}/u);
    expect(mapLinkAddressProblem('/isle/***')).toMatch(/three/u);
    expect(mapLinkAddressProblem('/isle#spot')).toMatch(/path only/u);
  });

  it('is kept when the manifest is described', () => {
    const pack = makeFixturePack();
    pack.manifest.mapLinks = [BY_QUERY];
    const writtenBy = { name: 'test', version: '1.0.0' };
    const manifest = describePack(pack, { updated: '2026-11-10T12:00:00Z', writtenBy });
    expect(manifest.mapLinks).toEqual([BY_QUERY]);
    expect(packDataSchema.safeParse({ ...pack, manifest }).success).toBe(true);
    expect(
      'mapLinks' in describePack(makeFixturePack(), { updated: '2026-11-10T12:00:00Z', writtenBy }),
    ).toBe(false);
  });
});
