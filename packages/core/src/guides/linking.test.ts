import type { GuideEntry, Location } from '@atlas/schema';
import { makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { indexPack } from '../pack/loadedPack';
import { GuideContents, guidesTogether } from './contents';
import {
  MapNames,
  baseName,
  matchPages,
  nameKey,
  specificity,
  stemWord,
  type NamesSource,
} from './linking';

const loc = (id: string, name: string, categoryId: string, regionId: string | null = null) =>
  ({
    id: `isle:loc:${id}`,
    mapId: 'isle:map:m',
    layerId: 'isle:layer:l',
    x: 1,
    y: 1,
    categoryId: `isle:cat:${categoryId}`,
    regionId: regionId ? `isle:region:${regionId}` : null,
    name,
    entityIds: [],
    guideId: null,
    since: '1.0.0',
  }) satisfies Location;

const cat = (id: string, name: string) => ({
  id: `isle:cat:${id}`,
  groupId: 'isle:catgroup:g',
  name,
  icon: 'pin',
  color: '#ffffff',
  trackable: true,
  defaultVisible: true,
});

/** A made-up isle: types, numbered and shared names, and nested regions. */
function isle(): NamesSource {
  const locations: Location[] = [
    loc('w1', 'Old waystone', 'waystone', 'north'),
    loc('w2', 'Lake waystone', 'waystone', 'south'),
    ...Array.from({ length: 44 }, (_, i) => loc(`c${i}`, 'Copper coin', 'coin', 'north')),
    loc('s1', 'Stone warden 1', 'foe', 'peaks'),
    loc('s2', 'Stone warden 2', 'foe', 'south'),
    loc('d1', 'Wolf den', 'den', 'north'),
    loc('d2', 'Wolf den', 'den', 'south'),
    loc('k1', "Hunters' camp", 'camp', 'south'),
    loc('r1', 'Ruin', 'ruin', 'south'),
    loc('g1', 'Glass key', 'key', null),
  ];
  return {
    locations,
    categories: [
      cat('waystone', 'Waystone'),
      cat('coin', 'Coin'),
      cat('foe', 'Elite foe'),
      cat('den', 'Beast den'),
      cat('camp', 'Camp'),
      cat('ruin', 'Ruin'),
      cat('key', 'Key'),
    ],
    regions: [
      { id: 'isle:region:north', mapId: 'isle:map:m', parentId: null, name: 'The North' },
      {
        id: 'isle:region:peaks',
        mapId: 'isle:map:m',
        parentId: 'isle:region:north',
        name: 'Peaks',
      },
      { id: 'isle:region:south', mapId: 'isle:map:m', parentId: null, name: 'Southreach' },
    ],
  };
}

const page = (id: string, title: string, source = true): GuideEntry => ({
  id: `isle:guide:${id}`,
  title,
  body: '',
  locationIds: [],
  ...(source
    ? {
        source: {
          url: `https://wiki.example.org/wiki/${id}`,
          site: 'Example Wiki',
          license: { name: 'CC BY-SA 4.0' },
          readAt: '2026-11-01',
        },
      }
    : {}),
});

describe('comparing names', () => {
  it('ignores case, accents, punctuation, a leading article, a note in brackets and plurals', () => {
    expect(nameKey('The Waystones')).toBe(nameKey('waystone'));
    expect(nameKey('Hunter’s Camps')).toBe(nameKey("Hunters' camp"));
    expect(nameKey('Iron-bound chests')).toBe(nameKey('Ironbound chest'));
    expect(nameKey('Wolves (enemy)')).toBe(nameKey('wolf'));
    expect(nameKey('Café')).toBe(nameKey('cafe'));
    expect(nameKey('A')).toBe('a');
    expect(
      ['berries', 'boxes', 'churches', 'knives', 'caves', 'keys', 'glasses', 'bus'].map(stemWord),
    ).toEqual(['berry', 'box', 'church', 'knif', 'caf', 'key', 'glass', 'bus']);
    expect(stemWord('knife')).toBe(stemWord('knives'));
    expect(stemWord('cave')).toBe(stemWord('caves'));
  });

  it('reads a location’s name without the number at its end', () => {
    expect(baseName('Stone warden 12')).toBe('Stone warden');
    expect(baseName('Chest #3')).toBe('Chest');
    expect(baseName('Glass key')).toBe('Glass key');
    expect(baseName('1999')).toBe('1999');
  });
});

describe('matching pages to the map', () => {
  const names = new MapNames(isle());

  it('links a page named like a type to every location of the type, for sure', () => {
    const match = names.match('Waystones');
    expect(match.group).toBe('sure');
    expect(match.candidates).toHaveLength(1);
    expect(match.candidates[0]).toMatchObject({
      what: 'type',
      label: 'Waystone',
      exact: true,
      target: { to: 'type', id: 'isle:cat:waystone' },
    });
    expect(match.candidates[0]!.locations).toEqual(['isle:loc:w1', 'isle:loc:w2']);
  });

  it('links one page to every location of a name: 44 coins share one page', () => {
    const match = names.match('Copper coins');
    expect(match.group).toBe('sure');
    expect(match.candidates[0]).toMatchObject({ what: 'name', label: 'Copper coin' });
    expect(match.candidates[0]!.locations).toHaveLength(44);
    // Numbered names meet under their name without the number.
    const wardens = names.match('Stone wardens');
    expect(wardens.group).toBe('sure');
    expect(wardens.candidates[0]).toMatchObject({ what: 'name', label: 'Stone warden' });
    expect(wardens.candidates[0]!.locations).toEqual(['isle:loc:s1', 'isle:loc:s2']);
  });

  it('links a page named like a region to the region and the regions inside it', () => {
    const match = names.match('The north');
    expect(match.group).toBe('sure');
    expect(match.candidates[0]).toMatchObject({ what: 'region', label: 'The North' });
    expect(match.candidates[0]!.locations).toContain('isle:loc:s1');
    expect(match.candidates[0]!.locations).toHaveLength(1 + 44 + 1 + 1);
  });

  it('is unsure of a name that is several things, and of a near name', () => {
    // A type and a location are both called Ruin, with different locations? The
    // same locations: the type is kept, so this one is sure.
    expect(names.match('Ruins').group).toBe('sure');
    expect(names.match('Ruins').candidates[0]!.what).toBe('type');
    // Only a near match: the words of the page are in a location's name.
    const wolves = names.match('Wolves');
    expect(wolves.group).toBe('unsure');
    expect(wolves.candidates[0]).toMatchObject({ what: 'name', label: 'Wolf den', exact: false });
    // One letter apart.
    expect(names.match('Waystome').candidates[0]?.label).toBe('Waystone');
    expect(names.match('Waystome').group).toBe('unsure');
    // A longer title that holds a type's name.
    expect(names.match('Camps of the hunters').candidates.map((c) => c.label)).toContain('Camp');
  });

  it('finds no match for a page about something else', () => {
    expect(names.match('Getting around')).toEqual({ group: 'none', candidates: [] });
    expect(names.match('…')).toEqual({ group: 'none', candidates: [] });
  });

  it('matches only pages read from a site, and keeps their order', () => {
    const matches = matchPages(names, [
      page('waystones', 'Waystones'),
      page('notes', 'Waystones', false),
      page('wolves', 'Wolves'),
      page('around', 'Getting around'),
    ]);
    expect(matches.map((m) => [m.guideId, m.group])).toEqual([
      ['isle:guide:waystones', 'sure'],
      ['isle:guide:wolves', 'unsure'],
      ['isle:guide:around', 'none'],
    ]);
  });

  it('resolves kept targets, by id or by name, and says when the map no longer has one', () => {
    expect(names.resolve({ to: 'type', id: 'isle:cat:coin' })?.locations).toHaveLength(44);
    expect(names.resolve({ to: 'name', name: 'stone WARDENS' })?.locations).toHaveLength(2);
    expect(names.resolve({ to: 'region', id: 'isle:region:gone' })).toBeNull();
    expect(names.resolve({ to: 'name', name: 'Nothing here' })).toBeNull();
    expect(
      names.locationsOf([
        { to: 'type', id: 'isle:cat:waystone' },
        { to: 'name', name: 'Old waystone' },
      ]),
    ).toEqual(['isle:loc:w1', 'isle:loc:w2']);
  });

  it('finds targets by what is typed: types, names and regions, not numbered names', () => {
    const found = names.find('war');
    expect(found.map((f) => [f.what, f.label])).toEqual([['name', 'Stone warden']]);
    expect(names.find('south').map((f) => f.label)).toEqual(['Southreach']);
    expect(names.find('c').map((f) => f.label)).toEqual([
      'Camp',
      'Coin',
      'Copper coin',
      "Hunters' camp",
    ]);
    expect(names.find('  ')).toEqual([]);
  });

  it('puts a location’s own name before its type, and its type before its region', () => {
    const name = names.resolve({ to: 'name', name: 'Wolf den' })!;
    const type = names.resolve({ to: 'type', id: 'isle:cat:den' })!;
    const region = names.resolve({ to: 'region', id: 'isle:region:south' })!;
    const sorted = [region, type, name].sort((a, b) => specificity(a) - specificity(b));
    expect(sorted.map((t) => t.what)).toEqual(['name', 'type', 'region']);
  });
});

describe('guides of another game', () => {
  it('reads them under a section named after that game, after the game’s own', () => {
    const own = makeGuidesFixturePack();
    const wiki = makeGuidesFixturePack();
    const rename = (id: string) => id.replace(/^pages:/u, 'wiki:');
    const other = {
      gameId: 'wiki',
      title: 'Example Wiki',
      data: {
        guides: wiki.guides.map((g) => ({ ...g, id: rename(g.id) })),
        sections: (wiki.sections ?? []).map((s) => ({
          ...s,
          id: rename(s.id),
          items: s.items.map(rename),
        })),
      },
    };
    const together = guidesTogether(indexPack(own, new URL('https://x.test/')), [other]);
    const contents = new GuideContents(together);
    expect(
      contents.top().map((e) => (e.kind === 'section' ? e.section.title : e.guide.title)),
    ).toEqual(['Basics', 'Example Wiki']);
    expect(contents.pathTo('wiki:guide:bells').map((s) => s.title)).toEqual([
      'Example Wiki',
      'Basics',
      'More',
    ]);
    expect(contents.isPage('wiki:guide:start')).toBe(true);
    expect(contents.isPage('pages:guide:start')).toBe(true);
    // Without others, the pack is read as it is.
    const alone = indexPack(own, new URL('https://x.test/'));
    expect(guidesTogether(alone, [])).toBe(alone);
  });
});
