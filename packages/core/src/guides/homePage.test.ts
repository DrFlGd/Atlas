import { NO_OWN_PAGES, type GuideEntry, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, guidesTogether, type GuidePages } from './contents';
import { firstPictureIn, madeLanding } from './landing';
import { shownContentsFor } from './ownPages';

/**
 * A wiki's home page: the page Guides opens on, which the top of the
 * contents branches from; and the landing page made for guides that have
 * none. On a made-up wiki: a menu of one section, the pages nothing in the
 * menu names in a section placed by links ("Pages"), and a home page that
 * leads to the main areas.
 */

const g = (local: string) => `wiki:guide:${local}`;
const s = (local: string) => `wiki:section:${local}`;
const pic = (local: string) => `wiki:picture:${local}`;

/**
 * A page that lists the pages named, a list item each: a list page, with
 * pages the wiki has but that were not read to make three at least.
 */
function page(local: string, links: string[] = [], extra = ''): GuideEntry {
  const title = local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  const unread = links.length > 0 && links.length < 3 ? [`${local}-more-1`, `${local}-more-2`] : [];
  return {
    id: g(local),
    title,
    body: `${extra}\n\n${[...links, ...unread].map((to) => `- [${to}](${g(to)})`).join('\n')}`,
    locationIds: [],
  };
}

const guides = () => [
  page('main-page', ['classes', 'items', 'quests', 'help']),
  page('help', ['editing']),
  page('editing'),
  page('classes', ['knight', 'archer']),
  page('knight', [], `![A knight](${pic('knight')})`),
  page('archer'),
  page('items', ['sword'], `![Shelves of items](${pic('items')})`),
  { ...page('sword'), body: `A sword, as a [knight](${g('knight')}) carries.` },
  page('quests'),
  page('stray'),
];

function wiki(home: string | null, listedHome = false): GuidePages {
  const sections: Section[] = [
    { id: s('menu'), title: 'Menu', items: [g('help'), ...(listedHome ? [g('main-page')] : [])] },
    {
      id: s('pages'),
      title: 'Pages',
      items: ['classes', 'knight', 'archer', 'items', 'sword', 'quests', 'editing', 'stray'].map(g),
      placeByLinks: true,
    },
  ];
  return { data: { guides: guides(), sections, maps: [] }, ...(home ? { homePage: home } : {}) };
}

/** The contents as nested lists of titles; a page with pages under it is `{ title: [...] }`. */
function tree(contents: GuideContents): unknown[] {
  const level = (entries: ReturnType<GuideContents['top']>): unknown[] =>
    entries.map((entry) => {
      if (entry.kind === 'section') {
        return { [entry.section.title]: level(contents.items(entry.section.id)) };
      }
      const under = contents.items(entry.guide.id);
      return under.length > 0 ? { [entry.guide.title]: level(under) } : entry.guide.title;
    });
  return level(contents.top());
}

