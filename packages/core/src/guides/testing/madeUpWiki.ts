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
 * - List pages: a table of a name, a type and the location (the location
 *   in a later column), or a bulleted list of a name and a few words.
 * - Item pages (weapons and armour) that mention a location and a
 *   character in a sentence, in a box of facts, in a later column of a
 *   table and in hidden text, and list two other items under "See also".
 * - Location pages, each mentioned by many items, that list the
 *   characters met there; character and enemy pages that mention
 *   locations and items.
 * - Notes no page links to.
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
}

/** About two thousand pages. */
export const LARGE_WIKI: MadeUpWikiSize = {
  weapons: 900,
  armour: 600,
  locations: 120,
  characters: 200,
  enemies: 160,
  notes: 14,
};

export const SMALL_WIKI: MadeUpWikiSize = {
  weapons: 30,
  armour: 20,
  locations: 6,
  characters: 8,
  enemies: 6,
  notes: 3,
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

  add(
    'locations',
    [
      'The locations of the world.',
      '',
      ...locations.map((local, i) => `- ${link(local, titleOf(local))}: region ${(i % 4) + 1}.`),
    ].join('\n'),
  );
  add(
    'characters',
    [
      'The people you meet.',
      '',
      ...characters.map((local) => `- ${link(local, titleOf(local))} – sells things.`),
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

  const loose = [
    ...weapons,
    ...armour,
    ...locations,
    ...characters,
    ...enemies,
    ...notes,
    'locations',
    'characters',
  ];
  const sections: Section[] = [
    {
      id: sectionId('equipment'),
      title: 'Equipment',
      items: [guideId('weapons'), guideId('armour')],
    },
    { id: sectionId('the-world'), title: 'The world', items: [guideId('enemies')] },
    { id: PAGES_SECTION, title: 'Pages', items: loose.map(guideId), placeByLinks: true },
  ];
  return {
    guides,
    sections,
    homePage: HOME,
    ids: { weapons, armour, locations, characters, enemies, notes, lists },
  };
}
