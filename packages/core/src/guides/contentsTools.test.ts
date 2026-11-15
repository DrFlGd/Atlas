import { NO_OWN_PAGES, type GuideEntry, type OwnPages, type Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { GuideContents, entryTitleOf } from './contents';
import { headingStepId } from './headingSteps';
import {
  addLevelPage,
  applyOwnPages,
  layoutFor,
  looseSections,
  moveShownEntries,
  setListPageSay,
  shownContentsFor,
} from './ownPages';
import { pagesListMarkdown } from './pagesList';

/**
 * The tools of the arrange tool that make and fill levels, on made-up
 * pages: several pages moved at once, a new level made of them, and the
 * person's say on which pages file the pages they list.
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

const LOOSE = ['a', 'b', 'c', 'd', 'x', 'y', 'z', 'w1', 'w2', 'w3', 'c1', 'c2', 'c3'];
const MENTIONED = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];

/**
 * Index lists a to d; Notes lists x, y and z, but names six pages more in
 * its sentences, so it is no list page; Gear lists three pages under
 * "Weapons" and three under "Charms", which are levels.
 */
function data() {
  const guides: GuideEntry[] = [
    entry('index', `# Index\n\n${items('a', 'b', 'c', 'd')}`),
    entry(
      'notes',
      `# Notes\n\n${MENTIONED.map((id) => `See ${to(id)} for more.`).join(' ')}\n\n${items('x', 'y', 'z')}`,
    ),
    entry(
      'gear',
      `# Gear\n\n## Weapons\n\n${items('w1', 'w2', 'w3')}\n\n## Charms\n\n${items('c1', 'c2', 'c3')}`,
    ),
    ...[...LOOSE, ...MENTIONED].map((id) => entry(id, `# ${titleOf(id)}\n\nA page.`)),
  ];
  const sections: Section[] = [
    { id: MENU, title: 'Menu', items: [g('index'), g('notes'), g('gear')] },
    { id: PAGES, title: 'Pages', items: [...LOOSE, ...MENTIONED].map(g), placeByLinks: true },
  ];
  return { guides, sections, maps: [] };
}

const contentsOf = (own: OwnPages) => new GuideContents(applyOwnPages(data(), own));
const trail = (contents: GuideContents, local: string) =>
  contents.trail(g(local)).map((step) => entryTitleOf(step));
const shownOf = (own: OwnPages) => shownContentsFor(data(), own);

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
    looseSections(data()),
  );
}

describe('several pages moved at once', () => {
  it('go under a page together, in their order, with one change', () => {
    const { own, moved, left } = moveMany(NO_OWN_PAGES, ['a', 'c', 'b'], g('notes'));
    expect(moved).toEqual(['a', 'c', 'b'].map(g));
    expect(left).toEqual([]);
    expect(shownOf(own).layout.sections[g('notes')]).toEqual(['a', 'c', 'b'].map(g));
    const contents = contentsOf(own);
    expect(trail(contents, 'c')).toEqual(['Menu', 'Notes']);
    // Index files what is left.
    expect(contents.items(g('index')).map((item) => entryTitleOf(item))).toEqual(['D']);
    expect(contents.pages()).toHaveLength(data().guides.length);
  });

  it('go to a section before an entry there, and keep their order', () => {
    const { own } = moveMany(NO_OWN_PAGES, ['b', 'd'], MENU, g('notes'));
    expect(shownOf(own).layout.sections[MENU]).toEqual(['index', 'b', 'd', 'notes', 'gear'].map(g));
  });

  it('never under themselves or a page beneath them: those stay, and are counted', () => {
    // Index holds a; moving Index and a under a leaves both; b goes.
    const { own, moved, left } = moveMany(NO_OWN_PAGES, ['index', 'a', 'b'], g('a'));
    expect(moved).toEqual([g('b')]);
    expect(left).toEqual([g('index'), g('a')]);
    expect(trail(contentsOf(own), 'b')).toEqual(['Menu', 'Index', 'A']);
    // A section never goes under a page.
    const section = moveShownEntries(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shownOf(NO_OWN_PAGES).layout,
      [PAGES, g('x')],
      g('index'),
      null,
      looseSections(data()),
    );
    expect(section.left).toEqual([PAGES]);
    expect(section.moved).toEqual([g('x')]);
  });
});

