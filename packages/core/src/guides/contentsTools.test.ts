import {
  NO_OWN_PAGES,
  readOwnPagesFile,
  writeOwnPagesFile,
  type GuideEntry,
  type OwnPages,
  type Section,
} from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, entryTitleOf, listingThrough } from './contents';
import {
  addLevelPage,
  addOwnPage,
  applyOwnPages,
  fileListedPages,
  layoutFor,
  moveShownEntries,
  packMenuPages,
  shownContentsFor,
} from './ownPages';
import { pagesListMarkdown } from './pagesList';

/**
 * The tools of the arrange tool, on made-up pages: several pages moved at
 * once, a new level made of them, the pages outside the menu as one group
 * ("Not in the menu") that pages move out of and back to, "File the pages
 * this page lists under it", and a layout made by an earlier app.
 */

const NOW = new Date('2026-11-15T10:00:00.000Z');
const g = (local: string) => `tools:guide:${local}`;
const MENU = 'tools:section:menu';
const PAGES = 'tools:section:pages';
const titleOf = (local: string) => local.charAt(0).toUpperCase() + local.slice(1);
const to = (local: string) => `[${titleOf(local)}](${g(local)})`;
const items = (...ids: string[]) => ids.map((id) => `- ${to(id)}`).join('\n');
const entry = (local: string, body: string): GuideEntry => ({
  id: g(local),
  title: titleOf(local),
  body,
  locationIds: [],
});

const WEAPONS = ['w1', 'w2', 'w3', 'w4', 'w5'];
const CHARMS = ['c1', 'c2', 'c3'];
const LOOSE = ['a', 'b', 'c', 'd', 'x', 'y', 'z', ...WEAPONS, ...CHARMS];

/**
 * A menu of three pages: Index lists a to d; Notes lists x, y and z; Gear
 * lists five pages under "Weapons" and three under "Charms". Every other
 * page is outside the menu.
 */
function data() {
  const guides: GuideEntry[] = [
    entry('index', `# Index\n\n${items('a', 'b', 'c', 'd')}`),
    entry('notes', `# Notes\n\nSee ${to('a')} for more.\n\n${items('x', 'y', 'z')}`),
    entry(
      'gear',
      `# Gear\n\n## Weapons\n\n${items(...WEAPONS)}\n\n## Charms\n\n${items(...CHARMS)}`,
    ),
    ...LOOSE.map((id) => entry(id, `# ${titleOf(id)}\n\nA page.`)),
  ];
  const sections: Section[] = [
    { id: MENU, title: 'Menu', items: [g('index'), g('notes'), g('gear')] },
    { id: PAGES, title: 'Pages', items: LOOSE.map(g), placeByLinks: true },
  ];
  return { guides, sections, maps: [] };
}

const contentsOf = (own: OwnPages) => new GuideContents(applyOwnPages(data(), own));
const trail = (contents: GuideContents, local: string) =>
  contents.trail(g(local)).map((step) => entryTitleOf(step));
const shownOf = (own: OwnPages) => shownContentsFor(data(), own);
const titles = (contents: GuideContents, id: string) =>
  contents.items(id).map((item) => entryTitleOf(item));

/** Moves pages as the arrange tool does, on the contents as shown. */
function moveMany(
  own: OwnPages,
  ids: string[],
  target: string | null,
  before: string | null = null,
) {
  return moveShownEntries(
    own,
    layoutFor(data(), own),
    shownOf(own).layout,
    ids.map(g),
    target,
    before,
  );
}

describe('the arrange tool’s contents', () => {
  it('is the menu, then the pages outside it as one flat group, every page once', () => {
    const shown = shownOf(NO_OWN_PAGES);
    expect(shown.outside).toBe(PAGES);
    expect(shown.layout.top).toEqual([MENU, PAGES]);
    expect(shown.layout.sections[MENU]).toEqual(['index', 'notes', 'gear'].map(g));
    // Nothing is put under Index, Notes or Gear by their lists.
    expect(shown.layout.sections[g('index')]).toBeUndefined();
    expect(shown.layout.sections[PAGES]).toEqual(LOOSE.map(g));
  });

  it('has no group for a pack whose pages are all in its menu', () => {
    const whole = { ...data(), sections: [data().sections[0]!] };
    const shown = shownContentsFor(whole, NO_OWN_PAGES);
    expect(shown.outside).toBeNull();
    expect(shown.layout.top).toEqual([MENU]);
  });

  it('moves a page into the menu, and back to the group when it is taken out', () => {
    let { own } = moveMany(NO_OWN_PAGES, ['x'], g('notes'));
    expect(shownOf(own).layout.sections[PAGES]).not.toContain(g('x'));
    expect(trail(contentsOf(own), 'x')).toEqual(['Menu', 'Notes']);
    expect(contentsOf(own).isInMenu(g('x'))).toBe(true);
    ({ own } = moveMany(own, ['x'], PAGES));
    expect(shownOf(own).layout.sections[PAGES]).toContain(g('x'));
    expect(own.contents?.sections[g('notes')]).toBeUndefined();
    expect(contentsOf(own).isInMenu(g('x'))).toBe(false);
    expect(contentsOf(own).pages()).toHaveLength(data().guides.length);
  });

  it('knows the pages the pack puts in its menu, which stay in it', () => {
    expect([...packMenuPages(data())]).toEqual(['index', 'notes', 'gear'].map(g));
  });

  it('shows a page put under a page outside the menu under it, not in the group', () => {
    const { own } = moveMany(NO_OWN_PAGES, ['y', 'z'], g('x'));
    const shown = shownOf(own);
    expect(shown.layout.sections[PAGES]).not.toContain(g('y'));
    expect(shown.layout.sections[g('x')]).toEqual(['y', 'z'].map(g));
    // Outside the menu in Guides too: x lists them at its foot.
    const contents = contentsOf(own);
    expect(contents.isInMenu(g('y'))).toBe(false);
    expect(titles(contents, g('x'))).toEqual(['Y', 'Z']);
  });
});

