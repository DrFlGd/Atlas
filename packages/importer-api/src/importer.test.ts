import { describe, expect, it } from 'vitest';
import demo from '../demo/demo-importer.js';
import {
  MAX_CATALOGUE_GAMES,
  MAX_LISTED_PAGES,
  PICTURE_MAX_REQUESTS,
  PICTURE_MAX_ZOOM,
  asImporter,
  canAddPage,
  checkCatalogue,
  checkGameListing,
  checkOutcome,
  checkPictureTiles,
  findCatalogueImporter,
  findGameImporter,
  findImporter,
  gameAddressOf,
  isAllowedPageUrl,
  isAllowedPictureTemplate,
  isPictureRequest,
  pageKey,
  sameSite,
  type AtlasImporter,
  type ImportContext,
  type PictureTilesRequest,
  type SavedSource,
} from './index';

const page = (
  map: string,
  places: { id: number; kind: string }[] = [{ id: 1, kind: 'beacon' }],
) => ({
  world: { slug: 'test-valley', name: 'Test Valley' },
  map: {
    slug: map,
    name: `Map ${map}`,
    width: 1024,
    height: 768,
    maxZoom: 2,
    tiles: `http://127.0.0.1:4432/tiles/${map}/{z}/{x}/{y}.png`,
  },
  places: places.map((p) => ({ ...p, name: `Place ${p.id}`, x: 10 * p.id, y: 20 })),
});

function context(saved: SavedSource[] = [], bundled: string[] = []): ImportContext {
  return {
    url: 'http://127.0.0.1:4432/demo-maps/test-valley/east',
    importedAt: '2026-11-10T12:00:00Z',
    app: { name: 'Atlas', version: '0.3.0' },
    savedSources: () => Promise.resolve(saved),
    existingPack: () => Promise.resolve(null),
    isBundled: (id) => bundled.includes(id),
  };
}

describe('page URLs', () => {
  it('accepts https and loopback http only', () => {
    expect(isAllowedPageUrl('https://maps.example.com/a/b')).toBe(true);
    expect(isAllowedPageUrl(' http://127.0.0.1:4432/x ')).toBe(true);
    expect(isAllowedPageUrl('http://localhost/x')).toBe(true);
    for (const bad of [
      'http://example.com/',
      'http://127.0.0.2/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'ftp://example.com/',
      'https://user:secret@example.com/',
      'not a url',
      '',
    ]) {
      expect(isAllowedPageUrl(bad), bad).toBe(false);
    }
  });

  it('finds the importer that recognises a URL', () => {
    const throwing = {
      matches: () => {
        throw new Error('boom');
      },
    };
    expect(findImporter([throwing, demo], 'http://127.0.0.1:4432/demo-maps/w/m')).toBe(demo);
    expect(findImporter([demo], 'http://127.0.0.1:4432/elsewhere')).toBeNull();
    expect(findImporter([demo], 'http://example.com/demo-maps/w/m')).toBeNull();
  });
});

describe('importer modules', () => {
  it('accepts the demo importer', () => {
    expect(asImporter(demo).id).toBe('demo-maps');
  });

  it('rejects modules that do not follow the contract', () => {
    expect(() => asImporter({ ...demo, id: 'Bad Id' })).toThrow(/not an Atlas importer/);
    expect(() => asImporter({ ...demo, apiVersion: 2 })).toThrow();
    expect(() => asImporter({ ...demo, convert: 'nope' })).toThrow();
    expect(() => asImporter({ ...demo, pageReader: 'x'.repeat(70_000) })).toThrow();
    expect(() => asImporter(null)).toThrow();
  });
});

