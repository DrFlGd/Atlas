import { NO_OWN_PAGES, type GuideEntry, type Section } from '@atlas/schema';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGuideLinks, type OtherGuides } from './guideLinks';
import {
  guideSourcesOf,
  isReadInOrder,
  isSourceHome,
  madeLandingOf,
  neighbours,
  readingOrder,
  sourceOfEntry,
  trailIn,
  useGuideSources,
} from './guideSources';
import { useOwnPages } from './ownPages';
import { packSaysPagesInOrder } from './pagesInOrder';
import type { LoadedGame } from './store';

/**
 * The sources of pages of a game's Guides: a made-up game with a map and
 * pages of its own, read with a made-up guide (its pack says its pages are
 * read in order) and a made-up wiki.
 */

const page = (id: string, title: string, order: number, body = 'Text.'): GuideEntry => ({
  id,
  title,
  body,
  locationIds: [],
  order,
});

interface Made {
  gameId: string;
  title: string;
  guides: GuideEntry[];
  sections: Section[];
  maps?: number;
  homePage?: string;
  pagesInOrder?: true;
  site?: string;
}

/** A pack as far as Guides reads it. */
function packOf(made: Made) {
  return {
    manifest: {
      gameId: made.gameId,
      title: made.title,
      idMigrations: {},
      ...(made.pagesInOrder ? { pagesInOrder: made.pagesInOrder } : {}),
      ...(made.site
        ? {
            source: {
              importer: { id: 'made-up', title: 'Made up' },
              pages: [{ url: `https://${made.site}/start`, importedAt: '2026-11-01T10:00:00Z' }],
            },
          }
        : {}),
    },
    data: {
      guides: made.guides,
      sections: made.sections,
      maps: Array.from({ length: made.maps ?? 0 }, (_, i) => ({ id: `${made.gameId}:map:${i}` })),
      pictures: [],
    },
    homePage: made.homePage ?? null,
    resolveUrl: (file: string) => file,
    currentId: (id: string) => id,
  };
}

const ISLE = packOf({
  gameId: 'isle',
  title: 'The made-up isle',
  maps: 1,
  guides: [page('isle:guide:tides', 'Tides', 0), page('isle:guide:boats', 'Boats', 1)],
  sections: [
    { id: 'isle:section:sea', title: 'The sea', items: ['isle:guide:tides', 'isle:guide:boats'] },
  ],
});

const WALK = packOf({
  gameId: 'walk',
  title: 'Walkthrough',
  pagesInOrder: true,
  site: 'guides.example',
  homePage: 'walk:guide:intro',
  guides: [
    page('walk:guide:intro', 'Before you start', 0),
    page('walk:guide:a', 'The landing', 1),
    page('walk:guide:a2', 'The first cave', 2),
    page('walk:guide:b', 'The bridge', 3),
    page('walk:guide:c', 'The tower', 4, 'See [the tides](isle:guide:tides).'),
  ],
  sections: [
    {
      id: 'walk:section:one',
      title: 'Chapter one',
      items: ['walk:guide:a', 'walk:section:caves', 'walk:guide:b'],
    },
    { id: 'walk:section:caves', title: 'Caves', items: ['walk:guide:a2'] },
    { id: 'walk:section:two', title: 'Chapter two', items: ['walk:guide:c'] },
  ],
});

const NOTES = packOf({
  gameId: 'notes',
  title: 'Isle notes',
  guides: [page('notes:guide:birds', 'Birds', 0), page('notes:guide:fish', 'Fish', 1)],
  sections: [
    {
      id: 'notes:section:life',
      title: 'Life',
      items: ['notes:guide:birds', 'notes:guide:fish'],
    },
  ],
});

const other = (pack: ReturnType<typeof packOf>): OtherGuides =>
  ({ gameId: pack.manifest.gameId, title: pack.manifest.title, pack }) as unknown as OtherGuides;

/** The game shown, read anew for each test so nothing worked out before is kept. */
const gameOf = (pack: ReturnType<typeof packOf>) =>
  ({ pack: { ...pack }, entry: { id: pack.manifest.gameId } }) as unknown as LoadedGame;

let game: LoadedGame;

beforeEach(() => {
  game = gameOf(ISLE);
  useGuideLinks.setState({ gameId: 'isle', others: [other(WALK), other(NOTES)] });
  useOwnPages.setState({ gameId: 'isle', status: 'ready', own: NO_OWN_PAGES });
  useGuideSources.setState({
    gameId: 'isle',
    chosen: null,
    ready: true,
    readLast: {},
    othersSay: {},
  });
});

