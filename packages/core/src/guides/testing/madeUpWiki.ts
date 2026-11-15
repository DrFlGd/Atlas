import type { GuideEntry, Section } from '@atlas/schema';

/**
 * A made-up wiki of any size, for the tests of where pages are filed (and
 * to time it): every name in it is invented. It has the shapes that go
 * wrong when every link files a page:
 *
 * - A home page whose tiles lead to three list pages (Weapons, Armour,
 *   Enemies), and that mentions a note in a sentence.
 * - A menu of two sections, Equipment (Weapons, Armour) and The world
 *   (Enemies). The list pages of locations and of characters are in no
 *   section of the menu, and no list page lists them: Weapons mentions
 *   the first in a sentence.
 * - List pages written in each shape an index takes: a table of a name, a
 *   type and the location (the location in a later column); a heading
 *   that is a link for each location, with a sentence under it that
 *   mentions the next one; lines of links with a few words, under
 *   headings of plain words (characters); a table of enemies.
 * - Item pages (weapons and armour) that mention a location and a
 *   character in a sentence, in a box of facts, in a later column of a
 *   table and in hidden text, and list two other items under "See also".
 * - Location pages, each mentioned by many items, that list the
 *   characters met there; character and enemy pages that mention
 *   locations and items.
 * - Notes no page links to.
 * - With `gear` (in the menu, under Equipment): an index of all gear whose
 *   tables name, beside each thing, where it is found, which enemy drops
 *   it and who sells it (so it lists fewer than three fifths of the pages
 *   it links to). Its headings: "Weapons", over a heading that is a link
 *   to each of two narrower list pages, Short Blades (a list of the
 *   blades, each with where it is found) and Bows (a table), each over a
 *   "List of …" heading over its table; "Trinkets", over "Charms" alone,
 *   over four charms; "Fittings", over "Belt", over two belt pages (a
 *   group too small to be a level); and "History", which lists nothing.
 *   Each item page mentions the first blade, a popular page both Gear and
 *   Short Blades list. A boss page names many pages in long prose and
 *   lists the three things it drops in a small table: it is no list page.
 *
 * With `filed`, the wiki also files pages itself (a guide's `filedUnder`,
 * as its categories would): each weapon under Weapons, each character
 * under the location it lives in (and a page not read), each note under
 * the first note.
 *
 * The same size always gives the same wiki.
 */

export interface MadeUpWikiSize {
  weapons: number;
  armour: number;
  locations: number;
  characters: number;
  enemies: number;
  notes: number;
  /** Short blades, and as many bows, under the index of all gear; none when left out. */
  gear?: number;
}

/** About two thousand pages. */
export const LARGE_WIKI: MadeUpWikiSize = {
  weapons: 900,
  armour: 600,
  locations: 120,
  characters: 200,
  enemies: 160,
  notes: 14,
  gear: 40,
};

export const SMALL_WIKI: MadeUpWikiSize = {
  weapons: 30,
  armour: 20,
  locations: 6,
  characters: 8,
  enemies: 6,
  notes: 3,
  gear: 6,
};

export const PACK = 'madeup';
export const guideId = (local: string) => `${PACK}:guide:${local}`;
export const sectionId = (local: string) => `${PACK}:section:${local}`;
/** The section of the pages the menu does not list, placed by their links. */
export const PAGES_SECTION = sectionId('pages');
export const HOME = guideId('main-page');

export interface MadeUpWiki {
  guides: GuideEntry[];
  sections: Section[];
  homePage: string;
  /** Local ids of each type of page. */
  ids: {
    weapons: string[];
    armour: string[];
    locations: string[];
    characters: string[];
    enemies: string[];
    notes: string[];
    lists: string[];
    blades: string[];
    bows: string[];
  };
}

const pad = (n: number) => String(n).padStart(4, '0');
const link = (local: string, words: string) => `[${words}](${guideId(local)})`;
const titleOf = (local: string) =>
  local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** Builds the made-up wiki. */