describe('the demo importer', () => {
  it('reads only what it needs from the page', () => {
    // Evaluates the reader's source text, as the app does in the page.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const reader = new Function(`return (${demo.pageReader})();`) as () => unknown;
    const site = { ...page('east'), loaded: true, account: { token: 'secret' } };
    (globalThis as Record<string, unknown>).demoMaps = undefined;
    expect(reader()).toBeNull();
    (globalThis as Record<string, unknown>).demoMaps = site;
    const data = reader();
    expect(JSON.stringify(data)).not.toContain('secret');
    expect(data).toEqual(page('east'));
    delete (globalThis as Record<string, unknown>).demoMaps;
  });

  it('builds a valid pack and merges maps of one world', async () => {
    const first = checkOutcome(await demo.convert(page('east'), context()));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.packId).toBe('test-valley');
    expect(first.summary).toMatchObject({ maps: 1, locations: 1, refreshed: false });

    const saved: SavedSource[] = [
      { key: 'east', url: 'u', importedAt: '2026-11-10T12:00:00Z', data: page('east') },
    ];
    const second = checkOutcome(
      await demo.convert(
        page('west', [
          { id: 1, kind: 'camp' },
          { id: 2, kind: 'cave' },
        ]),
        context(saved),
      ),
    );
    expect(second.ok && second.pack.maps.map((m) => m.id)).toEqual([
      'test-valley:map:east',
      'test-valley:map:west',
    ]);
    expect(second.ok && second.summary).toMatchObject({ maps: 2, locations: 3, mapLocations: 2 });

    // The same map again refreshes it in place and keeps its ids.
    saved.push({ key: 'west', url: 'u', importedAt: 't', data: page('west') });
    const again = checkOutcome(
      await demo.convert(
        page('east', [
          { id: 1, kind: 'beacon' },
          { id: 9, kind: 'beacon' },
        ]),
        context(saved),
      ),
    );
    expect(again.ok && again.pack.maps.map((m) => m.id)).toEqual([
      'test-valley:map:east',
      'test-valley:map:west',
    ]);
    expect(again.ok && again.summary.refreshed).toBe(true);
    expect(again.ok && again.pack.locations.map((l) => l.id)).toContain('test-valley:loc:east-1');
  });

  it('explains data in the wrong shape and bundled games', async () => {
    const wrong = await demo.convert({ world: 'x' }, context());
    expect(wrong).toEqual({
      ok: false,
      message: expect.stringMatching(/expected shape/) as string,
    });
  });

  it('refreshes a world that comes with the app, keeping its ids', async () => {
    const saved: SavedSource[] = [
      { key: 'east', url: 'u', importedAt: 't', data: page('east') },
      { key: 'west', url: 'u', importedAt: 't', data: page('west') },
    ];
    const outcome = checkOutcome(
      await demo.convert(page('east', [{ id: 1, kind: 'camp' }]), context(saved, ['test-valley'])),
    );
    expect(demo.refreshesBundledGames).toBe(true);
    expect(outcome.ok && outcome.pack.maps.map((m) => m.id)).toEqual([
      'test-valley:map:east',
      'test-valley:map:west',
    ]);
    expect(outcome.ok && outcome.summary.refreshed).toBe(true);
  });
});

describe('checklist pages', () => {
  const list = (rows: [string, number][]) => ({
    world: { slug: 'test-valley', name: 'Test Valley' },
    checklist: {
      slug: 'beacons',
      name: ' All beacons ',
      rows: rows.map(([map, place]) => ({ map, place, name: `${map} ${place}` })),
    },
  });

  it('adds a checklist to a world with maps, leaving out rows of maps not added', async () => {
    const none = await demo.convert(list([['east', 1]]), context());
    expect(none.ok).toBe(false);
    expect(!none.ok && none.message).toMatch(/Add its maps first/);

    const saved: SavedSource[] = [{ key: 'east', url: 'u', importedAt: 't', data: page('east') }];
    const outcome = checkOutcome(
      await demo.convert(
        list([
          ['east', 1],
          ['east', 1],
          ['west', 1],
        ]),
        context(saved),
      ),
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.mapId).toBeUndefined();
    expect(outcome.checklistId).toBe('test-valley:checklist:beacons');
    expect(outcome.sourceKey).toBe('checklist-beacons');
    expect(outcome.summary).toMatchObject({
      map: 'All beacons',
      checklist: { items: 1, leftOut: 1 },
    });
    expect(outcome.pack.checklistItems).toEqual([
      {
        id: 'test-valley:checkitem:beacons-east-1',
        checklistId: 'test-valley:checklist:beacons',
        name: 'east 1',
        order: 0,
        locationIds: ['test-valley:loc:east-1'],
        entityIds: [],
      },
    ]);

    // The checklist stays when another map is added, and gains the rows of that map.
    saved.push({
      key: 'checklist-beacons',
      url: 'u',
      importedAt: 't',
      data: list([
        ['east', 1],
        ['west', 1],
      ]),
    });
    const map = checkOutcome(await demo.convert(page('west'), context(saved)));
    expect(map.ok && map.pack.checklistItems.map((item) => item.id)).toEqual([
      'test-valley:checkitem:beacons-east-1',
      'test-valley:checkitem:beacons-west-1',
    ]);
  });

  it('checks that an outcome names a map or a checklist of its pack', async () => {
    const good = await demo.convert(page('east'), context());
    if (!good.ok) throw new Error('expected a pack');
    const { mapId: _mapId, ...withoutMap } = good;
    expect(checkOutcome(withoutMap)).toMatchObject({
      ok: false,
      message: /either the map or the checklist/,
    });
    expect(checkOutcome({ ...good, checklistId: 'test-valley:checklist:x' })).toMatchObject({
      ok: false,
    });
    expect(checkOutcome({ ...withoutMap, checklistId: 'test-valley:checklist:x' })).toMatchObject({
      ok: false,
      message: /checklist that is not in its pack/,
    });
  });
});

