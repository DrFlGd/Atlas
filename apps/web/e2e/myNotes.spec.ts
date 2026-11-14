import { devices, type Page } from '@playwright/test';
import {
  collectErrors,
  demoLocations,
  ownLocationsText,
  reloadSaved,
  storedSetting,
} from './helpers';
import { expect, test } from './layout';
import { choosePlace, placeResult, search } from './touch';

/**
 * "My note" on a location's card, in the standard layout on the demo game:
 * a note written on a location of the game, in Markdown, kept after a
 * reload in its own setting; its mark on the map; search finding a word
 * of a note after the names; "With my notes" showing only noted
 * locations; a note whose location is gone, under "Notes without a
 * location"; the note of a location of one's own; and on a phone.
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

const SETTING = 'ownNotes:demo';
const T = '2026-11-14T10:00:00.000Z';

interface NotesFile {
  format: string;
  version: number;
  notes: Record<string, { text: string; name: string; photos?: unknown[] }>;
}

async function storedNotes(page: Page): Promise<NotesFile | null> {
  const text = (await storedSetting(page, SETTING)) as string | undefined;
  return text ? (JSON.parse(text) as NotesFile) : null;
}

/** Puts settings as they are kept on this device, then shows the app with them. */
async function putSettings(page: Page, settings: Record<string, string>): Promise<void> {
  await page.evaluate(async (entries) => {
    const open = indexedDB.open('atlas');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(new Error(String(open.error)));
      };
    });
    const tx = db.transaction('settings', 'readwrite');
    for (const [key, value] of Object.entries(entries))
      tx.objectStore('settings').put({ key, value });
    await new Promise((resolve) => {
      tx.oncomplete = resolve;
    });
    db.close();
  }, settings);
  await page.reload();
  await expect(page.getByTestId('marker-count')).not.toHaveText('0');
}

async function idOf(page: Page, name: string): Promise<string> {
  const location = (await demoLocations(page.request)).find((l) => l.name === name);
  if (!location) throw new Error(`No location named ${name}`);
  return location.id;
}

async function writeNote(page: Page, text: string): Promise<void> {
  const card = page.getByTestId('my-note');
  await (
    (await card.getByTestId('add-note').count())
      ? card.getByTestId('add-note')
      : card.getByTestId('edit-note')
  ).click();
  await expect(page.getByTestId('note-text')).toBeFocused();
  await page.getByTestId('note-text').fill(text);
  await page.getByTestId('save-note').click();
  await expect(card).not.toHaveAttribute('data-editing');
}

