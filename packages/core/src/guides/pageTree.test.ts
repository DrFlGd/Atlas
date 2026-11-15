import { NO_OWN_PAGES, type GuideEntry, type OwnPages, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, entryIdOf, entryTitleOf, type GuidePages } from './contents';
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
import { headingStepId } from './headingSteps';
import { guideFiling, isListPage } from './pageFiling';
import { guideLinksIn } from './pageTree';
import {
  GEAR_BELT,
  GEAR_CHARMS,
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
      const under = contents.items(entryIdOf(entry));
      return under.length > 0 ? { [entryTitleOf(entry)]: level(under) } : entryTitleOf(entry);
    });
  return level(contents.top());
}

const trail = (contents: GuideContents, id: string) =>
  contents.trail(id).map((step) => entryTitleOf(step));

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

  it('puts a page under the narrower list page a list page lists and puts under itself', () => {
    const blades = ['dirk', 'kris', 'shiv'];
    const bows = ['longbow', 'recurve', 'sling'];
    const guides = [
      page('gear', ['short-blades', ...blades, 'bows', ...bows]),
      page('short-blades', blades),
      page('bows', bows),
      ...[...blades, ...bows].map((id) => page(id)),
    ];
    const contents = new GuideContents({
      data: wiki(guides, { Things: ['gear'] }, ['short-blades', 'bows', ...blades, ...bows]),
    });
    expect(tree(contents)[0]).toEqual({
      Things: [
        {
          Gear: [
            { 'Short Blades': ['Dirk', 'Kris', 'Shiv'] },
            { Bows: ['Longbow', 'Recurve', 'Sling'] },
          ],
        },
      ],
    });
    // And so on down: Gear › Weapons › Short Blades › Dirk.
    const deeper = [
      page('gear', ['weapons', 'short-blades', ...blades, 'bows']),
      page('weapons', ['short-blades', ...blades, 'bows', ...bows]),
      ...guides.slice(1),
    ];
    const deep = new GuideContents({
      data: wiki(deeper, { Things: ['gear'] }, [
        'weapons',
        'short-blades',
        'bows',
        ...blades,
        ...bows,
      ]),
    });
    expect(trail(deep, g('dirk'))).toEqual(['Things', 'Gear', 'Weapons', 'Short Blades']);
    expect(trail(deep, g('sling'))).toEqual(['Things', 'Gear', 'Weapons', 'Bows']);
    expect(deep.pages()).toHaveLength(deeper.length);
  });

  it('puts a page many pages link to under such a narrower list page, however short', () => {
    // Gear lists 30 things, Short Blades three of them; ten pages name the Dirk.
    const others = Array.from({ length: 27 }, (_, i) => `thing-${i}`);
    const blades = ['dirk', 'kris', 'shiv'];
    const fans = Array.from({ length: 10 }, (_, i) => `fan-${i}`);
    const guides = [
      page('gear', ['short-blades', ...blades, ...others]),
      page('short-blades', blades),
      page('favourites', ['dirk', 'thing-0', 'thing-1']),
      ...[...blades, ...others].map((id) => page(id)),
      ...fans.map((id) => mentions(id, 'dirk')),
    ];
    const loosePages = ['short-blades', 'favourites', ...blades, ...others, ...fans];
    const contents = (menuOf: Record<string, string[]>) =>
      new GuideContents({ data: wiki(guides, menuOf, loosePages) });
    expect(contents({ Things: ['gear'] }).parentOf(g('dirk'))).toBe(g('short-blades'));
    // A short list page Gear does not put under itself is shut out, though met first.
    const both = contents({ Mine: ['favourites'], Things: ['gear'] });
    expect(both.parentOf(g('dirk'))).toBe(g('short-blades'));
    expect(both.parentOf(g('thing-0'))).toBe(g('favourites'));
    expect(both.pages()).toHaveLength(guides.length);
  });

  it('never takes a neighbour that lists its neighbours for a narrower list page', () => {
    // Each blade's "See also" lists the next three: each is a list page, and Gear lists them all.
    const blades = ['dirk', 'kris', 'shiv', 'stiletto', 'cutter'];
    const guides = [
      page('gear', blades),
      ...blades.map((id, i) =>
        page(
          id,
          [1, 2, 3].map((step) => blades[(i + step) % blades.length]!),
        ),
      ),
    ];
    const contents = new GuideContents({ data: wiki(guides, { Things: ['gear'] }, blades) });
    expect(tree(contents)[0]).toEqual({
      Things: [{ Gear: ['Dirk', 'Kris', 'Shiv', 'Stiletto', 'Cutter'] }],
    });
    // Two list pages that list each other are neighbours too: both stay under Gear.
    const pair = [
      page('gear', ['short-blades', 'long-blades', 'dirk']),
      page('short-blades', ['long-blades', 'dirk', 'kris']),
      page('long-blades', ['short-blades', 'dirk', 'shiv']),
      page('dirk'),
      page('kris'),
      page('shiv'),
    ];
    const paired = new GuideContents({
      data: wiki(pair, { Things: ['gear'] }, [
        'short-blades',
        'long-blades',
        'dirk',
        'kris',
        'shiv',
      ]),
    });
    expect(tree(paired)[0]).toEqual({
      Things: [{ Gear: [{ 'Short Blades': ['Kris'] }, { 'Long Blades': ['Shiv'] }, 'Dirk'] }],
    });
  });

  it('leaves where the person or the wiki put a page before the narrower list page', () => {
    const blades = ['dirk', 'kris', 'shiv'];
    const guides = [
      page('gear', ['short-blades', ...blades]),
      page('short-blades', blades),
      ...blades.map((id) => (id === 'kris' ? { ...page(id), filedUnder: [g('gear')] } : page(id))),
    ];
    const data = wiki(guides, { Things: ['gear'] }, ['short-blades', ...blades]);
    const own = moveShownEntry(
      NO_OWN_PAGES,
      layoutFor(data, NO_OWN_PAGES),
      shownContentsFor(data, NO_OWN_PAGES).layout,
      g('shiv'),
      g('gear'),
      null,
      looseSections(data),
    );
    const contents = new GuideContents(applyOwnPages(data, own));
    expect(contents.parentOf(g('dirk'))).toBe(g('short-blades'));
    expect(contents.parentOf(g('kris'))).toBe(g('gear'));
    expect(contents.parentOf(g('shiv'))).toBe(g('gear'));
    expect(contents.placedByLinks(g('shiv'))).toBe(false);
    expect(contents.pages()).toHaveLength(guides.length);
  });

  it('keeps what the home page lists at the top, though one of them lists another', () => {
    const blades = ['dirk', 'kris', 'shiv'];
    const guides = [
      page('main-page', ['gear', 'short-blades', 'stray']),
      page('gear', ['short-blades', ...blades]),
      page('short-blades', blades),
      ...blades.map((id) => page(id)),
      page('stray'),
    ];
    const contents = new GuideContents({
      data: wiki(guides, {}, ['gear', 'short-blades', 'stray', ...blades]),
      homePage: g('main-page'),
    });
    // Short Blades is not under Gear: the list page met first files the blades.
    expect(contents.parentOf(g('short-blades'))).toBeNull();
    expect(contents.parentOf(g('gear'))).toBeNull();
    expect(contents.parentOf(g('dirk'))).toBe(g('gear'));
    expect(contents.pages()).toHaveLength(guides.length);
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

describe('pages the wiki files itself', () => {
  /** The base pages, with `filed` saying which pages the wiki files each under. */
  const filedData = (filed: Record<string, string[]>) =>
    wiki(
      base().map((guide) => {
        const under = filed[guide.id.slice('wiki:guide:'.length)];
        return under ? { ...guide, filedUnder: under.map(g) } : guide;
      }),
      menu,
      loose,
    );

  it('go under the page the wiki files them under, before the list page that lists them', () => {
    const data = filedData({ 'stone-hound': ['marsh'] });
    const contents = new GuideContents({ data });
    expect(trail(contents, g('stone-hound'))).toEqual(['The world', 'Regions', 'Marsh']);
    expect(contents.placedByLinks(g('stone-hound'))).toBe(true);
    expect(
      contents.items(g('bestiary')).map((entry) => entry.kind === 'page' && entry.guide.title),
    ).toEqual(['Marsh Toad', 'Cave Bat']);
    expect(contents.filing()).toMatchObject({ underFiledPage: 1, inPagesSection: 2 });
    // The arrange tool shows the same.
    expect(shownContentsFor(data, NO_OWN_PAGES).placed.get(g('stone-hound'))).toBe(g('marsh'));
  });

  it('go under one of those pages that lists them, else the first the wiki names', () => {
    let contents = new GuideContents({ data: filedData({ 'cave-bat': ['marsh', 'bestiary'] }) });
    expect(contents.parentOf(g('cave-bat'))).toBe(g('bestiary'));
    contents = new GuideContents({ data: filedData({ 'cave-bat': ['dunes', 'marsh'] }) });
    expect(contents.parentOf(g('cave-bat'))).toBe(g('dunes'));
  });

  it('skip a page that is not read, hidden or the page itself, and follow another name', () => {
    let contents = new GuideContents({
      data: filedData({ 'cave-bat': ['not-read', 'cave-bat'] }),
    });
    expect(contents.parentOf(g('cave-bat'))).toBe(g('bestiary'));
    contents = new GuideContents(
      applyOwnPages(
        filedData({ 'cave-bat': ['dunes'] }),
        setPageHidden(NO_OWN_PAGES, g('dunes'), true, NOW),
      ),
    );
    expect(contents.parentOf(g('cave-bat'))).toBe(g('bestiary'));
    contents = new GuideContents({
      data: filedData({ 'cave-bat': ['old-dunes'] }),
      aliases: { [g('old-dunes')]: g('dunes') },
    });
    expect(contents.parentOf(g('cave-bat'))).toBe(g('dunes'));
  });

  it('never go under a page that is under them, in a circle of any length', () => {
    const data = filedData({ dunes: ['peaks'], peaks: ['marsh'], marsh: ['dunes'] });
    const contents = new GuideContents({ data });
    const parents = ['dunes', 'peaks', 'marsh'].map((local) => contents.parentOf(g(local)));
    // Two of them under the one before them, and one under Regions, which lists it.
    expect(parents.filter((parent) => parent === g('regions'))).toHaveLength(1);
    expect(contents.pages()).toHaveLength(base().length);
    expect(new Set(contents.pages().map((guide) => guide.id)).size).toBe(base().length);
  });

  it('carry a page left in Pages, and with it the pages filed under it', () => {
    const contents = new GuideContents({ data: filedData({ 'lost-note': ['stray'] }) });
    expect(tree(contents).at(-1)).toEqual({ Pages: [{ Stray: ['Lost Note'] }] });
  });

  it('give way to where the person put a page', () => {
    const data = filedData({ 'stone-hound': ['marsh'], 'cave-bat': ['stone-hound'] });
    const own = moveShownEntry(
      NO_OWN_PAGES,
      layoutFor(data, NO_OWN_PAGES),
      shownContentsFor(data, NO_OWN_PAGES).layout,
      g('stone-hound'),
      g('peaks'),
      null,
      looseSections(data),
    );
    const contents = new GuideContents(applyOwnPages(data, own));
    expect(contents.parentOf(g('stone-hound'))).toBe(g('peaks'));
    expect(contents.placedByLinks(g('stone-hound'))).toBe(false);
    // What the wiki files under it follows it.
    expect(contents.parentOf(g('cave-bat'))).toBe(g('stone-hound'));
    expect(contents.filing()).toMatchObject({ byHand: 1, underFiledPage: 1 });
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
    contents.trail(guideId(local)).map((step) => entryTitleOf(step));

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
    expect(
      counts.underListPage +
        counts.underFiledPage +
        counts.inSection +
        counts.inPagesSection +
        counts.byHand,
    ).toBe(counts.pages);
  });

  it('shows every page once when the wiki files pages itself, and the same tree every time', () => {
    const made = madeUpWiki(size, { filed: true });
    const contents = contentsOf(made);
    const shown = contents.pages().map((guide) => guide.id);
    expect(shown).toHaveLength(made.guides.length);
    expect(new Set(shown).size).toBe(made.guides.length);
    const counts = contents.filing();
    expect(counts.pages).toBe(made.guides.length - 1);
    expect(
      counts.underListPage +
        counts.underFiledPage +
        counts.inSection +
        counts.inPagesSection +
        counts.byHand,
    ).toBe(counts.pages);
    const outline = (c: GuideContents) =>
      c.pages().map((guide) => `${guide.id}<${c.parentOf(guide.id) ?? ''}`);
    expect(outline(contentsOf(madeUpWiki(size, { filed: true })))).toEqual(outline(contents));
  });

  it('files a page under the page the wiki files it under, before any list page', () => {
    const made = madeUpWiki(size, { filed: true });
    const contents = contentsOf(made);
    // Weapons both files and lists its weapons.
    expect(titles(contents, 'blade-0001')).toEqual(['Equipment', 'Weapons']);
    // A character under the location it lives in, not under Characters; the page not read is skipped.
    const home = made.guides.find((x) => x.id === guideId('smith-0001'))!.filedUnder![1]!;
    expect(home).toMatch(/vale-/);
    expect(contents.parentOf(guideId('smith-0001'))).toBe(home);
    expect(titles(contents, 'smith-0001').slice(0, 2)).toEqual(['Pages', 'Locations']);
    expect(contents.items(guideId('characters'))).toEqual([]);
    // Notes under the first note, which files nothing under itself.
    expect(contents.parentOf(guideId('note-0002'))).toBe(guideId('note-0001'));
    expect(contents.parentOf(guideId('note-0001'))).toBe(PAGES_SECTION);
    expect(contents.filing()).toEqual({
      pages: 510,
      underListPage: 500 - 240 - 40,
      underFiledPage: 240 + 40 + 4,
      inSection: 3,
      inPagesSection: 3,
      byHand: 0,
    });
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
    // Characters lists them ten under each heading: each heading a level under it.
    expect(titles(contents, 'smith-0002')).toEqual(['Pages', 'Characters', 'Group 1']);
    // No item page is a list page (its table of upgrades lists nothing), and nothing is under one.
    const made = madeUpWiki(size);
    const lists = new Set(
      made.guides.filter((guide) => isListPage(guideFiling(guide))).map((guide) => guide.id),
    );
    for (const id of [...made.ids.weapons, ...made.ids.armour]) {
      expect(lists.has(guideId(id)), id).toBe(false);
      expect(contents.items(guideId(id))).toEqual([]);
    }
    expect(lists).toContain(guideId('locations'));
    expect(lists).toContain(guideId('characters'));
    // A note mentioned in a sentence of the home page, and notes nothing lists, stay in Pages.
    expect(contents.parentOf(guideId('note-0001'))).toBe(PAGES_SECTION);
    expect(contents.filing()).toEqual({
      pages: 510,
      underListPage: 500,
      underFiledPage: 0,
      inSection: 3,
      inPagesSection: 7,
      byHand: 0,
    });
  });

  it('files gear under the narrower list pages of an index whose rows name many pages', () => {
    const made = madeUpWiki({ ...size, gear: 24 });
    const contents = contentsOf(made);
    const shown = contents.pages().map((guide) => guide.id);
    expect(shown).toHaveLength(made.guides.length);
    expect(new Set(shown).size).toBe(made.guides.length);
    const guide = (local: string) => made.guides.find((x) => x.id === guideId(local))!;
    // Gear lists fewer than three fifths of the pages it links to: its rows name many more.
    const gear = guideFiling(guide('gear'));
    expect(gear.listing).toHaveLength(2 + 24 + 24 + GEAR_CHARMS.length + GEAR_BELT.length);
    expect(gear.listing.length).toBeLessThan(0.6 * gear.linked);
    expect(isListPage(gear)).toBe(true);
    // Its headings are levels: "Weapons" over the two headings that link to a
    // list page, "Trinkets" over its one sub-heading of charms. The belt pages
    // are too few for a level of their own, and "History" lists nothing.
    const weapons = headingStepId(guideId('gear'), 'weapons');
    const trinkets = headingStepId(guideId('gear'), 'trinkets');
    expect(contents.items(guideId('gear')).map((entry) => entryIdOf(entry))).toEqual([
      weapons,
      trinkets,
      ...GEAR_BELT.map(guideId),
    ]);
    expect(contents.items(weapons).map((entry) => entryTitleOf(entry))).toEqual([
      'Short Blades',
      'Bows',
    ]);
    expect(contents.items(trinkets).map((entry) => entryIdOf(entry))).toEqual(
      GEAR_CHARMS.map(guideId),
    );
    expect(contents.heading(trinkets)?.title).toBe('Trinkets');
    expect(contents.heading(trinkets)?.section).toBe('trinkets');
    expect(titles(contents, 'short-blades')).toEqual(['Equipment', 'Gear', 'Weapons']);
    expect(titles(contents, 'dirk-0002')).toEqual(['Equipment', 'Gear', 'Weapons', 'Short Blades']);
    expect(titles(contents, 'longbow-0024')).toEqual(['Equipment', 'Gear', 'Weapons', 'Bows']);
    expect(titles(contents, 'charm-0003')).toEqual(['Equipment', 'Gear', 'Trinkets']);
    expect(titles(contents, 'belt-hook')).toEqual(['Equipment', 'Gear']);
    // A page's parent is the page it is under, not the heading.
    expect(contents.parentOf(guideId('charm-0003'))).toBe(trinkets);
    expect(contents.pageParentOf(guideId('charm-0003'))).toBe(guideId('gear'));
    // The first blade, which every gear page names, too.
    expect(contents.linkedFrom(guideId('dirk-0001')).length).toBeGreaterThanOrEqual(8);
    expect(titles(contents, 'dirk-0001')).toEqual(['Equipment', 'Gear', 'Weapons', 'Short Blades']);
    // The boss lists what it drops in a small table, but is no list page.
    expect(isListPage(guideFiling(guide('mire-tyrant')))).toBe(false);
    expect(contents.parentOf(guideId('mire-tyrant'))).toBe(PAGES_SECTION);
    expect(contents.items(guideId('mire-tyrant'))).toEqual([]);
    // No gear page is a list page, and nothing is under one.
    for (const id of [...made.ids.blades, ...made.ids.bows]) {
      expect(isListPage(guideFiling(guide(id))), id).toBe(false);
      expect(contents.items(guideId(id))).toEqual([]);
    }
    const counts = contents.filing();
    expect(counts).toEqual({
      pages: 510 + 3 + 48 + 1 + 6,
      underListPage: 500 + 2 + 48 + 6,
      underFiledPage: 0,
      inSection: 4,
      inPagesSection: 8,
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
