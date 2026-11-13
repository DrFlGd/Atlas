import { pageKey } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_CHOICES,
  followsFrom,
  isFollowLinks,
  pagesToFollow,
  type FollowLinks,
} from './followLinks';
import {
  ImportRun,
  MAX_FETCHED_RUN_PAGES,
  foundByLinks,
  foundText,
  runSummary,
  type PageOutcome,
  type RunState,
} from './importRun';

/**
 * Following the links of a made-up wiki's pages during a go: which pages
 * are added, how far, and that the go keeps its rules.
 */

const SITE = 'https://wiki.example.org';
const at = (slug: string) => `${SITE}/wiki/${slug}`;
const wiki = {
  matches: (url: string) => url.startsWith(`${SITE}/wiki/`) && !url.endsWith('/Contents'),
  refuses: (url: string) => (url.includes('Forbidden') ? 'That page is not read.' : null),
};
const keys = (...slugs: string[]) => new Set(slugs.map((slug) => pageKey(at(slug))));

const follow = (options: Partial<Parameters<typeof pagesToFollow>[0]> = {}) =>
  pagesToFollow({
    follow: 'linked',
    depth: 0,
    links: [],
    importer: wiki,
    inGo: new Set(),
    read: new Set(),
    leftOut: new Set(),
    room: 100,
    ...options,
  });

describe('the choice', () => {
  it('has three options, the middle one first chosen, each with a sentence', () => {
    expect(FOLLOW_CHOICES.map((choice) => choice.label)).toEqual([
      'Only the pages ticked',
      'And the pages they link to',
      'And every page those lead to',
    ]);
    for (const choice of FOLLOW_CHOICES) expect(choice.sentence).toMatch(/^[A-Z].+\.$/u);
    expect(isFollowLinks('linked')).toBe(true);
    expect(isFollowLinks('deep')).toBe(false);
    expect(isFollowLinks(undefined)).toBe(false);
  });

  it('follows the links of the pages ticked, or of every page, or none', () => {
    expect([0, 1, 2].map((depth) => followsFrom('ticked', depth))).toEqual([false, false, false]);
    expect([0, 1, 2].map((depth) => followsFrom('linked', depth))).toEqual([true, false, false]);
    expect([0, 1, 2].map((depth) => followsFrom('all', depth))).toEqual([true, true, true]);
  });
});

describe('the pages a go adds', () => {
  it('adds pages of the same importer, each once, in the order linked', () => {
    const { add, over } = follow({
      links: [
        at('Bells'),
        `${at('Bells')}/`,
        'https://elsewhere.example.com/wiki/Gates',
        at('Contents'),
        at('Forbidden_room'),
        at('Gates'),
      ],
    });
    expect(add).toEqual([at('Bells'), at('Gates')]);
    expect(over).toBe(0);
  });

  it('never adds a page left out, read before or in the go already', () => {
    const { add } = follow({
      links: [at('Left'), at('Read'), at('Failed'), at('Next'), at('New')],
      leftOut: keys('Left'),
      read: keys('Read'),
      // A page that could not be read in this go is still one of its pages.
      inGo: keys('Failed', 'Next'),
    });
    expect(add).toEqual([at('New')]);
  });

  it('adds only what fits; the rest is counted', () => {
    const { add, over } = follow({ links: [at('A'), at('B'), at('C')], room: 1 });
    expect(add).toEqual([at('A')]);
    expect(over).toBe(2);
    expect(follow({ links: [at('A')], room: 0 })).toEqual({ add: [], over: 1 });
  });

  it('adds nothing beyond the depth the choice allows', () => {
    expect(follow({ follow: 'ticked', links: [at('A')] }).add).toEqual([]);
    expect(follow({ follow: 'linked', depth: 1, links: [at('A')] }).add).toEqual([]);
    expect(follow({ follow: 'all', depth: 5, links: [at('A')] }).add).toEqual([at('A')]);
  });
});

/**
 * A made-up wiki: each page's links. Harbour leads to Boats, and Boats to
 * Oars, which no contents list; Dock is left out and Welcome was read.
 */
const LINKS: Record<string, string[]> = {
  Harbour: ['Boats', 'Welcome', 'Dock'],
  Boats: ['Oars', 'Harbour', 'Sails'],
  Oars: ['Boats', 'Paint'],
  Sails: [],
  Paint: ['Oars'],
};

