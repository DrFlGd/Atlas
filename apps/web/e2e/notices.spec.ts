import type { Page } from '@playwright/test';
import { collectErrors } from './helpers';
import { expect, test } from './layout';
import { realErrors, setUp } from './fakeShell';

/**
 * Notices (toasts) in the standard layout stand at the top of what they
 * belong to, and what stands there moves down while one shows: at a
 * computer's, a tablet's and a phone's width, a notice lies over no button,
 * no field, no link and not the Library's strip of what is being read.
 */

test.use({ layout: 'standard' });

/** What the notice shown lies over, of what can be pressed or read as a strip. */
async function coveredByToast(page: Page): Promise<string[]> {
  const toast = page.getByTestId('toast');
  await expect(toast).toBeVisible();
  // Its height is followed by what moves down; give a moment for the layout to settle.
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const notice = document.querySelector<HTMLElement>('[data-testid="toast"]');
    if (!notice) return ['no notice'];
    const box = notice.getBoundingClientRect();
    const covered: string[] = [];
    const before = notice.style.pointerEvents;
    // What would be under the notice, were it not there.
    notice.style.pointerEvents = 'none';
    const pressable = document.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [role="button"], [role="switch"], [data-testid="library-strip"]',
    );
    for (const element of pressable) {
      if (notice.contains(element)) continue;
      const r = element.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const left = Math.max(r.left, box.left);
      const right = Math.min(r.right, box.right);
      const top = Math.max(r.top, box.top);
      const bottom = Math.min(r.bottom, box.bottom);
      if (left >= right || top >= bottom) continue;
      // Only what is drawn there, not what another screen already covers.
      const points = [
        [(left + right) / 2, (top + bottom) / 2],
        [left + 1, top + 1],
        [right - 1, bottom - 1],
      ];
      const drawn = points.some(([x, y]) => {
        const at = document.elementFromPoint(x!, y!);
        return at !== null && (at === element || element.contains(at));
      });
      if (drawn) {
        const name = (element.getAttribute('aria-label') ?? element.textContent).trim();
        covered.push(`${element.tagName.toLowerCase()} "${name.slice(0, 40)}"`);
      }
    }
    notice.style.pointerEvents = before;
    return covered;
  });
}

const SIZES = [
  { name: 'a computer', width: 1280, height: 800 },
  { name: 'a tablet', width: 1024, height: 768 },
  { name: 'a phone', width: 390, height: 844 },
];

for (const size of SIZES) {
  test(`at the width of ${size.name}, a notice covers no button and not the strip`, async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await setUp(page);

    // Settings: Look again says so.
    await page.getByTestId('section-settings').click();
    await page.getByTestId('refresh-maps').click();
    await expect(page.getByTestId('toast')).toHaveText('Looked at every folder again.');
    expect(await coveredByToast(page)).toEqual([]);

    // The Library, with the notice still shown.
    await page.getByTestId('section-library').click();
    await expect(page.getByTestId('library')).toBeVisible();
    expect(await coveredByToast(page)).toEqual([]);

    // The map: a location marked found, with Undo on the notice.
    await page.getByTestId('section-map').click();
    await expect(page.getByTestId('nearest-unfound')).toBeVisible();
    await page.getByTestId('nearest-unfound').click();
    await page.getByTestId('mark-found').click();
    await expect(page.getByTestId('toast')).toContainText('Marked found');
    expect(await coveredByToast(page)).toEqual([]);
    expect(realErrors(errors)).toEqual([]);
  });
}
