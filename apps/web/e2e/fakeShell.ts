import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { downloadsEnabled } from '../tooling/buildFlags.ts';

/**
 * A stand-in for the desktop shell, for the "Add a map" tests: the page
 * gets a fake `__TAURI_INTERNALS__.invoke` whose import window hands over
 * made-up page data for the made-up demo importer
 * (`packages/importer-api/demo/demo-importer.js`), which the tests serve as
 * the build's one importer. Nothing is opened and no site is asked for
 * anything; the real import window is covered by the desktop tests.
 *
 * The made-up site has, for each world, map pages
 * (`/demo-maps/<world>/<map>`), checklist pages
 * (`/demo-maps/<world>/checklists/<slug>`), guide pages (which the demo
 * importer does not read), a game page (`/demo-maps/<world>`) that links
 * to all of them, and a list of worlds (`/demo-maps`).
 */

/** The app under test was built with map image downloads (run with the build's `ATLAS_ENABLE_DOWNLOADS`). */
export const DOWNLOADS_BUILD = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);

export const SITE = 'https://maps.example.com/demo-maps';
const PACKS = 'http://atlas-pack.localhost/';
const IMPORTER = new URL('../../../packages/importer-api/demo/demo-importer.js', import.meta.url);
const WIKI_IMPORTER = new URL(
  '../../../packages/importer-api/demo/example-wiki-importer.js',
  import.meta.url,
);

/** The made-up Example Wiki that `example-wiki-importer.js` reads, answered by `import_fetch`. */
export const WIKI = 'https://wiki.example.org/wiki';

export interface WikiSite {
  /** The contents: each heading's pages, by slug. */
  headings: { title: string; pages: string[] }[];
  /** Every page there is, by slug: its title, its text and the slugs it links to. */
  pages: Record<string, { title: string; body: string; links?: string[] }>;
  /** Slugs the site answers with 503 ("busy, try later"), which stops a go. */
  busy?: string[];
}

export const EXAMPLE_WIKI: WikiSite = {
  headings: [
    { title: 'Basics', pages: ['Welcome', 'Bells', 'Gates'] },
    { title: 'Sights', pages: ['Harbour', 'Lighthouse', 'Missing'] },
  ],
  pages: {
    Welcome: {
      title: 'Welcome',
      body: 'The isle has [bells](Bells) and [gates](Gates).',
      links: ['Bells', 'Gates', 'Old_bell', 'Rusty_gate'],
    },
    Bells: { title: 'Bells', body: 'Ring every bell once.' },
    Gates: { title: 'Gates', body: 'Gates open at dusk.' },
    Harbour: { title: 'Harbour', body: 'Boats leave at dawn.' },
    Lighthouse: { title: 'Lighthouse', body: 'The light turns all night.' },
    Old_bell: { title: 'Old bell', body: 'It is cracked.' },
    Rusty_gate: { title: 'Rusty gate', body: 'It squeaks.' },
  },
};

export interface World {
  name: string;
  maps: Record<string, string>;
  /** Checklist pages: rows name a place (1 or 2) of one of the world's maps. */
  checklists?: Record<
    string,
    { name: string; rows: { map: string; place: number; name: string }[] }
  >;
  /** Guide pages, which the demo importer cannot add. */
  guides?: Record<string, string>;
}

/** The made-up site's worlds, by slug. */
export const WORLDS: Record<string, World> = {
  'test-valley': {
    name: 'Test Valley',
    maps: { 'east-field': 'East Field', 'west-ridge': 'West Ridge' },
    checklists: {
      beacons: {
        name: 'Every beacon',
        rows: [
          { map: 'east-field', place: 1, name: 'East Field beacon' },
          { map: 'west-ridge', place: 1, name: 'West Ridge beacon' },
        ],
      },
    },
    guides: { 'where-to-start': 'Where to start' },
  },
  'test-hills': { name: 'Test Hills', maps: { 'high-pass': 'High Pass' } },
  demo: { name: 'Demo again', maps: { plain: 'Plain' } },
};

interface ShellEvent {
  what: 'open' | 'close' | 'poll' | 'fetch';
  url: string | null;
  at: number;
  purpose?: string;
}

export interface MockShell {
  events: ShellEvent[];
  /** Slugs (the last part of the address) whose page keeps waiting until taken out of here. */
  hold: string[];
  /** Slugs whose window the person closes. */
  close: string[];
  /** Maps the site has added since, by world: their game page lists them too. */
  extra: Record<string, Record<string, string>>;
  reports: {
    outcome: string;
    message?: string;
    pages?: string[];
    run?: Record<string, number>;
    kinds?: Record<string, number>;
    alreadyAdded?: number;
    games?: number;
    update?: boolean;
  }[];
}

