import { NO_OWN_PAGES, type GuideEntry, type OwnPages, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, type GuidePages } from './contents';
import {
  addOwnPage,
  applyOwnPages,
  deleteOwnPage,
  layoutFor,
  looseSections,
  moveShownEntry,
  setPageHidden,
  shownContentsFor,
  stepInLayout,
  parentOf,
} from './ownPages';
import { guideLinksIn } from './pageTree';
import {
  PAGES_SECTION,
  guideId,
  madeUpWiki,
  sectionId,
  type MadeUpWiki,
} from './testing/madeUpWiki';

/**
 * Pages placed by their links, on a made-up wiki: a menu of sections
 * (Equipment, The world) with a few pages, and the pages nothing in the
 * menu names, in a section placed by links ("Pages").
 */

const NOW = new Date('2026-11-14T10:00:00.000Z');
const g = (local: string) => `wiki:guide:${local}`;
const s = (local: string) => `wiki:section:${local}`;
const PAGES = s('pages');

const titleOf = (local: string) =>
  local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/** A page that lists the pages named (a list item each) and mentions others in a sentence. */
function page(local: string, listed: string[] = [], mentioned: string[] = []): GuideEntry {
  const title = titleOf(local);
  const list = listed.map((to) => `- [${titleOf(to)}](${g(to)})`).join('\n');
  const text = mentioned.map((to) => `See [${titleOf(to)}](${g(to)}).`).join(' ');
  return { id: g(local), title, body: `# ${title}\n\n${text}\n\n${list}`, locationIds: [] };
}

/** A page that only mentions the pages named, in a sentence. */
const mentions = (local: string, ...mentioned: string[]) => page(local, [], mentioned);

