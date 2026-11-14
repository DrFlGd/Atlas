import type { ChecklistItem, Location, OwnList } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { LocationNameIndex } from '../guides/locationNames';
import type { LoadedPack } from '../pack/loadedPack';
import { idsOf, insertRows, newOwnId, newOwnList, newStep, stepsOf } from './ownLists';
import {
  addThing,
  findStep,
  findSteps,
  isLocationWords,
  locationParts,
  nearestCandidates,
  placeLocations,
  stepOfThing,
  stepPageId,
  thingNote,
  type BuildFinder,
} from './planBuild';

/**
 * A made-up map and a made-up wiki: its pages say where things are in
 * every way the planner reads (a heading, a table column, a box of facts, a
 * line, links and plain names), and one page is linked to the map.
 */

const NOW = new Date('2026-11-14T10:00:00.000Z');

const location = (local: string, name: string, x: number, y: number, mapId = 'isle:map:world') =>
  ({
    id: `isle:loc:${local}`,
    mapId,
    layerId: 'isle:layer:surface',
    x,
    y,
    categoryId: 'isle:cat:spot',
    regionId: null,
    name,
    entityIds: [],
    guideId: null,
    since: '1.0.0',
  }) satisfies Location;

const LOCATIONS = [
  location('shrine3', 'Sunken shrine 3', 100, 100),
  location('shrine4', 'Sunken shrine 4', 900, 900),
  location('mill', 'Old mill', 400, 400),
  location('wyrm1', 'Frost wyrm 1', 120, 100),
  location('wyrm2', 'Frost wyrm 2', 800, 800),
  location('wyrm3', 'Frost wyrm 3', 50, 50, 'isle:map:deep'),
  location('petal1', 'Moonpetal 1', 300, 300),
  location('warden', 'Stone warden 1', 600, 600),
  location('gate', 'Ash gate', 700, 100),
];

const page = (local: string) => `isle:guide:${local}`;

const PAGES: Record<string, string> = {
  [page('ember-blade')]: `
A short sword that glows like coals.

## Where to find

It rests in Sunken shrine 3, past the flooded hall.

## Materials

| Material | Amount |
| --- | --- |
| Moonpetal | 3 |
`,
  [page('blades')]: `
| Blade | Damage | Location |
| --- | --- | --- |
| [Ember blade](${page('ember-blade')}) | 40 | Sunken shrine 3 |
| Glass dagger | 22 | [The old mill](${page('mill')}) |
`,
  [page('maul')]: `
| Warden's maul | |
| --- | --- |
| Damage | 55 |
| Found in | [Stone wardens](${page('wardens')}) |
`,
  [page('wardens')]: 'Stone wardens guard each region.',
  [page('mill')]: 'An old mill by the river.',
  [page('ring')]: `
A ring of ash.

**Obtained:** from the chest behind [the gate](isle:loc:gate).
`,
  [page('cloak')]: `
A grey cloak.

### How to get it

- Frost wyrms drop it.
- ||Only Frost wyrm 3 drops it at night.||
`,
  [page('charm')]: `
A charm that hums near the sea.

## How to get

Bought from a travelling merchant who turns up at random.
`,
  [page('wyrm-page')]: 'About wyrms.',
};

/** Pages linked to the map: the wardens' page to every warden, the mill page to the mill. */
const LINKED: Record<string, string[]> = {
  [page('wardens')]: ['isle:loc:warden'],
  [page('mill')]: ['isle:loc:mill'],
  [page('wyrm-page')]: ['isle:loc:wyrm1', 'isle:loc:wyrm2'],
};

const ON_MAP = new Set(LOCATIONS.map((l) => l.id));

const finder: BuildFinder = {
  pageId: (id) => (id in PAGES ? id : id === page('old-ember') ? page('ember-blade') : null),
  pageBody: (id) => PAGES[id],
  linkedLocations: (id) => LINKED[id] ?? [],
  hasLocation: (id) => ON_MAP.has(id),
  names: new LocationNameIndex(LOCATIONS),
};

const pack = {
  locations: new Map(LOCATIONS.map((l) => [l.id, l])),
} as unknown as LoadedPack;

