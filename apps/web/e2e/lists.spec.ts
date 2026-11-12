import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, openMap, reloadSaved, storedSetting } from './helpers';
import { back, choosePlace } from './touch';

/**
 * Lists in the standard layout: the lists of a game, one list by area, by
 * kind or in order, and "Only this list on the map". The demo pack has
 * nested regions (two top-level areas), places without a region (the
 * second map), a list with stages and no places, and a route of 2,015
 * steps.
 */

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const ROUTE = 'Treasure hunter’s route';

async function openLists(page: Page): Promise<void> {
  await page.getByTestId('section-lists').click();
  await expect(page.getByTestId('lists-home')).toBeVisible();
}

function list(page: Page, name: string) {
  return page.getByTestId('list-link').filter({ hasText: name });
}

test.describe('on a phone', () => {
  test.use(pixel);

  test('the lists of the game: continue, collections, routes, guides', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await openLists(page);
    const home = page.getByTestId('lists-home');
    // Nothing opened yet: nothing to continue.
    await expect(home.getByTestId('continue')).toHaveCount(0);
    await expect(home.locator('h2')).toHaveText(['Collections', 'Routes', 'Guides to read']);
    // Everything comes first, every trackable place of the game.
    const everything = home.getByTestId('list-link').first();
    await expect(everything).toHaveAttribute('data-checklist-id', 'atlas:everything');
    await expect(everything).toContainText('Everything');
    await expect(everything.locator('[data-total]')).toHaveAttribute('data-total', '5041');
    await expect(
      home.locator('section', { hasText: 'Routes' }).getByTestId('list-link'),
    ).toHaveText([new RegExp(ROUTE)]);
    await expect(home.getByTestId('guide-link').first()).toBeVisible();

    // A list opened is offered to continue, in the view it was left in.
    await list(page, 'Waystones').click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toHaveAttribute('data-view', 'area');
    await screen.getByTestId('view-kind').click();
    await page.getByTestId('lists-back').click();
    const resume = home.getByTestId('continue');
    await expect(resume).toContainText('Waystones');
    await expect(resume).toContainText('Next up');
    await expect(home.locator('h2').first()).toHaveText('Continue');
    await resume.getByTestId('continue-resume').click();
    await expect(screen).toHaveAttribute('data-view', 'kind');
    expect(errors).toEqual([]);
  });

  test('each list keeps the view chosen last; a route opens in order', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await openLists(page);
    const screen = page.getByTestId('checklist-screen');
    await list(page, ROUTE).click();
    await expect(screen).toHaveAttribute('data-view', 'order');
    await page.getByTestId('lists-back').click();
    // A list with no place at all opens in order too.
    await list(page, 'The Sundered Isle story').click();
    await expect(screen).toHaveAttribute('data-view', 'order');
    await page.getByTestId('lists-back').click();

    await list(page, 'Waystones').click();
    await expect(screen).toHaveAttribute('data-view', 'area');
    await screen.getByTestId('view-order').click();
    await expect(screen).toHaveAttribute('data-view', 'order');
    await expect
      .poll(() => storedSetting(page, 'listViews:demo'))
      .toEqual({
        'demo:checklist:waystones': 'order',
      });
    await reloadSaved(page);
    await openLists(page);
    await list(page, 'Waystones').click();
    await expect(screen).toHaveAttribute('data-view', 'order');
    // Other lists keep their own.
    await page.getByTestId('lists-back').click();
    await list(page, 'Lore of the isle').click();
    await expect(screen).toHaveAttribute('data-view', 'area');
    expect(errors).toEqual([]);
  });

  test('by area: the map’s area first, an area by kind, the next area, and Back', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await openLists(page);
    await list(page, 'Everything').click();
    const areas = page.getByTestId('area-link');
    // The two top-level areas, and the places of the second map, which have none.
    await expect(areas).toHaveCount(3);
    await expect(areas.first().getByTestId('map-is-here')).toBeVisible();
    await expect(areas.last()).toContainText('No area');
    const first = (await areas.first().getAttribute('data-area'))!;

    await areas.first().click();
    const area = page.getByTestId('area-screen');
    await expect(area).toHaveAttribute('data-area', first);
    await expect(area.getByTestId('area-done')).toContainText('Everything ·');
    // To find: by kind, with what is left.
    await expect(area.getByTestId('show-todo')).toHaveAttribute('aria-pressed', 'true');
    await expect(area.getByTestId('kind-group').first()).toHaveAttribute('aria-expanded', 'true');
    const entry = area.getByTestId('check-item').first();
    const id = (await entry.getAttribute('data-item-id'))!;
    await entry.getByTestId('entry-tick').click();
    // Ticked, it stays under the finger until the choice changes.
    await expect(area.locator(`[data-item-id="${id}"]`)).toHaveAttribute('data-done', 'true');
    await expect(area.getByTestId('area-done')).toHaveAttribute('data-done', '1');
    await area.getByTestId('show-all').click();
    await expect(area.locator(`[data-item-id="${id}"]`)).toHaveAttribute('data-done', 'true');
    await area.getByTestId('show-todo').click();
    await expect(area.getByTestId('show-todo')).toContainText('To find ·');
    await expect(area.locator(`[data-item-id="${id}"]`)).toHaveCount(0);
    // A kind closes and opens.
    const kind = area.getByTestId('kind-group').first();
    await kind.click();
    await expect(kind).toHaveAttribute('aria-expanded', 'false');
    await kind.click();
    await expect(kind).toHaveAttribute('aria-expanded', 'true');

    // The next area takes this one's place.
    await area.getByTestId('next-area').click();
    await expect(area).not.toHaveAttribute('data-area', first);
    // Back: the list, then all lists, then the map.
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('checklist-screen')).toHaveAttribute('data-view', 'area');
    expect(await back(page)).toBe(true);
    await expect(page.getByTestId('lists-home')).toBeVisible();
    expect(await back(page)).toBe(true);
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');

    // The map button of an area fits the map to it, and shows the map.
    await openLists(page);
    await list(page, 'Waystones').click();
    await page.getByTestId('area-link').first().click();
    await page.getByTestId('area-on-map').click();
    await expect(page.locator('.touch')).toHaveAttribute('data-section', 'map');
    expect(errors).toEqual([]);
  });

  test('in order: Next up, Done, the done steps folded, and stages', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await openLists(page);
    await list(page, ROUTE).click();
    const screen = page.getByTestId('checklist-screen');
    const nextUp = page.getByTestId('next-up');
    await expect(nextUp.getByTestId('next-up-name')).toHaveText('Buy a bigger satchel');
    await expect(screen.locator('[data-next="true"]')).toContainText('Buy a bigger satchel');
    for (let i = 1; i <= 3; i++) {
      await nextUp.getByTestId('next-up-done').click();
      await expect(screen.getByTestId('checklist-done')).toHaveAttribute('data-done', String(i));
    }
    const name = (await nextUp.getByTestId('next-up-name').textContent())!;
    await expect(screen.locator('[data-next="true"]')).toContainText(name);
    // Steps 1 to 3 are one row, until shown.
    const run = screen.getByTestId('done-run');
    await expect(run).toHaveText(/Steps 1 to 3 are done/);
    await expect(screen.locator('[data-done="true"]')).toHaveCount(0);
    await run.click();
    await expect(screen.locator('[data-done="true"]')).toHaveCount(3);

    // What else there is to find where the next step is: Everything, on that area.
    const here = screen.getByTestId('while-here');
    await expect(here).toContainText(/While you are here: [\d,]+ more to find in /);
    await here.click();
    await expect(page.getByTestId('area-screen').getByTestId('area-done')).toContainText(
      'Everything ·',
    );
    expect(await back(page)).toBe(true);
    await expect(screen).toHaveAttribute('data-view', 'order');

    // A list with stages: a finished stage closes and is ticked.
    await page.getByTestId('lists-back').click();
    await list(page, 'The Sundered Isle story').click();
    const stages = screen.getByTestId('stage');
    await expect(stages.first()).toHaveAttribute('aria-expanded', 'true');
    for (let i = 0; i < 3; i++) await nextUp.getByTestId('next-up-done').click();
    await expect(stages.first()).toHaveAttribute('aria-expanded', 'false');
    await expect(stages.first()).toContainText('3 of 3');
    await expect(stages.nth(1)).toHaveAttribute('aria-expanded', 'true');
    // The story's steps have no place: nothing to show on the map.
    await expect(nextUp.getByTestId('next-up-show')).toHaveCount(0);
    await expect(screen.getByTestId('list-only-switch')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('only this list on the map, and the filters as they were after', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    const count = page.getByTestId('marker-count');
    // The player's own choice: herbs alone.
    await page.locator('[data-testid="kind-chip"][data-category="demo:cat:herb"]').click();
    await expect(count).toHaveText('1,494');

    await openLists(page);
    await list(page, 'Waystones').click();
    const only = page.getByTestId('list-only-switch');
    await expect(only).toHaveAttribute('aria-checked', 'true');
    await expect(count).toHaveText('120');
    await only.click();
    await expect(only).toHaveAttribute('aria-checked', 'false');
    await expect(count).toHaveText('1,494');
    await only.click();
    await expect(count).toHaveText('120');

    // On the map, a chip says so, and turns it off.
    await page.getByTestId('section-map').click();
    const chip = page.getByTestId('list-only-chip');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(count).toHaveText('1,494');
    await chip.click();
    await expect(count).toHaveText('120');
    await expect(
      page.locator('[data-testid="kind-chip"][data-category="demo:cat:herb"]'),
    ).toHaveAttribute('aria-pressed', 'true');

    // Leaving the list puts back what was shown before.
    await page.getByTestId('section-lists').click();
    await page.getByTestId('lists-back').click();
    await expect(count).toHaveText('1,494');
    await page.getByTestId('section-map').click();
    await expect(page.getByTestId('list-only-chip')).toHaveCount(0);
    await expect(
      page.locator('[data-testid="kind-chip"][data-category="demo:cat:herb"]'),
    ).toHaveAttribute('aria-pressed', 'true');

    // Off is kept on this device.
    await openLists(page);
    await list(page, 'Waystones').click();
    await page.getByTestId('list-only-switch').click();
    await expect.poll(() => storedSetting(page, 'listOnlyOnMap')).toBe(false);
    await reloadSaved(page);
    await openLists(page);
    await list(page, 'Waystones').click();
    await expect(page.getByTestId('list-only-switch')).toHaveAttribute('aria-checked', 'false');
    await expect(count).toHaveText('1,494');
    expect(errors).toEqual([]);
  });
});