/**
 * Stands in for the shell: the import window's commands, the library and
 * saving. A page of map `never` never hands over data; `broken` hands over
 * data in the wrong shape; the others after two polls, unless held.
 */
function installFakeShell({
  worlds,
  downloads,
  wiki,
}: {
  worlds: Record<string, World>;
  downloads: boolean;
  wiki: WikiSite | null;
}) {
  const shell: MockShell = { events: [], hold: [], close: [], extra: {}, reports: [] };
  (window as unknown as { __mockShell: MockShell }).__mockShell = shell;
  const write = (
    window as unknown as { __writePack: (id: string, files: unknown) => Promise<void> }
  ).__writePack;
  let current: { url: string; polls: number } | null = null;
  const packs: Record<string, unknown>[] = [];
  const sources: Record<
    string,
    { key: string; url: string; importedAt: string; mapId?: string; data: string }[]
  > = {};
  // What each pack written holds, and the pages it was made from, for the Library's facts.
  const contents: Record<string, Record<string, number>> = {};
  const written: Record<string, { url: string; mapId?: string; importedAt?: string }[]> = {};
  const listing = () => ({
    mapsFolder: { path: '/maps', isDefault: true, exists: true },
    packs: structuredClone(packs),
    hidden: [],
    locations: [],
    busy: [],
  });
  const mapsOf = (world: string) => ({ ...worlds[world]?.maps, ...shell.extra[world] });
  const mapData = (world: string, map: string) => {
    const site = worlds[world];
    const maps = mapsOf(world);
    const slug = map === 'broken' ? (Object.keys(maps)[0] ?? map) : map;
    const name = maps[slug];
    if (!site || !name || map === 'never') return null;
    return {
      world: { slug: world, name: site.name },
      map: {
        slug,
        name,
        width: 512,
        height: 512,
        maxZoom: 1,
        tiles: `https://tiles.example.com/${slug}/{z}/{x}/{y}.png`,
      },
      places:
        map === 'broken'
          ? [{ id: 'one', name: '', kind: 1, x: 'a', y: null }]
          : [
              { id: 1, name: `${name} beacon`, kind: 'beacon', x: 100, y: 120 },
              { id: 2, name: `${name} camp`, kind: 'camp', x: 400, y: 300 },
            ],
    };
  };
  const pageData = (address: string) => {
    const url = new URL(address);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'demo-maps') return null;
    const [, world = '', second, third] = parts;
    const site = worlds[world];
    const base = `${url.origin}/demo-maps`;
    if (parts.length === 1) {
      // The list of worlds: a world with one map links straight to it.
      return {
        heading: 'Demo map site',
        links: [
          ...Object.entries(worlds).map(([slug, other]) => {
            const maps = Object.keys(other.maps);
            return {
              href: maps.length === 1 ? `${base}/${slug}/${maps[0]}` : `${base}/${slug}`,
              text: other.name,
            };
          }),
          { href: 'https://elsewhere.example.org/demo-maps/far-away', text: 'Far away' },
        ],
      };
    }
    if (!site) return null;
    if (parts.length === 2) {
      // A game page: its maps, checklists and guides, and a link to another world.
      return {
        heading: site.name,
        links: [
          { href: `${base}/test-hills`, text: 'Test Hills' },
          ...Object.keys(site.guides ?? {}).map((slug) => ({
            href: `${base}/${world}/guides/${slug}`,
            text: site.guides![slug]!,
          })),
          ...Object.entries(mapsOf(world)).map(([slug, name]) => ({
            href: `${base}/${world}/${slug}`,
            text: name,
          })),
          ...Object.entries(site.checklists ?? {}).map(([slug, list]) => ({
            href: `${base}/${world}/checklists/${slug}/`,
            text: list.name,
          })),
          // The same map twice, as sites do.
          ...Object.keys(mapsOf(world))
            .slice(0, 1)
            .map((slug) => ({ href: `${base}/${world}/${slug}?from=menu`, text: '' })),
        ],
      };
    }
    if (second === 'checklists' && third) {
      const list = site.checklists?.[third];
      return list
        ? { world: { slug: world, name: site.name }, checklist: { slug: third, ...list } }
        : null;
    }
    return parts.length === 3 && second ? mapData(world, second) : null;
  };
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'desktop_info':
        return { name: 'Atlas', version: '0.0.0', platform: 'test', downloads };
      case 'library_list':
        return listing();
      case 'import_open':
        current = { url: args.url as string, polls: 0 };
        shell.events.push({
          what: 'open',
          url: current.url,
          at: Date.now(),
          ...(typeof args.purpose === 'string' ? { purpose: args.purpose } : {}),
        });
        return null;
      case 'import_poll': {
        if (!current) return { state: 'failed', message: 'No page is open.' };
        current.polls++;
        shell.events.push({ what: 'poll', url: current.url, at: Date.now() });
        const slug = new URL(current.url).pathname.split('/').filter(Boolean).pop() ?? '';
        if (shell.close.includes(slug)) return { state: 'closed' };
        const data = pageData(current.url);
        if (!data || shell.hold.includes(slug) || current.polls < 2) {
          return { state: 'waiting', loading: current.polls < 2, note: null };
        }
        return { state: 'ready', data: JSON.stringify(data) };
      }
      case 'import_fetch': {
        // The made-up wiki: robots.txt, its contents and its pages, as JSON.
        const address = args.url as string;
        shell.events.push({ what: 'fetch', url: address, at: Date.now() });
        const answer = (status: number, body: unknown) => ({
          url: address,
          finalUrl: address,
          status,
          contentType: 'application/json',
          text: typeof body === 'string' ? body : JSON.stringify(body),
          retryAfter: null,
        });
        const at = new URL(address);
        if (!wiki || at.origin !== 'https://wiki.example.org') {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'The site could not be reached.';
        }
        if (at.pathname === '/robots.txt') return answer(200, 'User-agent: *\nDisallow: /private/');
        const slug = at.pathname.replace(/^\/wiki\//, '');
        if (slug === 'Contents') {
          return answer(200, {
            headings: wiki.headings.map((heading) => ({
              title: heading.title,
              pages: heading.pages.map((page) => ({
                slug: page,
                title: wiki.pages[page]?.title ?? page.replaceAll('_', ' '),
              })),
            })),
          });
        }
        if (wiki.busy?.includes(slug)) return answer(503, 'Busy');
        const page = wiki.pages[slug];
        return page ? answer(200, page) : answer(404, 'Not found');
      }
      case 'import_close':
        if (current) shell.events.push({ what: 'close', url: current.url, at: Date.now() });
        current = null;
        return null;
      case 'import_report':
        shell.reports.push(args.report as MockShell['reports'][number]);
        return null;
      case 'library_import_sources':
        return (sources[args.packId as string] ?? []).map((source) => ({ ...source }));
      case 'library_import_source_list':
        return (sources[args.packId as string] ?? []).map(({ data: _, ...page }) => page);
      case 'library_import_source': {
        const one = (sources[args.packId as string] ?? []).find((s) => s.key === args.key);
        return one ? { ...one } : null;
      }
      case 'library_save_import': {
        const request = args.request as {
          packId: string;
          importer: { id: string; title: string };
          sourceKey: string;
          pageUrl: string;
          importedAt: string;
          mapId?: string;
          pageData: string;
          files: Record<string, string>;
        };
        await write(request.packId, request.files);
        const kept = (sources[request.packId] ??= []);
        const at = kept.findIndex((source) => source.key === request.sourceKey);
        const source = {
          key: request.sourceKey,
          url: request.pageUrl,
          importedAt: request.importedAt,
          ...(request.mapId ? { mapId: request.mapId } : {}),
          data: request.pageData,
        };
        if (at >= 0) kept[at] = source;
        else kept.push(source);
        const manifest = JSON.parse(request.files['manifest.json']!) as {
          title: string;
          packVersion: string;
          source?: { pages: { url: string; mapId?: string; importedAt?: string }[] };
        };
        written[request.packId] = manifest.source?.pages ?? [];
        const listed = {
          id: request.packId,
          title: manifest.title,
          url: `http://atlas-pack.localhost/${request.packId}/`,
          origin: 'maps-folder',
          path: `/maps/${request.packId}`,
          packVersion: manifest.packVersion,
          bundled: false,
          imported: { importerId: request.importer.id, importerTitle: request.importer.title },
          pages: (manifest.source?.pages ?? []).map((page) => ({
            url: page.url,
            mapId: page.mapId ?? null,
          })),
        };
        const count = (file: string) => {
          try {
            return (JSON.parse(request.files[file] ?? '[]') as unknown[]).length;
          } catch {
            return 0;
          }
        };
        contents[request.packId] = {
          maps: count('maps.json'),
          layers: count('layers.json'),
          locations: count('locations.json'),
          categories: count('categories.json'),
          regions: count('regions.json'),
          checklists: count('checklists.json'),
          guides: count('guides.json'),
        };
        const index = packs.findIndex((pack) => pack.id === request.packId);
        if (index >= 0) packs[index] = listed;
        else packs.push(listed);
        return listing();
      }
      case 'library_pack_details': {
        // The demo pack that comes with the app, or a pack written here.
        const id = args.id as string;
        return {
          pack: { id, title: id, packVersion: '1.0.0', schemaVersion: 1, attribution: [] },
          source: written[id]
            ? { kind: 'web-pages', pages: written[id] }
            : { kind: 'app', pages: [] },
          contents: contents[id] ?? {
            maps: 2,
            layers: 3,
            locations: 5000,
            categories: 4,
            regions: 0,
            checklists: 1,
            guides: 1,
          },
          layers: [],
          detail: null,
          imagesAt: null,
          archive: false,
          packFile: null,
        };
      }
      default:
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw `Unknown command ${command}`;
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

/** Lists the demo importer in `config.json`, serves it, and serves the packs the fake shell writes. */
export async function setUp(
  page: Page,
  downloads = DOWNLOADS_BUILD,
  { wiki = null }: { wiki?: WikiSite | null } = {},
) {
  const packs: Record<string, Record<string, string>> = {};
  await page.exposeFunction('__writePack', (id: string, files: Record<string, string>) => {
    packs[id] = files;
  });
  const importer = await readFile(IMPORTER, 'utf8');
  const wikiImporter = await readFile(WIKI_IMPORTER, 'utf8');
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...config,
        importers: [
          {
            id: 'demo-maps',
            title: 'Demo map site',
            description: 'Reads the made-up demo map site.',
            version: '1.0.0',
            module: 'importers/demo-maps.js',
          },
          ...(wiki
            ? [
                {
                  id: 'example-wiki',
                  title: 'Example Wiki',
                  description: 'Reads the made-up Example Wiki.',
                  version: '1.0.0',
                  module: 'importers/example-wiki.js',
                },
              ]
            : []),
        ],
      },
    });
  });
  await page.route('**/importers/demo-maps.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: importer }),
  );
  await page.route('**/importers/example-wiki.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: wikiImporter }),
  );
  await page.route(`${PACKS}**`, (route) => {
    const [, id = '', name = ''] =
      /^\/([^/]+)\/(.+)$/.exec(new URL(route.request().url()).pathname) ?? [];
    const body = packs[id]?.[name];
    const headers = { 'access-control-allow-origin': '*' };
    return body === undefined
      ? route.fulfill({ status: 404, headers, body: 'not found' })
      : route.fulfill({ headers, contentType: 'application/json', body });
  });
  await page.clock.install();
  await page.addInitScript(installFakeShell, { worlds: WORLDS, downloads, wiki });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

