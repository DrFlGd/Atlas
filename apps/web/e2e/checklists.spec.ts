import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  categoryCount,
  collectErrors,
  demoLocations,
  expectOverallFound,
  mapStatus,
  openMap,
  selectByName,
} from './helpers';

interface Item {
  id: string;
  checklistId: string;
  name: string;
  order: number;
  locationIds: string[];
  entityIds: string[];
  section?: string;
  note?: string;
}

interface Checklist {
  id: string;
  name: string;
  order: number;
  kind?: string;
}

async function demoJson<T>(request: APIRequestContext, file: string): Promise<T> {
  return (await (await request.get(`./packs/demo/${file}`)).json()) as T;
}

const itemsOf = async (request: APIRequestContext, checklistId: string) =>
  (await demoJson<Item[]>(request, 'checklistItems.json'))
    .filter((i) => i.checklistId === checklistId)
    .sort((a, b) => a.order - b.order);

const screenButton = (page: Page) =>
  page.getByRole('button', { name: 'Checklists and guides', exact: true });

/** Opens the screen from the top bar and one list on it. */
async function openList(page: Page, name: string) {
  await screenButton(page).click();
  await page.getByTestId('checklist-link').filter({ hasText: name }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

const itemRow = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
const itemBox = (page: Page, id: string) => itemRow(page, id).getByRole('checkbox');

test('opens from the top bar and with C, and lists checklists and guides with progress', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await openMap(page);
  const button = screenButton(page);
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('tab', { name: 'Filters' })).toHaveAttribute('aria-selected', 'true');

  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('button', { name: 'Filters', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  const pane = page.getByTestId('filters-pane');
  await expect(pane.getByRole('heading', { name: 'Checklists' })).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'Guides' })).toBeVisible();
  await expect(page.getByTestId('checklist-link')).toHaveCount(4);
  await expect(page.getByTestId('checklist-link').first()).toContainText('Waystones0/120');
  await expect(page.getByTestId('checklists-total')).toContainText('0 of 2,471 items');
  // Lists of places that are guides, and guides that are text, are under Guides.
  await expect(
    pane.getByTestId('guide-link').filter({ hasText: 'Into the Hollow Deep' }),
  ).toBeVisible();

  // C closes and opens it; the map stays usable beside it.
  await page.keyboard.press('c');
  await expect(pane).toBeHidden();
  await page.keyboard.press('c');
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('map')).toBeVisible();
  // The tabs work with arrow keys.
  await page.getByRole('tab', { name: 'Checklists and guides' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Filters' })).toBeFocused();
  await expect(page.getByTestId('category-tree')).toBeVisible();
  expect(errors).toEqual([]);
});

test('ticking an item marks its place found on the map, and the counters follow', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const [first] = await itemsOf(request, 'demo:checklist:waystones');
  await openMap(page);
  await openList(page, 'Waystones');
  await expect(page.getByTestId('checklist-done')).toHaveText('0 of 120 found or done');

  await itemBox(page, first!.id).check();
  await expectOverallFound(page, 1);
  await expect(page.getByTestId('checklist-done')).toHaveText('1 of 120 found or done');
  await expect(page.getByTestId('toast')).toContainText('One place marked found');

  // "Show on map" selects the place: it is found there.
  await itemRow(page, first!.id)
    .getByRole('button', { name: /on the map$/ })
    .click();
  await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'true');

  // The filters count it, and "Hide found" takes its marker off the map.
  await page.getByRole('tab', { name: 'Filters' }).click();
  expect(await categoryCount(page, 'demo:cat:waystone')).toBe('1/120');
  await page.getByRole('switch', { name: 'Hide found' }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('marker-count')).toHaveText('4,999');
  expect(errors).toEqual([]);
});

