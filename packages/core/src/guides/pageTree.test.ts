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

/**
 * Pages placed by their links, on a made-up wiki: a menu of sections
 * (Equipment, The world) with a few pages, and the pages nothing in the
 * menu names, in a section placed by links ("Pages").
 */

const NOW = new Date('2026-11-14T10:00:00.000Z');
const g = (local: string) => `wiki:guide:${local}`;
const s = (local: string) => `wiki:section:${local}`;
const PAGES = s('pages');

/** A page with a title from its id and links to the pages named. */
function page(local: string, ...links: string[]): GuideEntry {
  const title = local
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
  return {
    id: g(local),
    title,
    body: `# ${title}\n\n${links.map((to) => `See [${to}](${g(to)}).`).join('\n')}`,
    locationIds: [],
  };
}

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

/** The made-up wiki: Equipment › Armor › Warden Plate, The world › Bestiary › Marsh Toad. */
const base = () => [
  page('armor', 'warden-plate', 'ash-mail'),
  page('weapons', 'longblade'),
  page('bestiary', 'marsh-toad', 'stone-hound'),
  page('regions', 'marsh', 'bestiary'),
  page('warden-plate', 'warden-helm', 'marsh-toad'),
  page('ash-mail'),
  page('warden-helm'),
  page('longblade', 'warden-plate'),
  page('marsh-toad', 'marsh'),
  page('stone-hound'),
  page('marsh', 'marsh-toad'),
  page('lost-note', 'stray'),
  page('stray'),
];
const menu = { Equipment: ['armor', 'weapons'], 'The world': ['bestiary', 'regions'] };
const loose = [
  'warden-plate',
  'ash-mail',
  'warden-helm',
  'longblade',
  'marsh-toad',
  'stone-hound',
  'marsh',
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

  it('puts each page under the page it is reached from by the fewest links from the menu', () => {
    const contents = new GuideContents({ data: wiki(base(), menu, loose) });
    expect(tree(contents)).toEqual([
      {
        Equipment: [
          { Armor: [{ 'Warden Plate': ['Warden Helm'] }, 'Ash Mail'] },
          { Weapons: ['Longblade'] },
        ],
      },
      {
        'The world': [
          // Marsh Toad is one link from Bestiary and two from Armor.
          { Bestiary: ['Marsh Toad', 'Stone Hound'] },
          // Marsh is one link from Regions and two from Bestiary.
          { Regions: ['Marsh'] },
        ],
      },
      // Only what nothing in the menu leads to stays, as it is listed.
      { Pages: ['Lost Note', 'Stray'] },
    ]);
    expect(trail(contents, g('warden-helm'))).toEqual(['Equipment', 'Armor', 'Warden Plate']);
    expect(contents.pathTo(g('warden-helm')).map((x) => x.title)).toEqual(['Equipment']);
    expect(contents.parentOf(g('warden-plate'))).toBe(g('armor'));
    expect(contents.placedByLinks(g('warden-plate'))).toBe(true);
    expect(contents.placedByLinks(g('armor'))).toBe(false);
    expect(contents.items(s('equipment'))[0]).toMatchObject({ kind: 'page', pages: 3 });
    expect(contents.top()[0]).toMatchObject({ kind: 'section', pages: 6 });
    // Every page is still one page, once, in contents order.
    expect(contents.pages()).toHaveLength(base().length);
  });

  it('breaks a tie by the contents order, the same way every time', () => {
    // Two menu pages linking to one page at the same distance: the first in the contents wins.
    const both = [...base(), page('anvil', 'shared'), page('kiln', 'shared'), page('shared')];
    const tied = new GuideContents({
      data: wiki(both, { Tools: ['kiln', 'anvil'] }, ['shared']),
    });
    expect(tied.parentOf(g('shared'))).toBe(g('kiln'));
    const swapped = new GuideContents({
      data: wiki(both, { Tools: ['anvil', 'kiln'] }, ['shared']),
    });
    expect(swapped.parentOf(g('shared'))).toBe(g('anvil'));
  });

  it('is not led astray by circles, a page linking to itself, or links to pages it lacks', () => {
    const guides = [
      page('hub', 'a'),
      page('a', 'b', 'a', 'missing'),
      page('b', 'a', 'hub'),
      page('c', 'c'),
    ];
    const contents = new GuideContents({ data: wiki(guides, { Menu: ['hub'] }, ['a', 'b', 'c']) });
    expect(tree(contents)).toEqual([{ Menu: [{ Hub: [{ A: ['B'] }] }] }, { Pages: ['C'] }]);
  });

  it('keeps a page linked only from pages nothing leads to in its section', () => {
    const contents = new GuideContents({ data: wiki(base(), menu, loose) });
    // Lost Note links to Stray, but nothing placed leads to either: both stay, side by side.
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

  it('leaves a pack without a section placed by links as it was', () => {
    const data = wiki(base(), menu, loose);
    data.sections = data.sections!.map(({ placeByLinks: _, ...section }) => section);
    const contents = new GuideContents({ data });
    expect(contents.items(PAGES)).toHaveLength(loose.length);
    expect(contents.placedByLinks(g('warden-plate'))).toBe(false);
  });

  it('does not move unrelated pages when one page more is read', () => {
    const before = new GuideContents({ data: wiki(base(), menu, loose) });
    const more = [...base(), page('mail-shop', 'ash-mail', 'trinket'), page('trinket')];
    const withMore = wiki(more, { ...menu, Equipment: [...menu.Equipment, 'mail-shop'] }, [
      ...loose,
      'trinket',
    ]);
    const after = new GuideContents({ data: withMore });
    for (const id of loose) {
      expect(after.parentOf(g(id)), id).toBe(before.parentOf(g(id)));
    }
    expect(after.parentOf(g('trinket'))).toBe(g('mail-shop'));
    // A page that comes closer to the menu takes the pages it leads to sooner.
    const closer = new GuideContents({
      data: wiki(base(), { ...menu, Equipment: ['warden-helm', ...menu.Equipment] }, loose),
    });
    expect(closer.parentOf(g('warden-helm'))).toBe(s('equipment'));
    expect(closer.parentOf(g('warden-plate'))).toBe(g('armor'));
  });

  it('shows thousands of pages under one page, each counted once', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `item-${i}`);
    const guides = [page('catalogue', ...many), ...many.map((id) => page(id, 'catalogue'))];
    const started = performance.now();
    const contents = new GuideContents({
      data: wiki(guides, { Things: ['catalogue'] }, many),
    });
    const took = performance.now() - started;
    expect(contents.itemCount(g('catalogue'))).toBe(5000);
    expect(contents.items(s('things'))[0]).toMatchObject({ pages: 5000 });
    expect(contents.items(PAGES)).toEqual([]);
    expect(contents.linkedFrom(g('catalogue'))).toHaveLength(5000);
    expect(took).toBeLessThan(2000);
  });

  it('walks a chain of pages thousands deep without running out of stack', () => {
    const chain = Array.from({ length: 20000 }, (_, i) => `step-${i}`);
    const guides = chain.map((id, i) => page(id, ...(chain[i + 1] ? [chain[i + 1]!] : [])));
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
      [...base(), page('hounds', 'stone-hound')],
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
    expect(own.contents?.sections[g('armor')]).toEqual([g('ash-mail'), g('warden-plate')]);
    expect(own.contents?.sections[PAGES]).not.toContain(g('warden-plate'));
    const contents = contentsOf(own);
    expect(contents.items(g('armor')).map((e) => e.kind === 'page' && e.guide.title)).toEqual([
      'Ash Mail',
      'Warden Plate',
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
    // Warden Plate is reached through Longblade now.
    expect(contents.parentOf(g('warden-plate'))).toBe(g('longblade'));
    expect(contents.parentOf(g('ash-mail'))).toBe(PAGES);
    // The arrange tool shows the hidden page, with nothing placed under it by links.
    const shown = shownContentsFor(data(), own).layout;
    expect(shown.sections[g('armor')]).toBeUndefined();

    // A page of one's own linking to a page does not take it in.
    own = addOwnPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      { id: 'wiki:guide:own.notes', title: 'Notes', body: `[x](${g('stray')})` },
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
