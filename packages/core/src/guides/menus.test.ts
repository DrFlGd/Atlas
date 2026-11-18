import {
  NO_OWN_PAGES,
  packReadSchemas,
  type GuideEntry,
  type OwnPages,
  type Section,
} from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, entryIdOf, entryTitleOf, spreaderOf, type GuidePages } from './contents';
import { homeMenuOf, isNewsBlock, type HomeMenuEntry } from './homeMenu';
import { madeLanding } from './landing';
import { applyOwnPages, layoutFor, moveEntry, packLayout, shownContentsFor } from './ownPages';

/**
 * Menus made from a home page, and contents whose top holds pages and
 * sections in one order (unheaded sections). On made-up wikis only.
 */

const g = (local: string) => `isle:guide:${local}`;
const s = (local: string) => `isle:section:${local}`;

const titled = (local: string) =>
  local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const guide = (local: string, body = ''): GuideEntry => ({
  id: g(local),
  title: titled(local),
  body,
  locationIds: [],
});

/** A tile of a home page: a linked picture and the page's name. */
const tile = (local: string) =>
  `- [![${titled(local)}](isle:picture:${local})](${g(local)})[${titled(local)}](${g(local)})`;

/** The menu as nested lists: a page by its local id, a block as `{ title: [...] }`. */
function shape(entries: readonly HomeMenuEntry[]): unknown[] {
  return entries.map((entry) =>
    entry.kind === 'page'
      ? entry.id.replace('isle:guide:', '')
      : { [entry.title]: shape(entry.entries) },
  );
}

/** The contents as nested lists of titles. */
function tree(contents: GuideContents): unknown[] {
  const level = (entries: ReturnType<GuideContents['top']>): unknown[] =>
    entries.map((entry) => {
      const under = contents.items(entryIdOf(entry));
      if (entry.kind === 'section') return { [entry.section.title]: level(under) };
      return under.length > 0 ? { [entryTitleOf(entry)]: level(under) } : entryTitleOf(entry);
    });
  return level(contents.top());
}

describe('the menu a home page gives', () => {
  const home = guide(
    'main-page',
    [
      'Welcome to the wiki of the isle, written by its players.',
      '',
      `- [Rules of the wiki](${g('wiki-rules')})`,
      '',
      '## The isle',
      '',
      `The isle has [harbours](${g('harbours')}) and [caves](${g('caves')}).`,
      '',
      tile('getting-started'),
      tile('harbours'),
      tile('caves'),
      '',
      `## [Gear](${g('gear')})`,
      '',
      tile('blades'),
      tile('shields'),
      tile('harbours'),
      '',
      '### Rare gear',
      '',
      tile('moon-blade'),
      '',
      '## Isle news',
      '',
      '- Aug 19, 2026: [Version 2 is out](https://example.org/news/2)',
      '- Jun 18, 2026: [A book of the isle](https://example.org/news/book)',
      `- [Coming soon](${g('coming-soon')})`,
      '',
      '## Wiki news',
      '',
      `- 2026-09-10: [Editing without an account](${g('wiki-accounts')})`,
      `- 2026-07-25: [The wiki to read offline](${g('wiki-offline')})`,
      '',
      '## Wiki community',
      '',
      `- [Noticeboard](${g('wiki-noticeboard')})`,
      `- [Projects](${g('wiki-projects')})`,
    ].join('\n'),
  );
  /** Pages about the wiki itself are none to list, as an importer says. */
  const isPage = (id: string) => !id.startsWith(g('wiki-'));

  it('makes a block of each headed block, in order, with its tiles; news and the wiki’s own affairs are left out', () => {
    expect(shape(homeMenuOf(home, { isPage }))).toEqual([
      { 'The isle': ['getting-started', 'harbours', 'caves'] },
      // A heading that is a link puts its page first; a page listed before is not listed again.
      { Gear: ['gear', 'blades', 'shields', { 'Rare gear': ['moon-blade'] }] },
    ]);
  });

  it('leaves out and keeps blocks by their heading, as a rules file says', () => {
    const menu = homeMenuOf(home, { isPage, leaveOut: ['the ISLE'], keep: ['Isle news'] });
    expect(shape(menu)).toEqual([
      // A page is in the first block that lists it, even one left out: harbours is not repeated.
      { Gear: ['gear', 'blades', 'shields', { 'Rare gear': ['moon-blade'] }] },
      { 'Isle news': ['coming-soon'] },
    ]);
  });

  it('gives the tiles of a home page with one block as the top, with no section around them', () => {
    const one = guide(
      'main-page',
      [
        `Make sure to read the [rules](${g('wiki-rules')}).`,
        '',
        '## Content',
        '',
        tile('achievements'),
        tile('items'),
        tile('rooms'),
      ].join('\n'),
    );
    expect(shape(homeMenuOf(one, { isPage }))).toEqual(['achievements', 'items', 'rooms']);
    // No heading at all: the whole page is the one block.
    const plain = guide('main-page', [tile('items'), tile('rooms'), tile('bosses')].join('\n'));
    expect(shape(homeMenuOf(plain))).toEqual(['items', 'rooms', 'bosses']);
  });

  it('lists only the pages the caller keeps, and drops a block left with none', () => {
    const read = new Set([g('caves'), g('blades')]);
    expect(shape(homeMenuOf(home, { isPage: (id) => read.has(id) }))).toEqual([
      { 'The isle': ['caves'] },
      { Gear: ['blades'] },
    ]);
  });

  it('tells news by dated items or links that leave the wiki', () => {
    expect(isNewsBlock({ pageLinks: 1, webLinks: 5, linkedLines: 6, datedLines: 0 })).toBe(true);
    expect(isNewsBlock({ pageLinks: 2, webLinks: 0, linkedLines: 2, datedLines: 2 })).toBe(true);
    expect(isNewsBlock({ pageLinks: 20, webLinks: 1, linkedLines: 20, datedLines: 0 })).toBe(false);
    // A list of years or versions among many pages is no news.
    expect(isNewsBlock({ pageLinks: 12, webLinks: 0, linkedLines: 12, datedLines: 2 })).toBe(false);
  });
});