test.describe('on a computer', () => {
  test('a route in order: the card on the map, Done, Skip, and the F and N keys', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=standard');
    await page.keyboard.press('c');
    await list(page, ROUTE).click();
    const screen = page.getByTestId('checklist-screen');
    const card = page.getByTestId('next-up-card');
    const name = card.getByTestId('next-up-name');
    await expect(name).toHaveText('Buy a bigger satchel');
    await expect(card).toContainText('step 1 of 2,015');
    await expect(card).toContainText('F marks it done, N goes to the next step');

    // F: the next step done.
    await page.keyboard.press('f');
    await expect(screen.getByTestId('checklist-done')).toHaveAttribute('data-done', '1');
    const second = (await name.textContent())!;
    expect(second).not.toBe('Buy a bigger satchel');
    // N: the step after, nothing marked; Skip does the same.
    await page.keyboard.press('n');
    await expect(name).not.toHaveText(second);
    const third = (await name.textContent())!;
    await card.getByTestId('next-up-skip').click();
    await expect(name).not.toHaveText(third);
    await expect(screen.getByTestId('checklist-done')).toHaveAttribute('data-done', '1');
    await expect(screen.locator('[data-next="true"]')).not.toContainText(second);

    // A row selects its place; the place's card takes the corner, then gives it back.
    await screen.locator('[data-next="true"]').getByTestId('entry-show').click();
    await expect(page.getByTestId('place-sheet')).toBeVisible();
    await expect(card).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(card).toBeVisible();

    // The chip over the map shows the list alone, or not.
    const chip = page.getByTestId('list-only-chip');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await chip.click();
    await expect(screen.getByTestId('list-only-switch')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');

    // Other views keep the keys as they were: N goes to the nearest place.
    await screen.getByTestId('view-area').click();
    await expect(card).toHaveCount(0);
    await page.keyboard.press('n');
    await expect(page.getByTestId('place-sheet')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('an entry asked for from a place opens its list in order, this time', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=standard');
    await choosePlace(page, 'Lore tablet 15');
    await page
      .getByTestId('place-lists')
      .getByRole('button', { name: /On the checklist Lore of the isle/ })
      .click();
    const screen = page.getByTestId('checklist-screen');
    await expect(screen).toHaveAttribute('data-view', 'order');
    await expect(screen.locator('[data-item-id="demo:checkitem:lore-001"]')).toBeVisible();
    // Not kept: the list opens by area again.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('lists-home')).toBeVisible();
    await list(page, 'Lore of the isle').click();
    await expect(screen).toHaveAttribute('data-view', 'area');
    expect(errors).toEqual([]);
  });
});
