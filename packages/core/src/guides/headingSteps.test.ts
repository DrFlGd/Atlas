import { NO_OWN_PAGES, type GuideEntry, type OwnPages, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, entryIdOf, entryTitleOf } from './contents';
import { HEADING_STEP_MIN_PAGES, headingStepId, headingSteps } from './headingSteps';
import { shownContentsFor } from './ownPages';
import type { ListingHeading } from './pageFiling';

/** The headings of a list page as levels of the contents, on made-up pages. */

const heading = (level: number, words: string, guide: string | null = null): ListingHeading => ({
  level,
  words,
  section: words.toLowerCase().replace(/\s+/g, '-'),
  guide,
});

interface Options {
  title?: string;
  /** What the list page holds as shown; its listing when left out. */
  items?: string[];
  grouped?: (id: string) => boolean;
  weight?: (id: string) => number;
}

/**
 * The levels made of a list page's headings, as nested objects: a page by
 * its id, a step as `{ words: [what it holds] }`; null when none is made.
 * `listed` names each listed page, in order, with the heading it is under.
 */
function levels(headings: ListingHeading[], listed: [string, number][], options: Options = {}) {
  const listing = listed.map(([id]) => id);
  const found = headingSteps({
    page: 'list',
    title: options.title ?? 'List',
    items: options.items ?? listing,
    grouped: options.grouped ?? (() => true),
    weight: options.weight ?? (() => 1),
    listing,
    headings,
    listedUnder: listed.map(([, at]) => at),
  });
  if (!found) return null;
  const steps = new Map(found.steps.map((step) => [step.id, step]));
  const show = (items: readonly string[]): unknown[] =>
    items.map((id) => {
      const step = steps.get(id);
      return step ? { [step.words]: show(step.items) } : id;
    });
  return show(found.items);
}

/** `count` pages named `prefix1`, `prefix2`… listed under heading `at`. */
const pages = (prefix: string, count: number, at: number): [string, number][] =>
  Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, at]);