describe('the sources of a game’s Guides', () => {
  it('are the game’s own pages, then each other game’s, with its site', () => {
    const sources = guideSourcesOf(game);
    expect(sources.map((s) => [s.gameId, s.own, s.title, s.site])).toEqual([
      ['isle', true, 'The made-up isle', null],
      ['walk', false, 'Walkthrough', 'guides.example'],
      ['notes', false, 'Isle notes', null],
    ]);
    // Each shows its part of the contents only, its home page apart.
    expect(sources[0]!.top.map((e) => e.kind === 'section' && e.section.title)).toEqual([
      'The sea',
    ]);
    expect(sources[1]!.home?.id).toBe('walk:guide:intro');
    expect(sources[1]!.top.map((e) => e.kind === 'section' && e.section.title)).toEqual([
      'Chapter one',
      'Chapter two',
    ]);
    expect(sources[2]!.home).toBeNull();
  });

  it('leave out the game’s own when it has no pages', () => {
    const bare = gameOf(
      packOf({ gameId: 'isle', title: 'Bare', maps: 1, guides: [], sections: [] }),
    );
    expect(guideSourcesOf(bare).map((s) => s.gameId)).toEqual(['walk', 'notes']);
  });

  it('say which source a page or a section is shown in', () => {
    expect(sourceOfEntry(game, 'isle:guide:boats')?.gameId).toBe('isle');
    expect(sourceOfEntry(game, 'walk:guide:a2')?.gameId).toBe('walk');
    expect(sourceOfEntry(game, 'walk:section:caves')?.gameId).toBe('walk');
    expect(sourceOfEntry(game, 'walk:guide:intro')?.gameId).toBe('walk');
    expect(sourceOfEntry(game, 'notes:guide:fish')?.gameId).toBe('notes');
    expect(sourceOfEntry(game, 'elsewhere:guide:x')).toBeUndefined();
    expect(isSourceHome(game, 'walk:guide:intro')).toBe(true);
    expect(isSourceHome(game, 'walk:guide:a')).toBe(false);
  });

  it('give the way to a page within its source', () => {
    const walk = guideSourcesOf(game)[1]!;
    expect(
      trailIn(game, walk, 'walk:guide:a2').map(
        (step) => step.kind === 'section' && step.section.title,
      ),
    ).toEqual(['Chapter one', 'Caves']);
  });

  it('make the landing page of a source with no home page from its part of the contents', () => {
    const notes = guideSourcesOf(game)[2]!;
    const groups = madeLandingOf(game, notes);
    expect(groups.map((g) => g.section?.title)).toEqual(['Life']);
    expect(groups[0]!.tiles.map((t) => t.entry.kind === 'page' && t.entry.guide.title)).toEqual([
      'Birds',
      'Fish',
    ]);
  });
});

describe('a guide read in order', () => {
  it('is a source whose pack says so, or the person', () => {
    const [isle, walk, notes] = guideSourcesOf(game);
    expect(packSaysPagesInOrder(WALK as never)).toBe(true);
    expect(packSaysPagesInOrder(NOTES as never)).toBe(false);
    expect(isReadInOrder(walk!)).toBe(true);
    expect(isReadInOrder(notes!)).toBe(false);
    expect(isReadInOrder(isle!)).toBe(false);
    // The person's say, kept with the game's own pages, wins over the pack's.
    useOwnPages.setState({ own: { ...NO_OWN_PAGES, pagesInOrder: true } });
    expect(isReadInOrder(isle!)).toBe(true);
    // Another game's say, from its own pages file, wins over its pack's.
    useGuideSources.setState({ othersSay: { walk: false, notes: true } });
    expect(isReadInOrder(walk!)).toBe(false);
    expect(isReadInOrder(notes!)).toBe(true);
  });

  it('reads its home page, then its contents top to bottom, depth first', () => {
    const walk = guideSourcesOf(game)[1]!;
    expect(readingOrder(game, walk).map((p) => p.title)).toEqual([
      'Before you start',
      'The landing',
      'The first cave',
      'The bridge',
      'The tower',
    ]);
    expect(neighbours(game, walk, 'walk:guide:a2')).toMatchObject({
      previous: { id: 'walk:guide:a' },
      next: { id: 'walk:guide:b' },
    });
    expect(neighbours(game, walk, 'walk:guide:intro').previous).toBeNull();
    expect(neighbours(game, walk, 'walk:guide:c').next).toBeNull();
    // A page of another source is in no order of this one.
    expect(neighbours(game, walk, 'isle:guide:tides')).toEqual({ previous: null, next: null });
  });

  it('skips the pages the person hid', () => {
    useOwnPages.setState({
      own: {
        ...NO_OWN_PAGES,
        pages: [{ id: 'isle:guide:tides', hidden: true, updatedAt: '2026-11-01T10:00:00.000Z' }],
      },
    });
    const isle = guideSourcesOf(game)[0]!;
    expect(readingOrder(game, isle).map((p) => p.title)).toEqual(['Boats']);
  });
});
