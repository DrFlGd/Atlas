import { readFile, writeFile } from 'node:fs/promises';
import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, demoLocations, openMap, reloadSaved, type PackLocation } from './helpers';
import { mapSettled, screenPoint } from './touch';

/**
 * The list editor in the standard layout on a computer (1280 by 800): a
 * list of one's own made from a template, steps added from the map, by
 * type, by name, blank and as headings, moved with the keyboard, a note
 * with a link and hidden text, Preview, optional steps and Next up,
 * "Suggest an order", saving, and a list file out and back in. On a phone
 * own lists can be used but not made.
 */

const STANDARD = './?ui=standard';

async function place(page: Page, name: string): Promise<PackLocation> {
  const places = await demoLocations(page.request);
  return places.find((l) => l.name === name)!;
}

async function openLists(page: Page): Promise<void> {
  await page.getByTestId('section-lists').click();
  await expect(page.getByTestId('lists-home')).toBeVisible();
}

/** New list or guide, from a template; the editor opens on it. */
async function newList(page: Page, name: string, template: string): Promise<void> {
  await openLists(page);
  await page.getByTestId('new-own-list').click();
  const dialog = page.getByTestId('template-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('own-list-name')).toBeFocused();
  await page.getByTestId('own-list-name').fill(name);
  await dialog.getByTestId(`template-${template}`).click();
  await expect(dialog.getByTestId(`template-${template}`)).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('template-start').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('list-editor')).toBeVisible();
  await expect(page.getByTestId('editor-name')).toHaveText(name);
}

const rows = (page: Page) => page.getByTestId('editor-rows').getByTestId('editor-row');

/** The outline as the names of its rows, headings and steps. */
async function outline(page: Page): Promise<string[]> {
  return rows(page).evaluateAll((items) =>
    items.map(
      (item) =>
        item.querySelector('.editor-row-name')?.lastChild?.textContent ??
        item.querySelector('.editor-heading-title')?.textContent ??
        '',
    ),
  );
}

async function saved(page: Page): Promise<void> {
  await expect(page.getByTestId('save-state')).toHaveAttribute('data-state', 'saved');
}

/** Add › Search: adds locations by name, one after another. */
async function addByName(page: Page, ...names: string[]): Promise<void> {
  if ((await page.getByTestId('add-panel').count()) === 0) {
    await page.getByTestId('editor-add').click();
  }
  await page.getByTestId('add-tab-search').click();
  for (const name of names) {
    await page.getByTestId('add-search-input').fill(name);
    await page.getByRole('button', { name: `Add ${name}`, exact: true }).click();
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }
}

