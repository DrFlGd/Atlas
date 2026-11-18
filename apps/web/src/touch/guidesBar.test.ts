import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS, openProgressStore, progressStore } from '../state/services';
import { loadGuidesBar, parseBarOpen, setGuidesBarOpen, useGuidesBar } from './guidesBar';

beforeAll(async () => {
  // No IndexedDB here: the store kept in memory, as in a browser that allows none.
  await openProgressStore();
});

beforeEach(() => {
  useGuidesBar.setState({ open: true, chosen: false });
});

/** Until the save under way is done. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the contents beside a page in Guides', () => {
  it('is open unless it was folded', () => {
    expect(parseBarOpen(undefined)).toBe(true);
    expect(parseBarOpen(null)).toBe(true);
    expect(parseBarOpen(true)).toBe(true);
    expect(parseBarOpen('false')).toBe(true);
    expect(parseBarOpen(0)).toBe(true);
    expect(parseBarOpen(false)).toBe(false);
  });

  it('is open at first', async () => {
    await progressStore().putSetting(SETTINGS.guidesBar, undefined);
    await loadGuidesBar();
    expect(useGuidesBar.getState().open).toBe(true);
  });

  it('keeps the choice for the next time, for every game', async () => {
    setGuidesBarOpen(false);
    expect(useGuidesBar.getState().open).toBe(false);
    await settled();
    expect(await progressStore().getSetting(SETTINGS.guidesBar)).toBe(false);
    // The app started again: folded, as left.
    useGuidesBar.setState({ open: true, chosen: false });
    await loadGuidesBar();
    expect(useGuidesBar.getState().open).toBe(false);
    setGuidesBarOpen(true);
    await settled();
    useGuidesBar.setState({ open: false, chosen: false });
    await loadGuidesBar();
    expect(useGuidesBar.getState().open).toBe(true);
  });

  it('keeps a choice made before what was kept is read', async () => {
    await progressStore().putSetting(SETTINGS.guidesBar, false);
    const reading = loadGuidesBar();
    setGuidesBarOpen(true);
    await reading;
    expect(useGuidesBar.getState().open).toBe(true);
  });
});