export const mock = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockShell: MockShell }).__mockShell);

export const setMock = (page: Page, patch: Partial<Pick<MockShell, 'hold' | 'close' | 'extra'>>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __mockShell: MockShell }).__mockShell, patch);
  }, patch);

export const url = (world: string, map: string) => `${SITE}/${world}/${map}`;

export async function paste(page: Page, text: string) {
  await page.getByTestId('add-map-button').click();
  await page.getByTestId('add-map-url').fill(text);
}

export const rows = (page: Page) => page.getByTestId('add-map-run-page');

export async function expectStates(page: Page, states: string[]) {
  await expect(rows(page)).toHaveCount(states.length);
  for (const [i, state] of states.entries()) {
    await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
  }
}

/** The pages opened, in order, and checks that each was closed before the next opened, with the pause between. */
export async function openedPages(page: Page): Promise<string[]> {
  const { events } = await mock(page);
  const opened: string[] = [];
  let lastClose: number | null = null;
  let open: string | null = null;
  for (const event of events) {
    if (event.what === 'open') {
      expect(open, `${event.url} opened while ${open} was open`).toBeNull();
      if (lastClose !== null) expect(event.at - lastClose).toBeGreaterThanOrEqual(3000);
      open = event.url;
      opened.push(event.url!);
    } else if (event.what === 'close' && open) {
      lastClose = event.at;
      open = null;
    }
  }
  return opened;
}

/** Errors on the page, other than packs the fake shell has not written. */
export const realErrors = (errors: string[]) =>
  errors.filter((e) => !/Failed to load resource.*404/.test(e));