/** Random parts that count up: a, b, c… */
function counter() {
  let n = 0;
  return () => `t${(n++).toString(36)}`;
}

function build(things: { name: string; guideId?: string; locationId?: string }[]): OwnList {
  const random = counter();
  let list = newOwnList('isle', 'Ember build', 'build', NOW, [], random);
  for (const thing of things) {
    list = addThing(list, thing, newOwnId('isle', 'checkitem', new Set(idsOf(list)), random));
  }
  return list;
}

const step = (name: string, guideId?: string): ChecklistItem => ({
  id: `isle:checkitem:own.${name.replace(/\W+/g, '')}`,
  checklistId: 'isle:checklist:own.list',
  name,
  order: 0,
  locationIds: [],
  entityIds: [],
  ...(guideId ? { note: thingNote({ name, guideId }) } : {}),
});

const short = (ids: readonly string[]) => ids.map((id) => id.split(':').at(-1));

describe('collecting', () => {
  it('makes a step of a page with a link to it, and of a location with that location', () => {
    const list = build([
      { name: 'Ember [blade]', guideId: page('ember-blade') },
      { name: 'Frost wyrm 1', locationId: 'isle:loc:wyrm1' },
      { name: '  Moonpetal\n ' },
    ]);
    const steps = stepsOf(list);
    expect(steps.map((s) => s.name)).toEqual(['Ember [blade]', 'Frost wyrm 1', 'Moonpetal']);
    expect(steps[0]!.note).toBe(`[Ember \\[blade\\]](${page('ember-blade')})`);
    expect(stepPageId(steps[0]!)).toBe(page('ember-blade'));
    expect(steps[1]!.locationIds).toEqual(['isle:loc:wyrm1']);
    expect(steps[1]!.note).toBeUndefined();
    expect(stepPageId(steps[2]!)).toBeNull();
  });

  it('reads the page of a step only from a link its note starts with', () => {
    expect(stepPageId({ note: `[Ring](${page('ring')}) and more` })).toBe(page('ring'));
    expect(stepPageId({ note: `See [Ring](${page('ring')})` })).toBeNull();
    expect(stepPageId({ note: '[A location](isle:loc:gate)' })).toBeNull();
    expect(stepPageId({ note: '[Web](https://example.org/)' })).toBeNull();
    expect(stepPageId({})).toBeNull();
  });

  it('finds the step a thing already is: the same page, location or name', () => {
    const list = build([
      { name: 'Ember blade', guideId: page('ember-blade') },
      { name: 'Frost wyrm 1', locationId: 'isle:loc:wyrm1' },
      { name: 'Moonpetal' },
    ]);
    expect(stepOfThing(list, { name: 'Other name', guideId: page('ember-blade') })).toBeDefined();
    expect(
      stepOfThing(list, { name: 'Ember blade', guideId: page('old-ember') }, (a, b) =>
        [a, b].every((id) => id === page('ember-blade') || id === page('old-ember')),
      ),
    ).toBeDefined();
    expect(stepOfThing(list, { name: 'x', locationId: 'isle:loc:wyrm1' })).toBeDefined();
    expect(stepOfThing(list, { name: 'Frost wyrm 2', locationId: 'isle:loc:wyrm2' })).toBe(
      undefined,
    );
    expect(stepOfThing(list, { name: 'MOONPETALS' })).toBeDefined();
    // A step of the same name about no page is the thing too.
    expect(stepOfThing(list, { name: 'Moonpetal', guideId: page('moonpetal') })).toBeDefined();
    // A step about another page is another thing, even of the same name.
    expect(stepOfThing(list, { name: 'Ember blade', guideId: page('blades') })).toBeUndefined();
  });
});

