import type { GuideEntry, Section } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import {
  GuideContents,
  OTHER_GAME_SECTION,
  entryIdOf,
  entryTitleOf,
  isMenuWayTo,
  menuWayOf,
  stepsOfWay,
  withoutLedSteps,
  type ContentsEntry,
  type GuidePages,
} from './contents';

/**
 * A section led by its own page: a source's menu has entries that are
 * pages with pages under them, and the pack writes each as a section of
 * that title whose first item is the page. The menu shows such a section
 * as the page. On made-up contents only.
 */

const g = (local: string) => `marsh:guide:${local}`;
const s = (local: string) => `marsh:section:${local}`;

const guide = (local: string, title: string): GuideEntry => ({
  id: g(local),
  title,
  body: '',
  locationIds: [],
});

const GUIDES: GuideEntry[] = [
  guide('saltmarsh', 'Saltmarsh'),
  guide('bosses', 'Bosses'),
  guide('tide-king', 'Tide King'),
  guide('reed-queen', 'Reed Queen'),
  guide('tides', 'Tides'),
  guide('high-tide', 'High Tide'),
  guide('low-tide', 'Low Tide'),
  guide('note', 'A note'),
  guide('stray', 'Stray'),
];

const contentsOf = (sections: Section[], more: Partial<GuidePages> = {}) =>
  new GuideContents({ data: { guides: GUIDES, sections, maps: [] }, ...more });

const ids = (entries: readonly ContentsEntry[]) => entries.map((entry) => entryIdOf(entry));

describe('the page that leads a section', () => {
  it('is its first page, of the section’s title, still one of its items', () => {
    const contents = contentsOf([
      { id: s('bosses'), title: 'Bosses', items: [g('bosses'), g('tide-king'), g('reed-queen')] },
    ]);
    expect(contents.leadPage(s('bosses'))?.id).toBe(g('bosses'));
    expect(ids(contents.items(s('bosses')))).toEqual([
      g('bosses'),
      g('tide-king'),
      g('reed-queen'),
    ]);
    expect(contents.trail(g('bosses')).map((step) => entryTitleOf(step))).toEqual(['Bosses']);
  });

  it('has the same words as the section, in any case and spacing', () => {
    const contents = contentsOf([
      { id: s('king'), title: '  tide   KING ', items: [g('tide-king'), g('note')] },
      { id: s('tides'), title: 'The tides', items: [g('tides'), g('high-tide')] },
      { id: s('more'), title: 'Tides', items: [g('tides')] },
    ]);
    const tabbed = new GuideContents({
      data: {
        guides: GUIDES.map((page) =>
          page.id === g('high-tide') ? { ...page, title: 'High\tTide ' } : page,
        ),
        sections: [{ id: s('high'), title: 'high tide', items: [g('high-tide')] }],
        maps: [],
      },
    });
    expect(contents.leadPage(s('king'))?.id).toBe(g('tide-king'));
    expect(tabbed.leadPage(s('high'))?.id).toBe(g('high-tide'));
    // "Tides" is not "The tides": other words.
    expect(contents.leadPage(s('tides'))).toBeNull();
    // The section's only item still leads it.
    expect(contents.leadPage(s('more'))?.id).toBe(g('tides'));
  });

  it('is none when the first item is a section, or a page of another title', () => {
    const contents = contentsOf([
      { id: s('bosses'), title: 'Bosses', items: [s('tides'), g('bosses')] },
      { id: s('tides'), title: 'Tides', items: [g('high-tide'), g('tides')] },
    ]);
    expect(contents.leadPage(s('bosses'))).toBeNull();
    expect(contents.leadPage(s('tides'))).toBeNull();
  });

  it('is none for an empty section, a section outside the menu, an unknown id or a page', () => {
    const contents = contentsOf([
      { id: s('empty'), title: 'Empty', items: [] },
      { id: s('bosses'), title: 'Bosses', items: [g('bosses')], placeByLinks: true },
    ]);
    expect(contents.leadPage(s('empty'))).toBeNull();
    expect(contents.leadPage(s('bosses'))).toBeNull();
    expect(contents.leadPage(s('gone'))).toBeNull();
    expect(contents.leadPage(g('bosses'))).toBeNull();
    // No contents at all.
    expect(contentsOf([]).leadPage(s('bosses'))).toBeNull();
  });

  it('is read as the section shows its items: the home page left out, unheaded sections spread', () => {
    const contents = contentsOf(
      [
        { id: s('saltmarsh'), title: 'Saltmarsh', items: [g('saltmarsh'), g('stray')] },
        { id: s('bosses'), title: 'Bosses', items: [s('all-bosses')] },
        {
          id: s('all-bosses'),
          title: 'All bosses',
          items: [g('bosses'), g('tide-king')],
          unheaded: true,
        },
      ],
      { homePage: g('saltmarsh') },
    );
    expect(contents.leadPage(s('saltmarsh'))).toBeNull();
    expect(contents.leadPage(s('bosses'))?.id).toBe(g('bosses'));
    expect(contents.leadPage(s('all-bosses'))).toBeNull();
  });

  it('is none for the section that holds another game’s pages, led by its home page', () => {
    const other = `isle:section:${OTHER_GAME_SECTION}`;
    const contents = contentsOf([{ id: other, title: 'Saltmarsh', items: [g('saltmarsh')] }]);
    expect(contents.leadPage(other)).toBeNull();
  });

  it('copes with a page the menu lists in two sections: each lists it, the way follows the first', () => {
    const contents = contentsOf([
      { id: s('tides'), title: 'Tides', items: [g('tides'), g('reed-queen'), g('bosses')] },
      { id: s('bosses'), title: 'Bosses', items: [g('bosses'), g('tide-king'), g('reed-queen')] },
    ]);
    expect(ids(contents.items(s('tides')))).toContain(g('reed-queen'));
    expect(ids(contents.items(s('bosses')))).toContain(g('reed-queen'));
    expect(contents.trail(g('reed-queen')).map((step) => entryTitleOf(step))).toEqual(['Tides']);
    // A page that leads a section and is listed earlier elsewhere still leads it.
    expect(contents.leadPage(s('bosses'))?.id).toBe(g('bosses'));
    expect(contents.trail(g('bosses')).map((step) => entryTitleOf(step))).toEqual(['Tides']);
    // Each page is browsed once.
    const pages = contents.pages().map((page) => page.id);
    expect(new Set(pages).size).toBe(pages.length);
  });
});