export function madeUpWiki(
  size: MadeUpWikiSize = SMALL_WIKI,
  { filed = false }: { filed?: boolean } = {},
): MadeUpWiki {
  const weapons = Array.from({ length: size.weapons }, (_, i) => `blade-${pad(i + 1)}`);
  const armour = Array.from({ length: size.armour }, (_, i) => `mail-${pad(i + 1)}`);
  const locations = Array.from({ length: size.locations }, (_, i) => `vale-${pad(i + 1)}`);
  const characters = Array.from({ length: size.characters }, (_, i) => `smith-${pad(i + 1)}`);
  const enemies = Array.from({ length: size.enemies }, (_, i) => `ghoul-${pad(i + 1)}`);
  const notes = Array.from({ length: size.notes }, (_, i) => `note-${pad(i + 1)}`);
  const blades = Array.from({ length: size.gear ?? 0 }, (_, i) => `dirk-${pad(i + 1)}`);
  const bows = Array.from({ length: size.gear ?? 0 }, (_, i) => `longbow-${pad(i + 1)}`);
  const lists = ['weapons', 'armour', 'locations', 'characters', 'enemies'];
  const tiles = ['weapons', 'armour', 'enemies'];
  // Where each item is found and who sells it: a few locations hold most items.
  const locationOf = (i: number) => locations[(i * i + 3 * i) % Math.max(1, locations.length)]!;
  const characterOf = (i: number) => characters[(i * 7 + 1) % Math.max(1, characters.length)]!;
  const guides: GuideEntry[] = [];
  const add = (local: string, body: string, under: string[] = []) =>
    guides.push({
      id: guideId(local),
      title: titleOf(local),
      body,
      locationIds: [],
      ...(filed && under.length > 0 ? { filedUnder: under.map(guideId) } : {}),
    });

  add(
    'main-page',
    [
      'Welcome to the made-up wiki. Read the [rules](' + guideId('note-0001') + ') first.',
      '',
      '## Explore',
      '',
      ...tiles.map(
        (local) =>
          `- [![${titleOf(local)}](${PACK}:picture:${local} "=100x100")](${guideId(local)})${link(local, titleOf(local))}`,
      ),
    ].join('\n'),
  );

  /** A list page of items: a table of the name, its type and where it is found. */
  const itemList = (local: string, items: string[], type: string) =>
    add(
      local,
      [
        `Every ${type} of the game. Most are found in the ${link('locations', 'locations')}.`,
        '',
        '| Name | Type | Location |',
        '| --- | --- | --- |',
        ...items.map(
          (item, i) =>
            `| [![${titleOf(item)}](${PACK}:picture:${item} "=24x24")](${guideId(item)}) ${link(item, titleOf(item))} | ${type} | ${link(locationOf(i), titleOf(locationOf(i)))} |`,
        ),
      ].join('\n'),
    );
  itemList('weapons', weapons, 'Weapon');
  itemList('armour', armour, 'Armour');

  // A heading that is a link for each location, and a sentence under it.
  add(
    'locations',
    [
      'The locations of the world.',
      ...locations.flatMap((local, i) => {
        const next = locations[(i + 1) % locations.length]!;
        return [
          '',
          `### ${link(local, titleOf(local))}`,
          '',
          `In region ${(i % 4) + 1}, next to ${link(next, titleOf(next))}.`,
        ];
      }),
    ].join('\n'),
  );
  // Lines of links with a few words, ten under each heading of plain words.
  add(
    'characters',
    [
      'The people you meet.',
      ...Array.from({ length: Math.ceil(characters.length / 10) }, (_, group) => [
        '',
        `## Group ${group + 1}`,
        '',
        characters
          .slice(group * 10, group * 10 + 10)
          .map((local) => `${link(local, titleOf(local))} – sells things.`)
          .join('  \n'),
      ]).flat(),
    ].join('\n'),
  );
  add(
    'enemies',
    [
      'The enemies, and where they roam.',
      '',
      '| Enemy | Found in |',
      '| --- | --- |',
      ...enemies.map(
        (local, i) =>
          `| ${link(local, titleOf(local))} | ${link(locationOf(i * 5), titleOf(locationOf(i * 5)))} |`,
      ),
    ].join('\n'),
  );

  /** An item page: mentions in a box, a sentence, a later column and hidden text. */
  const item = (local: string, i: number, others: string[], type: string) => {
    const at = locationOf(i);
    const who = characterOf(i);
    const see = [others[(i + 1) % others.length]!, others[(i + 2) % others.length]!].filter(
      (other) => other !== local,
    );
    add(
      local,
      [
        `| ${titleOf(local)} | {box} |`,
        '| --- | --- |',
        `| ![${titleOf(local)}](${PACK}:picture:${local} "=96x96") |  |`,
        `| Type | ${type} |`,
        `| Location | ${link(at, titleOf(at))} |`,
        `| Sold by | ${link(who, titleOf(who))} |`,
        '',
        `The ${titleOf(local)} is a ${type.toLowerCase()} found in ${link(at, titleOf(at))}. ${link(who, titleOf(who))} sells it for a fair price.`,
        '',
        '## Upgrades',
        '',
        '| Level | Cost | Where |',
        '| --- | --- | --- |',
        `| 1 | 10 | ${link(at, titleOf(at))} |`,
        `| 2 | 20 | ${link(who, titleOf(who))} |`,
        '',
        `||Hidden: ${link(who, titleOf(who))} gives a second one.||`,
        '',
        '## See also',
        '',
        ...see.map((other) => `- ${link(other, titleOf(other))}`),
      ].join('\n'),
      type === 'Weapon' ? ['weapons'] : [],
    );
  };
  weapons.forEach((local, i) => {
    item(local, i, weapons, 'Weapon');
  });
  armour.forEach((local, i) => {
    item(local, i + weapons.length, armour, 'Armour');
  });

  // A location page lists the characters met there, as a short list.
  locations.forEach((local, i) => {
    const met = characters.filter((_, c) => c % Math.max(1, locations.length) === i).slice(0, 4);
    add(
      local,
      [
        `| ${titleOf(local)} | {box} |`,
        '| --- | --- |',
        `| Region | ${(i % 4) + 1} |`,
        '',
        `A location of the world, next to ${link(locations[(i + 1) % locations.length]!, titleOf(locations[(i + 1) % locations.length]!))}.`,
        '',
        ...(met.length > 0 ? ['## People', '', ...met.map((c) => `- ${link(c, titleOf(c))}`)] : []),
      ].join('\n'),
    );
  });
  characters.forEach((local, i) => {
    const home = locationOf(i * 3);
    add(
      local,
      [
        `| ${titleOf(local)} | {box} |`,
        '| --- | --- |',
        `| Home | ${link(home, titleOf(home))} |`,
        '',
        `${titleOf(local)} lives in ${link(home, titleOf(home))} and sells the ${link(weapons[i % Math.max(1, weapons.length)]!, titleOf(weapons[i % Math.max(1, weapons.length)]!))}.`,
      ].join('\n'),
      ['not-read', home],
    );
  });
  enemies.forEach((local, i) => {
    const at = locationOf(i * 5);
    add(
      local,
      `An enemy of ${link(at, titleOf(at))}. It drops the ${link(armour[i % Math.max(1, armour.length)]!, titleOf(armour[i % Math.max(1, armour.length)]!))}.`,
    );
  });
  notes.forEach((local) => add(local, 'A note no page lists.', [notes[0]!]));

  const gear = blades.length > 0;
  if (gear) addGear(add, { blades, bows, locations, enemies, characters, notes });

  const loose = [
    ...weapons,
    ...armour,
    ...locations,
    ...characters,
    ...enemies,
    ...notes,
    'locations',
    'characters',
    ...(gear
      ? ['short-blades', 'bows', ...blades, ...bows, ...GEAR_CHARMS, ...GEAR_BELT, 'mire-tyrant']
      : []),
  ];
  const sections: Section[] = [
    {
      id: sectionId('equipment'),
      title: 'Equipment',
      items: [guideId('weapons'), guideId('armour'), ...(gear ? [guideId('gear')] : [])],
    },
    { id: sectionId('the-world'), title: 'The world', items: [guideId('enemies')] },
    { id: PAGES_SECTION, title: 'Pages', items: loose.map(guideId), placeByLinks: true },
  ];
  return {
    guides,
    sections,
    homePage: HOME,
    ids: {
      weapons,
      armour,
      locations,
      characters,
      enemies,
      notes,
      lists: gear ? [...lists, 'gear', 'short-blades', 'bows'] : lists,
      blades,
      bows,
    },
  };
}