describe('where a page says a thing is', () => {
  it('knows the general words, tidied', () => {
    for (const words of [
      'Location',
      'Locations',
      'Where to find',
      'WHERE TO FIND IT:',
      'Found in',
    ]) {
      expect(isLocationWords(words), words).toBe(true);
    }
    for (const words of ['How to get', 'Obtained', '**Obtained**', 'how to obtain']) {
      expect(isLocationWords(words), words).toBe(true);
    }
    for (const words of ['Materials', 'Damage', 'Locations of interest', 'Trivia', '']) {
      expect(isLocationWords(words), words).toBe(false);
    }
  });

  it('reads the part under a heading, up to the next heading as high', () => {
    const parts = locationParts(PAGES[page('ember-blade')]!);
    expect(parts.texts).toEqual(['It rests in Sunken shrine 3, past the flooded hall.']);
    expect(parts.links).toEqual([]);
  });

  it('reads a column of a table, with its links', () => {
    const parts = locationParts(PAGES[page('blades')]!);
    expect(parts.texts).toEqual(['Sunken shrine 3', 'The old mill']);
    expect(parts.links).toEqual([page('mill')]);
    expect(parts.names).toContain('The old mill');
  });

  it('reads a row of a box of facts, and a line that starts with the words', () => {
    expect(locationParts(PAGES[page('maul')]!)).toMatchObject({
      links: [page('wardens')],
      texts: ['Stone wardens'],
    });
    expect(locationParts(PAGES[page('ring')]!)).toMatchObject({
      links: ['isle:loc:gate'],
      texts: ['from the chest behind the gate.'],
    });
  });

  it('leaves hidden text out, so nothing found gives an answer away', () => {
    const parts = locationParts(PAGES[page('cloak')]!);
    expect(parts.texts).toEqual(['Frost wyrms drop it.']);
    expect(parts.texts.join(' ')).not.toContain('night');
  });

  it('reads nothing from a page that says nothing of where', () => {
    expect(locationParts('Just text.\n\n| Damage | 3 |\n| --- | --- |\n| 1 | 2 |')).toEqual({
      links: [],
      texts: [],
      names: [],
    });
  });
});