test('marking a place on the map shows in the checklist at once, and the other way round', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const [, second] = await itemsOf(request, 'demo:checklist:waystones');
  const locations = await demoLocations(request);
  const place = locations.find((l) => l.id === second!.locationIds[0])!;
  await openMap(page);
  await openList(page, 'Waystones');
  await expect(itemBox(page, second!.id)).not.toBeChecked();

  await selectByName(page, place.name);
  await page.keyboard.press('f');
  await expect(itemBox(page, second!.id)).toBeChecked();
  await expect(page.getByTestId('checklist-done')).toHaveText('1 of 120 found or done');

  await itemBox(page, second!.id).uncheck();
  await expect(page.getByTestId('found-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expectOverallFound(page, 0);

  // The details pane names the checklist the place is on, and opens it there.
  await expect(page.getByTestId('also-in')).toContainText(second!.name);
  expect(errors).toEqual([]);
});

test('Z undoes a tick that marked several places, as one change', async ({ page, request }) => {
  const errors = collectErrors(page);
  const several = (await itemsOf(request, 'demo:checklist:lore')).find(
    (i) => i.locationIds.length === 3,
  )!;
  await openMap(page);
  await openList(page, 'Lore of the isle');
  await page.getByRole('searchbox', { name: 'Search this list' }).fill(several.name);
  await itemBox(page, several.id).check();
  await expectOverallFound(page, 3);
  await expect(page.getByTestId('toast')).toContainText('3 places marked found');

  await itemBox(page, several.id).uncheck();
  await expectOverallFound(page, 0);
  await page.keyboard.press('z');
  await expectOverallFound(page, 3);
  await expect(itemBox(page, several.id)).toBeChecked();
  await page.keyboard.press('z');
  await expectOverallFound(page, 0);
  await expect(itemBox(page, several.id)).not.toBeChecked();
  await expect(page.getByTestId('toast')).toContainText('is as it was');
  expect(errors).toEqual([]);
});

test('a step without a place keeps its own tick across a reload, outside the found counter', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const [step] = await itemsOf(request, 'demo:checklist:story');
  await openMap(page);
  await openList(page, 'The Sundered Isle story');
  await expect(page.locator('.check-section').first()).toHaveText('Prologue');
  await itemBox(page, step!.id).check();
  await expect(page.getByTestId('checklist-done')).toHaveText('1 of 10 found or done');
  await expectOverallFound(page, 0);

  await page.reload();
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
  await openList(page, 'The Sundered Isle story');
  await expect(itemBox(page, step!.id)).toBeChecked();
  await expectOverallFound(page, 0);
  expect(errors).toEqual([]);
});