/** A go over `ticked`, following links as `mode` says, the way `importing.ts` does. */
async function go(
  mode: FollowLinks,
  ticked: string[],
  {
    room = MAX_FETCHED_RUN_PAGES,
    outcome,
    onPage,
  }: {
    room?: number;
    outcome?: (slug: string) => PageOutcome | null;
    onPage?: (slug: string, run: ImportRun) => void;
  } = {},
): Promise<{ read: string[]; final: RunState }> {
  const read: string[] = [];
  const depths = ticked.map(() => 0);
  const inGo = keys(...ticked);
  const run: ImportRun = new ImportRun(
    ticked.map(at),
    0,
    {
      sleep: () => Promise.resolve(),
      onChange: () => undefined,
      importPage(index, url) {
        const slug = url.split('/').pop()!;
        read.push(slug);
        onPage?.(slug, run);
        const given = outcome?.(slug);
        if (given) return Promise.resolve(given);
        const depth = depths[index]!;
        const { add } = pagesToFollow({
          follow: mode,
          depth,
          links: (LINKS[slug] ?? []).map(at),
          importer: wiki,
          inGo,
          read: keys('Welcome'),
          leftOut: keys('Dock'),
          room: room - run.state.pages.length,
        });
        if (!run.state.stopRequested) {
          for (const found of add) {
            depths.push(depth + 1);
            inGo.add(pageKey(found));
          }
          run.add(add.map((found) => ({ url: found, foundOn: url })));
        }
        return Promise.resolve<PageOutcome>({
          kind: 'added',
          game: 'Example wiki',
          map: slug,
          packId: 'example-wiki',
          refreshed: false,
          guide: true,
        });
      },
    },
    0,
  );
  return { read, final: await run.run() };
}

describe('a go that follows links', () => {
  it('reads only the pages ticked', async () => {
    const { read, final } = await go('ticked', ['Harbour']);
    expect(read).toEqual(['Harbour']);
    expect(foundText(final)).toBeNull();
  });

  it('reads the pages the ticked pages link to, and not further', async () => {
    const { read, final } = await go('linked', ['Harbour']);
    expect(read).toEqual(['Harbour', 'Boats']);
    expect(final.pages.map((page) => page.foundOn ?? null)).toEqual([null, at('Harbour')]);
    expect(final.status).toBe('finished');
    expect(foundText(final)).toBe('1 found by links');
    expect(runSummary(final)).toBe('2 pages added');
  });

  it('follows every page those lead to, each once, until no new page is found', async () => {
    const { read, final } = await go('all', ['Harbour']);
    expect(read).toEqual(['Harbour', 'Boats', 'Oars', 'Sails', 'Paint']);
    expect(foundByLinks(final)).toBe(4);
  });

  it('a page ticked and linked to is read once, as ticked', async () => {
    const { read, final } = await go('all', ['Harbour', 'Oars']);
    expect(read).toEqual(['Harbour', 'Oars', 'Boats', 'Paint', 'Sails']);
    expect(final.pages.filter((page) => page.foundOn).map((page) => page.url)).toEqual([
      at('Boats'),
      at('Paint'),
      at('Sails'),
    ]);
  });

  it('stays within the go’s limit', async () => {
    const { read, final } = await go('all', ['Harbour'], { room: 3 });
    expect(read).toEqual(['Harbour', 'Boats', 'Oars']);
    expect(final.pages).toHaveLength(3);
  });

  it('a page that could not be read is not tried again in the same go', async () => {
    const { read } = await go('all', ['Harbour'], {
      outcome: (slug) =>
        slug === 'Boats' ? { kind: 'failed', message: 'The wiki has no such page.' } : null,
    });
    // Boats failed, so Oars, found only through it, was never found.
    expect(read).toEqual(['Harbour', 'Boats']);
  });

  it('stops at once on a refusal, with the pages found not read', async () => {
    const { read, final } = await go('all', ['Harbour'], {
      outcome: (slug) =>
        slug === 'Boats'
          ? { kind: 'refused', message: 'The site asked this app to slow down.' }
          : null,
    });
    expect(read).toEqual(['Harbour', 'Boats']);
    expect(final.stopReason).toBe('refused');
  });

  it('Stop ends it after the page open now, and adds nothing more', async () => {
    const { read, final } = await go('all', ['Harbour'], {
      onPage: (slug, run) => {
        if (slug === 'Boats') run.stop();
      },
    });
    expect(read).toEqual(['Harbour', 'Boats']);
    expect(final.stopReason).toBeNull();
    expect(final.status).toBe('finished');
    expect(final.pages).toHaveLength(2);
  });
});