/**
 * A guide's own table of contents, as an importer writes it: pages that
 * stand alone at the top between the sections (unheaded sections), a
 * section whose page leads it, and a section inside a section.
 */
function guideBook(unheaded = true): GuidePages {
  const loose = (id: string, title: string, items: string[]): Section => ({
    id: s(id),
    title,
    items,
    ...(unheaded ? { unheaded: true as const } : {}),
  });
  const sections: Section[] = [
    loose('menu', 'Menu', [g('full-map'), g('tips')]),
    {
      id: s('walkthrough'),
      title: 'Walkthrough',
      items: [g('walkthrough'), g('chapter-one'), s('side-quests')],
    },
    loose('menu-2', 'Endings', [g('endings')]),
    { id: s('bosses'), title: 'Bosses', items: [g('bosses'), g('warden')] },
    loose('menu-3', 'Menu', [g('relics'), g('trophies')]),
    { id: s('side-quests'), title: 'Side quests', items: [g('lost-cat')] },
    { id: s('pages'), title: 'Other pages', items: [g('stray')], placeByLinks: true },
  ];
  const guides = [
    'home',
    'full-map',
    'tips',
    'walkthrough',
    'chapter-one',
    'lost-cat',
    'endings',
    'bosses',
    'warden',
    'relics',
    'trophies',
    'stray',
  ].map((local) => guide(local, `Text of ${local}.`));
  return { data: { guides, sections, maps: [] }, homePage: g('home') };
}

const GUIDE_TOP = [
  'Full Map',
  'Tips',
  { Walkthrough: ['Walkthrough', 'Chapter One', { 'Side quests': ['Lost Cat'] }] },
  'Endings',
  { Bosses: ['Bosses', 'Warden'] },
  'Relics',
  'Trophies',
];

describe('pages and sections side by side at the top', () => {
  it('shows a guide’s table of contents in its order, loose pages between the sections', () => {
    const contents = new GuideContents(guideBook());
    expect(tree(contents)).toEqual(GUIDE_TOP);
    expect(contents.topEntryIds().slice(0, 3)).toEqual([
      g('full-map'),
      g('tips'),
      s('walkthrough'),
    ]);
    // The way to a page at the top is empty; to a page of a section, the section.
    expect(contents.trail(g('endings'))).toEqual([]);
    expect(contents.trail(g('lost-cat')).map((step) => entryIdOf(step))).toEqual([
      s('walkthrough'),
      s('side-quests'),
    ]);
    expect(contents.parentOf(g('tips'))).toBeNull();
    // The section of pages outside the menu is not shown; its page is still one to read.
    expect(contents.isPage(g('stray'))).toBe(true);
    expect(contents.isInMenu(g('stray'))).toBe(false);
  });

  it('opens in an app before unheaded sections, with them as sections of their own', () => {
    // Read as an app before the field reads it: the key is dropped.
    const before = packReadSchemas.sectionSchema.omit({ unheaded: true });
    const pack = guideBook();
    const old: GuidePages = {
      ...pack,
      data: { ...pack.data, sections: pack.data.sections!.map((section) => before.parse(section)) },
    };
    expect(tree(new GuideContents(old))).toEqual([
      { Menu: ['Full Map', 'Tips'] },
      { Walkthrough: ['Walkthrough', 'Chapter One', { 'Side quests': ['Lost Cat'] }] },
      { Endings: ['Endings'] },
      { Bosses: ['Bosses', 'Warden'] },
      { Menu: ['Relics', 'Trophies'] },
    ]);
  });

  it('spreads an unheaded section in a section, and never one placed by links', () => {
    const sections: Section[] = [
      { id: s('a'), title: 'A', items: [g('one'), s('b'), g('three')] },
      { id: s('b'), title: 'B', items: [g('two')], unheaded: true },
      { id: s('c'), title: 'C', items: [g('four')], unheaded: true, placeByLinks: true },
    ];
    const spread = spreaderOf(sections);
    expect([...spread.unheaded]).toEqual([s('b')]);
    expect(spread.items(sections[0]!.items)).toEqual([g('one'), g('two'), g('three')]);
  });

  it('makes the landing page with the loose pages as groups in their place', () => {
    const { homePage: _home, ...noHome } = guideBook();
    const groups = madeLanding(new GuideContents(noHome));
    expect(groups.map((group) => group.section?.title ?? null)).toEqual([
      null,
      'Walkthrough',
      null,
      'Bosses',
      null,
    ]);
  });
});