describe('outcome checks', () => {
  it('refuses packs that fail the schema or do not fit together', async () => {
    const good = await demo.convert(page('east'), context());
    if (!good.ok) throw new Error('expected a pack');
    expect(checkOutcome({ ...good, pack: { ...good.pack, maps: 'none' } })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expected shape/) as string,
    });
    const broken = structuredClone(good.pack);
    broken.locations[0]!.categoryId = 'test-valley:cat:missing';
    expect(checkOutcome({ ...good, pack: broken })).toMatchObject({ ok: false });
    expect(checkOutcome({ ...good, packId: 'other' })).toMatchObject({ ok: false });
    expect(checkOutcome({ ...good, mapId: 'test-valley:map:nowhere' })).toMatchObject({
      ok: false,
    });
    expect(checkOutcome({ ...good, sourceKey: '../x' })).toMatchObject({ ok: false });
    expect(checkOutcome('text')).toMatchObject({ ok: false });
    expect(checkOutcome({ ok: false, message: 'Plain reason.' })).toEqual({
      ok: false,
      message: 'Plain reason.',
    });
  });

  it('refuses remote tile sources that are not https or loopback', async () => {
    const outcome = await demo.convert(
      {
        ...page('east'),
        map: { ...page('east').map, tiles: 'http://example.com/{z}/{x}/{y}.png' },
      },
      context(),
    );
    expect(checkOutcome(outcome).ok).toBe(false);
  });

  it('takes a summary that says how the picture was sized, and nothing else new', async () => {
    const good = await demo.convert(page('east'), context());
    if (!good.ok) throw new Error('expected a pack');
    const measured = {
      ...good,
      summary: { ...good.summary, picture: { measured: true, tiles: 6 } },
    };
    expect(checkOutcome(measured)).toMatchObject({
      ok: true,
      summary: { picture: { measured: true, tiles: 6 } },
    });
    const estimated = {
      ...good,
      summary: {
        ...good.summary,
        picture: { measured: false, note: 'The picture could not be measured.' },
      },
    };
    expect(checkOutcome(estimated).ok).toBe(true);
    for (const picture of [
      { measured: 'yes' },
      { measured: true, tiles: -1 },
      { measured: false, note: '' },
      { measured: true, size: 3 },
    ]) {
      expect(checkOutcome({ ...good, summary: { ...good.summary, picture } }).ok).toBe(false);
    }
    expect(checkOutcome({ ...good, summary: { ...good.summary, other: 1 } }).ok).toBe(false);
  });
});

