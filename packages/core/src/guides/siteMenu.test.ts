import { NO_OWN_PAGES, type GuideEntry, type OwnPages, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { OTHER_LETTER, letterOf, pagesAToZ } from './allPages';
import {
  GuideContents,
  OUTSIDE_TRAIL_STEPS,
  entryIdOf,
  entryTitleOf,
  type ContentsEntry,
} from './contents';
import { applyOwnPages, layoutFor, moveShownEntries, shownContentsFor } from './ownPages';
import {
  HOME,
  LARGE_WIKI,
  PAGES_SECTION,
  SMALL_WIKI,
  guideId,
  madeUpWiki,
  sectionId,
} from './testing/madeUpWiki';

/**
 * The menu Guides shows is the source's own and what the person arranged
 * by hand, nothing more: the pack's sections in its order, never a section
 * of pages outside the menu (`placeByLinks`), and no page put under
 * another by reading pages. Every page stays a page to read, and "All
 * pages" lists each one once. On made-up wikis only.
 */

const data = (wiki = madeUpWiki(SMALL_WIKI, { filed: true })) => ({
  guides: wiki.guides,
  sections: wiki.sections,
  maps: [],
});

const contentsOf = (wiki = madeUpWiki(SMALL_WIKI, { filed: true }), own = NO_OWN_PAGES) =>
  new GuideContents({ ...applyOwnPages(data(wiki), own), homePage: wiki.homePage });

/** The menu as nested lists of titles. */
function tree(contents: GuideContents): unknown[] {
  const level = (entries: readonly ContentsEntry[]): unknown[] =>
    entries.map((entry) => {
      const under = contents.items(entryIdOf(entry));
      if (entry.kind === 'section') return { [entry.section.title]: level(under) };
      return under.length > 0 ? { [entryTitleOf(entry)]: level(under) } : entryTitleOf(entry);
    });
  return level(contents.top());
}

/** Every page the pack's sections list, and its home page, each once. */
function pagesIn(sections: readonly Section[], home: string | null): Set<string> {
  const ids = new Set<string>(home ? [home] : []);
  for (const section of sections) {
    for (const item of section.items) if (item.includes(':guide:')) ids.add(item);
  }
  return ids;
}

describe('the menu', () => {
  it('is the pack’s sections as given, and no list page holds the pages it lists', () => {
    const contents = contentsOf();
    expect(tree(contents)).toEqual([
      { Equipment: ['Weapons', 'Armour', 'Gear'] },
      { 'The world': ['Enemies'] },
    ]);
    expect(contents.items(guideId('weapons'))).toEqual([]);
    expect(contents.trail(guideId('gear')).map((step) => entryTitleOf(step))).toEqual([
      'Equipment',
    ]);
  });

  it('never shows the section of pages outside the menu, whose pages are still pages', () => {
    const wiki = madeUpWiki(SMALL_WIKI, { filed: true });
    const contents = contentsOf(wiki);
    expect(contents.topEntryIds()).not.toContain(PAGES_SECTION);
    expect(contents.isInMenu(PAGES_SECTION)).toBe(false);
    const blade = guideId(wiki.ids.weapons[0]!);
    expect(contents.isPage(blade)).toBe(true);
    expect(contents.isInMenu(blade)).toBe(false);
    expect(contents.parentOf(blade)).toBeUndefined();
    expect(contents.trail(blade)).toEqual([]);
    expect(contents.hasPagesOutsideMenu()).toBe(true);
  });

  it('keeps the sections of a pack in their order and nesting, the ones outside the menu left out', () => {
    const g = (local: string) => `nest:guide:${local}`;
    const s = (local: string) => `nest:section:${local}`;
    const guides: GuideEntry[] = ['a', 'b', 'c', 'd'].map((local) => ({
      id: g(local),
      title: local.toUpperCase(),
      body: '',
      locationIds: [],
    }));
    const sections: Section[] = [
      { id: s('outer'), title: 'Outer', items: [g('a'), s('inner'), s('hidden-pages')] },
      { id: s('inner'), title: 'Inner', items: [g('b')] },
      { id: s('hidden-pages'), title: 'More', items: [g('c')], placeByLinks: true },
      { id: s('last'), title: 'Last', items: [g('d')] },
    ];
    const contents = new GuideContents({ data: { guides, sections, maps: [] } });
    expect(tree(contents)).toEqual([{ Outer: ['A', { Inner: ['B'] }] }, { Last: ['D'] }]);
    expect(contents.isPage(g('c'))).toBe(true);
    expect(contents.top()[0]).toMatchObject({ kind: 'section', pages: 2 });
  });

  it('holds what the person placed by hand: a page in a section, and pages under a page', () => {
    const wiki = madeUpWiki(SMALL_WIKI, { filed: true });
    const layout = layoutFor(data(wiki), NO_OWN_PAGES);
    const shown = shownContentsFor(data(wiki), NO_OWN_PAGES, HOME).layout;
    const [first, second] = wiki.ids.weapons.map(guideId);
    let own: OwnPages = moveShownEntries(
      NO_OWN_PAGES,
      layout,
      shown,
      [first!, second!],
      guideId('weapons'),
      null,
    ).own;
    const note = guideId(wiki.ids.notes[0]!);
    own = moveShownEntries(
      own,
      layoutFor(data(wiki), own),
      shownContentsFor(data(wiki), own, HOME).layout,
      [note],
      sectionId('the-world'),
      null,
    ).own;
    const contents = contentsOf(wiki, own);
    expect(tree(contents)).toEqual([
      { Equipment: [{ Weapons: ['Blade 0001', 'Blade 0002'] }, 'Armour', 'Gear'] },
      { 'The world': ['Enemies', 'Note 0001'] },
    ]);
    expect(contents.trail(second!).map((step) => entryTitleOf(step))).toEqual([
      'Equipment',
      'Weapons',
    ]);
    expect(contents.top()[0]).toMatchObject({ pages: 5 });
    expect(contents.filing()).toMatchObject({ inMenu: 5, byHand: 2 });
  });

  it('counts the pages in the menu and outside it, each once', () => {
    const wiki = madeUpWiki(SMALL_WIKI);
    const counts = contentsOf(wiki).filing();
    expect(counts.inMenu).toBe(4);
    expect(counts.byHand).toBe(0);
    expect(counts.pages).toBe(pagesIn(wiki.sections, null).size);
    expect(counts.inMenu + counts.byHand + counts.outsideMenu).toBe(counts.pages);
  });
});

describe('every page', () => {
  it('is a page to read, once, in the menu or not, on a wiki of thousands', () => {
    const wiki = madeUpWiki(LARGE_WIKI, { filed: true });
    const contents = contentsOf(wiki);
    const listed = pagesIn(wiki.sections, wiki.homePage);
    const pages = contents.pages();
    expect(pages[0]!.id).toBe(wiki.homePage);
    expect(new Set(pages.map((page) => page.id))).toEqual(listed);
    expect(pages).toHaveLength(listed.size);
    // "All pages" holds them all, each once.
    const all = pagesAToZ(pages).flatMap((group) => group.pages);
    expect(all).toHaveLength(listed.size);
    expect(new Set(all.map((page) => page.id)).size).toBe(listed.size);
  });

  it('stays one when the person hides the page it was put under by hand', () => {
    const wiki = madeUpWiki(SMALL_WIKI);
    const [first, second] = wiki.ids.notes.map(guideId);
    const own: OwnPages = {
      ...NO_OWN_PAGES,
      pages: [{ id: first!, hidden: true, updatedAt: '2026-11-15T10:00:00.000Z' }],
      contents: {
        ...layoutFor(data(wiki), NO_OWN_PAGES),
        sections: {
          ...layoutFor(data(wiki), NO_OWN_PAGES).sections,
          [PAGES_SECTION]: layoutFor(data(wiki), NO_OWN_PAGES).sections[PAGES_SECTION]!.filter(
            (id) => id !== second,
          ),
          [first!]: [second!],
        },
      },
    };
    const contents = contentsOf(wiki, own);
    expect(contents.isPage(first!)).toBe(false);
    expect(contents.isPage(second!)).toBe(true);
    expect(contents.pages().map((page) => page.id)).toContain(second);
  });
});

describe('the way above a page outside the menu', () => {
  it('follows the pages the source files it under, outermost first', () => {
    const wiki = madeUpWiki(SMALL_WIKI, { filed: true });
    const contents = contentsOf(wiki);
    const blade = guideId(wiki.ids.weapons[2]!);
    expect(contents.outsideTrail(blade).map((step) => entryTitleOf(step))).toEqual(['Weapons']);
    // A character: the first page of its `filedUnder` that is read (the first is not).
    const smith = wiki.guides.find((guide) => guide.id === guideId(wiki.ids.characters[0]!))!;
    const home = smith.filedUnder![1]!;
    expect(contents.outsideTrail(smith.id).map((step) => entryIdOf(step))).toEqual([home]);
  });

  it('is none where the source files the page under nothing, and for a page in the menu', () => {
    const wiki = madeUpWiki(SMALL_WIKI);
    const contents = contentsOf(wiki);
    expect(contents.outsideTrail(guideId(wiki.ids.weapons[0]!))).toEqual([]);
    expect(contents.outsideTrail(guideId('weapons'))).toEqual([]);
  });

  it('never names a page twice, stops at the home page, and is at most a few steps', () => {
    const g = (local: string) => `chain:guide:${local}`;
    const page = (local: string, under: string[] = []): GuideEntry => ({
      id: g(local),
      title: local,
      body: '',
      locationIds: [],
      ...(under.length > 0 ? { filedUnder: under.map(g) } : {}),
    });
    const chain = Array.from({ length: 10 }, (_, i) => page(`p${i}`, [`p${i + 1}`]));
    const guides = [
      ...chain,
      page('p10'),
      page('circle-a', ['circle-b']),
      page('circle-b', ['circle-a']),
      page('start', ['self', 'start', 'gone', 'circle-a']),
      page('to-home', ['home']),
      page('home'),
      page('old-name-user', ['old-name']),
    ];
    const contents = new GuideContents({
      data: {
        guides,
        sections: [
          {
            id: 'chain:section:pages',
            title: 'Pages',
            items: guides.map((guide) => guide.id),
            placeByLinks: true,
          },
        ],
        maps: [],
      },
      homePage: g('home'),
      aliases: { [g('old-name')]: g('p10') },
    });
    const titles = (local: string) =>
      contents.outsideTrail(g(local)).map((step) => entryTitleOf(step));
    expect(titles('p0')).toHaveLength(OUTSIDE_TRAIL_STEPS);
    expect(titles('p0')).toEqual(['p6', 'p5', 'p4', 'p3', 'p2', 'p1']);
    expect(titles('start')).toEqual(['circle-b', 'circle-a']);
    expect(titles('to-home')).toEqual([]);
    expect(titles('old-name-user')).toEqual(['p10']);
  });

  it('starts with the page it was put under by hand', () => {
    const wiki = madeUpWiki(SMALL_WIKI, { filed: true });
    const blade = guideId(wiki.ids.weapons[0]!);
    const note = guideId(wiki.ids.notes[1]!);
    const own = moveShownEntries(
      NO_OWN_PAGES,
      layoutFor(data(wiki), NO_OWN_PAGES),
      shownContentsFor(data(wiki), NO_OWN_PAGES, HOME).layout,
      [note],
      blade,
      null,
    ).own;
    const contents = contentsOf(wiki, own);
    expect(contents.isInMenu(note)).toBe(false);
    expect(contents.outsideTrail(note).map((step) => entryIdOf(step))).toEqual([
      guideId('weapons'),
      blade,
    ]);
    expect(contents.items(blade).map((entry) => entryIdOf(entry))).toEqual([note]);
  });
});

describe('“Linked from”', () => {
  it('names every page that links to a page, in contents order, the home page aside', () => {
    const wiki = madeUpWiki(SMALL_WIKI);
    const contents = contentsOf(wiki);
    const from = contents.linkedFrom(guideId('locations')).map((page) => page.id);
    expect(from).toContain(guideId('weapons'));
    expect(from).not.toContain(wiki.homePage);
    expect(new Set(from).size).toBe(from.length);
  });

  it('names thousands of pages that link to one, read once', () => {
    const g = (local: string) => `many:guide:${local}`;
    const guides: GuideEntry[] = [
      { id: g('hub'), title: 'Hub', body: 'The hub.', locationIds: [] },
      ...Array.from({ length: 5000 }, (_, i) => ({
        id: g(`p${i}`),
        title: `Page ${i}`,
        body: `See the [hub](${g('hub')}).`,
        locationIds: [],
      })),
    ];
    const contents = new GuideContents({
      data: {
        guides,
        sections: [{ id: 'many:section:p', title: 'P', items: guides.map((x) => x.id) }],
        maps: [],
      },
    });
    const started = performance.now();
    expect(contents.linkedFrom(g('hub'))).toHaveLength(5000);
    expect(contents.linkedFrom(g('p1'))).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('“All pages”', () => {
  const page = (title: string, id = title.toLowerCase().replace(/\W+/g, '-')): GuideEntry => ({
    id: `az:guide:${id || 'x'}`,
    title,
    body: '',
    locationIds: [],
  });

  it('lists every page under its first letter, digits and signs first, numbers by value', () => {
    const groups = pagesAToZ(
      [
        'Item 10',
        'item 9',
        'Élan',
        'Echo',
        'Apple',
        '7 Seas',
        '"Quoted"',
        'zebra',
        'Item 9',
        'Ápex',
      ].map((title, i) => page(title, `p${i}`)),
    );
    expect(groups.map((group) => group.letter)).toEqual([OTHER_LETTER, 'A', 'E', 'I', 'Z']);
    expect(groups.map((group) => group.pages.map((p) => p.title))).toEqual([
      ['"Quoted"', '7 Seas'],
      ['Ápex', 'Apple'],
      ['Echo', 'Élan'],
      ['item 9', 'Item 9', 'Item 10'],
      ['zebra'],
    ]);
    expect(letterOf('  ébène')).toBe('E');
    expect(letterOf('')).toBe(OTHER_LETTER);
  });

  it('is the same every time for pages of one title', () => {
    const twins = [page('Twin', 'b'), page('Twin', 'a')];
    expect(pagesAToZ(twins)[0]!.pages.map((p) => p.id)).toEqual(['az:guide:a', 'az:guide:b']);
    expect(pagesAToZ([...twins].reverse())[0]!.pages.map((p) => p.id)).toEqual([
      'az:guide:a',
      'az:guide:b',
    ]);
  });

  it('sorts five thousand pages quickly', () => {
    const words = ['Ash', 'Bog', 'Cave', 'Dune', 'Elm', 'Fen', 'Glen', 'Hill', '3rd'];
    const pages = Array.from({ length: 5000 }, (_, i) =>
      page(`${words[i % words.length]} ${5000 - i}`, `n${i}`),
    );
    const started = performance.now();
    const groups = pagesAToZ(pages);
    const took = performance.now() - started;
    expect(groups.reduce((sum, group) => sum + group.pages.length, 0)).toBe(5000);
    expect(groups[0]!.letter).toBe(OTHER_LETTER);
    // Numbers by their value: Ash 5, Ash 14, … Ash 5000.
    const ash = groups[1]!.pages.map((p) => Number(p.title.split(' ')[1]));
    expect(ash).toEqual([...ash].sort((a, b) => a - b));
    expect(ash[0]).toBe(5);
    expect(took).toBeLessThan(1000);
  });
});