test('in-app links in guides and notes move the map, switching map, or open lists', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const locations = await demoLocations(request);
  const door = locations.find((l) => l.categoryId === 'demo:cat:door')!;
  await openMap(page);
  await screenButton(page).click();
  await page.getByTestId('guide-link').filter({ hasText: 'Into the Hollow Deep' }).click();
  const guide = page.getByTestId('guide-page');
  await expect(guide.getByRole('heading', { name: 'Into the Hollow Deep' })).toBeFocused();
  // Web links stay ordinary links.
  await expect(guide.locator('a')).toHaveCount(0);

  await guide.getByRole('button', { name: 'sealed door', exact: true }).click();
  await expect(page.getByTestId('selected-name')).toHaveText(door.name);
  await expect.poll(async () => (await mapStatus(page)).layer).toBe(door.layerId);
  await expect(page.getByLabel('Map', { exact: true })).toHaveValue('demo:map:deep');

  // A link to a list opens it; Back returns to the guide.
  await guide.getByRole('button', { name: 'Lore of the isle' }).click();
  await expect(page.getByRole('heading', { name: 'Lore of the isle', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Into the Hollow Deep' }).click();
  await expect(page.getByTestId('guide-page')).toBeVisible();

  // A place's own note in a list row links to another place.
  await page.getByRole('button', { name: /^Back to all/ }).click();
  await page.getByTestId('checklist-link').filter({ hasText: 'Lore of the isle' }).click();
  const note = page.locator('.check-item-note').first();
  const waystone = note.locator('button.app-link').first();
  const waystoneName = await waystone.textContent();
  await waystone.click();
  await expect(page.getByTestId('selected-name')).toHaveText(waystoneName!);
  await expect.poll(async () => (await mapStatus(page)).layer).toBe('demo:layer:surface');
  expect(errors).toEqual([]);
});

test('search finds lists, items and guides and opens them', async ({ page, request }) => {
  const errors = collectErrors(page);
  const route = await itemsOf(request, 'demo:checklist:route');
  const late = route.at(-1)!;
  await openMap(page);
  const input = page.getByRole('combobox', { name: 'Search locations' });

  await page.keyboard.press('/');
  await input.fill(late.name);
  await page.getByRole('option').filter({ hasText: 'Checklist item' }).first().click();
  await expect(page.getByRole('heading', { name: 'Treasure hunter’s route' })).toBeVisible();
  // The item at the end of a long list is scrolled to and focused.
  await expect(itemBox(page, late.id)).toBeFocused();
  await expect(itemBox(page, late.id)).toBeInViewport();

  await page.keyboard.press('/');
  await input.fill('arriving on the isle');
  // Results follow the typing a moment later; Enter opens the first one shown.
  await expect(
    page.getByRole('listbox', { name: 'Search results' }).getByRole('option').first(),
  ).toContainText('Guide');
  await input.press('Enter');
  await expect(page.getByTestId('guide-page')).toContainText('You wake on the western shore');
  expect(errors).toEqual([]);
});

test('a list filters by region and category with counts, by text, and hides found', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const route = await itemsOf(request, 'demo:checklist:route');
  const keys = route.filter((i) => i.locationIds.length > 0 && i.name.includes(' key '));
  await openMap(page);
  await openList(page, 'Treasure hunter’s route');
  await page.getByRole('button', { name: 'Filter by region and category' }).click();
  const facets = page.getByTestId('checklist-facets');
  const categories = facets.getByRole('group', { name: 'Categories' });
  await expect(categories.getByTestId('facet').filter({ hasText: 'Old key' })).toContainText(
    `0/${keys.length}`,
  );
  // Places on the second map have no region; they are listed under that map.
  await expect(facets.getByRole('group', { name: 'Regions' })).toContainText('The Hollow Deep');

  await categories.getByRole('button', { name: 'Deselect all categories' }).click();
  await expect(page.getByText('No items match the filters.')).toBeVisible();
  await categories.getByRole('checkbox', { name: /Old key/ }).check();
  await expect(page.getByTestId('check-item').first()).toContainText('key');
  await page.getByRole('searchbox', { name: 'Search this list' }).fill(keys[0]!.name);
  await expect(page.getByTestId('check-item')).toHaveCount(1);
  await itemBox(page, keys[0]!.id).check();
  await expect(categories.getByTestId('facet').filter({ hasText: 'Old key' })).toContainText(
    `1/${keys.length}`,
  );
  await page.getByRole('searchbox', { name: 'Search this list' }).fill('');
  await page.getByRole('switch', { name: 'Hide found' }).check();
  await expect(itemRow(page, keys[0]!.id)).toHaveCount(0);
  await categories.getByRole('button', { name: 'Select all categories', exact: true }).click();
  await expect(page.getByTestId('check-item').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('a list of 2,500 items opens at once and renders only what is in view', async ({ page }) => {
  const errors = collectErrors(page);
  const ids = (await demoLocations(page.request)).map((l) => l.id);
  const big: Item[] = Array.from({ length: 2500 }, (_, i) => ({
    id: `demo:checkitem:big-${i}`,
    checklistId: 'demo:checklist:big',
    name: `Generated place ${i + 1}`,
    order: i,
    locationIds: i % 50 === 0 ? [] : [ids[(i * 7) % ids.length]!],
    entityIds: [],
  }));
  await page.route('**/packs/demo/checklists.json', async (route) => {
    const lists = (await (await route.fetch()).json()) as Checklist[];
    await route.fulfill({
      json: [...lists, { id: 'demo:checklist:big', name: 'Big list', order: 9 }],
    });
  });
  await page.route('**/packs/demo/checklistItems.json', async (route) => {
    const items = (await (await route.fetch()).json()) as Item[];
    await route.fulfill({ json: [...items, ...big] });
  });
  await openMap(page);
  await screenButton(page).click();

  const started = Date.now();
  await page.getByTestId('checklist-link').filter({ hasText: 'Big list' }).click();
  await expect(itemRow(page, big[0]!.id)).toBeVisible();
  const openMs = Date.now() - started;
  const rendered = Number(await page.getByTestId('check-items').getAttribute('data-rendered'));
  expect(rendered).toBeGreaterThan(5);
  expect(rendered).toBeLessThan(80);
  await expect(page.getByTestId('check-items').locator('li').first()).toHaveAttribute(
    'aria-setsize',
    '2500',
  );

  // Ticking re-renders the ticked row, not the list.
  const tickStarted = Date.now();
  await itemBox(page, big[1]!.id).check();
  await expect(page.getByTestId('checklist-done')).toHaveText('1 of 2,500 found or done');
  const tickMs = Date.now() - tickStarted;

  // Scrolling to the end renders the last rows.
  await page.locator('.checklists').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(itemRow(page, big.at(-1)!.id)).toBeVisible();
  test
    .info()
    .annotations.push({ type: 'timing', description: `open ${openMs} ms, tick ${tickMs} ms` });
  // Generous bounds for slow machines; typical values are far lower.
  expect(openMs).toBeLessThan(1500);
  expect(tickMs).toBeLessThan(1000);
  expect(errors).toEqual([]);
});

test('on narrow windows the screen is a sheet that comes back to the item', async ({
  page,
  request,
}) => {
  const errors = collectErrors(page);
  const [, , third] = await itemsOf(request, 'demo:checklist:waystones');
  await page.setViewportSize({ width: 390, height: 844 });
  await openMap(page);
  await screenButton(page).click();
  const sheet = page.getByTestId('filters-pane');
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeCloseTo(390, 0);
  expect(box.y + box.height).toBeCloseTo(844, 0);

  await page.getByTestId('checklist-link').filter({ hasText: 'Waystones' }).click();
  await itemRow(page, third!.id)
    .getByRole('button', { name: /on the map$/ })
    .click();
  await expect(sheet).toBeHidden();
  await expect(page.getByTestId('details-pane')).toBeVisible();
  await expect(page.getByTestId('selected-name')).toBeVisible();

  await screenButton(page).click();
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Waystones', level: 2 })).toBeVisible();
  await expect(itemRow(page, third!.id)).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a pack without checklists or guides has no entry for them', async ({ page }) => {
  const id = (kind: string, local: string) => `tiny:${kind}:${local}`;
  const files: Record<string, unknown> = {
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
    'locations.json': [
      {
        id: id('loc', '1'),
        mapId: id('map', 'm'),
        layerId: id('layer', 'l'),
        x: 40,
        y: 60,
        categoryId: id('cat', 'c'),
        regionId: null,
        name: 'Tiny thing',
        entityIds: [],
        guideId: null,
        since: '1.0.0',
      },
    ],
  };
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { packs: [{ id: 'tiny', url: 'packs/tiny/', title: 'Tiny' }] } }),
  );
  await page.route('**/packs/tiny/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/tiny/')[1] ?? '';
    const body = files[name];
    return body === undefined
      ? route.fulfill({ status: 404, body: 'not found' })
      : route.fulfill({ json: body });
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('1');
  await expect(page.getByTestId('checklists-button')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.getByTestId('details-empty')).not.toContainText('Checklists');
  await page.keyboard.press('c');
  await expect(page.getByTestId('toast')).toHaveText('This game has no checklists or guides.');
});