describe('the headings of a list page as levels', () => {
  it('make a level of each heading with pages under it, and leave out one with none', () => {
    const headings = [heading(2, 'Weapons'), heading(2, 'Armour'), heading(2, 'Lore')];
    expect(levels(headings, [...pages('w', 3, 0), ...pages('a', 3, 1)])).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
  });

  it(`let the pages of a heading with fewer than ${HEADING_STEP_MIN_PAGES} rise, in their place`, () => {
    const headings = [heading(2, 'Weapons'), heading(2, 'Rings'), heading(2, 'Armour')];
    const listed = [...pages('w', 3, 0), ...pages('r', 2, 1), ...pages('a', 3, 2)];
    expect(levels(headings, listed)).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      'r1',
      'r2',
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
    // A page counts with the pages under it, however deep.
    expect(levels(headings, listed, { weight: (id) => (id === 'r1' ? 3 : 1) })).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      { Rings: ['r1', 'r2'] },
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
  });

  it('let pages rise as far as they must: in the end, straight under the list page', () => {
    const headings = [heading(2, 'Weapons'), heading(3, 'Blades'), heading(2, 'Armour')];
    expect(levels(headings, [...pages('b', 2, 1), ...pages('a', 3, 2)])).toEqual([
      'b1',
      'b2',
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
  });

  it('go as deep as the headings do', () => {
    const headings = [
      heading(2, 'Weapons'),
      heading(3, 'Blades'),
      heading(3, 'Bows'),
      heading(2, 'Armour'),
    ];
    const listed = [...pages('b', 3, 1), ...pages('w', 3, 2), ...pages('a', 3, 3)];
    expect(levels(headings, listed)).toEqual([
      { Weapons: [{ Blades: ['b1', 'b2', 'b3'] }, { Bows: ['w1', 'w2', 'w3'] }] },
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
  });

  it('fold a heading that holds nothing itself and one heading under it, by the outer words', () => {
    const headings = [heading(2, 'Weapons'), heading(2, 'Trinkets'), heading(3, 'Charms')];
    const listed = [...pages('w', 3, 0), ...pages('c', 3, 2)];
    expect(levels(headings, listed)).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      { Trinkets: ['c1', 'c2', 'c3'] },
    ]);
    const found = headingSteps({
      page: 'list',
      title: 'List',
      items: listed.map(([id]) => id),
      grouped: () => true,
      weight: () => 1,
      listing: listed.map(([id]) => id),
      headings,
      listedUnder: listed.map(([, at]) => at),
    });
    // It opens the list page at the outer heading.
    expect(found?.steps.map((step) => step.id)).toEqual([
      headingStepId('list', 'weapons'),
      headingStepId('list', 'trinkets'),
    ]);
    // With a page of its own, it keeps the level under it.
    expect(levels(headings, [...pages('w', 3, 0), ['t1', 1], ...pages('c', 3, 2)])).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      { Trinkets: ['t1', { Charms: ['c1', 'c2', 'c3'] }] },
    ]);
  });

  it('make no level of one heading over every page: the levels under it are the levels', () => {
    const headings = [heading(2, 'All gear'), heading(3, 'Weapons'), heading(3, 'Armour')];
    expect(levels(headings, [...pages('w', 3, 1), ...pages('a', 3, 2)])).toEqual([
      { Weapons: ['w1', 'w2', 'w3'] },
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
    // One group and nothing beside it makes no level at all.
    expect(levels([heading(2, 'Weapons')], pages('w', 4, 0))).toBeNull();
    // One group and a page put beside it by hand does.
    expect(
      levels([heading(2, 'Weapons')], pages('w', 3, 0), {
        items: ['moved', 'w1', 'w2', 'w3'],
        grouped: (id) => id !== 'moved',
      }),
    ).toEqual(['moved', { Weapons: ['w1', 'w2', 'w3'] }]);
    // One group and pages beside it does.
    expect(levels([heading(2, 'Weapons')], [...pages('x', 2, -1), ...pages('w', 3, 0)])).toEqual([
      'x1',
      'x2',
      { Weapons: ['w1', 'w2', 'w3'] },
    ]);
  });

  it('make no level of a first-level heading with the page title', () => {
    const headings = [heading(1, 'List'), heading(2, 'Weapons'), heading(1, 'Others')];
    const listed = [...pages('x', 2, 0), ...pages('w', 3, 1), ...pages('o', 3, 2)];
    expect(levels(headings, listed)).toEqual([
      'x1',
      'x2',
      { Weapons: ['w1', 'w2', 'w3'] },
      { Others: ['o1', 'o2', 'o3'] },
    ]);
  });

  it('group only the pages the list page files by its listing, and keep the others first', () => {
    const headings = [heading(2, 'Weapons'), heading(2, 'Armour')];
    const listed = [...pages('w', 4, 0), ...pages('a', 3, 1)];
    const items = ['moved', ...listed.map(([id]) => id), 'filed'];
    const grouped = (id: string) => id !== 'moved' && id !== 'filed' && id !== 'w2';
    expect(levels(headings, listed, { items, grouped })).toEqual([
      'moved',
      'w2',
      'filed',
      { Weapons: ['w1', 'w3', 'w4'] },
      { Armour: ['a1', 'a2', 'a3'] },
    ]);
  });

  it('are none with no headings or fewer than two pages to group', () => {
    expect(levels([], pages('w', 6, -1))).toBeNull();
    expect(levels([heading(2, 'Weapons')], pages('w', 1, 0))).toBeNull();
    // One page with pages under it, beside a page put there by hand, is a level.
    expect(
      levels([heading(2, 'Weapons')], pages('w', 1, 0), {
        items: ['moved', 'w1'],
        grouped: (id) => id !== 'moved',
        weight: (id) => (id === 'w1' ? 9 : 1),
      }),
    ).toEqual(['moved', { Weapons: ['w1'] }]);
  });
});

/** Made-up pages in the contents: a menu section and the pages placed by links. */

const g = (local: string) => `heads:guide:${local}`;
const PAGES = 'heads:section:pages';
const titleOf = (local: string) =>
  local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
const to = (local: string) => `[${titleOf(local)}](${g(local)})`;
const entry = (local: string, body: string, more: Partial<GuideEntry> = {}): GuideEntry => ({
  id: g(local),
  title: titleOf(local),
  body,
  locationIds: [],
  ...more,
});
const items = (...ids: string[]) => ids.map((id) => `- ${to(id)}`).join('\n');
const names = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);

const BLADES = names('blade', 4);
const BOWS = names('bow', 3);
const CHARMS = names('charm', 3);

/**
 * An index of gear: "Weapons" over two headings that link to a page each
 * (Short Blades, Bows), "Charms", and a heading that links to a page the
 * pack does not hold (Spears).
 */
const GEAR = [
  '# Gear',
  'All the gear there is.',
  '## Weapons',
  `### ${to('short-blades')}`,
  '#### List of short blades',
  items(...BLADES),
  `### ${to('bows')}`,
  items(...BOWS),
  `## ${to('spears')}`,
  items(...names('spear', 3)),
  '## Charms',
  items(...CHARMS),
  '## History',
  'The first gear was a stick.',
].join('\n\n');

function gearData(more: { guides?: GuideEntry[]; under?: Record<string, string[]> } = {}) {
  const loose = ['short-blades', 'bows', ...BLADES, ...BOWS, ...names('spear', 3), ...CHARMS];
  const guides = [
    entry('armory', `# Armory\n\n${items('gear')}`),
    entry('gear', GEAR),
    // Neither narrower page lists the pages under its heading.
    entry('short-blades', '# Short Blades\n\nBlades shorter than a forearm.'),
    entry('bows', '# Bows\n\nBows of every wood.'),
    ...loose.slice(2).map((id) => entry(id, `# ${titleOf(id)}\n\nA piece of gear.`)),
    ...(more.guides ?? []),
  ];
  const byId = new Map(guides.map((guide) => [guide.id, guide]));
  const sections: Section[] = [
    // The person put the index under the Armory.
    { id: 'heads:section:equipment', title: 'Equipment', items: [g('armory')] },
    {
      id: PAGES,
      title: 'Pages',
      items: [...loose, ...(more.guides ?? []).map((guide) => guide.id.slice(12))]
        .map(g)
        .filter((id) => byId.has(id)),
      placeByLinks: true,
    },
  ];
  const under = Object.fromEntries(
    Object.entries({ armory: ['gear'], ...more.under }).map(([id, list]) => [g(id), list.map(g)]),
  );
  return { data: { guides: [...byId.values()], sections, maps: [] }, under };
}

const gearWiki = (more: Parameters<typeof gearData>[0] = {}) => new GuideContents(gearData(more));

const trail = (contents: GuideContents, local: string) =>
  contents.trail(g(local)).map((step) => entryTitleOf(step));
const under = (contents: GuideContents, id: string) =>
  contents.items(id).map((item) => entryTitleOf(item));

describe('the headings of a list page in the contents', () => {
  it('put the pages under a heading that links to a page under that page, and plain headings make levels', () => {
    const contents = gearWiki();
    const weapons = headingStepId(g('gear'), 'weapons');
    const spears = headingStepId(g('gear'), 'spears');
    const charms = headingStepId(g('gear'), 'charms');
    expect(contents.items(g('gear')).map((item) => entryIdOf(item))).toEqual([
      weapons,
      spears,
      charms,
    ]);
    expect(under(contents, weapons)).toEqual(['Short Blades', 'Bows']);
    expect(trail(contents, 'blade-2')).toEqual([
      'Equipment',
      'Armory',
      'Gear',
      'Weapons',
      'Short Blades',
    ]);
    expect(trail(contents, 'bow-3')).toEqual(['Equipment', 'Armory', 'Gear', 'Weapons', 'Bows']);
    // A heading that links to a page the pack does not hold is a plain heading.
    expect(under(contents, spears)).toEqual(['Spear 1', 'Spear 2', 'Spear 3']);
    expect(contents.heading(spears)).toMatchObject({ title: 'Spears', section: 'spears' });
    expect(contents.heading(spears)?.guide.id).toBe(g('gear'));
    expect(trail(contents, 'charm-1')).toEqual(['Equipment', 'Armory', 'Gear', 'Charms']);
    // "List of short blades" is under a heading that links to a page: no level of its own.
    expect(contents.heading(headingStepId(g('gear'), 'list-of-short-blades'))).toBeUndefined();
    // "History" lists nothing.
    expect(contents.heading(headingStepId(g('gear'), 'history'))).toBeUndefined();
    // Every page shown once; the levels are no pages and counted as none.
    const shown = contents.pages().map((guide) => guide.id);
    expect(shown).toHaveLength(4 + BLADES.length + BOWS.length + 3 + CHARMS.length);
    expect(new Set(shown).size).toBe(shown.length);
    expect(contents.filing()).toEqual({
      pages: 17,
      underListPage: 15,
      underFiledPage: 0,
      inSection: 1,
      inPagesSection: 0,
      byHand: 1,
    });
  });

  it('come before a narrower list page that lists the same pages, and never in a circle', () => {
    // A quiver, listed under "Charms", lists every bow: the heading of Bows comes first.
    const quiver = entry('quiver', `# Quiver\n\n${items(...BOWS)}`);
    let gear = entry('gear', GEAR.replace(items(...CHARMS), items(...CHARMS, 'quiver')));
    let contents = gearWiki({ guides: [gear, quiver] });
    expect(trail(contents, 'bow-1')).toEqual(['Equipment', 'Armory', 'Gear', 'Weapons', 'Bows']);
    expect(trail(contents, 'quiver')).toEqual(['Equipment', 'Armory', 'Gear', 'Charms']);
    // Listed under the heading of Bows, a quiver that lists Bows goes under it, not over it.
    const circle = entry('quiver', `# Quiver\n\n${items('bows', ...BOWS)}`);
    gear = entry('gear', GEAR.replace(items(...BOWS), items(...BOWS, 'quiver')));
    contents = gearWiki({ guides: [gear, circle] });
    expect(trail(contents, 'quiver')).toEqual(['Equipment', 'Armory', 'Gear', 'Weapons', 'Bows']);
    // Under Bows, the narrower list decides as ever: the quiver lists the bows.
    expect(trail(contents, 'bow-1')).toEqual([
      'Equipment',
      'Armory',
      'Gear',
      'Weapons',
      'Bows',
      'Quiver',
    ]);
    expect(contents.pages()).toHaveLength(gearWiki().pages().length + 1);
  });

  it('come after a page the person moved and a page the source files under another', () => {
    const filed = entry('blade-3', '# Blade 3\n\nA piece of gear.', {
      filedUnder: [g('charm-1')],
    });
    const contents = gearWiki({ guides: [filed], under: { 'bow-1': ['blade-1'] } });
    expect(trail(contents, 'blade-1')).toEqual([
      'Equipment',
      'Armory',
      'Gear',
      'Weapons',
      'Bows',
      'Bow 1',
    ]);
    expect(trail(contents, 'blade-3')).toEqual([
      'Equipment',
      'Armory',
      'Gear',
      'Charms',
      'Charm 1',
    ]);
    expect(trail(contents, 'blade-2')).toEqual([
      'Equipment',
      'Armory',
      'Gear',
      'Weapons',
      'Short Blades',
    ]);
  });

  it('are plain headings when they link to a page above the list page or placed elsewhere', () => {
    // The heading of Bows links to the Armory, which is above the index.
    const gear = entry('gear', GEAR.replace(`### ${to('bows')}`, `### ${to('armory')}`));
    const contents = gearWiki({ guides: [gear] });
    const armory = headingStepId(g('gear'), 'armory');
    expect(contents.heading(armory)?.title).toBe('Armory');
    expect(trail(contents, 'bow-2')).toEqual(['Equipment', 'Armory', 'Gear', 'Weapons', 'Armory']);
    expect(contents.parentOf(g('bow-2'))).toBe(armory);
    expect(contents.pageParentOf(g('bow-2'))).toBe(g('gear'));
  });

  it('are no place to move a page to in the arrange tool, which files by the headings that link', () => {
    const { data } = gearData();
    const own: OwnPages = {
      ...NO_OWN_PAGES,
      contents: {
        top: ['heads:section:equipment', PAGES],
        sections: {
          'heads:section:equipment': [g('armory')],
          [g('armory')]: [g('gear')],
          [PAGES]: data.sections[1]!.items,
        },
      },
    };
    const { layout } = shownContentsFor(data, own);
    const ids = [...Object.keys(layout.sections), ...Object.values(layout.sections).flat()];
    expect(ids.filter((id) => id.includes('#'))).toEqual([]);
    expect(layout.sections[g('short-blades')]).toEqual(BLADES.map(g));
    expect(layout.sections[g('gear')]).toEqual(
      ['short-blades', 'bows', ...names('spear', 3), ...CHARMS].map(g),
    );
  });
});