describe('the way to a page, as the menu shows it', () => {
  const contents = contentsOf(
    [
      { id: s('marsh'), title: 'Marsh', items: [s('bosses'), s('tides')] },
      { id: s('bosses'), title: 'Bosses', items: [g('bosses'), g('tide-king'), g('reed-queen')] },
      { id: s('tides'), title: 'Tides', items: [g('high-tide'), g('tides')] },
    ],
    { under: { [g('bosses')]: [g('note')] } },
  );
  const way = (id: string) =>
    withoutLedSteps(contents, contents.trail(id), id).map((step) => entryTitleOf(step));

  it('leaves out the section a page leads', () => {
    expect(contents.trail(g('bosses')).map((step) => entryTitleOf(step))).toEqual([
      'Marsh',
      'Bosses',
    ]);
    expect(way(g('bosses'))).toEqual(['Marsh']);
  });

  it('keeps the section above its other pages, and names a page that leads it once', () => {
    expect(way(g('tide-king'))).toEqual(['Marsh', 'Bosses']);
    // Put under the page by hand: the page, not the section too.
    expect(contents.trail(g('note')).map((step) => step.kind)).toEqual([
      'section',
      'section',
      'page',
    ]);
    expect(way(g('note'))).toEqual(['Marsh', 'Bosses']);
    expect(withoutLedSteps(contents, contents.trail(g('note')), g('note'))[1]?.kind).toBe('page');
  });

  it('keeps a section no page leads, and the way to a section', () => {
    expect(way(g('tides'))).toEqual(['Marsh', 'Tides']);
    expect(way(s('bosses'))).toEqual(['Marsh']);
  });
});

describe('a way down the menu, as its rows', () => {
  // Reed Queen is listed under Walkthrough first, then under Bosses, led by its page.
  const sections: Section[] = [
    { id: s('walkthrough'), title: 'Walkthrough', items: [g('tides'), g('reed-queen')] },
    { id: s('bosses'), title: 'Bosses', items: [g('bosses'), g('tide-king'), g('reed-queen')] },
  ];
  const contents = contentsOf(sections, { under: { [g('bosses')]: [g('note')] } });
  const top = contents.topEntryIds();

  it('shows under a section led by its page the pages put under the page, then its others', () => {
    expect(ids(contents.menuItems(s('bosses')))).toEqual([
      g('note'),
      g('tide-king'),
      g('reed-queen'),
    ]);
    expect(ids(contents.menuItems(s('walkthrough')))).toEqual(
      ids(contents.items(s('walkthrough'))),
    );
  });

  it('is the way to the first place, a page that leads its section being the section', () => {
    const way = (id: string) => menuWayOf(contents, contents.trail(id), id);
    expect(way(g('reed-queen'))).toEqual([s('walkthrough'), g('reed-queen')]);
    expect(way(g('bosses'))).toEqual([s('bosses')]);
    expect(way(g('note'))).toEqual([s('bosses'), g('note')]);
    expect(way(s('bosses'))).toEqual([s('bosses')]);
  });

  it('is followed while the menu shows it and it leads to the place', () => {
    expect(isMenuWayTo(contents, top, [s('bosses'), g('reed-queen')], g('reed-queen'))).toBe(true);
    expect(isMenuWayTo(contents, top, [s('walkthrough'), g('reed-queen')], g('reed-queen'))).toBe(
      true,
    );
    // A section's heading leads to its page.
    expect(isMenuWayTo(contents, top, [s('bosses')], g('bosses'))).toBe(true);
    expect(isMenuWayTo(contents, top, [s('bosses'), g('note')], g('note'))).toBe(true);
  });

  it('is not followed to another place, from outside the top, or where the menu lists it no more', () => {
    expect(isMenuWayTo(contents, top, [s('bosses'), g('tide-king')], g('reed-queen'))).toBe(false);
    expect(isMenuWayTo(contents, top, [g('reed-queen')], g('reed-queen'))).toBe(false);
    expect(isMenuWayTo(contents, top, [], g('reed-queen'))).toBe(false);
    // The page the section is led by is the section, not a row under it.
    expect(isMenuWayTo(contents, top, [s('bosses'), g('bosses')], g('bosses'))).toBe(false);
    // Reed Queen taken out of Bosses: the way remembered is no longer one.
    const changed = contentsOf([
      sections[0]!,
      { ...sections[1]!, items: [g('bosses'), g('tide-king')] },
    ]);
    expect(
      isMenuWayTo(changed, changed.topEntryIds(), [s('bosses'), g('reed-queen')], g('reed-queen')),
    ).toBe(false);
  });

  it('gives its steps, sections and pages, leaving out ids that are neither', () => {
    expect(
      stepsOfWay(contents, [s('bosses'), g('gone'), g('note')]).map((step) => [
        step.kind,
        entryTitleOf(step),
      ]),
    ).toEqual([
      ['section', 'Bosses'],
      ['page', 'A note'],
    ]);
  });
});
