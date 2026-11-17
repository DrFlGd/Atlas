import { NO_OWN_PAGES, type GuideEntry, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  GuideContents,
  entryIdOf,
  entryTitleOf,
  guidesTogether,
  type GuidePages,
} from './contents';
import { firstPictureIn, madeLanding } from './landing';
import { shownContentsFor } from './ownPages';

/**
 * A wiki's home page: the page Guides opens on, shown on its own and not
 * in the menu; and the landing page made for guides that have none. On a
 * made-up wiki: a menu of one section, the pages its menu does not name
 * in a section of pages outside the menu ("Pages"), and a home page that
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
      const under = contents.items(entryIdOf(entry));
      return under.length > 0 ? { [entryTitleOf(entry)]: level(under) } : entryTitleOf(entry);
    });
  return level(contents.top());
}

describe('a home page', () => {
  it('is shown on its own: the menu is only the source’s own, nothing put at its top', () => {
    const contents = new GuideContents(wiki(g('main-page')));
    expect(contents.homePage()?.id).toBe(g('main-page'));
    // The pages the home page lists stay outside the menu, and nothing goes under Help.
    expect(tree(contents)).toEqual([{ Menu: ['Help'] }]);
    expect(contents.isInMenu(g('classes'))).toBe(false);
    expect(contents.parentOf(g('classes'))).toBeUndefined();
    expect(contents.parentOf(g('main-page'))).toBeUndefined();
    expect(contents.trail(g('main-page'))).toEqual([]);
    // It is a page to read and to find, the first; every other page is one too.
    expect(contents.isPage(g('main-page'))).toBe(true);
    expect(contents.isPage(g('classes'))).toBe(true);
    expect(contents.isHomePage(g('main-page'))).toBe(true);
    expect(contents.isHomePage(g('help'))).toBe(false);
    expect(contents.pages()[0]!.id).toBe(g('main-page'));
    expect(contents.pages()).toHaveLength(guides().length);
  });

  it('without one, shows the same menu', () => {
    const contents = new GuideContents(wiki(null));
    expect(contents.homePage()).toBeNull();
    expect(tree(contents)).toEqual([{ Menu: ['Help'] }]);
    expect(contents.topEntryIds()).not.toContain(s('pages'));
    // Every page the contents lists, the home page aside, which no section lists.
    expect(contents.pages()).toHaveLength(guides().length - 1);
  });

  it('is shown on its own even where a section lists it', () => {
    const contents = new GuideContents(wiki(g('main-page'), true));
    expect(tree(contents)[0]).toEqual({ Menu: ['Help'] });
    expect(contents.pages().filter((p) => p.id === g('main-page'))).toHaveLength(1);
  });

  it('is never named under "Linked from"', () => {
    const contents = new GuideContents(wiki(g('main-page')));
    expect(contents.linkedFrom(g('knight')).map((p) => p.title)).toEqual(['Classes', 'Sword']);
    // Help is linked from the home page only, which every page's way leads to.
    expect(contents.linkedFrom(g('help'))).toEqual([]);
    expect(contents.linkedFrom(g('editing')).map((p) => p.title)).toEqual(['Help']);
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

  it('is not in the arrange tool’s contents, which ends with the pages outside the menu', () => {
    const { data } = wiki(g('main-page'), true);
    const shown = shownContentsFor(data, NO_OWN_PAGES, g('main-page'));
    expect(shown.layout.top).toEqual([s('menu'), s('pages')]);
    expect(shown.layout.sections[s('menu')]).toEqual([g('help')]);
    expect(shown.layout.sections[s('pages')]).toEqual(
      ['classes', 'knight', 'archer', 'items', 'sword', 'quests', 'editing', 'stray'].map(g),
    );
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
    // Its pages outside its menu are pages of the contents, not in the menu.
    expect(contents.isPage(g('stray'))).toBe(true);
    expect(contents.isInMenu(g('stray'))).toBe(false);
    // Its own game's home page is not this game's.
    expect(contents.homePage()).toBeNull();
  });
});

describe('the landing page made from the contents', () => {
  it('groups the top of the menu, with a picture where a page has one, the rest counted', () => {
    const data = wiki(null).data;
    const menu: Section = {
      id: s('areas'),
      title: 'Areas',
      items: ['classes', 'items', 'quests', 'knight'].map(g),
    };
    const contents = new GuideContents({ data: { ...data, sections: [menu, ...data.sections!] } });
    const groups = madeLanding(contents, 3);
    expect(groups.map((group) => group.section?.title ?? null)).toEqual(['Areas', 'Menu']);
    const [areas] = groups;
    expect(areas!.tiles).toHaveLength(3);
    expect(areas!.more).toBe(1);
    expect(areas!.pages).toBe(4);
    expect(areas!.tiles.map((t) => t.picture)).toEqual([null, pic('items'), null]);
  });

  it('gives a section the picture of its first page that has one', () => {
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
