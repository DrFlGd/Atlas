import { beforeEach, describe, expect, it } from 'vitest';
import {
  canGoBack,
  canGoForward,
  currentPlace,
  openPlace,
  readerBack,
  readerBackTo,
  readerForward,
  rememberScroll,
  resetReader,
  useReader,
  waitsForSection,
  arrivedAtSection,
  wayCame,
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
    const arrived = useReader.getState().visits.at(-1)!;
    expect(arrived).toMatchObject({
      place: { kind: 'page', guideId: 'b', section: 'by-boat' },
      scroll: 840,
    });
    expect(arrived.toSection).toBeUndefined();
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

describe('the way the reader came', () => {
  beforeEach(() => {
    resetReader();
  });

  /** The way to the visit shown, as page ids ("home" for the landing page), and where each is kept. */
  const way = () =>
    wayCame().map((step) => (step.place.kind === 'page' ? step.place.guideId : step.place.kind));
  const walk = (guideId: string) => {
    openPlace(page(guideId), 'walk');
  };

  it('is the pages walked from the landing page', () => {
    walk('gear');
    walk('short-blades');
    walk('dirk');
    expect(way()).toEqual(['home', 'gear', 'short-blades']);
    expect(wayCame().map((step) => step.at)).toEqual([0, 1, 2]);
  });

  it('starts afresh from a page opened from the contents, a search or a list', () => {
    walk('gear');
    openPlace(page('basics'));
    expect(way()).toEqual([]);
    walk('gear');
    walk('dirk');
    expect(way()).toEqual(['basics', 'gear']);
    // From a search, then walked on.
    openPlace({ kind: 'search', query: 'dirk' });
    openPlace(page('dirk'));
    expect(way()).toEqual([]);
    walk('kris');
    expect(way()).toEqual(['dirk']);
  });

  it('starts afresh when walked from a place that is no page', () => {
    openPlace({ kind: 'contents', sectionId: 'basics' });
    walk('gear');
    expect(way()).toEqual([]);
    openPlace({ kind: 'search', query: 'g' });
    walk('dirk');
    expect(way()).toEqual([]);
  });

  it('holds no page twice: walking to a page on the way cuts it back to that page', () => {
    walk('gear');
    walk('short-blades');
    walk('dirk');
    walk('gear');
    expect(way()).toEqual(['home']);
    walk('kris');
    expect(way()).toEqual(['home', 'gear']);
    // Back to the page the walk started on: a fresh start again.
    openPlace(page('basics'));
    walk('gear');
    walk('basics');
    expect(way()).toEqual([]);
  });

  it('takes no step for a jump to a heading of the same page', () => {
    walk('gear');
    walk('dirk');
    openPlace({ kind: 'page', guideId: 'dirk', section: 'drops' });
    arrivedAtSection(400);
    expect(way()).toEqual(['home', 'gear']);
    walk('kris');
    // The page with its heading is one step, and pressing it goes back to the heading.
    expect(way()).toEqual(['home', 'gear', 'dirk']);
    expect(wayCame().at(-1)?.place).toEqual({ kind: 'page', guideId: 'dirk', section: 'drops' });
  });

  it('goes back to a step as Back pressed that many times, its scroll kept, and Forward still there', () => {
    walk('gear');
    rememberScroll(640);
    walk('short-blades');
    rememberScroll(80);
    walk('dirk');
    const gear = wayCame()[1]!;
    expect(readerBackTo(gear.at)).toBe(true);
    expect(currentPlace()).toEqual(page('gear'));
    const state = useReader.getState();
    expect(state.visits[state.at]?.scroll).toBe(640);
    expect(way()).toEqual(['home']);
    expect(readerForward()).toBe(true);
    expect(currentPlace()).toEqual(page('short-blades'));
    expect(way()).toEqual(['home', 'gear']);
    readerForward();
    expect(way()).toEqual(['home', 'gear', 'short-blades']);
    // Only to a visit before the one shown.
    expect(readerBackTo(useReader.getState().at)).toBe(false);
    expect(readerBackTo(-1)).toBe(false);
  });

  it('belongs to each visit: Back and Forward show its own', () => {
    openPlace(page('basics'));
    walk('gear');
    walk('dirk');
    openPlace(page('kris'));
    expect(way()).toEqual([]);
    readerBack();
    expect(way()).toEqual(['basics', 'gear']);
    readerBack();
    expect(way()).toEqual(['basics']);
    // A new walk from a visit gone back to forgets Forward, as any page opened does.
    walk('shiv');
    expect(way()).toEqual(['basics', 'gear']);
    expect(canGoForward(useReader.getState())).toBe(false);
  });

  it('leaves out the visits no longer kept', () => {
    for (let i = 0; i < 150; i++) walk(String(i));
    const steps = wayCame();
    expect(steps).toHaveLength(99);
    expect(steps[0]).toEqual({ at: 0, place: page('50') });
    expect(steps.every((step, i) => step.at === i)).toBe(true);
  });
});
