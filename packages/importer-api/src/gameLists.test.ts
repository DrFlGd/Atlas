import { describe, expect, it } from 'vitest';
import {
  GAMES_LIST_VALUE,
  MAX_LINK_PICTURES,
  MAX_LINK_WORDS,
  MAX_PAGE_LINKS,
  MAX_READER_CHARS,
  checkSiteRules,
  gamePageReader,
  gamesListReader,
  gamesListSpec,
  pageLinksOf,
  pageLinksSpec,
  readGamePage,
  readGamesList,
  type RulesMapPart,
} from './index';

const HOST = 'maps.example.com';

/** A made-up map part with one map page for each game and map, its list of games and each game's page. */
const PART = {
  type: 'map',
  reader: 'rules',
  start: '/maps/{game}/{map}',
  data: {
    from: 'values',
    values: { sheet: { element: 'script#chart-data', path: 'props.sheet' } },
  },
  game: { name: 'sheet.voyage' },
  maps: {
    path: 'sheet.chart',
    id: 'slug',
    name: 'title',
    size: ['width', 'height'],
    maxZoom: 'deepest',
    picture: { images: '/tiles/{map}/{z}/{x}/{y}.png', tile: 256 },
  },
  types: { from: 'locations' },
  locations: {
    path: 'sheet.chart.pins[*]',
    fields: { type: 'layer', x: 'across', y: 'depth' },
  },
  position: { units: 'pixels' },
  games: {
    address: '/maps',
    element: 'script#chart-data',
    path: 'props.voyages[*]',
    id: 'slug',
    name: 'title',
    only: { path: 'charts[*].preview', hosts: [HOST] },
  },
  gamePage: {
    address: '/maps/{game}',
    links: 'a.chart-card',
    name: 'h3',
    only: { picture: 'img', hosts: [HOST] },
  },
  reading: { ways: ['window'] },
};

/** A made-up file with one part. */
const file = (part: unknown) => ({
  format: 'atlas-site-rules',
  version: 1,
  site: { id: 'chart-maps', name: 'Chart Maps', hosts: [HOST] },
  parts: [part],
});

/** The part as the checker passes it. */
function checked(part: unknown = PART): RulesMapPart {
  const result = checkSiteRules(file(part));
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return (result.rules as { parts: RulesMapPart[] }).parts[0]!;
}

/** The problems of a part, by field. */
function problems(part: Record<string, unknown>): Record<string, string> {
  const result = checkSiteRules(file(part));
  if (result.ok) return {};
  return Object.fromEntries(result.problems.map((p) => [p.field, p.message]));
}

/** Expects each named field's problem to match its pattern. */
function expectProblems(got: Record<string, string>, expected: Record<string, RegExp>): void {
  for (const [field, pattern] of Object.entries(expected))
    expect(got[field], field).toMatch(pattern);
}

/** Runs a reader of no arguments in a made-up window, as the app's window would. */
function run(reader: string, window: Record<string, unknown>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const read = new Function('window', `return (${reader})();`) as (w: unknown) => unknown;
  return read(window);
}

/** A made-up list page's JSON: one game of the site's own maps, one of another site's, and entries it cannot use. */
const LIST = {
  props: {
    voyages: [
      {
        slug: 'harbour-tales',
        title: 'Harbour Tales',
        secret: 'never taken',
        charts: [
          { preview: 'https://charts.example.net/a.jpg', owner: 'never taken' },
          { preview: `https://${HOST}/previews/old-harbour.jpg` },
        ],
      },
      {
        slug: 'storm-coast',
        title: 'Storm Coast',
        charts: [{ preview: 'https://charts.example.net/b.jpg' }],
      },
      { slug: 'no way/in', title: 'Not a piece', charts: [{ preview: `https://${HOST}/c.jpg` }] },
      { slug: 'Harbour-Tales', title: 'Twice', charts: [{ preview: `https://${HOST}/d.jpg` }] },
      { title: 'No slug', charts: [{ preview: `https://${HOST}/e.jpg` }] },
    ],
  },
  session: 'never taken',
};

