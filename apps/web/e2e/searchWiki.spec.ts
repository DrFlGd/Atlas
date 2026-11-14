import { devices, type Page } from '@playwright/test';
import {
  collectErrors,
  demoLocations,
  ownLocationsText,
  reloadSaved,
  storedSetting,
} from './helpers';
import { expect, test } from './layout';
import { choosePlace } from './touch';

/**
 * "Search wiki" on a location's card, in the standard layout on the demo
 * game and its made-up wiki: the saved pages found by the location's name,
 * the best first; a page linked to this location alone or to every
 * location of its name, asked only when there are several; the link taken
 * off from the card, and put back; another page searched for; and the
 * links kept in the guide links file, shown in "Link pages to the map".
 */

test.use({ layout: 'standard' });

const { defaultBrowserType: _browser, ...pixel } = devices['Pixel 7'];

interface LinksFile {
  version: number;
  choices: Record<string, { state: string; targets?: Record<string, string>[] }>;
}

async function storedLinks(page: Page): Promise<LinksFile | null> {
  const text = (await storedSetting(page, 'guideLinks:demo')) as string | undefined;
  return text ? (JSON.parse(text) as LinksFile) : null;
}

const hits = (page: Page) => page.getByTestId('wiki-search-hit');
const hit = (page: Page, title: string) =>
  hits(page).filter({ has: page.locator('.place-wiki-hit-title', { hasText: title }) });

test.describe('on a computer', () => {
  test('finds the saved pages by name and links one to this location alone', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await choosePlace(page, 'Wolf den 3');
    await expect(page.getByTestId('from-the-wiki')).toHaveCount(0);
    await page.getByTestId('search-wiki').click();
    const panel = page.getByTestId('wiki-search');
    await expect(page.getByTestId('wiki-search-input')).toBeFocused();
    await expect(page.getByTestId('wiki-search-input')).toHaveValue('Wolf den 3');
    // The page whose title fits first, then the pages that only mention the name.
    await expect(hits(page).first()).toContainText('Wolves');
    await expect(hits(page).first()).toHaveAttribute('data-via', 'title');
    await expect(panel.getByTestId('wiki-search-summary')).toContainText('the best first');

    // Many locations are named Wolf den: it asks.
    await hit(page, 'Wolves').getByTestId('wiki-search-link').click();
    const question = page.getByTestId('wiki-link-question');
    await expect(question.getByTestId('link-every-location')).toHaveText(
      'Every location named Wolf den (149)',
    );
    await expect(question.getByTestId('link-every-location')).toBeFocused();
    await question.getByTestId('link-this-location').click();
    await expect(panel).toHaveCount(0);
    const wiki = page.getByTestId('from-the-wiki');
    await expect(wiki).toContainText('Wolves');
    await expect(wiki).toContainText('about this location');
    const id = (await demoLocations(page.request)).find((l) => l.name === 'Wolf den 3')!.id;
    await expect.poll(async () => (await storedLinks(page))?.version).toBe(2);
    expect((await storedLinks(page))!.choices['demo:guide:wiki-wolves']).toEqual({
      state: 'linked',
      targets: [{ to: 'location', id }],
    });

    // Not on another location of the name.
    await choosePlace(page, 'Wolf den 4');
    await expect(page.getByTestId('from-the-wiki')).toHaveCount(0);

    // Taken off from the card, and put back with Undo.
    await choosePlace(page, 'Wolf den 3');
    await wiki.getByTestId('unlink-wiki-page').click();
    await expect(page.getByTestId('from-the-wiki')).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(wiki).toContainText('Wolves');

    // Another page, for every location of the name.
    await wiki.getByTestId('search-wiki').click();
    await page.getByTestId('wiki-search-input').fill('waystone');
    await page.getByTestId('wiki-search-input').press('Enter');
    await expect(hits(page).first()).toContainText('Waystones');
    await expect(hit(page, 'Wolves')).toHaveCount(0);
    await hit(page, 'Waystones').getByTestId('wiki-search-link').click();
    await page.getByTestId('link-every-location').click();
    await choosePlace(page, 'Wolf den 4');
    await expect(page.getByTestId('from-the-wiki')).toContainText('Waystones');

    // The review shows the link to one location in words, and it is kept.
    await reloadSaved(page);
    await page.getByTestId('section-guides').click();
    await page.getByTestId('open-guide-links').click();
    await expect(page.getByTestId('guide-links')).toContainText('Wolf den 3 (this location only)');
    expect(errors).toEqual([]);
  });

  test('links at once when the location is the only one of its name', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await expect(page.getByTestId('marker-count')).toHaveText('5,000');
    await page.evaluate(async (text) => {
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
      tx.objectStore('settings').put({ key: 'ownLocations:demo', value: text });
      await new Promise((resolve) => {
        tx.oncomplete = resolve;
      });
      db.close();
    }, ownLocationsText);
    await page.reload();
    await choosePlace(page, 'Old well');
    await page.getByTestId('search-wiki').click();
    await page.getByTestId('wiki-search-input').fill('Waystones');
    await page.getByTestId('wiki-search-go').click();
    await hit(page, 'Waystones').getByTestId('wiki-search-link').click();
    await expect(page.getByTestId('wiki-link-question')).toHaveCount(0);
    await expect(page.getByTestId('from-the-wiki')).toContainText('Waystones');
    await expect
      .poll(async () => (await storedLinks(page))?.choices['demo:guide:wiki-waystones'])
      .toEqual({ state: 'linked', targets: [{ to: 'name', name: 'Old well' }] });
    // Only a name: the file stays as an older Atlas writes it.
    expect((await storedLinks(page))!.version).toBe(1);
    // Nothing fits: it says so.
    await page.getByTestId('search-wiki').click();
    await page.getByTestId('wiki-search-input').fill('copper kettle');
    await page.getByTestId('wiki-search-input').press('Enter');
    await expect(page.getByTestId('wiki-search-summary')).toHaveText(
      'No saved page fits “copper kettle”. Try other words.',
    );
    await page.getByTestId('wiki-search-input').press('Escape');
    await expect(page.getByTestId('wiki-search')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ ...pixel });

  test('searches the wiki from the card', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('./');
    await choosePlace(page, 'Stone warden 12');
    await page.getByTestId('place-details-row').click();
    await page.getByTestId('search-wiki').click();
    await expect(hits(page).first()).toContainText('Stone wardens');
    await hit(page, 'Stone wardens').getByTestId('wiki-search-link').click();
    await page.getByTestId('link-every-location').click();
    await expect(page.getByTestId('from-the-wiki')).toContainText('Stone wardens');
    expect(errors).toEqual([]);
  });
});
