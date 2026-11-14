import { devices, type Page } from '@playwright/test';
import { collectErrors, demoLocations, reloadSaved, storedSetting } from './helpers';
import { expect, test } from './layout';
import { choosePlace } from './touch';

/**
 * The build planner, in the standard layout on the demo game and its
 * made-up wiki: "Add to build" from a page, a row of a page's table, a
 * result of the search and a location's card, into a Build guide asked
 * for once and remembered; nothing added twice; the list as it is used;
 * "Find on the map" and its check panel (found, several possible, not
 * found), nothing put on a step until confirmed; "Suggest an order" and the
 * line on the map. On a phone, collecting works and finding says it needs
 * a wider screen.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const body = (page: Page) => page.getByTestId('guides-body');
const shownPage = (page: Page) => page.getByTestId('guides-page');
const toast = (page: Page) => page.getByTestId('toast');

/** Opens a page of the demo wiki's Gear section in Guides. */
async function openGearPage(page: Page, title: string): Promise<void> {
  await page.getByTestId('section-guides').click();
  const crumbs = page.locator('.guides-crumbs');
  if ((await crumbs.locator('button', { hasText: 'Contents' }).count()) > 0) {
    await crumbs.locator('button', { hasText: 'Contents' }).click();
  }
  await body(page).getByTestId('guides-section').filter({ hasText: 'Gear' }).click();
  await body(page).getByTestId('guides-page-link').filter({ hasText: title }).click();
  await expect(shownPage(page).locator('h1')).toHaveText(title);
}