describe('the person’s own arrangement over unheaded sections', () => {
  const titles = (pages: GuidePages) => tree(new GuideContents(pages));

  it('lays out the pack with the loose pages at the top, and moves them like any page', () => {
    const pack = guideBook();
    const layout = packLayout(pack.data);
    expect(layout.top.slice(0, 4)).toEqual([
      g('full-map'),
      g('tips'),
      s('walkthrough'),
      g('endings'),
    ]);
    expect(Object.keys(layout.sections)).not.toContain(s('menu'));
    // Move a page from the top into a section.
    const own: OwnPages = moveEntry(NO_OWN_PAGES, layout, g('tips'), null, s('bosses'), null);
    const shown = titles(applyOwnPages(pack.data, own));
    expect(shown[0]).toBe('Full Map');
    expect(shown).toContainEqual({ Bosses: ['Bosses', 'Warden', 'Tips'] });
    expect(shown).not.toContain('Tips');
    // The arrange tool sees the same.
    const tool = shownContentsFor(pack.data, own, pack.homePage);
    expect(tool.layout.sections[s('bosses')]).toEqual([g('bosses'), g('warden'), g('tips')]);
  });

  it('keeps the pages of a section the person arranged before it became unheaded', () => {
    const pack = guideBook();
    // Made when the pack had a headed "Menu" at the top, the person's order inside it reversed.
    const own: OwnPages = {
      ...NO_OWN_PAGES,
      contents: {
        top: [s('menu'), s('walkthrough'), s('bosses'), s('pages')],
        sections: {
          [s('menu')]: [g('tips'), g('full-map')],
          [s('walkthrough')]: [g('walkthrough'), g('chapter-one'), s('side-quests')],
          [s('side-quests')]: [g('lost-cat')],
          [s('bosses')]: [g('bosses'), g('warden')],
        },
      },
    };
    const layout = layoutFor(pack.data, own);
    // The unheaded section is no entry any more; its pages are where the pack puts them, none lost.
    expect(layout.top).not.toContain(s('menu'));
    const shown = JSON.stringify(titles(applyOwnPages(pack.data, own)));
    for (const title of ['Full Map', 'Tips', 'Endings', 'Relics', 'Trophies', 'Lost Cat']) {
      expect(shown).toContain(`"${title}"`);
    }
  });
});

describe('a home page and the menu', () => {
  const home = guide(
    'main-page',
    [
      '## The isle',
      '',
      tile('harbours'),
      tile('caves'),
      tile('forests'),
      tile('meadows'),
      '',
      '## Isle news',
      '',
      `- [Coming soon](${g('coming-soon')})`,
    ].join('\n'),
  );
  const pages = ['harbours', 'caves', 'forests', 'meadows', 'coming-soon'].map((local) =>
    guide(local, `Text of ${local}.`),
  );

  it('shows the menu the importer made from the home page, and nothing of the other pages', () => {
    const sections: Section[] = [
      {
        id: s('the-isle'),
        title: 'The isle',
        items: [g('harbours'), g('caves'), g('forests'), g('meadows')],
      },
      { id: s('pages'), title: 'Other pages', items: [g('coming-soon')], placeByLinks: true },
    ];
    const contents = new GuideContents({
      data: { guides: [home, ...pages], sections, maps: [] },
      homePage: home.id,
    });
    expect(tree(contents)).toEqual([{ 'The isle': ['Harbours', 'Caves', 'Forests', 'Meadows'] }]);
    expect(contents.isPage(g('coming-soon'))).toBe(true);
  });

  it('never puts at the top what the home page lists', () => {
    const sections: Section[] = [
      { id: s('menu'), title: 'Menu', items: [g('harbours')] },
      {
        id: s('pages'),
        title: 'Pages',
        items: [g('caves'), g('forests'), g('meadows'), g('coming-soon')],
        placeByLinks: true,
      },
    ];
    const contents = new GuideContents({
      data: { guides: [home, ...pages], sections, maps: [] },
      homePage: home.id,
    });
    expect(tree(contents)).toEqual([{ Menu: ['Harbours'] }]);
    expect(contents.pages().map((page) => page.title)).toEqual([
      'Main Page',
      'Harbours',
      'Caves',
      'Forests',
      'Meadows',
      'Coming Soon',
    ]);
  });
});