test.describe('on a computer', () => {
  test('a build guide: from the map, by type, by name, blank steps and headings', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'Waystone build', 'build');
    await expect(page.locator('.editor-badge')).toHaveText('Editing');
    // An empty list starts with the ways to add steps.
    await expect(page.getByTestId('add-panel')).toBeVisible();
    await expect(page.getByTestId('editor-map-hint')).toHaveText(
      'Tap a location to add it at the end',
    );

    // By name.
    await addByName(page, 'Thornwood waystone 1');
    await expect(rows(page)).toHaveCount(1);

    // A tap on a location of the map adds it after the open step.
    await rows(page).first().locator('.editor-row-main').click();
    await expect(page.getByTestId('step-panel')).toContainText('Step 1 of 1');
    await expect(page.getByTestId('editor-map-hint')).toHaveText(
      'Tap a location to add it after step 1',
    );
    const second = await place(page, 'Thornwood waystone 95');
    await mapSettled(page);
    const point = await screenPoint(page, second);
    await page.mouse.click(point.x, point.y);
    await expect(rows(page)).toHaveCount(2);
    expect(await outline(page)).toEqual(['Thornwood waystone 1', 'Thornwood waystone 95']);
    // The new step is open, and a tap selects nothing.
    await expect(page.getByTestId('step-panel')).toContainText('Step 2 of 2');
    await expect(page.getByTestId('step-name')).toHaveValue('Thornwood waystone 95');
    await expect(page.getByTestId('place-sheet')).toHaveCount(0);
    // Both are numbered on the map, joined in order.
    await expect(page.locator('.atlas-step')).toHaveCount(2);
    await expect(page.locator('.atlas-step-line')).toHaveCount(1);

    // A type in an area: every waystone of Thornwood, but not the two in the list.
    await page.getByTestId('editor-add').click();
    await page.getByTestId('add-tab-type').click();
    await page.getByTestId('add-type-area').selectOption('demo:region:thornwood');
    const waystones = page.getByTestId('add-type-row').filter({ hasText: 'Waystone' });
    await expect(waystones).toContainText('2 are already in the list');
    const total = Number(await waystones.locator('.editor-type-count').textContent());
    await waystones.locator('input').check();
    await expect(page.getByTestId('editor-map-hint')).toHaveText(
      `${total - 2} locations are picked`,
    );
    await expect(page.locator('.atlas-step-pick')).toHaveCount(total - 2);
    await page.getByTestId('add-type-submit').click();
    await expect(rows(page)).toHaveCount(total);
    await expect(page.getByTestId('toast')).toContainText(`Added ${total - 2} locations.`);
    // None is added twice.
    const names = await outline(page);
    expect(new Set(names).size).toBe(names.length);
    // Ticking it again offers nothing new.
    await expect(waystones.locator('input')).toBeDisabled();

    // Blank: a step with no location, and a heading.
    await page.getByTestId('add-tab-blank').click();
    await page.getByTestId('add-blank-name').fill('Talk to the smith');
    await page.getByTestId('add-blank-submit').click();
    const smith = rows(page).filter({ hasText: 'Talk to the smith' });
    await expect(smith).toContainText('No location');
    await expect(page.getByTestId('step-name')).toBeFocused();
    await page.getByTestId('editor-heading').click();
    await expect(page.getByTestId('heading-title')).toBeFocused();
    await page.getByTestId('heading-title').fill('Late game');
    await expect(rows(page).filter({ hasText: 'Late game' })).toHaveAttribute(
      'data-kind',
      'heading',
    );
    await expect(rows(page)).toHaveCount(total + 2);
    await saved(page);
    expect(errors).toEqual([]);
  });

  test('moving steps with the keyboard, and Suggest an order with Undo', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'Out of order', 'route');
    // Far, then near: the nearest next from the first is the third.
    await addByName(page, 'Thornwood waystone 1', 'Thornwood waystone 81', 'Thornwood waystone 48');
    const added = ['Thornwood waystone 1', 'Thornwood waystone 81', 'Thornwood waystone 48'];
    expect(await outline(page)).toEqual(added);

    // Alt and an arrow on a row's handle move it; the focus stays on it.
    const handle = page.getByRole('button', { name: 'Move Thornwood waystone 48' });
    await handle.focus();
    await page.keyboard.press('Alt+ArrowUp');
    expect(await outline(page)).toEqual([added[0], added[2], added[1]]);
    await expect(page.getByRole('button', { name: 'Move Thornwood waystone 48' })).toBeFocused();
    await page.keyboard.press('Alt+ArrowDown');
    expect(await outline(page)).toEqual(added);
    // Move up and Move down, on the open step.
    await rows(page).nth(2).locator('.editor-row-main').click();
    await page.getByTestId('move-up').click();
    expect(await outline(page)).toEqual([added[0], added[2], added[1]]);
    await page.getByTestId('move-down').click();
    expect(await outline(page)).toEqual(added);

    // Suggest an order: nearest next. Undo puts it back.
    await page.getByTestId('editor-suggest').click();
    expect(await outline(page)).toEqual([added[0], added[2], added[1]]);
    await expect(page.getByTestId('toast')).toContainText('suggested order');
    await page.getByTestId('toast-action').click();
    expect(await outline(page)).toEqual(added);

    // Delete a step, and Undo.
    await rows(page).nth(1).locator('.editor-row-main').click();
    await page.getByTestId('delete-step').click();
    expect(await outline(page)).toEqual([added[0], added[2]]);
    await page.getByTestId('toast-action').click();
    expect(await outline(page)).toEqual(added);
    await saved(page);
    expect(errors).toEqual([]);
  });

  test('a note with a link and hidden text, an optional step, Preview and Next up', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'Two steps', 'build');
    await addByName(page, 'Thornwood waystone 1', 'Thornwood waystone 95');

    // The note of step 1: text, a link to a location found by name, hidden text.
    await rows(page).first().locator('.editor-row-main').click();
    const note = page.getByTestId('step-note');
    await note.fill('Past the bridge, see ');
    await note.press('End');
    await page.getByTestId('note-link').click();
    await page.getByTestId('location-finder').fill('Thornwood waystone 95');
    await page.getByTestId('location-hit').first().click();
    const linked = await place(page, 'Thornwood waystone 95');
    await expect(note).toHaveValue(`Past the bridge, see [Thornwood waystone 95](${linked.id})`);
    await note.press('End');
    await note.pressSequentially('. Drop down the cliff');
    // The last words selected, then Hide.
    await note.evaluate((element: HTMLTextAreaElement) => {
      const at = element.value.indexOf('Drop down the cliff');
      element.setSelectionRange(at, element.value.length);
    });
    await page.getByTestId('note-hide').click();
    await expect(note).toHaveValue(
      `Past the bridge, see [Thornwood waystone 95](${linked.id}). ||Drop down the cliff||`,
    );
    await expect(rows(page).first().getByTestId('mark-hidden')).toBeVisible();
    // Shown as it will be.
    const shown = page.locator('.editor-note-shown');
    await expect(shown.locator('.app-link')).toHaveText('Thornwood waystone 95');
    await expect(shown.getByRole('button', { name: 'Show hidden text' })).toBeVisible();

    // Step 1 is optional: Next up passes over it.
    await page.getByTestId('optional-switch').click();
    await expect(page.getByTestId('optional-switch')).toHaveAttribute('aria-checked', 'true');
    await expect(rows(page).first().getByTestId('mark-optional')).toHaveText('Optional');
    // On the map, drawn as optional once another step is open.
    await rows(page).nth(1).locator('.editor-row-main').click();
    await expect(page.locator('.atlas-step-optional')).toHaveCount(1);

    // Preview: the list as it will be used, and a clear way back.
    await page.getByTestId('editor-preview').click();
    await expect(page.getByTestId('editor-preview-bar')).toBeVisible();
    await expect(page.getByTestId('back-to-editing')).toBeFocused();
    await expect(page.getByTestId('list-editor')).toHaveCount(0);
    await expect(page.getByTestId('next-up-name')).toHaveText('Thornwood waystone 95');
    const first = page.getByTestId('check-item').first();
    await expect(first).toContainText('Optional');
    await first.getByTestId('entry-more').click();
    const body = first.getByTestId('entry-more-body');
    await expect(body.locator('.app-link')).toHaveText('Thornwood waystone 95');
    await expect(body.getByText('Drop down the cliff')).toBeHidden();
    await body.getByRole('button', { name: 'Show hidden text' }).click();
    await expect(body.getByText('Drop down the cliff')).toBeVisible();
    await page.getByTestId('back-to-editing').click();
    await expect(page.getByTestId('list-editor')).toBeVisible();
    await saved(page);
    expect(errors).toEqual([]);
  });

  test('kept after a reload; Done, rename, change template and delete', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'Kept', 'collection');
    await addByName(page, 'Thornwood waystone 1');
    // Renamed in place.
    await page.getByTestId('editor-name').click();
    await page.getByTestId('editor-name-input').fill('Kept list');
    await page.getByTestId('editor-name-input').press('Enter');
    await expect(page.getByTestId('editor-name')).toHaveText('Kept list');
    await saved(page);

    await reloadSaved(page);
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await openLists(page);
    const own = page.getByTestId('own-lists');
    const link = own.getByTestId('list-link').filter({ hasText: 'Kept list' });
    await expect(link).toContainText('Collection');
    await link.click();
    await page.getByTestId('edit-own-list').click();
    expect(await outline(page)).toEqual(['Thornwood waystone 1']);

    // Change template: nothing is lost.
    await page.getByTestId('list-menu').click();
    await page.getByTestId('menu-change-template').click();
    await page.getByTestId('template-dialog').getByTestId('template-route').click();
    await page.getByTestId('template-dialog').getByTestId('template-start').click();
    await expect(page.locator('.editor-head-figure')).toContainText('100% route');
    expect(await outline(page)).toEqual(['Thornwood waystone 1']);
    await expect(page.getByTestId('optional-switch')).toBeVisible();

    // Done: the list as it is used.
    await page.getByTestId('editor-done').click();
    await expect(page.getByTestId('list-editor')).toHaveCount(0);
    await expect(page.getByTestId('edit-own-list')).toBeVisible();

    // Delete, after asking; Undo brings it back.
    await page.getByTestId('edit-own-list').click();
    await page.getByTestId('list-menu').click();
    await page.getByTestId('menu-delete').click();
    await page.getByTestId('confirm-delete-list').click();
    await expect(page.getByTestId('lists-home')).toBeVisible();
    await expect(own.getByTestId('list-link')).toHaveCount(0);
    await page.getByTestId('toast-action').click();
    await expect(own.getByTestId('list-link')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('a list file: exported without marks, imported back, refused for another game', async ({
    page,
  }, testInfo) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'To share', 'route');
    await addByName(page, 'Thornwood waystone 1', 'Thornwood waystone 95');
    await page.getByTestId('add-tab-blank').click();
    await page.getByTestId('add-blank-name').fill('Ask the ferryman');
    await page.getByTestId('add-blank-submit').click();
    // Steps done in Preview are the person's progress, not the list's: a
    // location found, and a step with no location ticked.
    await page.getByTestId('editor-preview').click();
    await page.getByTestId('check-item').first().getByTestId('entry-tick').click();
    await page.getByTestId('check-item').nth(2).getByTestId('entry-tick').click();
    await page.getByTestId('back-to-editing').click();
    await saved(page);

    await page.getByTestId('list-menu').click();
    const downloading = page.waitForEvent('download');
    await page.getByTestId('menu-export').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe('To share.atlaslist');
    const file = testInfo.outputPath('to-share.atlaslist');
    await download.saveAs(file);
    const text = await readFile(file, 'utf8');
    const json = JSON.parse(text) as {
      format: string;
      gameId: string;
      list: { checklist: { name: string }; items: unknown[] };
    };
    expect(json.format).toBe('atlas-list');
    expect(json.gameId).toBe('demo');
    expect(json.list.checklist.name).toBe('To share');
    expect(json.list.items).toHaveLength(3);
    expect(text).not.toMatch(/"(done|found|progress)"/);

    // Imported back: a second list, with ids of its own.
    await page.getByTestId('editor-done').click();
    await page.getByTestId('lists-back').click();
    const own = page.getByTestId('own-lists');
    const choosing = page.waitForEvent('filechooser');
    await page.getByTestId('import-own-list').click();
    await (await choosing).setFiles(file);
    await expect(page.getByTestId('toast')).toContainText('Imported “To share”.');
    const links = own.getByTestId('list-link').filter({ hasText: 'To share' });
    await expect(links).toHaveCount(2);
    const ids = await links.evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-checklist-id')),
    );
    expect(ids[0]).not.toBe(ids[1]);
    // No mark came with it: the location found is found in both lists (marks
    // are the map's), and the step ticked by hand is not ticked in the copy.
    await expect(links.nth(0)).toContainText('2 of 3');
    await expect(links.nth(1)).toContainText('1 of 3');

    // A list of another game is refused, and says so.
    const other = testInfo.outputPath('other.atlaslist');
    const otherText = text.replaceAll('"demo:', '"other:');
    await writeFile(
      other,
      JSON.stringify({ ...JSON.parse(otherText), gameId: 'other', gameTitle: 'Other world' }),
    );
    const again = page.waitForEvent('filechooser');
    await page.getByTestId('import-own-list').click();
    await (await again).setFiles(other);
    await expect(page.getByTestId('toast')).toContainText(
      'This list was made for Other world, not for',
    );
    await expect(links).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('narrowed to a phone’s width, own lists are used but not changed', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, STANDARD);
    await newList(page, 'Pocket list', 'plain');
    await page.getByTestId('add-tab-blank').click();
    await page.getByTestId('add-blank-name').fill('Buy a lantern');
    await page.getByTestId('add-blank-submit').click();
    await saved(page);

    await page.setViewportSize({ width: 412, height: 860 });
    await expect(page.locator('.touch')).toHaveAttribute('data-arrangement', 'compact');
    await expect(page.getByTestId('list-editor')).toHaveCount(0);
    // The list is there, to tick, without Edit.
    await expect(page.getByTestId('check-item')).toContainText('Buy a lantern');
    await expect(page.getByTestId('edit-own-list')).toHaveCount(0);
    await expect(page.getByTestId('own-lists-phone-note')).toContainText(
      'This list can be changed on a wider screen',
    );
    await page.getByTestId('check-item').getByTestId('entry-tick').click();
    await expect(page.getByTestId('check-item')).toHaveAttribute('data-done', 'true');
    await page.getByTestId('lists-back').click();
    const own = page.getByTestId('own-lists');
    await expect(own.getByTestId('list-link')).toHaveCount(1);
    await expect(page.getByTestId('new-own-list')).toHaveCount(0);
    await expect(own.getByTestId('own-lists-phone-note')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];
  test.use(pixel);

  test('lists are not made here: one quiet line says where', async ({ page }) => {
    const errors = collectErrors(page);
    await openMap(page, './?ui=touch');
    await page.getByTestId('section-lists').tap();
    await expect(page.getByTestId('lists-home')).toBeVisible();
    await expect(page.getByTestId('own-lists-phone-note')).toHaveText(
      'Your own lists and guides can be made on a wider screen: a tablet on its side, or a computer.',
    );
    await expect(page.getByTestId('new-own-list')).toHaveCount(0);
    await expect(page.getByTestId('import-own-list')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