describe('finding on the map', () => {
  it('takes the locations the step’s page is linked to first', () => {
    expect(findStep(step('Mill', page('mill')), finder)).toMatchObject({
      outcome: 'found',
      by: 'linked',
      locationIds: ['isle:loc:mill'],
    });
    // Linked to two: both are possible.
    expect(findStep(step('Ember blade', page('wyrm-page')), finder)).toMatchObject({
      outcome: 'several',
      by: 'linked',
    });
  });

  it('then the locations whose name fits the step’s name', () => {
    expect(findStep(step('Frost wyrm 2'), finder)).toMatchObject({
      outcome: 'found',
      by: 'name',
      locationIds: ['isle:loc:wyrm2'],
    });
    expect(short(findStep(step('Frost wyrms'), finder).locationIds)).toEqual([
      'wyrm1',
      'wyrm2',
      'wyrm3',
    ]);
    // Spelt a little otherwise: possible, never found without asking.
    const near = findStep(step('Old mlil'), finder);
    expect(near).toMatchObject({ outcome: 'several', by: 'name' });
    expect(short(near.locationIds)).toEqual(['mill']);
  });

  it('then the page: a heading’s part with a plain name', () => {
    expect(findStep(step('Ember blade', page('ember-blade')), finder)).toMatchObject({
      outcome: 'found',
      by: 'page',
      locationIds: ['isle:loc:shrine3'],
    });
    // Another name of the page is the page.
    expect(findStep(step('Ember blade', page('old-ember')), finder).locationIds).toEqual([
      'isle:loc:shrine3',
    ]);
  });

  it('then the page: a table column with a name and a link to a page linked to the map', () => {
    const found = findStep(step('Blades', page('blades')), finder);
    expect(found).toMatchObject({ outcome: 'several', by: 'page' });
    expect(short(found.locationIds)).toEqual(['mill', 'shrine3']);
  });

  it('then the page: a box of facts linking a page linked to the map', () => {
    expect(findStep(step('Warden’s maul', page('maul')), finder)).toMatchObject({
      outcome: 'found',
      by: 'page',
      locationIds: ['isle:loc:warden'],
    });
  });

  it('then the page: a link to a location, and names in a list under a heading', () => {
    expect(findStep(step('Ash ring', page('ring')), finder).locationIds).toEqual(['isle:loc:gate']);
    const cloak = findStep(step('Grey cloak', page('cloak')), finder);
    expect(cloak).toMatchObject({ outcome: 'several', by: 'page' });
    expect(short(cloak.locationIds)).toEqual(['wyrm1', 'wyrm2', 'wyrm3']);
  });

  it('says plainly when nothing is found', () => {
    expect(findStep(step('Tidecaller charm', page('charm')), finder)).toEqual({
      stepId: step('Tidecaller charm').id,
      name: 'Tidecaller charm',
      outcome: 'none',
      by: null,
      locationIds: [],
    });
    expect(findStep(step('Copper kettle'), finder).outcome).toBe('none');
  });

  it('looks only for steps with no location on the map', () => {
    let list = build([
      { name: 'Ember blade', guideId: page('ember-blade') },
      { name: 'Frost wyrm 1', locationId: 'isle:loc:wyrm1' },
      { name: 'Moonpetal' },
      { name: 'Tidecaller charm', guideId: page('charm') },
    ]);
    // A location the map no longer has counts as none.
    const gone = stepsOf(list)[2]!.id;
    list = {
      ...list,
      items: list.items.map((i) => (i.id === gone ? { ...i, locationIds: ['isle:loc:gone'] } : i)),
    };
    const { findings, located } = findSteps(list, finder);
    expect(located).toBe(1);
    expect(findings.map((f) => [f.name, f.outcome])).toEqual([
      ['Ember blade', 'found'],
      ['Moonpetal', 'found'],
      ['Tidecaller charm', 'none'],
    ]);
  });

  it('builds its indexes once: thousands of steps and locations are quick', () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      location(`m${i}`, `${['Gilded', 'Weathered', 'Iron-bound'][i % 3]} chest ${i}`, i, i),
    );
    const names = new LocationNameIndex(many);
    const quick: BuildFinder = { ...finder, names, hasLocation: () => true };
    let list = newOwnList('isle', 'Big', 'build', NOW, [], counter());
    const random = counter();
    const rows = Array.from({ length: 2000 }, (_, i) =>
      newStep(list, newOwnId('isle', 'checkitem', new Set(), random), {
        name: i % 2 ? `Gilded chest ${i}` : 'Ember blade',
        ...(i % 2 ? {} : { note: thingNote({ name: 'x', guideId: page('ember-blade') }) }),
      }),
    );
    list = insertRows(list, null, rows);
    const started = performance.now();
    const { findings } = findSteps(list, quick);
    expect(findings).toHaveLength(2000);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('choosing and placing', () => {
  it('lists the possible locations nearest first to the step before', () => {
    const list = build([
      { name: 'Frost wyrm 2', locationId: 'isle:loc:wyrm2' },
      { name: 'Frost wyrms' },
    ]);
    const second = stepsOf(list)[1]!.id;
    const ids = ['isle:loc:wyrm1', 'isle:loc:wyrm3', 'isle:loc:shrine4'];
    // From Frost wyrm 2 (800, 800): Sunken shrine 4 is nearest; the other map comes last.
    expect(short(nearestCandidates(list, pack, second, ids))).toEqual([
      'shrine4',
      'wyrm1',
      'wyrm3',
    ]);
    // With no step on the map, in the order found.
    const alone = build([{ name: 'Frost wyrms' }]);
    expect(short(nearestCandidates(alone, pack, stepsOf(alone)[0]!.id, ids))).toEqual([
      'wyrm1',
      'wyrm3',
      'shrine4',
    ]);
  });

  it('puts one location on each step confirmed, and leaves the others', () => {
    const list = build([{ name: 'Ember blade' }, { name: 'Moonpetal' }, { name: 'Charm' }]);
    const [a, b, c] = stepsOf(list);
    const placed = placeLocations(
      list,
      new Map([
        [a!.id, 'isle:loc:shrine3'],
        [b!.id, 'isle:loc:petal1'],
        ['isle:checkitem:own.gone', 'isle:loc:mill'],
      ]),
    );
    expect(stepsOf(placed).map((s) => s.locationIds)).toEqual([
      ['isle:loc:shrine3'],
      ['isle:loc:petal1'],
      [],
    ]);
    expect(stepsOf(placed)[2]).toEqual(c);
  });
});
