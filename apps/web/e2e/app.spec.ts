import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  categoryCount,
  collectErrors,
  demoLocations,
  demoRegions,
  expectOverallFound,
  mapStatus,
  openMap,
  overall,
  searchAndChoose,
  selectByName,
  type PackRegion,
} from './helpers';

const HERB = 'demo:cat:herb';
const RELIC = 'demo:cat:relic';

test('filters categories and groups, and the marker count follows', async ({ page, request }) => {
  const errors = collectErrors(page);
  const surface = (await demoLocations(request)).filter((l) => l.mapId === 'demo:map:world');
  const herbs = surface.filter((l) => l.categoryId === HERB).length;
  await openMap(page);

  await page.getByTestId(`category-${HERB}`).getByRole('checkbox').uncheck();
  await expect(page.getByTestId('marker-count')).toHaveText((5000 - herbs).toLocaleString('en'));

  // Hiding a group hides all of its categories and leaves the group box unchecked.
  const collectibles = page.getByTestId('group-demo:catgroup:collectibles').getByRole('checkbox');
  await expect(collectibles).toHaveAttribute('aria-checked', 'mixed');
  await collectibles.click();
  await expect(collectibles).toBeChecked();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await collectibles.click();
  const collectibleCount = surface.filter((l) =>
    ['herb', 'relic', 'chest', 'tablet', 'key'].some((c) => l.categoryId === `demo:cat:${c}`),
  ).length;
  await expect(page.getByTestId('marker-count')).toHaveText(
    (5000 - collectibleCount).toLocaleString('en'),
  );

  // Presets replace the visible set; "Reset filters" restores the pack defaults.
  await page.getByRole('button', { name: 'Hunter' }).click();
  await expect(page.getByRole('button', { name: 'Hunter' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByTestId(`category-${RELIC}`).getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');

  // A user preset is saved, applied and deleted.
  await page.getByTestId(`category-${HERB}`).getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Save current as preset…' }).click();
  await page.getByLabel('Preset name').fill('No herbs');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const noHerbs = page.getByRole('button', { name: 'No herbs', exact: true });
  await expect(noHerbs).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await noHerbs.click();
  await expect(page.getByTestId('marker-count')).toHaveText((5000 - herbs).toLocaleString('en'));
  await page.getByRole('button', { name: 'Delete preset No herbs' }).click();
  await expect(noHerbs).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('marks found, counters move, undo restores, hide found hides', async ({ page, request }) => {
  const errors = collectErrors(page);
  const relic = (await demoLocations(request)).find(
    (l) => l.categoryId === RELIC && l.mapId === 'demo:map:world',
  )!;
  await openMap(page);
  const before = await overall(page);
  expect(before.found).toBe(0);
  const relicTotal = (await categoryCount(page, RELIC)).split('/')[1];

  await selectByName(page, relic.name);
  const toggle = page.getByTestId('found-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await page.keyboard.press('f');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expectOverallFound(page, 1);
  expect(await categoryCount(page, RELIC)).toBe(`1/${relicTotal}`);
  await expect(page.getByTestId('region-progress')).toContainText('1/');

  await page.keyboard.press('z');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expectOverallFound(page, 0);
  expect(await categoryCount(page, RELIC)).toBe(`0/${relicTotal}`);

  // The button works too, and "hide found" removes the marker unless it is selected.
  await toggle.click();
  await expectOverallFound(page, 1);
  await page.getByRole('switch', { name: 'Hide found' }).check();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000'); // still selected
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-count')).toHaveText('4,999');
  expect(errors).toEqual([]);
});

test('only trackable categories can be marked', async ({ page, request }) => {
  const camp = (await demoLocations(request)).find((l) => l.categoryId === 'demo:cat:camp')!;
  await openMap(page);
  await selectByName(page, camp.name);
  await expect(page.getByTestId('found-toggle')).toHaveCount(0);
  await page.keyboard.press('f');
  await expectOverallFound(page, 0);
  await expect(page.getByTestId('toast')).toContainText('not tracked');
});

test('search covers every map and flies to the result', async ({ page, request }) => {
  const errors = collectErrors(page);
  const all = await demoLocations(request);
  const deep = all.find(
    (l) =>
      l.layerId === 'demo:layer:deep-lower' &&
      l.categoryId === 'demo:cat:key' &&
      all.filter((other) => other.name === l.name).length === 1,
  )!;
  await openMap(page);
  await selectByName(page, deep.name);
  await expect.poll(async () => (await mapStatus(page)).layer).toBe('demo:layer:deep-lower');
  await expect(page.getByLabel('Map', { exact: true })).toHaveValue('demo:map:deep');
  await expect(page.getByRole('button', { name: /Lower galleries/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(async () => {
      const view = await mapStatus(page);
      return Math.hypot(view.x - deep.x, view.y - deep.y);
    })
    .toBeLessThan(30);

  // The guide entry renders as Markdown, with links opening in a new tab.
  const link = page.locator('.guide-body a').first();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  // Entities are searchable and lead to one of their locations.
  await searchAndChoose(page, 'Old key');
  await expect(page.getByTestId('details')).toContainText('Old key');
  expect(errors).toEqual([]);
});

test('N jumps to the nearest unfound marker; shortcuts do not fire while typing', async ({
  page,
}) => {
  await openMap(page, './#@4096,4096,4');
  await page.keyboard.press('n');
  await expect(page.getByTestId('selected-name')).toBeVisible();
  const first = await page.getByTestId('selected-name').textContent();
  await page.keyboard.press('f');
  await expectOverallFound(page, 1);
  await page.keyboard.press('n');
  await expect(page.getByTestId('selected-name')).not.toHaveText(first!);

  await page.keyboard.press('/');
  await page.keyboard.type('fz');
  await expect(page.getByRole('combobox', { name: 'Search locations' })).toHaveValue('fz');
  await expectOverallFound(page, 1);
});

/**
 * How far the map's centre is from a point, in screen pixels at the zoom
 * shown. The view lands on whole screen pixels, so a few image pixels of
 * difference at low zoom are expected.
 */
async function distanceFromView(
  page: Page,
  [x, y]: readonly [number, number],
  maxZoom = 5,
): Promise<number> {
  const view = await mapStatus(page);
  return Math.hypot(view.x - x, view.y - y) / 2 ** (maxZoom - view.zoom);
}

/** Whether a point is inside the visible part of the map, for a layer whose 1:1 level is `maxZoom`. */
async function inView(page: Page, [x, y]: readonly [number, number], maxZoom: number) {
  const view = await mapStatus(page);
  const box = (await page.getByTestId('map').boundingBox())!;
  const imagePixels = 2 ** (maxZoom - view.zoom);
  return (
    Math.abs(view.x - x) <= (box.width / 2) * imagePixels &&
    Math.abs(view.y - y) <= (box.height / 2) * imagePixels
  );
}

/** Whether every point of a region's outline is in view. */
async function outlineInView(page: Page, region: PackRegion, maxZoom: number) {
  for (const point of region.polygon!) if (!(await inView(page, point, maxZoom))) return false;
  return true;
}

test('a region row moves the map to the region, by mouse or keyboard', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const regions = (await demoRegions(request)).filter((r) => r.mapId === 'demo:map:world');
  // The demo has both kinds: child regions with a centre, top-level ones with an outline only.
  const outlineOnly = regions.find((r) => !r.center && r.polygon)!;
  const withCenter = regions.find((r) => r.center && r.parentId === outlineOnly.id)!;
  expect(outlineOnly).toBeDefined();
  expect(withCenter).toBeDefined();
  await openMap(page, './#@4096,4096,1');
  const progress = page.getByTestId('region-progress');

  // Each region row is a button named for where it goes, and keeps its figures and meter.
  const go = progress.getByRole('button', { name: `Go to ${withCenter.name}`, exact: true });
  await expect(go).toBeVisible();
  const figures = /^[\d,]+\/[\d,]+ \d+%$/;
  await expect(go).toHaveAccessibleDescription(figures);
  await expect(go.locator('.progress-figure')).toHaveText(figures);
  await expect(go.locator('.meter')).toHaveCount(1);
  // The whole-map row is not a button.
  await expect(progress.locator('div.progress-row')).toHaveCount(1);
  await expect(progress.getByRole('button')).toHaveCount(regions.length);

  const before = await mapStatus(page);
  await go.click();
  await expect.poll(() => distanceFromView(page, withCenter.center!)).toBeLessThan(3);
  await expect.poll(async () => (await mapStatus(page)).zoom).toBeGreaterThan(before.zoom);
  expect((await mapStatus(page)).layer).toBe('demo:layer:surface');
  // Zoomed so that the whole outline shows around the centre.
  expect(await outlineInView(page, withCenter, 5)).toBe(true);

  // Keyboard: focus the row of a region without a centre and press Enter.
  const goOutline = progress.getByRole('button', {
    name: `Go to ${outlineOnly.name}`,
    exact: true,
  });
  await goOutline.focus();
  await expect(goOutline).toBeFocused();
  await page.keyboard.press('Enter');
  // A large outline is shown whole; near the image's edges the map may hold
  // the view a little off the outline's middle.
  await expect.poll(() => outlineInView(page, outlineOnly, 5)).toBe(true);
  expect(await outlineInView(page, withCenter, 5)).toBe(true);
  // Space works too, as on any button.
  await go.focus();
  await page.keyboard.press(' ');
  await expect.poll(() => distanceFromView(page, withCenter.center!)).toBeLessThan(3);
  expect(errors).toEqual([]);
});

test('on narrow windows a region row closes the filter sheet and shows the region', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const region = (await demoRegions(request)).find((r) => r.center)!;
  await page.setViewportSize({ width: 390, height: 844 });
  await openMap(page, './#@7000,1000,4');
  expect(await inView(page, region.center!, 5)).toBe(false);
  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByTestId('filters-pane')).toBeVisible();
  await page
    .getByTestId('region-progress')
    .getByRole('button', { name: `Go to ${region.name}`, exact: true })
    .click();
  await expect(page.getByTestId('filters-pane')).toBeHidden();
  await expect(page.getByTestId('details-pane')).toBeHidden();
  // A tall, narrow map area shows the whole region at a low zoom, where the
  // map's edges can hold the view off the exact centre; the centre is in view.
  await expect.poll(() => inView(page, region.center!, 5)).toBe(true);
  expect(errors).toEqual([]);
});

async function openProfiles(page: Page) {
  await page.getByRole('button', { name: /^Profile:/ }).click();
  const dialog = page.getByTestId('profile-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

test('profiles keep progress separate', async ({ page, request }) => {
  const errors = collectErrors(page);
  const [a, b] = (await demoLocations(request)).filter((l) => l.categoryId === RELIC);
  await openMap(page);
  await selectByName(page, a!.name);
  await page.keyboard.press('f');
  await expectOverallFound(page, 1);

  let dialog = await openProfiles(page);
  await dialog.getByLabel('New profile name').fill('Second run');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('Second run');
  await page.keyboard.press('Escape');
  await expectOverallFound(page, 0);

  await selectByName(page, b!.name);
  await page.keyboard.press('f');
  await selectByName(page, a!.name);
  await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'false');

  dialog = await openProfiles(page);
  await dialog.getByRole('button', { name: 'Playthrough 1', exact: true }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('Playthrough 1');
  await page.keyboard.press('Escape');
  await expectOverallFound(page, 1);
  await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'true');

  // Rename, duplicate and delete.
  dialog = await openProfiles(page);
  await dialog.getByRole('button', { name: 'Rename Playthrough 1' }).click();
  await dialog.getByLabel('New name for Playthrough 1').fill('Main run');
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('Main run');
  await dialog.getByRole('button', { name: 'Duplicate Main run' }).click();
  await expect(page.getByTestId('profile-name')).toHaveText('Main run (copy)');
  await expect(dialog.getByTestId('profile-row')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Delete Second run' }).click();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByTestId('profile-row')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expectOverallFound(page, 1);
  expect(errors).toEqual([]);
});

test('export then import round-trips progress', async ({ page, request }) => {
  const errors = collectErrors(page);
  const [a, b] = (await demoLocations(request)).filter((l) => l.categoryId === RELIC);
  await openMap(page);
  for (const location of [a!, b!]) {
    await selectByName(page, location.name);
    await page.keyboard.press('f');
  }
  await expectOverallFound(page, 2);

  let dialog = await openProfiles(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    dialog.getByRole('button', { name: 'Export all profiles' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^atlas-all-profiles-\d{4}-\d{2}-\d{2}\.json$/);
  const file = await download.path();
  const exported = JSON.parse(await readFile(file, 'utf8')) as {
    format: string;
    progress: unknown[];
  };
  expect(exported.format).toBe('atlas-progress');
  expect(exported.progress).toHaveLength(2);

  // Lose the progress, then bring it back with a replace import.
  await page.keyboard.press('Escape');
  await page.keyboard.press('f'); // un-mark b, the selection
  await expectOverallFound(page, 1);
  dialog = await openProfiles(page);
  await dialog.getByTestId('import-file').setInputFiles(file);
  await expect(dialog.getByTestId('import-review')).toContainText('holds 1 profile');
  await dialog.getByRole('radio', { name: /Replace/ }).check();
  await expect(dialog.getByTestId('import-review')).toContainText('Changes 2 progress records');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog.getByTestId('import-review')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expectOverallFound(page, 2);

  // A merge of the same file changes nothing, and a bad file is explained.
  dialog = await openProfiles(page);
  await dialog.getByTestId('import-file').setInputFiles(file);
  await expect(dialog.getByTestId('import-review')).toContainText('Changes 0 progress records');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.getByTestId('import-file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"atlas-progress","version":1}'),
  });
  await expect(dialog.getByRole('alert')).toContainText('not a valid export');
  expect(errors).toEqual([]);
});

test('reload keeps progress, filters and the profile', async ({ page, request }) => {
  const relic = (await demoLocations(request)).find((l) => l.categoryId === RELIC)!;
  await openMap(page);
  await selectByName(page, relic.name);
  await page.keyboard.press('f');
  await expectOverallFound(page, 1);
  await page.getByTestId(`category-${HERB}`).getByRole('checkbox').uncheck();

  await page.reload();
  await expect(page.getByTestId('overall-progress')).toHaveAttribute('data-found', '1');
  await expect(page.getByTestId(`category-${HERB}`).getByRole('checkbox')).not.toBeChecked();
  await selectByName(page, relic.name);
  await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'true');
});

/** A tiny second pack, served by the test, whose tiles were never downloaded. */
function tinyPack(): Record<string, unknown> {
  const id = (kind: string, local: string) => `tiny:${kind}:${local}`;
  return {
    'manifest.json': {
      schemaVersion: 1,
      gameId: 'tiny',
      title: 'Tiny test pack',
      packVersion: '1.0.0',
      gamePatch: '1',
      attribution: [],
      idMigrations: {},
    },
    'maps.json': [{ id: id('map', 'm'), name: 'Small map', width: 512, height: 512 }],
    'layers.json': [
      {
        id: id('layer', 'l'),
        mapId: id('map', 'm'),
        name: 'Ground',
        tiles: { type: 'xyz', url: 'tiles/{z}/{x}/{y}.webp' },
        minZoom: 0,
        maxZoom: 1,
        tileSize: 256,
      },
    ],
    'categoryGroups.json': [{ id: id('catgroup', 'g'), name: 'Things', order: 0 }],
    'categories.json': [
      {
        id: id('cat', 'c'),
        groupId: id('catgroup', 'g'),
        name: 'Thing',
        icon: 'crown',
        color: '#c080ff',
        trackable: true,
        defaultVisible: true,
      },
    ],
    'locations.json': Array.from({ length: 12 }, (_, i) => ({
      id: id('loc', String(i + 1)),
      mapId: id('map', 'm'),
      layerId: id('layer', 'l'),
      x: 40 + (i % 4) * 120,
      y: 60 + Math.floor(i / 4) * 150,
      categoryId: id('cat', 'c'),
      regionId: null,
      name: `Tiny thing ${i + 1}`,
      entityIds: [],
      guideId: null,
      since: '1.0.0',
    })),
    // Optional files are present but empty, so the only 404 is the tile probe.
    ...Object.fromEntries(
      ['regions', 'entities', 'checklists', 'checklistItems', 'guides', 'links', 'presets'].map(
        (name) => [`${name}.json`, []],
      ),
    ),
  };
}

test('offers a game switcher and loads a pack whose tiles are missing', async ({ page }) => {
  const errors = collectErrors(page);
  const files = tinyPack();
  await page.route('**/packs/index.json', (route) =>
    route.fulfill({
      json: {
        packs: [
          { id: 'demo', url: 'packs/demo/', title: 'Atlas demo world' },
          { id: 'tiny', url: 'packs/tiny/', title: 'Tiny test pack' },
        ],
      },
    }),
  );
  await page.route('**/packs/tiny/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/tiny/')[1] ?? '';
    const body = files[name];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: body });
  });

  await openMap(page);
  const game = page.getByLabel('Game');
  await game.selectOption('tiny');
  await expect(page.getByTestId('marker-count')).toHaveText('12');
  await expect(page.getByTestId('tile-notice')).toBeVisible();
  await expect(page.locator('.atlas-tiles')).toHaveCount(0);
  await expect(page.locator('.atlas-marker-canvas')).not.toHaveAttribute('data-drawn-markers', '0');
  await selectByName(page, 'Tiny thing 3');
  await page.keyboard.press('f');
  await expectOverallFound(page, 1);

  // Each game has its own profiles and progress.
  await game.selectOption('demo');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await expectOverallFound(page, 0);
  await game.selectOption('tiny');
  await expectOverallFound(page, 1);

  // Only the one probe for the missing tiles may show up, as a failed resource load.
  const unexpected = errors.filter((e) => !/Failed to load resource.*404/.test(e));
  expect(unexpected).toEqual([]);
  expect(errors.length).toBeLessThanOrEqual(1);
});

test('narrow windows use bottom sheets', async ({ page, request }) => {
  const errors = collectErrors(page);
  const relic = (await demoLocations(request)).find((l) => l.categoryId === RELIC)!;
  await page.setViewportSize({ width: 390, height: 844 });
  await openMap(page);
  await expect(page.getByTestId('filters-pane')).toBeHidden();
  await expect(page.getByTestId('details-pane')).toBeHidden();

  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  await expect(page.getByTestId('filters-pane')).toBeVisible();
  const sheet = (await page.getByTestId('filters-pane').boundingBox())!;
  expect(sheet.y + sheet.height).toBeCloseTo(844, 0);
  expect(sheet.width).toBeCloseTo(390, 0);

  await selectByName(page, relic.name);
  await expect(page.getByTestId('details-pane')).toBeVisible();
  await expect(page.getByTestId('filters-pane')).toBeHidden();
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(page.getByTestId('details-pane')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a computer shows keyboard hints and zoom buttons, with no room kept for system bars', async ({
  page,
}) => {
  await openMap(page);
  await expect(page.getByRole('combobox', { name: 'Search locations' })).toHaveAttribute(
    'placeholder',
    'Search  ( / )',
  );
  await expect(page.getByTestId('details-empty')).toContainText('Keyboard');
  await expect(page.locator('.leaflet-control-zoom')).toBeVisible();
  const shell = (await page.locator('.shell').boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(shell).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
});