describe('a new level made of pages', () => {
  const level = { id: g('own.level'), title: 'Level', body: '' };

  it('is a page of ones own where the first page was, holding them in their order', () => {
    const shown = shownOf(NO_OWN_PAGES);
    const { own, moved, left } = addLevelPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shown.layout,
      level,
      [g('d'), g('b')],
      looseSections(data()),
      NOW,
    );
    expect(moved).toEqual([g('d'), g('b')]);
    expect(left).toEqual([]);
    expect(own.pages.map((page) => page.id)).toEqual([level.id]);
    const contents = contentsOf(own);
    // Under Index, where d was; the others stay under Index by its listing.
    expect(contents.items(g('index')).map((item) => entryTitleOf(item))).toEqual([
      'Level',
      'A',
      'C',
    ]);
    expect(contents.items(level.id).map((item) => entryTitleOf(item))).toEqual(['D', 'B']);
    expect(trail(contents, 'b')).toEqual(['Menu', 'Index', 'Level']);
    expect(contents.pages()).toHaveLength(data().guides.length + 1);
  });

  it('in a section, goes before the first page, and a section ticked with it stays', () => {
    const { own, left } = addLevelPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shownOf(NO_OWN_PAGES).layout,
      level,
      [g('notes'), PAGES, g('gear')],
      looseSections(data()),
      NOW,
    );
    expect(left).toEqual([PAGES]);
    expect(shownOf(own).layout.sections[MENU]).toEqual(['index', 'own.level'].map(g));
    expect(shownOf(own).layout.sections[level.id]).toEqual(['notes', 'gear'].map(g));
  });

  it('can be made of the pages of a heading level, which then is the person’s own', () => {
    const shown = shownOf(NO_OWN_PAGES);
    const weapons = headingStepId(g('gear'), 'weapons');
    expect(shown.steps.get(weapons)).toMatchObject({ page: g('gear'), title: 'Weapons' });
    expect(shown.levels.get(g('gear'))).toEqual([weapons, headingStepId(g('gear'), 'charms')]);
    // The layout the moves work on holds no level.
    expect(JSON.stringify(shown.layout)).not.toContain('#');
    const { own } = addLevelPage(
      NO_OWN_PAGES,
      layoutFor(data(), NO_OWN_PAGES),
      shown.layout,
      { ...level, title: 'Weapons' },
      [...shown.levels.get(weapons)!],
      looseSections(data()),
      NOW,
    );
    const after = shownOf(own);
    expect(after.layout.sections[level.id]).toEqual(['w1', 'w2', 'w3'].map(g));
    // The other level stays a level of Gear.
    expect(after.levels.get(g('gear'))).toEqual([level.id, headingStepId(g('gear'), 'charms')]);
    expect(trail(contentsOf(own), 'w2')).toEqual(['Menu', 'Gear', 'Weapons']);
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

describe('the person’s say on list pages', () => {
  it('files the pages a page lists under it whatever its share, and takes it back', () => {
    expect(trail(contentsOf(NO_OWN_PAGES), 'x')).toEqual(['Pages']);
    const own = setListPageSay(NO_OWN_PAGES, g('notes'), true);
    expect(own.listPages).toEqual({ [g('notes')]: true });
    expect(trail(contentsOf(own), 'x')).toEqual(['Menu', 'Notes']);
    expect(shownOf(own).layout.sections[g('notes')]).toEqual(['x', 'y', 'z'].map(g));
    // Let the app decide again.
    const back = setListPageSay(own, g('notes'), null);
    expect(back.listPages).toBeUndefined();
    expect(trail(contentsOf(back), 'x')).toEqual(['Pages']);
    expect(setListPageSay(back, g('notes'), null)).toBe(back);
  });

  it('files nothing under a page the app took for a list page', () => {
    expect(trail(contentsOf(NO_OWN_PAGES), 'a')).toEqual(['Menu', 'Index']);
    const own = setListPageSay(NO_OWN_PAGES, g('index'), false);
    expect(trail(contentsOf(own), 'a')).toEqual(['Pages']);
    expect(shownOf(own).layout.sections[g('index')]).toBeUndefined();
    // Its heading levels go with it: Gear filing nothing has none.
    const gear = setListPageSay(NO_OWN_PAGES, g('gear'), false);
    expect(shownOf(gear).levels.size).toBe(0);
    expect(contentsOf(gear).items(g('gear'))).toEqual([]);
  });

  it('never moves a page the person put somewhere by hand', () => {
    const { own } = moveMany(NO_OWN_PAGES, ['x'], g('index'));
    const said = setListPageSay(own, g('notes'), true);
    const contents = contentsOf(said);
    expect(trail(contents, 'x')).toEqual(['Menu', 'Index']);
    expect(trail(contents, 'y')).toEqual(['Menu', 'Notes']);
    expect(contents.pages()).toHaveLength(data().guides.length);
  });
});
