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
  waitsForSection,
  arrivedAtSection,
} from './reader';

const page = (guideId: string) => ({ kind: 'page', guideId }) as const;

describe('the Guides reader', () => {
  beforeEach(() => {
    resetReader();
  });

  it('starts at the landing page, with nowhere to go back to', () => {
    expect(currentPlace()).toEqual({ kind: 'home' });
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
      { kind: 'home' },
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
    expect(currentPlace()).toEqual({ kind: 'home' });
  });

  it('opens the contents from the landing page, and Back returns to it; the landing page shown is not opened again', () => {
    openPlace({ kind: 'home' });
    expect(useReader.getState().visits).toHaveLength(1);
    openPlace({ kind: 'contents', sectionId: null });
    openPlace({ kind: 'home' });
    expect(useReader.getState().visits.map((v) => v.place)).toEqual([
      { kind: 'home' },
      { kind: 'contents', sectionId: null },
      { kind: 'home' },
    ]);
    readerBack();
    readerBack();
    expect(currentPlace()).toEqual({ kind: 'home' });
  });

  it('keeps at most a hundred visits', () => {
    for (let i = 0; i < 150; i++) openPlace(page(String(i)));
    const state = useReader.getState();
    expect(state.visits).toHaveLength(100);
    expect(currentPlace()).toEqual(page('149'));
  });

  it('opens a page at a section, and Back returns to where the reader was', () => {
    openPlace(page('a'));
    rememberScroll(300);
    openPlace({ kind: 'page', guideId: 'b', section: 'by-boat' });
    expect(waitsForSection()).toBe(true);
    arrivedAtSection(840);
    expect(waitsForSection()).toBe(false);
    expect(useReader.getState().visits.at(-1)).toEqual({
      place: { kind: 'page', guideId: 'b', section: 'by-boat' },
      scroll: 840,
    });
    readerBack();
    expect(currentPlace()).toEqual(page('a'));
    expect(useReader.getState().visits[useReader.getState().at]?.scroll).toBe(300);
    // Forward: where the section was, not waiting for it again.
    readerForward();
    expect(waitsForSection()).toBe(false);
    expect(useReader.getState().visits[useReader.getState().at]?.scroll).toBe(840);
  });

  it('keeps a jump within the page as a place of its own', () => {
    openPlace(page('a'));
    rememberScroll(50);
    openPlace({ kind: 'page', guideId: 'a', section: 'notes' });
    expect(canGoBack(useReader.getState())).toBe(true);
    arrivedAtSection(900);
    readerBack();
    expect(currentPlace()).toEqual(page('a'));
    expect(useReader.getState().visits[useReader.getState().at]?.scroll).toBe(50);
  });

  it('scrolls to the section shown again rather than keeping it twice', () => {
    openPlace({ kind: 'page', guideId: 'a', section: 'notes' });
    arrivedAtSection(900);
    rememberScroll(20);
    openPlace({ kind: 'page', guideId: 'a', section: 'notes' });
    expect(useReader.getState().visits).toHaveLength(2);
    expect(waitsForSection()).toBe(true);
    // A page opened at its top never waits.
    openPlace(page('b'));
    expect(waitsForSection()).toBe(false);
  });
});