describe('the checker, for a list of games and a game’s page', () => {
  it('passes the made-up part, and refuses what does not fit', () => {
    expect(problems(PART)).toEqual({});
    expectProblems(problems({ ...PART, start: '/maps/{map}' }), {
      'parts[0].games': /\{game\} and \{map\}/u,
      'parts[0].gamePage': /\{game\} and \{map\}/u,
    });
    expectProblems(
      problems({
        ...PART,
        reading: { ways: ['fetch'] },
        data: { from: 'page', element: 'script#x' },
      }),
      { 'parts[0].games': /window/u },
    );
    const { gamePage: _page, ...withoutPage } = PART;
    expect(problems(withoutPage)['parts[0].games']).toMatch(/needs gamePage/u);
    expect(problems({ ...PART, games: { ...PART.games, address: '/maps/{game}' } })).toHaveProperty(
      'parts[0].games.address',
    );
    expect(
      problems({
        ...PART,
        games: { ...PART.games, address: 'https://elsewhere.example.org/maps' },
      }),
    ).toHaveProperty('parts[0].games.address');
    expect(problems({ ...PART, games: { ...PART.games, path: 'props.voyages' } })).toHaveProperty(
      'parts[0].games.path',
    );
    expectProblems(
      problems({ ...PART, games: { ...PART.games, only: { picture: 'img', hosts: [HOST] } } }),
      {
        'parts[0].games.only.path': /is needed/u,
        'parts[0].games.only.picture': /only for gamePage/u,
      },
    );
    expectProblems(
      problems({ ...PART, gamePage: { ...PART.gamePage, only: { path: 'x', hosts: [HOST] } } }),
      {
        'parts[0].gamePage.only.picture': /is needed/u,
        'parts[0].gamePage.only.path': /only for games.only/u,
      },
    );
    for (const address of ['/maps', '/maps/{game}/{map}', '/maps/{map}']) {
      expect(
        problems({ ...PART, gamePage: { ...PART.gamePage, address } }),
        address,
      ).toHaveProperty('parts[0].gamePage.address');
    }
    // `only` is a list of hosts and nothing else.
    expect(
      problems({ ...PART, games: { ...PART.games, only: { path: 'x', hosts: [HOST], when: 1 } } }),
    ).not.toEqual({});
    expect(
      problems({ ...PART, games: { ...PART.games, only: { path: 'x', hosts: [] } } }),
    ).not.toEqual({});
  });
});

describe('the list of games, read in the window', () => {
  it('takes the JSON of the element, and of it only the list and the fields its paths name', () => {
    const part = checked();
    const spec = gamesListSpec(part)!;
    expect(spec.values).toEqual([
      {
        name: GAMES_LIST_VALUE,
        from: [],
        call: 'element',
        element: 'script#chart-data',
        inside: [],
      },
    ]);
    const reader = gamesListReader(part)!;
    expect(reader.length).toBeLessThan(MAX_READER_CHARS);
    const text = JSON.stringify(LIST);
    const document = {
      readyState: 'complete',
      querySelector: (selector: string) =>
        selector === 'script#chart-data' ? { textContent: text } : null,
    };
    const got = run(reader, { document }) as { values: Record<string, unknown> };
    const taken = JSON.stringify(got.values[GAMES_LIST_VALUE]);
    expect(taken).toContain('harbour-tales');
    expect(taken).toContain('old-harbour.jpg');
    expect(taken).not.toContain('never taken');
    // While the page loads, or without the element, nothing is handed over.
    expect(run(reader, { document: { ...document, readyState: 'loading' } })).toBeNull();
    expect(
      run(reader, { document: { readyState: 'complete', querySelector: () => null } }),
    ).toBeNull();
    // A part without a list has no reader of it.
    const { games: _games, gamePage: _page, ...plain } = PART;
    expect(gamesListReader(checked(plain))).toBeNull();
  });

  it('keeps the games `only` keeps, each id once, and counts the others', () => {
    const part = checked();
    const read = readGamesList(part, { atlasPageValues: 1, values: { [GAMES_LIST_VALUE]: LIST } });
    expect(read).toEqual({
      games: [{ id: 'harbour-tales', name: 'Harbour Tales' }],
      notOnly: 1,
      unusable: 3,
    });
    // Without `only`, every usable game is listed; a game without a name is named by its id.
    const { only: _only, ...all } = PART.games;
    const named = { ...LIST, props: { voyages: [...LIST.props.voyages, { slug: 'quiet-bay' }] } };
    const every = readGamesList(checked({ ...PART, games: all }), {
      atlasPageValues: 1,
      values: { [GAMES_LIST_VALUE]: named },
    });
    expect('games' in every && every.games.map((g) => [g.id, g.name])).toEqual([
      ['harbour-tales', 'Harbour Tales'],
      ['storm-coast', 'Storm Coast'],
      ['quiet-bay', 'quiet-bay'],
    ]);
  });

  it('says plainly when the page held no list', () => {
    const part = checked();
    expect(readGamesList(part, null)).toEqual({
      problem: 'The page held no JSON in its element script#chart-data.',
    });
    expect(readGamesList(part, { atlasPageValues: 1, values: { [GAMES_LIST_VALUE]: {} } })).toEqual(
      {
        problem: 'The list of games (games.path, props.voyages[*]) found nothing in the page.',
      },
    );
  });
});

/** A made-up drawn link of a game's page. */
const link = (href: string, words: string, pictures: string[] = [`https://${HOST}/p.jpg`]) => ({
  href,
  words,
  pictures,
});