describe('a home page', () => {
  it('is the root the top of the contents branches from', () => {
    const contents = new GuideContents(wiki(g('main-page')));
    expect(contents.homePage()?.id).toBe(g('main-page'));
    expect(tree(contents)).toEqual([
      // The menu's pages stay where the menu puts them.
      { Menu: [{ Help: ['Editing'] }] },
      // The main areas the home page leads to, at the top, before the pages nothing leads to.
      { Classes: ['Knight', 'Archer'] },
      { Items: ['Sword'] },
      'Quests',
      { Pages: ['Stray'] },
    ]);
    // A page at the top has no way above it, and the home page is in no section.
    expect(contents.trail(g('classes'))).toEqual([]);
    expect(contents.parentOf(g('classes'))).toBeNull();
    expect(contents.parentOf(g('main-page'))).toBeUndefined();
    expect(contents.trail(g('main-page'))).toEqual([]);
    expect(contents.placedByLinks(g('classes'))).toBe(true);
    // It is a page to read and to find, the first.
    expect(contents.isPage(g('main-page'))).toBe(true);
    expect(contents.isHomePage(g('main-page'))).toBe(true);
    expect(contents.isHomePage(g('help'))).toBe(false);
    expect(contents.pages()[0]!.id).toBe(g('main-page'));
    expect(contents.pages()).toHaveLength(guides().length);
  });

  it('without one, places the same pages as before', () => {
    const contents = new GuideContents(wiki(null));
    expect(contents.homePage()).toBeNull();
    expect(tree(contents)).toEqual([
      { Menu: [{ Help: ['Editing'] }] },
      // A list page nothing leads to keeps the pages it lists under it.
      { Pages: [{ Classes: ['Knight', 'Archer'] }, { Items: ['Sword'] }, 'Quests', 'Stray'] },
    ]);
  });

  it('leaves out the section of pages placed by links once it leads to all of them', () => {
    const data = wiki(g('main-page'));
    const all = {
      ...data.data,
      guides: data.data.guides.filter((guide) => guide.id !== g('stray')),
    };
    const contents = new GuideContents({ ...data, data: all });
    expect(
      tree(contents).map((entry) =>
        typeof entry === 'string' ? entry : Object.keys(entry as object)[0],
      ),
    ).toEqual(['Menu', 'Classes', 'Items', 'Quests']);
    expect(contents.topEntryIds()).not.toContain(s('pages'));
  });

  it('is shown on its own even where a section lists it', () => {
    const contents = new GuideContents(wiki(g('main-page'), true));
    expect(tree(contents)[0]).toEqual({ Menu: [{ Help: ['Editing'] }] });
    expect(contents.pages().filter((p) => p.id === g('main-page'))).toHaveLength(1);
  });

  it('is never named under "Also linked from"', () => {
    const contents = new GuideContents(wiki(g('main-page')));
    // Knight is under Classes; Sword links to it as well; the home page leads to neither.
    expect(contents.linkedFrom(g('knight')).map((p) => p.title)).toEqual(['Sword']);
    // Help is in the menu, and the home page links to it: not named, as the way above leads there.
    expect(contents.linkedFrom(g('help'))).toEqual([]);
  });

  it('is not used when the guides lack it, or through another name', () => {
    expect(new GuideContents(wiki(g('gone'))).homePage()).toBeNull();
    const renamed = new GuideContents({
      ...wiki(g('main-page')),
      aliases: { [g('old-main')]: g('main-page') },
    });
    expect(renamed.isHomePage(g('old-main'))).toBe(true);
  });

  it('is left out of a game with no contents, and read first', () => {
    const contents = new GuideContents({
      data: { guides: guides(), sections: [], maps: [] },
      homePage: g('main-page'),
    });
    expect(contents.top().map((e) => (e.kind === 'page' ? e.guide.id : ''))).not.toContain(
      g('main-page'),
    );
    expect(contents.pages()[0]!.id).toBe(g('main-page'));
  });

  it('branches the arrange tool’s contents the same way', () => {
    const { data } = wiki(g('main-page'));
    const shown = shownContentsFor(data, NO_OWN_PAGES, undefined, g('main-page'));
    expect(shown.layout.top).toEqual([
      s('menu'),
      g('classes'),
      g('items'),
      g('quests'),
      s('pages'),
    ]);
    expect(shown.layout.sections[s('pages')]).toEqual([g('stray')]);
    expect(shown.placed.get(g('classes'))).toBe(g('main-page'));
    expect(Object.keys(shown.layout.sections)).not.toContain(g('main-page'));
  });

  it('of another game read with this one is first under its title', () => {
    const own: GuidePages = {
      data: { guides: [page('notes')], sections: [], maps: [{} as never] },
    };
    const together = guidesTogether(own, [
      {
        gameId: 'wiki',
        title: 'The Wiki',
        data: wiki(null).data,
        homePage: g('main-page'),
      },
    ]);
    const contents = new GuideContents(together);
    const [section] = contents.top();
    expect(section?.kind === 'section' && section.section.title).toBe('The Wiki');
    const first = contents.items((section as { section: Section }).section.id)[0];
    expect(first?.kind === 'page' && first.guide.id).toBe(g('main-page'));
    // Its own game's home page is not this game's.
    expect(contents.homePage()).toBeNull();
  });
});

describe('the landing page made from the contents', () => {
  it('groups the top of the contents, with a picture where a page has one', () => {
    const contents = new GuideContents(wiki(null));
    const groups = madeLanding(contents, 3);
    expect(groups.map((group) => group.section?.title ?? null)).toEqual(['Menu', 'Pages']);
    const [menu, pages] = groups;
    expect(menu!.tiles.map((t) => (t.entry.kind === 'page' ? t.entry.guide.title : ''))).toEqual([
      'Help',
    ]);
    // Three tiles at most, the rest counted: Classes and Items hold the pages they list.
    expect(pages!.tiles).toHaveLength(3);
    expect(pages!.more).toBe(1);
    expect([menu!.pages, pages!.pages]).toEqual([2, 7]);
    expect(pages!.tiles.map((t) => t.picture)).toEqual([null, pic('items'), null]);
  });

  it('gives a section the picture of its first page that has one, and pages at the top a group', () => {
    const contents = new GuideContents(wiki(g('main-page')));
    const groups = madeLanding(contents);
    expect(groups.map((group) => group.section?.title ?? null)).toEqual(['Menu', null, 'Pages']);
    const top = groups[1]!;
    expect(top.tiles.map((t) => (t.entry.kind === 'page' ? t.entry.guide.title : ''))).toEqual([
      'Classes',
      'Items',
      'Quests',
    ]);
    const sections = new GuideContents({
      data: {
        guides: guides(),
        sections: [
          { id: s('people'), title: 'People', items: [s('heroes')] },
          { id: s('heroes'), title: 'Heroes', items: [g('archer'), g('knight')] },
        ],
        maps: [],
      },
    });
    const [people] = madeLanding(sections);
    expect(people!.tiles[0]).toMatchObject({ entry: { kind: 'section' }, picture: pic('knight') });
  });

  it('reads the first picture of a page, not an icon and not hidden text', () => {
    expect(firstPictureIn(`![a](${pic('a')}) ![b](${pic('b')})`)).toBe(pic('a'));
    expect(firstPictureIn(`![icon](${pic('a')} "=24x24") ![big](<${pic('b')}> "=300")`)).toBe(
      pic('b'),
    );
    expect(firstPictureIn(`![small](${pic('a')} "=40")`)).toBeNull();
    expect(firstPictureIn(`||![secret](${pic('a')})|| ![shown](${pic('b')})`)).toBe(pic('b'));
    expect(firstPictureIn(`\\|\\| ![shown](${pic('a')})`)).toBe(pic('a'));
    expect(firstPictureIn('![web](https://example.org/a.png) no pictures of the pack')).toBeNull();
  });
});