function wiki(
  guides: GuideEntry[],
  menu: Record<string, string[]>,
  loose: string[],
): GuidePages['data'] {
  const sections: Section[] = Object.entries(menu).map(([title, items]) => ({
    id: s(title.toLowerCase().replace(/\s+/g, '-')),
    title,
    items: items.map(g),
  }));
  sections.push({ id: PAGES, title: 'Pages', items: loose.map(g), placeByLinks: true });
  return { guides, sections, maps: [] };
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

const trail = (contents: GuideContents, id: string) =>
  contents
    .trail(id)
    .map((step) => (step.kind === 'section' ? step.section.title : step.guide.title));

/**
 * The made-up wiki: Equipment › Armor › Warden Plate › Warden Helm,
 * The world › Bestiary › Marsh Toad. Armor, Weapons, Bestiary, Regions
 * and Warden Plate are list pages; the others mention pages in sentences.
 */
const base = () => [
  page('armor', ['warden-plate', 'ash-mail', 'iron-cap']),
  page('weapons', ['longblade', 'short-bow', 'hand-axe']),
  page('bestiary', ['marsh-toad', 'stone-hound', 'cave-bat']),
  page('regions', ['marsh', 'dunes', 'peaks', 'bestiary']),
  page('warden-plate', ['warden-helm', 'warden-boots', 'warden-gloves'], ['marsh-toad']),
  page('ash-mail'),
  page('iron-cap'),
  page('warden-helm'),
  page('warden-boots'),
  page('warden-gloves'),
  mentions('longblade', 'warden-plate'),
  page('short-bow'),
  page('hand-axe'),
  mentions('marsh-toad', 'marsh'),
  page('stone-hound'),
  page('cave-bat'),
  mentions('marsh', 'marsh-toad'),
  page('dunes'),
  page('peaks'),
  mentions('lost-note', 'stray'),
  page('stray'),
];
const menu = { Equipment: ['armor', 'weapons'], 'The world': ['bestiary', 'regions'] };
const loose = [
  'warden-plate',
  'ash-mail',
  'iron-cap',
  'warden-helm',
  'warden-boots',
  'warden-gloves',
  'longblade',
  'short-bow',
  'hand-axe',
  'marsh-toad',
  'stone-hound',
  'cave-bat',
  'marsh',
  'dunes',
  'peaks',
  'lost-note',
  'stray',
];

describe('pages placed by their links', () => {
  it('reads the guide ids a page links to, in order, each once, never itself', () => {
    const body = `[a](wiki:guide:a) ![p](wiki:picture:p) [b](wiki:guide:b "Title") [a again](wiki:guide:a) [self](wiki:guide:me) <https://example.org> [c](<wiki:guide:c>)`;
    expect(guideLinksIn(body, 'wiki:guide:me')).toEqual([
      'wiki:guide:a',
      'wiki:guide:b',
      'wiki:guide:c',
    ]);
    expect(guideLinksIn('no links here')).toEqual([]);
  });

  it('reads a link to a section of a page as a link to the page', () => {
    const body = `[a](wiki:guide:a "#drops") [here](wiki:guide:me "#notes") [b](<wiki:guide:b> "#where-to-find")`;
    expect(guideLinksIn(body, 'wiki:guide:me')).toEqual(['wiki:guide:a', 'wiki:guide:b']);
  });

  it('puts each page under the list page that lists it, met first from the menu', () => {
    const contents = new GuideContents({ data: wiki(base(), menu, loose) });
    expect(tree(contents)).toEqual([
      {
        Equipment: [
          {
            Armor: [
              { 'Warden Plate': ['Warden Helm', 'Warden Boots', 'Warden Gloves'] },
              'Ash Mail',
              'Iron Cap',
            ],
          },
          { Weapons: ['Longblade', 'Short Bow', 'Hand Axe'] },
        ],
      },
      {
        'The world': [
          // Warden Plate mentions Marsh Toad in a sentence: it files nothing.
          { Bestiary: ['Marsh Toad', 'Stone Hound', 'Cave Bat'] },
          { Regions: ['Marsh', 'Dunes', 'Peaks'] },
        ],
      },
      // Only what no list page lists stays, as it is listed.
      { Pages: ['Lost Note', 'Stray'] },
    ]);
    expect(trail(contents, g('warden-helm'))).toEqual(['Equipment', 'Armor', 'Warden Plate']);
    expect(contents.pathTo(g('warden-helm')).map((x) => x.title)).toEqual(['Equipment']);
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
    expect(contents.placedByLinks(g('warden-plate'))).toBe(true);
    expect(contents.placedByLinks(g('armor'))).toBe(false);
    expect(contents.items(s('equipment'))[0]).toMatchObject({ kind: 'page', pages: 6 });
    expect(contents.top()[0]).toMatchObject({ kind: 'section', pages: 11 });
    // Every page is still one page, once, in contents order.
    expect(contents.pages()).toHaveLength(base().length);
  });

  it('never files a page by a link in a sentence', () => {
    // Longblade mentions Warden Plate; with Armor gone, nothing lists it.
    const guides = base().filter((guide) => guide.id !== g('armor'));
    const contents = new GuideContents({
      data: wiki(guides, { ...menu, Equipment: ['weapons'] }, loose),
    });
    expect(contents.parentOf(g('warden-plate'))).toBe(PAGES);
    // A list page left in its section keeps what it lists under it.
    expect(contents.parentOf(g('warden-helm'))).toBe(g('warden-plate'));
    expect(contents.parentOf(g('ash-mail'))).toBe(PAGES);
  });

  it('files a page under a list page that nothing leads to', () => {
    const guides = [...base(), page('notes', ['note-1', 'note-2', 'note-3'])];
    guides.push(page('note-1'), page('note-2'), page('note-3'));
    const contents = new GuideContents({
      data: wiki(guides, menu, [...loose, 'note-1', 'note-2', 'note-3', 'notes']),
    });
    expect(tree(contents).at(-1)).toEqual({
      Pages: ['Lost Note', 'Stray', { Notes: ['Note 1', 'Note 2', 'Note 3'] }],
    });
  });

  it('puts a page many pages link to only under one of the longest list pages listing it', () => {
    // Ten items name the Vale, each in a list of three (a list page); Places, in no
    // section of the menu, lists the Vale with seven others.
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const places = ['vale', ...Array.from({ length: 7 }, (_, i) => `place-${i}`)];
    const guides = [
      page('items', items),
      ...items.map((id) => page(id, ['vale', `${id}-a`, `${id}-b`])),
      page('places', places),
      ...places.map((id) => page(id)),
    ];
    const contents = (pages: GuideEntry[]) =>
      new GuideContents({
        data: wiki(pages, { Things: ['items'] }, [...items, ...places, 'places']),
      });
    // The first item is met long before Places: the Vale still goes under Places.
    expect(contents(guides).parentOf(g('vale'))).toBe(g('places'));
    expect(contents(guides).parentOf(g('places'))).toBe(PAGES);
    // A page few pages link to goes under the list page met first.
    const once = guides.map((guide) =>
      guide.id.startsWith(g('item-')) && guide.id !== g('item-0')
        ? page(guide.id.slice(11), [`${guide.id.slice(11)}-a`, `${guide.id.slice(11)}-b`, 'x'])
        : guide,
    );
    expect(contents(once).parentOf(g('vale'))).toBe(g('item-0'));
    // With no longer list page, the list page met first is as long as any.
    const without = guides.filter((guide) => guide.id !== g('places'));
    expect(contents(without).parentOf(g('vale'))).toBe(g('item-0'));
  });

  it('files the pages the home page lists, but not those it mentions', () => {
    const guides = [page('main-page', ['armor', 'bestiary', 'lost-note'], ['stray']), ...base()];
    const contents = new GuideContents({
      data: wiki(guides, { Equipment: ['weapons'] }, [...loose, 'armor', 'bestiary', 'regions']),
      homePage: g('main-page'),
    });
    expect(contents.parentOf(g('armor'))).toBeNull();
    expect(contents.parentOf(g('lost-note'))).toBeNull();
    expect(contents.parentOf(g('stray'))).toBe(PAGES);
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
  });

  it('breaks a tie by the contents order, the same way every time', () => {
    // Two menu pages listing one page: the first in the contents wins.
    const both = [
      ...base(),
      page('anvil', ['shared', 'tongs', 'hammer']),
      page('kiln', ['shared', 'coal', 'bellows']),
      page('shared'),
    ];
    const tied = new GuideContents({
      data: wiki(both, { Tools: ['kiln', 'anvil'] }, ['shared']),
    });
    expect(tied.parentOf(g('shared'))).toBe(g('kiln'));
    const swapped = new GuideContents({
      data: wiki(both, { Tools: ['anvil', 'kiln'] }, ['shared']),
    });
    expect(swapped.parentOf(g('shared'))).toBe(g('anvil'));
  });

  it('is not led astray by circles, a page listing itself, or links to pages it lacks', () => {
    const guides = [
      page('hub', ['a', 'b2', 'b3']),
      page('a', ['b', 'a', 'missing', 'hub']),
      page('b', ['a', 'hub', 'b', 'missing']),
      page('b2'),
      page('b3'),
      page('c', ['c', 'missing', 'other', 'more']),
    ];
    const contents = new GuideContents({
      data: wiki(guides, { Menu: ['hub'] }, ['a', 'b', 'b2', 'b3', 'c']),
    });
    expect(tree(contents)).toEqual([
      { Menu: [{ Hub: [{ A: ['B'] }, 'B2', 'B3'] }] },
      { Pages: ['C'] },
    ]);
  });

  it('keeps a page linked only from pages nothing leads to in its section', () => {
    const contents = new GuideContents({ data: wiki(base(), menu, loose) });
    // Lost Note mentions Stray, and nothing placed leads to either: both stay, side by side.
    expect(contents.parentOf(g('lost-note'))).toBe(PAGES);
    expect(contents.parentOf(g('stray'))).toBe(PAGES);
  });

  it('lists the other pages that link to a page, in contents order, but its own', () => {
    const contents = new GuideContents({ data: wiki(base(), menu, loose) });
    // Warden Plate is under Armor, and Longblade links to it too.
    expect(contents.linkedFrom(g('warden-plate')).map((x) => x.title)).toEqual(['Longblade']);
    // Marsh Toad is under Bestiary; Warden Plate and Marsh link to it as well.
    expect(contents.linkedFrom(g('marsh-toad')).map((x) => x.title)).toEqual([
      'Warden Plate',
      'Marsh',
    ]);
    expect(contents.linkedFrom(g('ash-mail'))).toEqual([]);
  });

  it('counts a link to another name of a page as a link to the page', () => {
    // Armor lists "warden-plate-old", another name of Warden Plate.
    const guides = base().map((guide) =>
      guide.id === g('armor')
        ? { ...guide, body: guide.body.replace(g('warden-plate'), g('warden-plate-old')) }
        : guide,
    );
    const without = new GuideContents({ data: wiki(guides, menu, loose) });
    expect(without.parentOf(g('warden-plate'))).toBe(PAGES);
    const contents = new GuideContents({
      data: wiki(guides, menu, loose),
      aliases: { [g('warden-plate-old')]: g('warden-plate') },
    });
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
    expect(contents.linkedFrom(g('warden-plate')).map((x) => x.title)).toEqual(['Longblade']);
  });

  it('leaves a pack without a section placed by links as it was', () => {
    const data = wiki(base(), menu, loose);
    data.sections = data.sections!.map(({ placeByLinks: _, ...section }) => section);
    const contents = new GuideContents({ data });
    expect(contents.items(PAGES)).toHaveLength(loose.length);
    expect(contents.placedByLinks(g('warden-plate'))).toBe(false);
  });

  it('does not move unrelated pages when one page more is read', () => {
    const before = new GuideContents({ data: wiki(base(), menu, loose) });
    const more = [
      ...base(),
      page('mail-shop', ['ash-mail', 'trinket', 'candle']),
      page('trinket'),
      page('candle'),
    ];
    const withMore = wiki(more, { ...menu, Equipment: [...menu.Equipment, 'mail-shop'] }, [
      ...loose,
      'trinket',
      'candle',
    ]);
    const after = new GuideContents({ data: withMore });
    for (const id of loose) {
      expect(after.parentOf(g(id)), id).toBe(before.parentOf(g(id)));
    }
    expect(after.parentOf(g('trinket'))).toBe(g('mail-shop'));
    // A list page that comes closer to the menu takes the pages it lists sooner.
    const closer = new GuideContents({
      data: wiki(base(), { ...menu, Equipment: ['warden-plate', ...menu.Equipment] }, loose),
    });
    expect(closer.parentOf(g('warden-plate'))).toBe(s('equipment'));
    expect(closer.parentOf(g('warden-helm'))).toBe(g('warden-plate'));
    expect(closer.parentOf(g('ash-mail'))).toBe(g('armor'));
  });

  it('shows thousands of pages under one page, each counted once', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `item-${i}`);
    const guides = [page('catalogue', many), ...many.map((id) => mentions(id, 'catalogue'))];
    const started = performance.now();
    const contents = new GuideContents({
      data: wiki(guides, { Things: ['catalogue'] }, many),
    });
    contents.pages();
    const took = performance.now() - started;
    expect(contents.itemCount(g('catalogue'))).toBe(5000);
    expect(contents.items(s('things'))[0]).toMatchObject({ pages: 5000 });
    expect(contents.items(PAGES)).toEqual([]);
    expect(contents.linkedFrom(g('catalogue'))).toHaveLength(5000);
    expect(took).toBeLessThan(2000);
  });

  it('walks a chain of pages thousands deep without running out of stack', () => {
    const chain = Array.from({ length: 20000 }, (_, i) => `step-${i}`);
    // Each step lists the next, and two pages the wiki lacks: a list page.
    const guides = chain.map((id, i) =>
      page(id, [...(chain[i + 1] ? [chain[i + 1]!] : []), `${id}-x`, `${id}-y`]),
    );
    const contents = new GuideContents({
      data: wiki(guides, { Start: [chain[0]!] }, chain.slice(1)),
    });
    expect(contents.trail(g(chain.at(-1)!))).toHaveLength(chain.length);
    expect(contents.pages()).toHaveLength(chain.length);
  });
});