/** The charms and belt pages of the index of all gear. */
export const GEAR_CHARMS = ['charm-0001', 'charm-0002', 'charm-0003', 'charm-0004'];
export const GEAR_BELT = ['belt-pouch', 'belt-hook'];

/**
 * The index of all gear, its two narrower list pages, the gear pages and a
 * boss page (see the top of this file).
 */
function addGear(
  add: (local: string, body: string) => void,
  {
    blades,
    bows,
    locations,
    enemies,
    characters,
    notes,
  }: Record<'blades' | 'bows' | 'locations' | 'enemies' | 'characters' | 'notes', string[]>,
): void {
  const at = <T>(list: T[], i: number) => list[i % Math.max(1, list.length)]!;
  // Each row names a location and an enemy of its own, as far as there are.
  const foundAt = (i: number) => at(locations, i * 2 + 1);
  const droppedBy = (i: number) => at(enemies, i * 3 + 2);
  const soldBy = (i: number) => at(characters, i + 1);
  const popular = blades[0]!;
  const table = (items: string[], type: string, from: number) => [
    '| Icon | Name | Description | Found at | Dropped by | Sold by |',
    '| --- | --- | --- | --- | --- | --- |',
    ...items.map(
      (item, i) =>
        `| [![${titleOf(item)}](${PACK}:picture:${item} "=24x24")](${guideId(item)}) | ${link(item, titleOf(item))} | A ${type} of fair weight. | Near the gate of ${link(foundAt(from + i), titleOf(foundAt(from + i)))} | ${link(droppedBy(from + i), titleOf(droppedBy(from + i)))} | ${link(soldBy(from + i), titleOf(soldBy(from + i)))} |`,
    ),
  ];
  add(
    'gear',
    [
      `All the gear of the game, by type. Most of it can be bought from ${link(at(characters, 0), titleOf(at(characters, 0)))}.`,
      '',
      '## Weapons',
      '',
      'What you fight with.',
      '',
      `### ${link('short-blades', 'Short Blades')}`,
      '',
      '#### List of short blades',
      '',
      ...table(blades, 'short blade', 0),
      '',
      `### ${link('bows', 'Bows')}`,
      '',
      '#### List of bows',
      '',
      ...table(bows, 'bow', blades.length),
      '',
      '## Trinkets',
      '',
      '### Charms',
      '',
      ...GEAR_CHARMS.map((charm) => `- ${link(charm, titleOf(charm))} – worn at the neck`),
      '',
      '## Fittings',
      '',
      '### Belt',
      '',
      ...GEAR_BELT.map((item) => `- ${link(item, titleOf(item))}`),
      '',
      '## History',
      '',
      'The first gear of the game was a stick.',
    ].join('\n'),
  );
  add(
    'short-blades',
    [
      'The short blades, quick and light.',
      '',
      ...blades.map(
        (blade, i) =>
          `- ${link(blade, titleOf(blade))} – found in ${link(foundAt(i), titleOf(foundAt(i)))}`,
      ),
    ].join('\n'),
  );
  add(
    'bows',
    [
      'The bows, for a fight from afar.',
      '',
      '| Name | Range |',
      '| --- | --- |',
      ...bows.map((bow, i) => `| ${link(bow, titleOf(bow))} | ${10 + i} |`),
    ].join('\n'),
  );
  for (const local of [...GEAR_CHARMS, ...GEAR_BELT])
    add(local, `A piece of gear: ${titleOf(local)}.`);
  [...blades, ...bows].forEach((local, i) => {
    const type = i < blades.length ? 'Short blade' : 'Bow';
    add(
      local,
      [
        `| ${titleOf(local)} | {box} |`,
        '| --- | --- |',
        `| Type | ${type} |`,
        `| Found at | ${link(foundAt(i), titleOf(foundAt(i)))} |`,
        '',
        `The ${titleOf(local)} is a ${type.toLowerCase()}.` +
          (local === popular
            ? ' Every other piece of gear is measured against it.'
            : ` It is often compared with the ${link(popular, titleOf(popular))}.`),
      ].join('\n'),
    );
  });
  // A boss: long prose that names many pages, and a small table of what it drops.
  add(
    'mire-tyrant',
    [
      '| Mire Tyrant | {box} |',
      '| --- | --- |',
      `| Location | ${link(at(locations, 0), titleOf(at(locations, 0)))} |`,
      '',
      `The Mire Tyrant rules the bog below ${link(at(locations, 0), titleOf(at(locations, 0)))}, and its servants roam as far as ${link(at(locations, 1), titleOf(at(locations, 1)))}. It is guarded by ${link(at(enemies, 0), titleOf(at(enemies, 0)))} and ${link(at(enemies, 1), titleOf(at(enemies, 1)))}, which come back after each fight.`,
      '',
      `${link(at(characters, 1), titleOf(at(characters, 1)))} tells of it, and ${link(at(characters, 2), titleOf(at(characters, 2)))} sells a charm against its poison. Read ${link(at(notes, 0), titleOf(at(notes, 0)))} before the fight.`,
      '',
      '## Drops',
      '',
      '| Item | Chance |',
      '| --- | --- |',
      `| ${link(blades[0]!, titleOf(blades[0]!))} | 10% |`,
      `| ${link(at(blades, 1), titleOf(at(blades, 1)))} | 5% |`,
      `| ${link(bows[0]!, titleOf(bows[0]!))} | 1% |`,
    ].join('\n'),
  );
}
