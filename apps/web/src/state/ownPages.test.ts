import { NO_OWN_PAGES, type OwnPages } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { mergeOwnPages, pageWidthOf, useOwnPages, type OwnPagesState } from './ownPages';
import type { LoadedGame } from './store';

/** A game of the demo pack whose manifest gives the pages a width, or none, and the site's own width. */
const game = (pageWidth?: string, siteWidth?: number) =>
  ({
    pack: {
      manifest: {
        gameId: 'demo',
        ...(pageWidth ? { pageWidth } : {}),
        ...(siteWidth ? { siteWidth } : {}),
      },
    },
  }) as unknown as LoadedGame;

const state = (own: OwnPages, gameId = 'demo'): OwnPagesState => ({
  ...useOwnPages.getState(),
  gameId,
  status: 'ready',
  own,
});

describe('the width of a game’s pages', () => {
  it('is the person’s choice, else the pack’s, else a column of text', () => {
    expect(pageWidthOf(game(), state(NO_OWN_PAGES))).toEqual({
      width: 'reading',
      chosen: false,
      site: 'reading',
    });
    expect(pageWidthOf(game('wide'), state(NO_OWN_PAGES))).toEqual({
      width: 'wide',
      chosen: false,
      site: 'wide',
    });
    const chosen = { ...NO_OWN_PAGES, pageWidth: 'full' as const };
    expect(pageWidthOf(game('wide'), state(chosen))).toEqual({
      width: 'full',
      chosen: true,
      site: 'wide',
    });
    // The own pages of another game say nothing of this one.
    expect(pageWidthOf(game('wide'), state(chosen, 'other')).width).toBe('wide');
  });

  it('is the site’s own width only for a pack that knows it, and else a column of text', () => {
    const original = { ...NO_OWN_PAGES, pageWidth: 'site' as const };
    expect(pageWidthOf(game('wide', 1012), state(original))).toEqual({
      width: 'site',
      chosen: true,
      site: 'wide',
      siteWidth: 1012,
    });
    expect(pageWidthOf(game('site', 1012), state(NO_OWN_PAGES))).toMatchObject({
      width: 'site',
      site: 'site',
    });
    // Without the number: reading, whoever chose it; the choice is kept for a pack that has it.
    expect(pageWidthOf(game('wide'), state(original))).toEqual({
      width: 'reading',
      chosen: true,
      site: 'wide',
    });
    expect(pageWidthOf(game('site'), state(NO_OWN_PAGES))).toMatchObject({
      width: 'reading',
      site: 'reading',
    });
    // A number out of bounds is none.
    expect(pageWidthOf(game('site', 99), state(NO_OWN_PAGES)).width).toBe('reading');
  });

  it('comes with own pages added from a pack file, when the file says one', () => {
    const here: OwnPages = { ...NO_OWN_PAGES, pageWidth: 'wide' };
    expect(mergeOwnPages(here, { ...NO_OWN_PAGES, pageWidth: 'full' }).pageWidth).toBe('full');
    expect(mergeOwnPages(here, NO_OWN_PAGES).pageWidth).toBe('wide');
    expect(mergeOwnPages(NO_OWN_PAGES, NO_OWN_PAGES)).not.toHaveProperty('pageWidth');
  });
});

describe('whether a game’s pages are read in order', () => {
  it('comes with own pages added from a pack file, when the file says', () => {
    const here: OwnPages = { ...NO_OWN_PAGES, pagesInOrder: true };
    expect(mergeOwnPages(here, { ...NO_OWN_PAGES, pagesInOrder: false }).pagesInOrder).toBe(false);
    expect(mergeOwnPages(here, NO_OWN_PAGES).pagesInOrder).toBe(true);
    expect(mergeOwnPages(NO_OWN_PAGES, NO_OWN_PAGES)).not.toHaveProperty('pagesInOrder');
  });
});
