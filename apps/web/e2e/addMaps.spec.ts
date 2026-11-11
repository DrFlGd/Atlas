import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { downloadsEnabled } from '../tooling/buildFlags.ts';
import { collectErrors } from './helpers';

/**
 * "Add a map" with several addresses, against a stand-in for the desktop
 * shell: the page gets a fake `__TAURI_INTERNALS__.invoke` whose import
 * window hands over made-up page data for the made-up demo importer
 * (`packages/importer-api/demo/demo-importer.js`), which the test serves as
 * the build's one importer. Nothing is opened and no site is asked for
 * anything; the real import window is covered by the desktop tests.
 */

/** The app under test was built with map image downloads (run with the build's `ATLAS_ENABLE_DOWNLOADS`). */
const DOWNLOADS_BUILD = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);

const SHOTS = 'test-results/add-maps';
const SITE = 'https://maps.example.com/demo-maps';
const PACKS = 'http://atlas-pack.localhost/';
const IMPORTER = new URL('../../../packages/importer-api/demo/demo-importer.js', import.meta.url);

/** The made-up site's maps, by world and map slug. */
const WORLDS: Record<string, { name: string; maps: Record<string, string> }> = {
  'test-valley': {
    name: 'Test Valley',
    maps: { 'east-field': 'East Field', 'west-ridge': 'West Ridge' },
  },
  'test-hills': { name: 'Test Hills', maps: { 'high-pass': 'High Pass' } },
  demo: { name: 'Demo again', maps: { plain: 'Plain' } },
};

interface ShellEvent {
  what: 'open' | 'close' | 'poll';
  url: string | null;
  at: number;
}

interface MockShell {
  events: ShellEvent[];
  /** Map slugs whose page keeps waiting until taken out of here. */
  hold: string[];
  /** Map slugs whose window the person closes. */
  close: string[];
  reports: { outcome: string; message?: string; pages?: string[]; run?: Record<string, number> }[];
}

/**
 * Stands in for the shell: the import window's commands, the library and
 * saving. A page of map `never` never hands over data; `broken` hands over
 * data in the wrong shape; the others after two polls, unless held.
 */
function installFakeShell({ worlds, downloads }: { worlds: typeof WORLDS; downloads: boolean }) {
  const shell: MockShell = { events: [], hold: [], close: [], reports: [] };
  (window as unknown as { __mockShell: MockShell }).__mockShell = shell;
  const write = (
    window as unknown as { __writePack: (id: string, files: unknown) => Promise<void> }
  ).__writePack;
  let current: { url: string; polls: number } | null = null;
  const packs: Record<string, unknown>[] = [];
  const sources: Record<
    string,
    { key: string; url: string; importedAt: string; mapId: string; data: string }[]
  > = {};
  const listing = () => ({
    mapsFolder: { path: '/maps', isDefault: true, exists: true },
    packs: structuredClone(packs),
    hidden: [],
    locations: [],
    busy: [],
  });
  const pageData = (url: string) => {
    const [, world = '', map = ''] =
      /\/demo-maps\/([^/]+)\/([^/]+)$/.exec(new URL(url).pathname) ?? [];
    const site = worlds[world];
    const slug = map === 'broken' ? (Object.keys(site?.maps ?? {})[0] ?? map) : map;
    const name = site?.maps[slug];
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
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'desktop_info':
        return { name: 'Atlas', version: '0.0.0', platform: 'test', downloads };
      case 'library_list':
        return listing();
      case 'import_open':
        current = { url: args.url as string, polls: 0 };
        shell.events.push({ what: 'open', url: current.url, at: Date.now() });
        return null;
      case 'import_poll': {
        if (!current) return { state: 'failed', message: 'No page is open.' };
        current.polls++;
        shell.events.push({ what: 'poll', url: current.url, at: Date.now() });
        const slug = current.url.split('/').pop() ?? '';
        if (shell.close.includes(slug)) return { state: 'closed' };
        const data = pageData(current.url);
        if (!data || shell.hold.includes(slug) || current.polls < 2) {
          return { state: 'waiting', loading: current.polls < 2, note: null };
        }
        return { state: 'ready', data: JSON.stringify(data) };
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
      case 'library_save_import': {
        const request = args.request as {
          packId: string;
          importer: { id: string; title: string };
          sourceKey: string;
          pageUrl: string;
          importedAt: string;
          mapId: string;
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
          mapId: request.mapId,
          data: request.pageData,
        };
        if (at >= 0) kept[at] = source;
        else kept.push(source);
        if (!packs.some((pack) => pack.id === request.packId)) {
          packs.push({
            id: request.packId,
            title: (JSON.parse(request.files['manifest.json']!) as { title: string }).title,
            url: `http://atlas-pack.localhost/${request.packId}/`,
            origin: 'maps-folder',
            path: `/maps/${request.packId}`,
            packVersion: '1.0.0',
            bundled: false,
            imported: { importerId: request.importer.id, importerTitle: request.importer.title },
          });
        }
        return listing();
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
async function setUp(page: Page, downloads = DOWNLOADS_BUILD) {
  const packs: Record<string, Record<string, string>> = {};
  await page.exposeFunction('__writePack', (id: string, files: Record<string, string>) => {
    packs[id] = files;
  });
  const importer = await readFile(IMPORTER, 'utf8');
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
        ],
      },
    });
  });
  await page.route('**/importers/demo-maps.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: importer }),
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
  await page.addInitScript(installFakeShell, { worlds: WORLDS, downloads });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

const mock = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockShell: MockShell }).__mockShell);

