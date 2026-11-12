import { expect, test as base } from '@playwright/test';

/**
 * The layout a test runs in. The app shows its standard layout (a rail,
 * one panel and the map) unless the classic one is chosen; the specs
 * written for the classic layout keep guarding it by opening every page of
 * the test in it, as `?ui=classic` would for the rest of a session (see
 * `src/touch/uiMode.ts`). A test or group can ask for the standard layout
 * with `test.use({ layout: 'standard' })`, or for none (the setting
 * decides) with `test.use({ layout: null })`.
 */
export type TestLayout = 'classic' | 'standard' | null;

export const test = base.extend<{ layout: TestLayout; pinLayout: undefined }>({
  layout: ['classic', { option: true }],
  pinLayout: [
    async ({ page, layout }, use) => {
      if (layout) {
        await page.addInitScript((value) => {
          try {
            window.sessionStorage.setItem('atlas-ui', value);
          } catch {
            // A page without storage, such as about:blank.
          }
        }, layout);
      }
      await use(undefined);
    },
    { auto: true },
  ],
});

export { expect };