describe('the person over pages placed by links', () => {
  const data = () => wiki(base(), menu, loose);
  const contentsOf = (own: OwnPages) => new GuideContents(applyOwnPages(data(), own));
  /** Moves an entry as the arrange tool does, on the contents as shown. */
  const move = (own: OwnPages, id: string, to: string | null, before: string | null = null) => {
    const shown = shownContentsFor(data(), own).layout;
    return moveShownEntry(
      own,
      layoutFor(data(), own),
      shown,
      id,
      to,
      before,
      looseSections(data()),
    );
  };

  it('keeps a page moved by hand where it was put, under a page or in a section', () => {
    let own = move(NO_OWN_PAGES, g('stone-hound'), g('marsh'));
    let contents = contentsOf(own);
    expect(contents.parentOf(g('stone-hound'))).toBe(g('marsh'));
    expect(contents.placedByLinks(g('stone-hound'))).toBe(false);
    // The other pages still go where their links lead.
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
    // Read again with a closer page for it: it stays where it was put.
    const more = wiki(
      [...base(), page('hounds', ['stone-hound', 'cave-bat', 'marsh-toad'])],
      { ...menu, 'The world': ['hounds', ...menu['The world']] },
      loose,
    );
    contents = new GuideContents(applyOwnPages(more, own));
    expect(contents.parentOf(g('stone-hound'))).toBe(g('marsh'));
    // Moved to a section: it heads its own pages from there.
    own = move(own, g('warden-plate'), s('the-world'));
    contents = contentsOf(own);
    expect(contents.parentOf(g('warden-plate'))).toBe(s('the-world'));
    expect(contents.parentOf(g('warden-helm'))).toBe(g('warden-plate'));
  });

  it('keeps the order of the pages under a page as arranged, and new ones after', () => {
    // Ash Mail before Warden Plate under Armor.
    const own = move(NO_OWN_PAGES, g('ash-mail'), g('armor'), g('warden-plate'));
    expect(own.contents?.sections[g('armor')]).toEqual([
      g('ash-mail'),
      g('warden-plate'),
      g('iron-cap'),
    ]);
    expect(own.contents?.sections[PAGES]).not.toContain(g('warden-plate'));
    const contents = contentsOf(own);
    expect(contents.items(g('armor')).map((e) => e.kind === 'page' && e.guide.title)).toEqual([
      'Ash Mail',
      'Warden Plate',
      'Iron Cap',
    ]);
    // Move up and down work on the contents as shown.
    const shown = shownContentsFor(data(), own).layout;
    expect(stepInLayout(shown, g('warden-plate'), parentOf(shown, g('warden-plate'))!, -1)).toEqual(
      { to: g('armor'), before: g('ash-mail') },
    );
  });

  it('never puts a page under itself, nor a section under a page', () => {
    expect(move(NO_OWN_PAGES, g('armor'), g('warden-helm'))).toBe(NO_OWN_PAGES);
    expect(move(NO_OWN_PAGES, g('armor'), g('armor'))).toBe(NO_OWN_PAGES);
    expect(move(NO_OWN_PAGES, s('equipment'), g('regions'))).toBe(NO_OWN_PAGES);
  });

  it('places by links again a page left in, or moved back to, the section placed by links', () => {
    // A layout from before pages were placed by links: every page in "Pages".
    const old: OwnPages = {
      ...NO_OWN_PAGES,
      contents: {
        top: [s('the-world'), s('equipment'), PAGES],
        sections: {
          [s('equipment')]: [g('weapons'), g('armor')],
          [s('the-world')]: [g('bestiary'), g('regions')],
          [PAGES]: loose.map(g),
        },
      },
    };
    const contents = contentsOf(old);
    expect(contents.top().map((e) => e.kind === 'section' && e.section.title)).toEqual([
      'The world',
      'Equipment',
      'Pages',
    ]);
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
    // A page the pack has since put in the menu goes there, though the old layout had it in "Pages".
    const later = wiki(base(), { ...menu, Equipment: [...menu.Equipment, 'longblade'] }, loose);
    expect(new GuideContents(applyOwnPages(later, old)).parentOf(g('longblade'))).toBe(
      s('equipment'),
    );
    // Moved back to "Pages" by hand: placed by its links again.
    let own = move(NO_OWN_PAGES, g('warden-plate'), s('equipment'));
    own = move(own, g('warden-plate'), PAGES);
    expect(contentsOf(own).parentOf(g('warden-plate'))).toBe(g('armor'));
  });

  it('does not place pages under a hidden page or by the links of ones own pages', () => {
    let own = setPageHidden(NO_OWN_PAGES, g('armor'), true, NOW);
    let contents = contentsOf(own);
    expect(contents.isPage(g('armor'))).toBe(false);
    // Longblade only mentions Warden Plate: it stays in Pages, with what it lists under it.
    expect(contents.parentOf(g('warden-plate'))).toBe(PAGES);
    expect(contents.parentOf(g('warden-helm'))).toBe(g('warden-plate'));
    expect(contents.parentOf(g('ash-mail'))).toBe(PAGES);
    // The arrange tool shows the hidden page, with nothing placed under it by links.
    const shown = shownContentsFor(data(), own).layout;
    expect(shown.sections[g('armor')]).toBeUndefined();

    // A page of one's own listing pages does not take them in.
    own = addOwnPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      {
        id: 'wiki:guide:own.notes',
        title: 'Notes',
        body: ['stray', 'dunes', 'peaks'].map((to) => `- [${to}](${g(to)})`).join('\n'),
      },
      s('equipment'),
      g('armor'),
      NOW,
    );
    contents = contentsOf(own);
    expect(contents.parentOf(g('stray'))).toBe(PAGES);
    // But a page moved under it by hand stays there, and goes where it was when it is deleted.
    own = move(own, g('stray'), 'wiki:guide:own.notes');
    expect(contentsOf(own).parentOf(g('stray'))).toBe('wiki:guide:own.notes');
    own = deleteOwnPage(own, layoutFor(data(), own), 'wiki:guide:own.notes');
    expect(contentsOf(own).parentOf(g('stray'))).toBe(s('equipment'));
  });

  it('shows a page put under a hidden page where pages nothing leads to are', () => {
    let own = move(NO_OWN_PAGES, g('stray'), g('ash-mail'));
    own = setPageHidden(own, g('ash-mail'), true, NOW);
    const contents = contentsOf(own);
    expect(contents.parentOf(g('stray'))).toBe(PAGES);
  });
});