describe('a game’s page, read in the window', () => {
  /** A made-up drawn element. */
  const element = (fields: Record<string, unknown>, inside: Record<string, unknown[]> = {}) => ({
    ...fields,
    querySelector: (selector: string) => inside[selector]?.[0] ?? null,
    querySelectorAll: (selector: string) => inside[selector] ?? [],
  });

  it('takes the links its selector finds, their words and pictures, and nothing else', () => {
    const part = checked();
    expect(pageLinksSpec(part)).toEqual({ links: 'a.chart-card', name: 'h3', picture: 'img' });
    const reader = gamePageReader(part)!;
    expect(reader.length).toBeLessThan(MAX_READER_CHARS);
    const sources = Array.from(
      { length: MAX_LINK_PICTURES + 2 },
      (_, i) => `https://${HOST}/${i}.jpg`,
    );
    const pictures = sources.map((src) => element({ src }));
    const links = [
      element(
        { href: `https://${HOST}/maps/harbour-tales/old-harbour`, textContent: 'ignored' },
        { h3: [element({ textContent: '  Old\n Harbour ' })], img: pictures },
      ),
      element({ href: '', textContent: 'no address' }),
      element({ href: `https://${HOST}/maps/harbour-tales/reef`, textContent: 'x'.repeat(500) }),
    ];
    const document = {
      readyState: 'complete',
      querySelectorAll: (selector: string) => (selector === 'a.chart-card' ? links : []),
      cookie: 'never taken',
    };
    const got = pageLinksOf(run(reader, { document, performance: { now: () => 60_000 } }))!;
    expect(got.links).toHaveLength(2);
    expect(got.links[0]).toEqual({
      href: `https://${HOST}/maps/harbour-tales/old-harbour`,
      words: 'Old Harbour',
      pictures: sources.slice(0, MAX_LINK_PICTURES),
    });
    expect(got.links[1]!.words).toHaveLength(MAX_LINK_WORDS);
    expect(JSON.stringify(got)).not.toContain('never taken');
  });

  it('waits while the page loads, or finds no link before it has been open long enough', () => {
    const reader = gamePageReader(checked())!;
    const empty = { readyState: 'complete', querySelectorAll: () => [] };
    expect(run(reader, { document: { ...empty, readyState: 'loading' } })).toBeNull();
    expect(run(reader, { document: empty, performance: { now: () => 1000 } })).toBeNull();
    expect(run(reader, { document: empty, performance: { now: () => 60_000 } })).toEqual({
      atlasPageLinks: 1,
      links: [],
    });
  });

  it('checks what is handed over, within its bounds', () => {
    expect(pageLinksOf(null)).toBeNull();
    expect(pageLinksOf({ atlasPageLinks: 2, links: [] })).toBeNull();
    const many = Array.from({ length: MAX_PAGE_LINKS + 5 }, (_, i) =>
      link(`https://${HOST}/maps/a/m${i}`, 'M'),
    );
    expect(pageLinksOf({ atlasPageLinks: 1, links: many })!.links).toHaveLength(MAX_PAGE_LINKS);
    expect(
      pageLinksOf({ atlasPageLinks: 1, links: [{ href: 7 }, { href: 'x', pictures: [1, 'y'] }] }),
    ).toEqual({ atlasPageLinks: 1, links: [{ href: 'x', words: '', pictures: ['y'] }] });
  });

  it('keeps each map page of the game once, on the site’s hosts, that `only` keeps', () => {
    const part = checked();
    const given = {
      atlasPageLinks: 1,
      links: [
        link(`https://${HOST}/maps/harbour-tales/old-harbour?at=4#top`, 'Old Harbour'),
        link(`https://${HOST}/maps/harbour-tales/old-harbour`, 'Again'),
        link(`https://www.${HOST}/maps/Harbour-Tales/reef`, ''),
        link(`https://${HOST}/maps/harbour-tales/storm`, 'Storm', [
          'https://charts.example.net/s.jpg',
        ]),
        link(`https://${HOST}/maps/harbour-tales/fog`, 'Fog', []),
        link(`https://${HOST}/maps/storm-coast/cliffs`, 'Another game'),
        link(`https://elsewhere.example.org/maps/harbour-tales/x`, 'Another site'),
        link(`http://${HOST}/maps/harbour-tales/plain`, 'Not https'),
        link(`https://${HOST}/maps/harbour-tales`, 'The game itself'),
        link('not an address', 'Broken'),
      ],
    };
    const read = readGamePage(part, given, 'harbour-tales', [HOST]);
    expect(read).toEqual({
      maps: [
        {
          url: `https://${HOST}/maps/harbour-tales/old-harbour`,
          map: 'old-harbour',
          name: 'Old Harbour',
        },
        { url: `https://www.${HOST}/maps/Harbour-Tales/reef`, map: 'reef', name: 'reef' },
      ],
      notOnly: 2,
      other: 5,
    });
    // Without `only`, every map page of the game is kept.
    const { only: _only, ...plain } = PART.gamePage;
    const every = readGamePage(checked({ ...PART, gamePage: plain }), given, 'harbour-tales', [
      HOST,
    ]);
    expect('maps' in every && every.maps.map((m) => m.map)).toEqual([
      'old-harbour',
      'reef',
      'storm',
      'fog',
    ]);
    expect(readGamePage(part, { nope: 1 }, 'harbour-tales', [HOST])).toEqual({
      problem: 'What the game’s page gave is not its links.',
    });
  });
});