/** The first "Add to build": the question, answered with a new Build guide. */
async function startBuild(page: Page, name: string): Promise<void> {
  const dialog = page.getByTestId('build-list-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('build-list-new')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByTestId('build-list-name')).toBeFocused();
  await dialog.getByTestId('build-list-name').fill(name);
  await dialog.getByTestId('build-list-done').click();
  await expect(dialog).toHaveCount(0);
}

const rowButton = (page: Page, name: string) =>
  shownPage(page).getByRole('button', { name: `Add “${name}” to build`, exact: true });

interface StoredLists {
  lists: {
    checklist: { name: string; type: string };
    items: { name: string; note?: string; locationIds: string[] }[];
  }[];
}

async function storedLists(page: Page): Promise<StoredLists | null> {
  const text = (await storedSetting(page, 'ownLists:demo')) as string | undefined;
  return text ? (JSON.parse(text) as StoredLists) : null;
}

/** Collects the demo build: a page, a table row, a page by its row, a search result, a card. */
async function collect(page: Page): Promise<void> {
  await openGearPage(page, 'Ember blade');
  await shownPage(page).getByTestId('add-to-build').click();
  await startBuild(page, 'Ember build');
  await expect(toast(page)).toHaveText(/Added “Ember blade” to Ember build\./);
  // The next things go to the same list with one press.
  await rowButton(page, 'Moonpetal').click();
  await expect(toast(page)).toHaveText(/Added “Moonpetal” to Ember build\./);
  await openGearPage(page, 'Blades');
  await rowButton(page, 'Stonebreaker maul').click();
  await expect(toast(page)).toHaveText(/Added “Stonebreaker maul” to Ember build\./);
  await page.getByTestId('guides-search').first().fill('tidecaller');
  await page
    .getByTestId('guides-results')
    .getByRole('button', { name: 'Add “Tidecaller charm” to build' })
    .click();
  await expect(toast(page)).toHaveText(/Added “Tidecaller charm” to Ember build\./);
  await page.getByTestId('section-map').click();
  await choosePlace(page, 'Frost wyrm 2');
  await page.getByTestId('place-sheet').getByTestId('add-to-build').click();
  await expect(toast(page)).toHaveText(/Added “Frost wyrm 2” to Ember build\./);
}

const STEPS = ['Ember blade', 'Moonpetal', 'Stonebreaker maul', 'Tidecaller charm', 'Frost wyrm 2'];

test.describe('on a computer', () => {
  test('collects from a page, a table row, the search and a card, each once', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await collect(page);

    // The same things again: not added twice, and said so.
    await page.getByTestId('place-sheet').getByTestId('add-to-build').click();
    await expect(toast(page)).toHaveText('“Frost wyrm 2” is in Ember build already.');
    await openGearPage(page, 'Ember blade');
    await expect(page.getByTestId('add-to-build-bar')).toContainText('to Ember build');
    await shownPage(page).getByTestId('add-to-build').click();
    await expect(toast(page)).toHaveText('“Ember blade” is in Ember build already.');
    // A row's page is the page: added from the row, it is there already.
    await openGearPage(page, 'Stonebreaker maul');
    await shownPage(page).getByTestId('add-to-build').click();
    await expect(toast(page)).toHaveText('“Stonebreaker maul” is in Ember build already.');
    // A box of facts and a table of steps have no row buttons.
    await expect(shownPage(page).locator('[data-build-row]')).toHaveCount(0);

    // Undo takes the step out again.
    await openGearPage(page, 'Ember blade');
    await rowButton(page, 'Saltleaf').click();
    await expect(toast(page)).toHaveText(/Added “Saltleaf”/);
    await toast(page).getByTestId('toast-action').click();
    await expect(toast(page)).toHaveText('Took “Saltleaf” out of Ember build.');

    // Kept as an ordinary own list: each thing a step, a page linked in its note.
    await expect
      .poll(async () => (await storedLists(page))?.lists[0]?.items.map((i) => i.name))
      .toEqual(STEPS);
    const [list] = (await storedLists(page))!.lists;
    expect(list!.checklist).toMatchObject({ name: 'Ember build', type: 'build' });
    expect(list!.items[0]!.note).toBe('[Ember blade](demo:guide:wiki-ember-blade)');
    expect(list!.items[2]!.note).toBe('[Stonebreaker maul](demo:guide:wiki-stonebreaker-maul)');
    expect(list!.items[1]!.note).toBeUndefined();
    const wyrm = (await demoLocations(page.request)).find((l) => l.name === 'Frost wyrm 2')!;
    expect(list!.items[4]!.locationIds).toEqual([wyrm.id]);
    await expect.poll(() => storedSetting(page, 'buildList:demo')).toMatch(/^demo:checklist:own\./);

    // "Change": another list, remembered for what comes next.
    await page.getByTestId('build-list-change').click();
    const dialog = page.getByTestId('build-list-dialog');
    await expect(dialog.getByTestId('build-list-choice')).toHaveAttribute('aria-checked', 'true');
    await dialog.getByTestId('build-list-new').click();
    await dialog.getByTestId('build-list-name').fill('Frost build');
    await dialog.getByTestId('build-list-done').click();
    await expect(page.getByTestId('add-to-build-bar')).toContainText('to Frost build');

    // The list as it is used: its steps, and the page linked from the step.
    await reloadSaved(page);
    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'Ember build' }).click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toHaveAttribute('data-list-type', 'build');
    for (const name of STEPS) await expect(screen).toContainText(name);
    await expect(page.getByTestId('list-find-on-map')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('finds the steps on the map, asks among several, and orders them', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    // The wardens' page linked to every warden: the maul's page links to it.
    await page.getByTestId('section-guides').click();
    await page.getByTestId('open-guide-links').click();
    await page.getByTestId('link-confirm-all').click();
    await expect(page.getByTestId('guide-links-status')).toContainText('Saved');
    await collect(page);

    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'Ember build' }).click();
    await page.getByTestId('list-find-on-map').click();
    const panel = page.getByTestId('find-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('editor-map-hint')).toHaveText(
      'Check what was found, then put it on the steps',
    );
    await expect(panel.getByTestId('find-summary')).toContainText(
      'One step has a location already and stays as it is.',
    );

    // Found: the place named under "Where to find" on the blade's page.
    const shrine = (await demoLocations(page.request)).find((l) =>
      /^Sunken shrine \d+$/.test(l.name),
    )!;
    const found = panel.getByTestId('find-found').getByTestId('find-step');
    await expect(found).toHaveCount(1);
    await expect(found).toContainText('Ember blade');
    await expect(found).toContainText('Named in its page');
    await expect(found).toContainText(shrine.name);
    await expect(found).toContainText('Ruin');
    await expect(found.getByTestId('find-use')).toBeChecked();

    // Several possible: by name, and through the page linked to the map.
    const several = panel.getByTestId('find-several').getByTestId('find-step');
    await expect(several).toHaveCount(2);
    const moonpetal = several.filter({ hasText: 'Moonpetal' });
    await expect(moonpetal).toContainText('By its name');
    await expect(moonpetal).toContainText('possible locations, nearest first');
    await expect(moonpetal.getByTestId('find-choice')).toHaveCount(5);
    await moonpetal.getByTestId('find-more').click();
    await expect(moonpetal.getByTestId('find-choice')).toHaveCount(15);
    const maul = several.filter({ hasText: 'Stonebreaker maul' });
    await expect(maul).toContainText('Named in its page');
    await expect(maul).toContainText('Elite foe');
    // Nothing is chosen for them yet.
    await expect(moonpetal.getByTestId('find-choice-none').locator('input')).toBeChecked();

    // Not found, said plainly.
    const none = panel.getByTestId('find-none').getByTestId('find-step');
    await expect(none).toHaveText(
      /Tidecaller charm\s*No location found\. It stays a step with no location\./,
    );

    // A location can be looked at on the map before it is chosen.
    const first = moonpetal.getByTestId('find-choice').first();
    await first.getByTestId('find-show').click();
    await expect(first.getByTestId('find-show')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.atlas-step-pick')).toHaveCount(1);
    const chosenName = (await first.locator('.editor-location-name').textContent())!;
    await first.locator('input').check();
    await expect(panel.getByTestId('find-confirm')).toHaveText('Put on 2 steps');

    // Nothing is put on a step until it is confirmed.
    const rows = page.getByTestId('editor-rows').getByTestId('editor-row');
    await expect(rows.filter({ hasText: 'Ember blade' })).toContainText('No location');
    await panel.getByTestId('find-confirm').click();
    await expect(panel).toHaveCount(0);
    await expect(toast(page)).toContainText('Put locations on 2 steps.');
    await expect(rows.filter({ hasText: 'Ember blade' })).toContainText('Ruin');
    await expect(rows.filter({ hasText: 'Moonpetal' })).toContainText('Wild herb');
    await expect(rows.filter({ hasText: 'Stonebreaker maul' })).toContainText('No location');
    await expect(rows.filter({ hasText: 'Tidecaller charm' })).toContainText('No location');
    await rows.filter({ hasText: 'Moonpetal' }).locator('.editor-row-main').click();
    await expect(page.getByTestId('step-location')).toContainText(chosenName);

    // Suggest an order, and what it knows, said once.
    await expect(page.getByTestId('editor-order-note')).toHaveText(
      'Nearest next, in a straight line: it knows nothing of locked doors, story order, merchants or random drops.',
    );
    await page.getByTestId('editor-suggest').click();
    await expect(toast(page)).toContainText('suggested order');
    const names = await rows
      .locator('.editor-row-name')
      .evaluateAll((items) => items.map((item) => item.lastChild?.textContent ?? ''));
    // Steps with no location keep their place after the step they followed.
    const at = names.indexOf('Moonpetal');
    expect(names.slice(at, at + 3)).toEqual(['Moonpetal', 'Stonebreaker maul', 'Tidecaller charm']);
    expect(names[0]).toBe('Ember blade');
    // The route on the map: the three steps with a location, joined.
    await expect(page.locator('.atlas-step')).toHaveCount(3);
    await expect(page.locator('.atlas-step-line')).toHaveCount(1);

    // Found again: only the steps still without a location.
    await page.getByTestId('editor-find').click();
    await expect(panel.getByTestId('find-summary')).toContainText(
      '3 steps have a location already and stay as they are.',
    );
    await expect(panel.getByTestId('find-found')).toHaveCount(0);
    await panel.getByTestId('find-close').click();
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('collects into a build, and says finding needs a wider screen', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await page.getByTestId('section-guides').click();
    await body(page).getByTestId('guides-section').filter({ hasText: 'Gear' }).click();
    await body(page).getByTestId('guides-page-link').filter({ hasText: 'Ember blade' }).click();
    await shownPage(page).getByTestId('add-to-build').click();
    await startBuild(page, 'Pocket build');
    await expect(toast(page)).toHaveText(/Added “Ember blade” to Pocket build\./);
    await rowButton(page, 'Relic shard').click();
    await expect(toast(page)).toHaveText(/Added “Relic shard” to Pocket build\./);

    await page.getByTestId('section-lists').click();
    await page.getByTestId('list-link').filter({ hasText: 'Pocket build' }).click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toContainText('Relic shard');
    await expect(page.getByTestId('own-lists-phone-note')).toHaveText(
      'Find on the map and Suggest an order need a wider screen: a tablet on its side, or a computer. Here you can add to the list with Add to build.',
    );
    await expect(page.getByTestId('list-find-on-map')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