const setMock = (page: Page, patch: Partial<Pick<MockShell, 'hold' | 'close'>>) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __mockShell: MockShell }).__mockShell, patch);
  }, patch);

const url = (world: string, map: string) => `${SITE}/${world}/${map}`;

async function paste(page: Page, text: string) {
  await page.getByTestId('add-map-button').click();
  await page.getByTestId('add-map-url').fill(text);
}

const rows = (page: Page) => page.getByTestId('add-map-run-page');

async function expectStates(page: Page, states: string[]) {
  await expect(rows(page)).toHaveCount(states.length);
  for (const [i, state] of states.entries()) {
    await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
  }
}

/** The pages opened, in order, and checks that each was closed before the next opened, with the pause between. */
async function openedPages(page: Page): Promise<string[]> {
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

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test('adds several maps one after another, with a state for each and a summary', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(
    page,
    [
      `  ${url('test-valley', 'east-field')}`,
      `${url('test-valley', 'west-ridge')}, ${url('test-valley', 'east-field')}`,
      'https://other.example.org/maps/somewhere',
      `${url('demo', 'plain')} ${url('test-valley', 'broken')}`,
      url('test-hills', 'high-pass'),
    ].join('\n'),
  );
  // Six different addresses; the repeat is counted once.
  await expect(page.getByTestId('add-map-start')).toHaveText('Add 6 maps');
  await page.screenshot({ path: `${SHOTS}/0-form.png` });
  await page.getByTestId('add-map-start').click();

  // The address no importer recognises is shown before anything opens.
  const check = page.getByTestId('add-map-check');
  await expect(check).toContainText('One address cannot be added. The other 5 can');
  const checked = page.getByTestId('add-map-check-address');
  await expect(checked).toHaveCount(6);
  await expect(checked.nth(2)).toHaveAttribute('data-state', 'left-out');
  await expect(checked.nth(2)).toContainText('No importer in this app recognises this address.');
  expect((await mock(page)).events).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/1-check.png` });

  // The second page holds on to its data for a while.
  await setMock(page, { hold: ['west-ridge'] });
  await page.getByTestId('add-map-confirm').click();
  const dialog = page.getByTestId('add-map-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'run');
  await expect(dialog).toHaveAttribute('data-run', 'running');
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'added');
  await expect(rows(page).nth(0)).toContainText('Added “East Field” to Test Valley');
  await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'open');
  await expect(rows(page).nth(2)).toHaveText(/Waiting$/);
  // After a while the open page gets the hint to look at its window.
  await page.clock.fastForward(21_000);
  await expect(rows(page).nth(1).getByTestId('add-map-still-waiting')).toContainText(
    'if it asks you to sign in, to confirm you are a person or to wait, deal with it there',
  );
  await page.screenshot({ path: `${SHOTS}/2-running.png` });
  await setMock(page, { hold: [] });

  await expect(dialog).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expectStates(page, ['added', 'added', 'failed', 'failed', 'added']);
  await expect(rows(page).nth(1)).toContainText('Added “West Ridge” to Test Valley');
  await expect(rows(page).nth(2)).toContainText('Not added: Demo again comes with this app');
  await expect(rows(page).nth(3)).toContainText('Not added: The page did not hold demo map data');
  await expect(rows(page).nth(4)).toContainText('Added “High Pass” to Test Hills');
  await expect(page.getByTestId('add-map-summary')).toHaveText('3 maps added, 2 not added.');
  await expect(page.getByTestId('add-map-run')).toContainText('One address was left out');

  // Every page once, in order, one at a time, with the pause between.
  expect(await openedPages(page)).toEqual([
    url('test-valley', 'east-field'),
    url('test-valley', 'west-ridge'),
    url('demo', 'plain'),
    url('test-valley', 'broken'),
    url('test-hills', 'high-pass'),
  ]);

  // The game of the last map added is shown.
  await expect(
    page.locator('.topbar select').filter({ has: page.locator('option[value="test-hills"]') }),
  ).toHaveValue('test-hills');
  // The download is offered once, for the game shown.
  await expect(page.getByTestId('add-map-download')).toHaveCount(DOWNLOADS_BUILD ? 1 : 0);
  if (DOWNLOADS_BUILD) {
    await expect(page.getByTestId('add-map-download')).toHaveText(
      'Download map images of Test Hills…',
    );
  }
  await expect(page.getByTestId('add-map-images-note')).toContainText(
    DOWNLOADS_BUILD ? 'Test Hills is shown now' : 'Their map images are not installed',
  );
  await page.screenshot({ path: `${SHOTS}/3-finished.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${SHOTS}/3-finished-narrow.png` });
  await page.setViewportSize({ width: 1280, height: 800 });

  // The activity log: the start with the pages, every page, the summary.
  const reports = (await mock(page)).reports;
  expect(reports[0]).toMatchObject({ outcome: 'run-started', run: { leftOut: 1 } });
  expect(reports[0]!.pages).toHaveLength(5);
  expect(reports.map((r) => r.outcome)).toEqual([
    'run-started',
    'added',
    'added',
    'failed',
    'failed',
    'added',
    'run-finished',
  ]);
  expect(reports.at(-1)).toMatchObject({
    run: { added: 3, refreshed: 0, notAdded: 2, notStarted: 0, leftOut: 1 },
  });

  // Adding a page of it again refreshes it.
  await page.getByRole('button', { name: 'Add more maps' }).click();
  await page
    .getByTestId('add-map-url')
    .fill(`${url('test-valley', 'west-ridge')}\n${url('test-hills', 'high-pass')}`);
  await page.getByTestId('add-map-start').click();
  await expect(dialog).toHaveAttribute('data-run', 'finished', { timeout: 30_000 });
  await expect(rows(page).nth(0)).toContainText('Refreshed “West Ridge” in Test Valley');
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 maps refreshed.');

  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('stops after two pages in a row without data', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(
    page,
    [
      url('test-valley', 'never'),
      url('test-hills', 'never'),
      url('test-valley', 'east-field'),
    ].join('\n'),
  );
  await page.getByTestId('add-map-start').click();
  const dialog = page.getByTestId('add-map-dialog');
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'open');
  // The demo importer waits 30 seconds for each page.
  await page.clock.fastForward(31_000);
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'failed');
  await expect(rows(page).nth(0)).toContainText('did not provide the map data within 30 seconds');
  await expect(rows(page).nth(1)).toHaveAttribute('data-state', 'open', { timeout: 10_000 });
  await page.clock.fastForward(31_000);
  await expect(dialog).toHaveAttribute('data-run', 'stopped');
  await expectStates(page, ['failed', 'failed', 'not-started']);
  await expect(page.getByTestId('add-map-stopped')).toContainText(
    'Two pages in a row did not provide their map data, so this app stopped rather than open the rest.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText('2 maps not added, 1 not started.');
  expect(await openedPages(page)).toEqual([
    url('test-valley', 'never'),
    url('test-hills', 'never'),
  ]);
  await page.screenshot({ path: `${SHOTS}/4-no-data.png` });
  const outcomes = (await mock(page)).reports.map((r) => r.outcome);
  expect(outcomes).toEqual([
    'run-started',
    'timed-out',
    'timed-out',
    'run-stopped',
    'run-finished',
  ]);
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('Stop ends the run after the open page, and closing the page window ends it at once', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await setUp(page);
  const three = [
    url('test-valley', 'east-field'),
    url('test-valley', 'west-ridge'),
    url('test-hills', 'high-pass'),
  ];
  await setMock(page, { hold: ['east-field'] });
  await paste(page, three.join('\n'));
  await page.getByTestId('add-map-start').click();
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'open');
  await page.getByTestId('add-map-stop').click();
  await expect(page.getByTestId('add-map-stopping')).toContainText(
    'This app stops after the page that is open now.',
  );
  await expect(page.getByTestId('add-map-stop')).toBeDisabled();
  await setMock(page, { hold: [] });
  const dialog = page.getByTestId('add-map-dialog');
  await expect(dialog).toHaveAttribute('data-run', 'stopped');
  await expectStates(page, ['added', 'not-started', 'not-started']);
  await expect(page.getByTestId('add-map-stopped')).toHaveText(
    'You stopped adding maps, so the pages after that were not opened.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText('1 map added, 2 not started.');
  await expect(
    page.locator('.topbar select').filter({ has: page.locator('option[value="test-valley"]') }),
  ).toHaveValue('test-valley');

  // The person closes the window of the second page: the run stops there.
  await page.getByRole('button', { name: 'Add more maps' }).click();
  await setMock(page, { close: ['west-ridge'] });
  await page.getByTestId('add-map-url').fill(three.join(', '));
  await page.getByTestId('add-map-start').click();
  await expect(dialog).toHaveAttribute('data-run', 'stopped', { timeout: 30_000 });
  await expectStates(page, ['added', 'failed', 'not-started']);
  await expect(rows(page).nth(1)).toContainText(
    'Not added: The page window was closed before the page provided the map data.',
  );
  await expect(page.getByTestId('add-map-stopped')).toHaveText(
    'The page window was closed, so this app stopped and opened no more pages.',
  );
  await expect(page.getByTestId('add-map-summary')).toHaveText(
    '1 map refreshed, 1 not added, 1 not started.',
  );
  await page.screenshot({ path: `${SHOTS}/5-closed.png` });
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});

test('one address works as before, and too many are refused', async ({ page }) => {
  const errors = collectErrors(page);
  await setUp(page);
  await paste(page, ` ${url('test-valley', 'east-field')} `);
  await expect(page.getByTestId('add-map-start')).toHaveText('Add');
  await page.getByTestId('add-map-url').press('Enter');
  const dialog = page.getByTestId('add-map-dialog');
  await expect(dialog).toHaveAttribute('data-phase', 'done');
  await expect(page.getByTestId('add-map-game')).toHaveText('Test Valley');
  await expect(page.getByTestId('add-map-run')).toHaveCount(0);
  expect((await mock(page)).reports.map((r) => r.outcome)).toEqual(['added']);

  await page.getByRole('button', { name: 'Add another map' }).click();
  await expect(page.getByTestId('add-map-url')).toHaveValue('');
  await page
    .getByTestId('add-map-url')
    .fill(Array.from({ length: 26 }, (_, i) => url('test-valley', `map-${i}`)).join('\n'));
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('add-map-error')).toHaveText(
    'That is 26 addresses. This app adds at most 25 maps at a time, so remove some and add them afterwards.',
  );
  expect((await mock(page)).events.filter((e) => e.what === 'open')).toHaveLength(1);

  // Only addresses that cannot be added: nothing to start.
  await page.getByTestId('add-map-url').fill('https://other.example.org/a\nnot-an-address');
  await page.getByTestId('add-map-start').click();
  await expect(page.getByTestId('add-map-check')).toContainText(
    'None of these addresses can be added.',
  );
  await expect(page.getByTestId('add-map-check-address').nth(1)).toContainText(
    'This is not a web address this app can open.',
  );
  await expect(page.getByTestId('add-map-confirm')).toHaveCount(0);
  await page.getByTestId('add-map-edit').click();
  await expect(page.getByTestId('add-map-url')).toHaveValue(
    'https://other.example.org/a\nnot-an-address',
  );
  expect(errors.filter((e) => !/Failed to load resource.*404/.test(e))).toEqual([]);
});