describe('measuring a picture', () => {
  const template = 'https://tiles.example.com/set/{z}/{x}/{y}.jpg';
  const request: PictureTilesRequest = { urlTemplate: template, zoom: 3, start: [4, 2] };

  it('allows https and loopback http image addresses without user names', () => {
    expect(isAllowedPictureTemplate(template)).toBe(true);
    expect(isAllowedPictureTemplate('https://tiles.example.com/{z}/{y}/{x}.webp')).toBe(true);
    expect(isAllowedPictureTemplate('http://127.0.0.1:4492/t/{z}/{x}/{y}.png')).toBe(true);
    for (const bad of [
      'http://tiles.example.com/{z}/{x}/{y}.png',
      'https://user:secret@tiles.example.com/{z}/{x}/{y}.png',
      'http://localhost:80@tiles.example.com/{z}/{x}/{y}.png',
      'https://tiles.example.com/{z}/{x}.png',
      'ftp://localhost/{z}/{x}/{y}.png',
      '',
    ]) {
      expect(isAllowedPictureTemplate(bad), bad).toBe(false);
    }
  });

  it('checks a request: the address, the zoom and a start tile inside the world', () => {
    expect(isPictureRequest(request)).toBe(true);
    expect(isPictureRequest({ ...request, cachedOnly: true })).toBe(true);
    expect(isPictureRequest({ ...request, zoom: 0, start: [0, 0] })).toBe(true);
    for (const bad of [
      null,
      'text',
      { ...request, urlTemplate: 'http://example.com/{z}/{x}/{y}' },
      { ...request, zoom: -1 },
      { ...request, zoom: PICTURE_MAX_ZOOM + 1 },
      { ...request, zoom: 1.5 },
      { ...request, start: [8, 0] },
      { ...request, start: [0, -1] },
      { ...request, start: [0] },
      { ...request, cachedOnly: 'yes' },
    ]) {
      expect(isPictureRequest(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('checks an answer against the request', () => {
    const answer = {
      zoom: 3,
      present: [
        [4, 2],
        [5, 2],
      ],
      absent: [[3, 2]],
      complete: true,
    };
    expect(checkPictureTiles(answer, request)).toEqual(answer);
    expect(checkPictureTiles(null, request)).toBeNull();
    for (const bad of [
      { ...answer, zoom: 4 },
      { ...answer, present: [[5, 2]] },
      {
        ...answer,
        present: [
          [4, 2],
          [8, 2],
        ],
      },
      {
        ...answer,
        present: [
          [4, 2],
          [4, 2],
        ],
      },
      { ...answer, absent: [[4, 2]] },
      { ...answer, complete: 'yes' },
      { ...answer, extra: true },
      { ...answer, present: [] },
    ]) {
      expect(checkPictureTiles(bad, request), JSON.stringify(bad)).toBeNull();
    }
  });

  it('is optional: an importer is handed a context with or without it', async () => {
    const asked: PictureTilesRequest[] = [];
    const withPicture: ImportContext = {
      ...context(),
      pictureTiles: (r) => {
        asked.push(r);
        return Promise.resolve(null);
      },
    };
    // The demo importer never measures; it works the same either way.
    const without = await demo.convert(page('east'), context());
    const withIt = await demo.convert(page('east'), withPicture);
    expect(withIt).toEqual(without);
    expect(asked).toEqual([]);
    expect('pictureTiles' in context()).toBe(false);
    expect(PICTURE_MAX_REQUESTS).toBe(256);
  });
});

describe("listing a game's pages and a site's games", () => {
  const site = 'http://127.0.0.1:4432/demo-maps';
  const game = `${site}/test-valley`;
  const listed = (pages: unknown[], name: unknown = 'Test Valley') => ({
    ok: true,
    game: name,
    pages,
  });
  const map = (slug: string, title = `Map ${slug}`) => ({
    url: `${game}/${slug}`,
    kind: 'map',
    title,
  });

  it('accepts importers with the capabilities, and only a catalogue with game pages', () => {
    expect(asImporter(demo).games).toBeDefined();
    expect(asImporter(demo).catalogue?.address).toBe(site);
    const { games: _games, ...withoutGames } = demo;
    expect(() => asImporter(withoutGames)).toThrow(/catalogue/);
    expect(() => asImporter({ ...demo, games: { ...demo.games, pageReader: '' } })).toThrow();
    expect(() =>
      asImporter({ ...demo, catalogue: { ...demo.catalogue, address: 'ftp://x/' } }),
    ).toThrow();
    expect(() => asImporter({ ...demo, refreshesBundledGames: 'yes' })).toThrow();
    // Importers without them keep working.
    const { games: _g, catalogue: _c, refreshesBundledGames: _r, ...plain } = demo;
    expect(asImporter(plain).games).toBeUndefined();
  });

  it('finds the importer of a game address or a list of games', () => {
    expect(findGameImporter([demo], game)).toBe(demo);
    expect(findGameImporter([demo], `${game}/east-field`)).toBeNull();
    expect(findGameImporter([demo], 'http://example.com/demo-maps/x')).toBeNull();
    expect(findCatalogueImporter([demo], `${site}/`)).toBe(demo);
    expect(findCatalogueImporter([demo], game)).toBeNull();
    const throwing = {
      games: {
        ...demo.games!,
        matches: () => {
          throw new Error('boom');
        },
      },
    };
    expect(findGameImporter([throwing], game)).toBeNull();
  });

  it('checks a game listing', () => {
    const good = checkGameListing(
      listed([
        map('east'),
        { ...map('west'), title: '  West  ', group: ' Extra ' },
        {
          url: `${game}/guides/start`,
          kind: 'guides',
          title: 'Start',
        },
      ]),
      game,
      demo,
    );
    expect(good).toEqual({
      ok: true,
      game: 'Test Valley',
      pages: [
        map('east'),
        { ...map('west'), title: 'West', group: 'Extra' },
        { url: `${game}/guides/start`, kind: 'guides', title: 'Start' },
      ],
    });
    const bad: [unknown, RegExp][] = [
      [
        listed([{ ...map('a'), url: 'https://elsewhere.example.com/demo-maps/test-valley/a' }]),
        /not a page on the site/,
      ],
      [
        listed([{ ...map('a'), url: 'http://127.0.0.1:4433/demo-maps/test-valley/a' }]),
        /not a page on the site/,
      ],
      [listed([{ ...map('a'), url: 'javascript:alert(1)' }]), /not a page on the site/],
      [listed([map('a'), { ...map('a'), url: `${game}/a/` }]), /listed twice/],
      [listed([{ ...map('a'), url: `${game}/guides/x` }]), /does not read it/],
      [listed([{ ...map('a'), kind: 'Not A Word' }]), /unexpected|cannot use/],
      [listed([{ ...map('a'), title: '' }]), /cannot use/],
      [listed([{ ...map('a'), extra: 1 }]), /cannot use/],
      [listed([map('a')], ''), /cannot use/],
      [listed(Array.from({ length: MAX_LISTED_PAGES + 1 }, (_, i) => map(`m${i}`))), /cannot use/],
      ['text', /cannot use/],
    ];
    for (const [value, message] of bad) {
      const outcome = checkGameListing(value, game, demo);
      expect(outcome.ok, JSON.stringify(value).slice(0, 100)).toBe(false);
      expect(!outcome.ok && outcome.message).toMatch(message);
    }
    expect(checkGameListing({ ok: false, message: 'No list here.' }, game, demo)).toEqual({
      ok: false,
      message: 'No list here.',
    });
    expect(checkGameListing(listed([]), game, demo)).toEqual({
      ok: true,
      game: 'Test Valley',
      pages: [],
    });
  });

  it('checks a catalogue', () => {
    const games = (list: unknown[]) => ({ ok: true, games: list });
    expect(
      checkCatalogue(
        games([
          { id: 'test-valley', name: ' Test Valley ', address: game, search: ' tv ' },
          { id: 'test-hills', name: 'Test Hills', address: `${site}/test-hills/high-pass` },
        ]),
        site,
        demo,
      ),
    ).toEqual({
      ok: true,
      games: [
        { id: 'test-valley', name: 'Test Valley', address: game, search: 'tv' },
        { id: 'test-hills', name: 'Test Hills', address: `${site}/test-hills/high-pass` },
      ],
    });
    const bad: unknown[] = [
      games([{ id: 'a', name: 'A', address: 'https://elsewhere.example.com/demo-maps/a' }]),
      games([{ id: 'a', name: 'A', address: `${site}/a/guides/x` }]),
      games([{ id: 'Bad Id', name: 'A', address: `${site}/a` }]),
      games([
        { id: 'a', name: 'A', address: `${site}/a` },
        { id: 'a', name: 'B', address: `${site}/b` },
      ]),
      games(
        Array.from({ length: MAX_CATALOGUE_GAMES + 1 }, (_, i) => ({
          id: `g${i}`,
          name: 'G',
          address: `${site}/g${i}`,
        })),
      ),
      { ok: true },
    ];
    for (const value of bad) expect(checkCatalogue(value, site, demo).ok).toBe(false);
  });

  it('gives the game address of a map page only when it is usable', () => {
    expect(gameAddressOf(demo, `${game}/east-field`)).toBe(game);
    const lying = (address: string): Pick<AtlasImporter, 'games'> => ({
      games: { ...demo.games!, gameAddress: () => address },
    });
    expect(
      gameAddressOf(lying('https://elsewhere.example.com/demo-maps/x'), `${game}/a`),
    ).toBeNull();
    expect(gameAddressOf(lying(`${game}/east-field`), `${game}/a`)).toBeNull();
    expect(
      gameAddressOf({ games: { ...demo.games!, gameAddress: undefined } }, `${game}/a`),
    ).toBeNull();
    expect(gameAddressOf({}, `${game}/a`)).toBeNull();
  });

  it('compares sites and pages', () => {
    expect(sameSite('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameSite('https://example.com/a', 'https://cdn.example.com/b')).toBe(true);
    expect(sameSite('https://example.com/a', 'http://example.com/b')).toBe(false);
    expect(sameSite('https://example.com/a', 'https://example.com.evil.net/b')).toBe(false);
    expect(sameSite('nonsense', 'https://example.com/')).toBe(false);
    expect(pageKey('https://www.Example.com/a/b/?x=1#y')).toBe(pageKey('https://example.com/a/b'));
    expect(canAddPage(demo, `${game}/east`)).toBe(true);
    expect(canAddPage(demo, `${game}/guides/x`)).toBe(false);
  });

  it("lists a demo world's pages and the demo worlds from their links", async () => {
    const links = (list: [string, string][]) => ({
      heading: 'Test Valley',
      links: list.map(([href, text]) => ({ href, text })),
    });
    const listing = checkGameListing(
      await demo.games!.convert(
        links([
          [`${game}/east-field`, 'East Field'],
          [`${game}/west-ridge/`, ''],
          [`${game}/east-field`, 'East Field again'],
          [`${game}/guides/getting-started`, 'Getting started'],
          [`${site}/test-hills/high-pass`, 'Another world'],
          ['https://elsewhere.example.com/demo-maps/test-valley/x', 'Elsewhere'],
        ]),
        { url: game, app: { name: 'Atlas', version: '0' } },
      ),
      game,
      demo,
    );
    expect(listing).toEqual({
      ok: true,
      game: 'Test Valley',
      pages: [
        { url: `${game}/east-field`, kind: 'map', title: 'East Field' },
        { url: `${game}/west-ridge`, kind: 'map', title: 'West ridge' },
        { url: `${game}/guides/getting-started`, kind: 'guides', title: 'Getting started' },
      ],
    });
    const catalogue = checkCatalogue(
      await demo.catalogue!.convert(
        links([
          [game, 'Test Valley'],
          [`${site}/test-hills/high-pass`, 'Test Hills'],
          [`${game}/east-field`, 'Again'],
          ['https://elsewhere.example.com/demo-maps/x', 'Elsewhere'],
        ]),
        { url: site, app: { name: 'Atlas', version: '0' } },
      ),
      site,
      demo,
    );
    expect(catalogue.ok && catalogue.games.map((g) => [g.id, g.address])).toEqual([
      ['test-valley', game],
      ['test-hills', `${site}/test-hills/high-pass`],
    ]);
    expect(
      (await demo.games!.convert('nonsense', { url: game, app: { name: 'A', version: '0' } })).ok,
    ).toBe(false);
  });

  it('reads links only once the page says it is ready', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const reader = new Function(`return (${demo.games!.pageReader})();`) as () => unknown;
    const anchors = [{ href: `${game}/east-field`, textContent: ' East Field ' }];
    const body = { dataset: { ready: 'no' } };
    (globalThis as Record<string, unknown>).document = {
      body,
      querySelectorAll: () => anchors,
      querySelector: () => ({ textContent: 'Test Valley' }),
    };
    expect(reader()).toBeNull();
    body.dataset.ready = 'yes';
    expect(reader()).toEqual({
      heading: 'Test Valley',
      links: [{ href: `${game}/east-field`, text: 'East Field' }],
    });
    delete (globalThis as Record<string, unknown>).document;
  });
});