describe('several pages moved at once', () => {
  it('go under a page together, in their order, with one change', () => {
    const { own, moved, left } = moveMany(NO_OWN_PAGES, ['a', 'c', 'b'], g('notes'));
    expect(moved).toEqual(['a', 'c', 'b'].map(g));
    expect(left).toEqual([]);
    expect(shownOf(own).layout.sections[g('notes')]).toEqual(['a', 'c', 'b'].map(g));
    const contents = contentsOf(own);
    expect(trail(contents, 'c')).toEqual(['Menu', 'Notes']);
    expect(titles(contents, g('index'))).toEqual([]);
    expect(contents.pages()).toHaveLength(data().guides.length);
  });

  it('go to a section before an entry there, and keep their order', () => {
    const { own } = moveMany(NO_OWN_PAGES, ['b', 'd'], MENU, g('notes'));
    expect(shownOf(own).layout.sections[MENU]).toEqual(['index', 'b', 'd', 'notes', 'gear'].map(g));
  });

  it('never under themselves or a page beneath them: those stay, and are counted', () => {
    let { own } = moveMany(NO_OWN_PAGES, ['a'], g('index'));
    const result = moveMany(own, ['index', 'a', 'b'], g('a'));
    expect(result.moved).toEqual([g('b')]);
    expect(result.left).toEqual([g('index'), g('a')]);
    own = result.own;
    expect(trail(contentsOf(own), 'b')).toEqual(['Menu', 'Index', 'A']);
    // A section never goes under a page.
    const section = moveShownEntries(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shownOf(NO_OWN_PAGES).layout,
      [MENU, g('x')],
      g('index'),
      null,
    );
    expect(section.left).toEqual([MENU]);
    expect(section.moved).toEqual([g('x')]);
  });
});

describe('a new level made of pages', () => {
  const level = { id: g('own.level'), title: 'Level', body: '' };

  it('is a page of ones own where the first page was, holding them in their order', () => {
    const placed = moveMany(NO_OWN_PAGES, ['a', 'b', 'c', 'd'], g('index')).own;
    const { own, moved, left } = addLevelPage(
      placed,
      layoutFor(data(), placed),
      shownOf(placed).layout,
      level,
      [g('d'), g('b')],
      NOW,
    );
    expect(moved).toEqual([g('d'), g('b')]);
    expect(left).toEqual([]);
    expect(own.pages.map((page) => page.id)).toEqual([level.id]);
    const contents = contentsOf(own);
    // Under Index, at the end of the pages put there by hand.
    expect(titles(contents, g('index'))).toEqual(['A', 'C', 'Level']);
    expect(titles(contents, level.id)).toEqual(['D', 'B']);
    expect(trail(contents, 'b')).toEqual(['Menu', 'Index', 'Level']);
    expect(contents.pages()).toHaveLength(data().guides.length + 1);
  });

  it('in a section, goes before the first page, and a section ticked with it stays', () => {
    const { own, left } = addLevelPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shownOf(NO_OWN_PAGES).layout,
      level,
      [g('notes'), MENU, g('gear')],
      NOW,
    );
    expect(left).toEqual([MENU]);
    expect(shownOf(own).layout.sections[MENU]).toEqual(['index', 'own.level'].map(g));
    expect(shownOf(own).layout.sections[level.id]).toEqual(['notes', 'gear'].map(g));
  });

  it('made of pages outside the menu, stays outside it with them', () => {
    const { own } = addLevelPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shownOf(NO_OWN_PAGES).layout,
      level,
      [g('w1'), g('w2')],
      NOW,
    );
    const shown = shownOf(own);
    expect(shown.layout.sections[PAGES]).toContain(level.id);
    expect(shown.layout.sections[level.id]).toEqual(['w1', 'w2'].map(g));
    expect(contentsOf(own).isInMenu(level.id)).toBe(false);
  });

  it('lists its pages in its text as links, nested, as words that start nothing', () => {
    expect(
      pagesListMarkdown([
        { id: g('a'), title: 'A [first]' },
        { title: '2. Weapons', under: [{ id: g('w1'), title: 'W1', under: [] }] },
        { title: '# Charms', under: [{ id: g('c1'), title: 'C1' }] },
      ]),
    ).toBe(
      [
        `- [A \\[first\\]](${g('a')})`,
        '- 2\\. Weapons',
        `  - [W1](${g('w1')})`,
        '- \\# Charms',
        `  - [C1](${g('c1')})`,
        '',
      ].join('\n'),
    );
    expect(pagesListMarkdown([])).toBe('');
  });
});