describe('on a made-up wiki of hundreds of pages', () => {
  const size = { weapons: 240, armour: 160, locations: 30, characters: 40, enemies: 30, notes: 5 };
  const contentsOf = (made: MadeUpWiki) =>
    new GuideContents({
      data: { guides: made.guides, sections: made.sections, maps: [] },
      homePage: made.homePage,
    });
  const titles = (contents: GuideContents, local: string) =>
    contents
      .trail(guideId(local))
      .map((step) => (step.kind === 'section' ? step.section.title : step.guide.title));

  it('shows every page it holds in the contents, exactly once', () => {
    const made = madeUpWiki(size);
    const contents = contentsOf(made);
    const shown = contents.pages().map((guide) => guide.id);
    expect(made.guides.length).toBeGreaterThan(500);
    expect(shown).toHaveLength(made.guides.length);
    expect(new Set(shown).size).toBe(made.guides.length);
    // Every page but the home page has one home, and the way to it ends at the top.
    for (const guide of made.guides) {
      if (guide.id === made.homePage) continue;
      expect(contents.parentOf(guide.id), guide.id).not.toBeUndefined();
    }
    const counts = contents.filing();
    expect(counts.pages).toBe(made.guides.length - 1);
    expect(counts.underListPage + counts.inSection + counts.inPagesSection + counts.byHand).toBe(
      counts.pages,
    );
  });

  it('gives the same tree for the same pages, every time', () => {
    const outline = (contents: GuideContents) =>
      contents.pages().map((guide) => `${guide.id}<${contents.parentOf(guide.id) ?? ''}`);
    const first = outline(contentsOf(madeUpWiki(size)));
    const again = outline(contentsOf(madeUpWiki(size)));
    expect(again).toEqual(first);
  });

  it('files weapons under Weapons, and their locations and characters under their own lists', () => {
    const contents = contentsOf(madeUpWiki(size));
    expect(titles(contents, 'blade-0001')).toEqual(['Equipment', 'Weapons']);
    expect(titles(contents, 'mail-0001')).toEqual(['Equipment', 'Armour']);
    expect(titles(contents, 'ghoul-0001')).toEqual(['The world', 'Enemies']);
    // Named by many weapons in a box, a sentence and a later column: under their list pages,
    // which no page lists, in Pages.
    expect(titles(contents, 'vale-0001')).toEqual(['Pages', 'Locations']);
    expect(titles(contents, 'smith-0002')).toEqual(['Pages', 'Characters']);
    // Nothing is under a weapon.
    for (const id of madeUpWiki(size).ids.weapons) expect(contents.items(guideId(id))).toEqual([]);
    // A note mentioned in a sentence of the home page, and notes nothing lists, stay in Pages.
    expect(contents.parentOf(guideId('note-0001'))).toBe(PAGES_SECTION);
    expect(contents.filing()).toEqual({
      pages: 510,
      underListPage: 500,
      inSection: 3,
      inPagesSection: 7,
      byHand: 0,
    });
  });

  it('keeps a page the person moved where they put it', () => {
    const made = madeUpWiki(size);
    const data = { guides: made.guides, sections: made.sections, maps: [] };
    const own: OwnPages = {
      ...NO_OWN_PAGES,
      contents: {
        top: [sectionId('equipment'), sectionId('the-world'), PAGES_SECTION],
        sections: {
          [sectionId('equipment')]: [guideId('weapons'), guideId('armour')],
          [sectionId('the-world')]: [guideId('enemies')],
          [guideId('blade-0002')]: [guideId('vale-0001')],
          [PAGES_SECTION]: made.guides
            .map((guide) => guide.id)
            .filter(
              (id) =>
                ![
                  made.homePage,
                  guideId('weapons'),
                  guideId('armour'),
                  guideId('enemies'),
                ].includes(id) && id !== guideId('vale-0001'),
            ),
        },
      },
    };
    const contents = new GuideContents({ ...applyOwnPages(data, own), homePage: made.homePage });
    expect(contents.parentOf(guideId('vale-0001'))).toBe(guideId('blade-0002'));
    expect(contents.parentOf(guideId('vale-0002'))).toBe(guideId('locations'));
    expect(contents.filing().byHand).toBe(1);
    expect(contents.pages()).toHaveLength(made.guides.length);
  });
});
