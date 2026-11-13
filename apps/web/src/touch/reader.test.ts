import { beforeEach, describe, expect, it } from 'vitest';
import {
  canGoBack,
  canGoForward,
  currentPlace,
  openPlace,
  readerBack,
  readerForward,
  rememberScroll,
  resetReader,
  useReader,
} from './reader';

const page = (guideId: string) => ({ kind: 'page', guideId }) as const;

describe('the Guides reader', () => {
  beforeEach(() => {
    resetReader();
  });

  it('starts at the top of the contents, with nowhere to go back to', () => {
    expect(currentPlace()).toEqual({ kind: 'contents', sectionId: null });
    expect(canGoBack(useReader.getState())).toBe(false);
    expect(readerBack()).toBe(false);
  });

  it('goes back and forward through the pages read, each where it was scrolled to', () => {
    openPlace(page('a'));
    rememberScroll(120);
    openPlace(page('b'));
    expect(readerBack()).toBe(true);
    expect(currentPlace()).toEqual(page('a'));
    const { visits, at } = useReader.getState();
    expect(visits[at]?.scroll).toBe(120);
    expect(canGoForward(useReader.getState())).toBe(true);
    expect(readerForward()).toBe(true);
    expect(currentPlace()).toEqual(page('b'));
    expect(readerForward()).toBe(false);
  });

  it('forgets Forward when another page is opened, and ignores the page already shown', () => {
    openPlace(page('a'));
    openPlace(page('b'));
    readerBack();
    openPlace(page('c'));
    expect(canGoForward(useReader.getState())).toBe(false);
    openPlace(page('c'));
    expect(useReader.getState().visits.map((v) => v.place)).toEqual([
      { kind: 'contents', sectionId: null },
      page('a'),
      page('c'),
    ]);
  });

  it('keeps one visit for a search typed on, so Back skips the letters', () => {
    openPlace({ kind: 'search', query: 'b' });
    openPlace({ kind: 'search', query: 'be' });
    openPlace({ kind: 'search', query: 'bell' });
    expect(useReader.getState().visits).toHaveLength(2);
    readerBack();
    expect(currentPlace()).toEqual({ kind: 'contents', sectionId: null });
  });

  it('keeps at most a hundred visits', () => {
    for (let i = 0; i < 150; i++) openPlace(page(String(i)));
    const state = useReader.getState();
    expect(state.visits).toHaveLength(100);
    expect(currentPlace()).toEqual(page('149'));
  });
});