test.describe('on a computer', () => {
  test('writes a note on a location, shows it with a mark, and keeps it', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await choosePlace(page, 'Wolf den 3');
    const card = page.getByTestId('my-note');
    await expect(card.getByTestId('add-note')).toBeVisible();
    // Cancelled, nothing is kept.
    await card.getByTestId('add-note').click();
    await page.getByTestId('note-text').fill('Not this.');
    await page.getByTestId('note-text').press('Escape');
    await expect(card.getByTestId('add-note')).toBeFocused();
    expect(await storedNotes(page)).toBeNull();

    await writeNote(
      page,
      'The ladder is **behind** the den.\n\nGo there from Emberfall Vale waystone 31.',
    );
    await expect(card.locator('strong')).toHaveText('behind');
    await expect(card).toContainText('Go there from Emberfall Vale waystone 31.');
    // The mark on the map.
    await expect(page.locator('.atlas-marker-canvas')).not.toHaveAttribute('data-drawn-noted', '0');
    // Kept in a file of its own, under the location's id.
    const id = await idOf(page, 'Wolf den 3');
    await expect.poll(async () => (await storedNotes(page))?.notes[id]?.name).toBe('Wolf den 3');
    const file = (await storedNotes(page))!;
    expect(file).toMatchObject({ format: 'atlas-own-notes', version: 1 });
    expect(file.notes[id]?.text).toContain('**behind**');

    // Search finds a word of the note, after the locations found by name.
    await search(page, 'Emberfall Vale waystone 31');
    const rows = page.locator('[data-testid="search-result"][data-kind="location"]');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.touch-row-title')).toHaveText('Emberfall Vale waystone 31');
    await expect(rows.nth(1)).toHaveAttribute('data-by-note', '');
    await expect(rows.nth(1).locator('.touch-row-title')).toHaveText('Wolf den 3');
    await expect(rows.nth(1)).toContainText('My note:');
    await page.getByTestId('search-input').fill('ladder');
    await expect(placeResult(page, 'Wolf den 3')).toHaveAttribute('data-by-note', '');

    // After a reload it is there; edited, then deleted with Undo.
    await reloadSaved(page);
    await choosePlace(page, 'Wolf den 3');
    await expect(card).toContainText('The ladder is behind the den.');
    await writeNote(page, 'Three wolves.');
    await expect(card).toContainText('Three wolves.');
    await card.getByTestId('delete-note').click();
    await expect(card.getByTestId('add-note')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(card).toContainText('Three wolves.');
    expect(errors).toEqual([]);
  });

  test('shows only the noted locations, and keeps the notes of locations gone', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    const den = await idOf(page, 'Wolf den 5');
    await putSettings(page, {
      [SETTING]: JSON.stringify({
        format: 'atlas-own-notes',
        version: 1,
        gameId: 'demo',
        updatedAt: T,
        notes: {
          [den]: { text: 'Five wolves.', name: 'Wolf den 5', updatedAt: T },
          // A location the game no longer has.
          'demo:loc:gone-1': { text: 'A chest was **here**.', name: 'Sunken chest', updatedAt: T },
        },
      }),
      'ownLocations:demo': ownLocationsText.replace(
        '"name":"Old well",',
        '"name":"Old well","note":"Water is clean.",',
      ),
    });
    await expect(page.getByTestId('marker-count')).toHaveText('5,002');

    // With my notes: the location of the game and the location of one's own with a note.
    const only = page.getByTestId('notes-only-switch');
    await expect(only).toContainText('2 locations');
    await only.click();
    await expect(only).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('marker-count')).toHaveText('2');
    await only.click();
    await expect(page.getByTestId('marker-count')).toHaveText('5,002');

    // The note of a location gone, under the name it had: read, copied and deleted.
    const apart = page.getByTestId('notes-without-location');
    await apart.locator('summary').click();
    const note = apart.getByTestId('unplaced-note');
    await expect(note).toHaveCount(1);
    await expect(note).toContainText('Sunken chest');
    await expect(note.locator('strong')).toHaveText('here');
    await note.getByTestId('copy-unplaced-note').click();
    await expect(page.getByText('Copied your note on “Sunken chest”.')).toBeVisible();
    await note.getByTestId('delete-unplaced-note').click();
    await expect(apart).toHaveCount(0);
    await expect
      .poll(async () => Object.keys((await storedNotes(page))?.notes ?? {}))
      .toEqual([den]);

    // The note of a location of one's own is shown as one's note, and changed with the location.
    await choosePlace(page, 'Old well');
    const card = page.getByTestId('my-note');
    await expect(card).toContainText('Water is clean.');
    await writeNote(page, 'Water is clean. Bring a rope.');
    await expect
      .poll(async () => (await storedSetting(page, 'ownLocations:demo')) as string)
      .toContain('Bring a rope.');
    expect(await storedNotes(page)).not.toBeNull();
    expect(Object.keys((await storedNotes(page))!.notes)).toEqual([den]);
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('writes a note from the card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await choosePlace(page, 'Wolf den 3');
    await page.getByTestId('place-details-row').click();
    await writeNote(page, 'Watch for the *grey wolf*.');
    await expect(page.getByTestId('my-note').locator('em')).toHaveText('grey wolf');
    await expect(page.getByTestId('place-details-row')).toContainText('my note');
    await page.getByTestId('close-place').click();
    // The chip over the map shows only the noted location.
    await page.getByTestId('notes-only-chip').click();
    await expect(page.getByTestId('notes-only-chip')).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });
});