describe('“File the pages this page lists under it”', () => {
  const fileUnder = (own: OwnPages, local: string) => {
    const guide = data().guides.find((page) => page.id === g(local))!;
    return fileListedPages(
      own,
      layoutFor(data(), own),
      shownOf(own),
      g(local),
      listingThrough(guide, undefined),
    );
  };

  it('puts the pages it lists outside the menu under it by hand, in its order', () => {
    const { own, moved, placed } = fileUnder(NO_OWN_PAGES, 'gear');
    expect(moved).toEqual([...WEAPONS, ...CHARMS].map(g));
    expect(placed).toEqual([]);
    expect(own.contents?.sections[g('gear')]).toEqual([...WEAPONS, ...CHARMS].map(g));
    // No level from its headings: the pages are side by side under it.
    const contents = contentsOf(own);
    expect(titles(contents, g('gear'))).toEqual([...WEAPONS, ...CHARMS].map(titleOf));
    expect(trail(contents, 'w3')).toEqual(['Menu', 'Gear']);
  });

  it('leaves a page it lists that is in the menu or put by hand, and its mentions', () => {
    const moved = moveMany(NO_OWN_PAGES, ['x'], g('index')).own;
    const filed = fileUnder(moved, 'notes');
    expect(filed.moved).toEqual(['y', 'z'].map(g));
    expect(filed.placed).toEqual([g('x')]);
    // Notes mentions a in a sentence: that files nothing.
    expect(trail(contentsOf(filed.own), 'a')).toEqual([]);
    expect(trail(contentsOf(filed.own), 'x')).toEqual(['Menu', 'Index']);
  });

  it('files nothing again by itself when the page’s text changes later', () => {
    const { own } = fileUnder(NO_OWN_PAGES, 'index');
    const changed = applyOwnPages(
      {
        ...data(),
        guides: data().guides.map((page) =>
          page.id === g('index') ? { ...page, body: items('x') } : page,
        ),
      },
      own,
    );
    const contents = new GuideContents(changed);
    expect(titles(contents, g('index'))).toEqual(['A', 'B', 'C', 'D']);
    expect(contents.isInMenu(g('x'))).toBe(false);
  });
});

describe('a person’s layout made by an earlier app', () => {
  /** As an earlier app kept it: a page moved by hand, a list kept under Gear, and says on list pages. */
  function oldLayout(): OwnPages {
    const layout = layoutFor(data(), NO_OWN_PAGES);
    const frozen = [g('x'), ...WEAPONS.map(g)];
    return {
      ...NO_OWN_PAGES,
      contents: {
        top: layout.top,
        sections: {
          ...layout.sections,
          [MENU]: [...layout.sections[MENU]!, g('c1')],
          [PAGES]: layout.sections[PAGES]!.filter((id) => !frozen.includes(id) && id !== g('c1')),
          [g('gear')]: frozen,
        },
      },
      listPages: { [g('notes')]: true, [g('index')]: false },
    };
  }

  it('loads from its file, the says on list pages kept as they are', () => {
    const text = writeOwnPagesFile('tools', oldLayout(), NOW);
    const read = readOwnPagesFile(JSON.parse(text) as unknown);
    expect(read.ok && read.file.own.listPages).toEqual({
      [g('notes')]: true,
      [g('index')]: false,
    });
  });

  it('keeps everything put by hand, and the says on list pages change nothing', () => {
    const contents = contentsOf(oldLayout());
    expect(titles(contents, g('gear'))).toEqual(['x', ...WEAPONS].map(titleOf));
    expect(trail(contents, 'w2')).toEqual(['Menu', 'Gear']);
    expect(trail(contents, 'c1')).toEqual(['Menu']);
    // Notes said to file what it lists, Index said to file none: both hold nothing, as by hand.
    expect(titles(contents, g('notes'))).toEqual([]);
    expect(titles(contents, g('index'))).toEqual([]);
    expect(contents.isInMenu(g('y'))).toBe(false);
    expect(contents.pages()).toHaveLength(data().guides.length);
  });

  it('grows by hand as before', () => {
    const { own } = moveMany(oldLayout(), ['y'], g('gear'), g('w3'));
    expect(own.contents?.sections[g('gear')]).toEqual([
      g('x'),
      g('w1'),
      g('w2'),
      g('y'),
      ...['w3', 'w4', 'w5'].map(g),
    ]);
    const page = { id: g('own.new'), title: 'New page', body: '' };
    const added = addOwnPage(own, layoutFor(data(), own), page, g('gear'), null, NOW);
    expect(added.contents?.sections[g('gear')]?.at(-1)).toBe(page.id);
  });
});
