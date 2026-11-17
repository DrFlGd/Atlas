import { create } from 'zustand';

/**
 * The Guides section's reader: where it is (the landing page, the
 * contents, a section, a page or a search), and the places it was before
 * and after, so Back and Forward return to them, each where it was
 * scrolled to. A game's guides open on the landing page: the wiki's own
 * home page, or one made from the top of the contents.
 *
 * A page can be opened at a section of it (a heading's name, see
 * `sections.ts` in `@atlas/core`): the visit is scrolled to that heading
 * when it is first shown, and kept as any other place, so Back returns to
 * where the reader was before the jump, on another page or on the same
 * one. A jump to the section shown already scrolls to it again.
 *
 * Each visit remembers the way the reader came to it: the pages walked
 * from the place shown (a link in a page's text or a box of facts, a tile
 * of the landing page, "Also linked from", the pages under a page), back
 * to the last fresh start (the landing page, or a page opened from the
 * contents, a search, a list or the map). Walking to a page already on
 * the way cuts it back to that page, so no page is on it twice; a jump to
 * a heading of the same page is no step. The way belongs to the visit:
 * Back and Forward show each visit's own.
 */

export type ReaderPlace =
  /**
   * The landing page: the home page, or one made from the top of the
   * contents; of one source of pages (by the game id of its pages, see
   * `guideSources.ts`), or of the one chosen when it names none.
   */
  | { kind: 'home'; source?: string }
  /** The contents: its top (`sectionId` null, of a source as the landing page is), or one section. */
  | { kind: 'contents'; sectionId: string | null; source?: string }
  /** A page, at its top or at one of its sections. */
  | { kind: 'page'; guideId: string; section?: string }
  | { kind: 'search'; query: string }
  /** Linking the pages to the map (see `GuideLinksReview.tsx`). */
  | { kind: 'links' };

interface Visit {
  place: ReaderPlace;
  /** How far down it was scrolled when left. */
  scroll: number;
  /** Not shown yet since it was opened at its section: it is scrolled there when shown. */
  toSection?: true;
  /** Which visit this is, for the way to later ones. */
  serial: number;
  /** The visits walked to come here, from the fresh start on (see the top of this file); none for a fresh start. */
  way?: readonly number[];
}

/** How a place is opened: walked to from the place shown, or as a fresh start (see the top of this file). */
export type OpenedBy = 'walk' | 'fresh';

export interface ReaderState {
  visits: Visit[];
  /** The visit shown. */
  at: number;
}

/** Places kept for Back, at most. */
const MAX_VISITS = 100;

const TOP: Visit = { place: { kind: 'home' }, scroll: 0, serial: 0 };

let serials = 0;
const nextSerial = () => ++serials;

export const useReader = create<ReaderState>()(() => ({ visits: [TOP], at: 0 }));

const get = useReader.getState;
const set = useReader.setState;

export const currentPlace = (state: ReaderState = get()): ReaderPlace =>
  state.visits[state.at]?.place ?? TOP.place;

export const canGoBack = (state: ReaderState) => state.at > 0;
export const canGoForward = (state: ReaderState) => state.at < state.visits.length - 1;

const samePlace = (a: ReaderPlace, b: ReaderPlace) =>
  a.kind === b.kind &&
  (a.kind === 'contents'
    ? a.sectionId === (b as typeof a).sectionId && a.source === (b as typeof a).source
    : a.kind === 'home'
      ? a.source === (b as typeof a).source
      : a.kind === 'page'
        ? a.guideId === (b as typeof a).guideId && a.section === (b as typeof a).section
        : a.kind === 'search'
          ? a.query === (b as typeof a).query
          : true);

/** Keeps how far the place shown is scrolled, for when it is shown again. */
export function rememberScroll(scroll: number): void {
  const { visits, at } = get();
  const visit = visits[at];
  if (!visit || visit.scroll === scroll) return;
  const next = [...visits];
  next[at] = { ...visit, scroll };
  set({ visits: next });
}

/**
 * The way to a page opened from the visit shown: walked, the way to the
 * visit shown and that visit, cut back before the page where it is on it
 * already. A jump within the page shown, however it is made, keeps that
 * page's way. Only a page is walked to, and only from a page or the
 * landing page.
 */
function wayTo(
  visits: readonly Visit[],
  from: Visit | undefined,
  place: ReaderPlace,
  by: OpenedBy,
) {
  if (!from || place.kind !== 'page') return undefined;
  const shown = from.place;
  // A jump within the page shown, by any way: no step.
  if (shown.kind === 'page' && shown.guideId === place.guideId) return from.way;
  if (by !== 'walk' || (shown.kind !== 'page' && shown.kind !== 'home')) return undefined;
  const way = [...(from.way ?? []), from.serial];
  const pageOf = new Map(visits.map((visit) => [visit.serial, visit.place]));
  const again = way.findIndex((serial) => {
    const before = pageOf.get(serial);
    return before?.kind === 'page' && before.guideId === place.guideId;
  });
  const kept = again < 0 ? way : way.slice(0, again);
  return kept.length > 0 ? kept : undefined;
}

/**
 * Goes to a place: Forward is forgotten, and Back returns here. A search
 * typed on from a search replaces it, so Back skips the letters typed.
 * `by` says whether the reader walked there from the place shown, or
 * started afresh (see the top of this file).
 */
export function openPlace(place: ReaderPlace, by: OpenedBy = 'fresh'): void {
  const { visits, at } = get();
  const here = visits[at]?.place;
  const toSection = place.kind === 'page' && place.section ? { toSection: true as const } : {};
  if (here && samePlace(here, place)) {
    // The section shown: scrolled to again, as the reader may have moved on.
    if (toSection.toSection) {
      const next = [...visits];
      next[at] = { ...visits[at]!, ...toSection };
      set({ visits: next });
    }
    return;
  }
  if (here?.kind === 'search' && place.kind === 'search') {
    const next = visits.slice(0, at + 1);
    next[at] = { place, scroll: 0, serial: nextSerial() };
    set({ visits: next });
    return;
  }
  const way = wayTo(visits, visits[at], place, by);
  const visit: Visit = {
    place,
    scroll: 0,
    ...toSection,
    serial: nextSerial(),
    ...(way ? { way } : {}),
  };
  const next = [...visits.slice(0, at + 1), visit].slice(-MAX_VISITS);
  set({ visits: next, at: next.length - 1 });
}

/** A visit on the way to the one shown: where it is in the visits kept, and its place. */
export interface WayStep {
  at: number;
  place: ReaderPlace;
}

/**
 * The way the reader came to the visit shown (see the top of this file):
 * the visits walked, from the fresh start on, the visit shown left out;
 * none when it was opened afresh. Visits no longer kept are left out.
 */
export function wayCame(state: ReaderState = get()): WayStep[] {
  const way = state.visits[state.at]?.way;
  if (!way) return [];
  const atOf = new Map(state.visits.map((visit, at) => [visit.serial, at]));
  return way.flatMap((serial) => {
    const at = atOf.get(serial);
    return at === undefined || at >= state.at ? [] : [{ at, place: state.visits[at]!.place }];
  });
}

/** Back to a visit before the one shown, as Back pressed that many times; false when there is none. */
export function readerBackTo(at: number): boolean {
  const state = get();
  if (!Number.isInteger(at) || at < 0 || at >= state.at) return false;
  set({ at });
  return true;
}

/** Whether the place shown waits to be scrolled to its section. */
export const waitsForSection = (state: ReaderState = get()): boolean =>
  state.visits[state.at]?.toSection === true;

/** The place shown was scrolled to its section (or found none): from now on it keeps its own scroll. */
export function arrivedAtSection(scroll: number): void {
  const { visits, at } = get();
  const visit = visits[at];
  if (!visit?.toSection) return;
  const next = [...visits];
  const { toSection: _, ...arrived } = visit;
  next[at] = { ...arrived, scroll };
  set({ visits: next });
}

/** Back to the place before; false when there is none. */
export function readerBack(): boolean {
  const { at } = get();
  if (at === 0) return false;
  set({ at: at - 1 });
  return true;
}

export function readerForward(): boolean {
  const state = get();
  if (!canGoForward(state)) return false;
  set({ at: state.at + 1 });
  return true;
}

/**
 * The landing page or the top of the contents shown names no source of
 * pages: it is of `source` from now on, so Back and Forward show it of the
 * source it was shown of.
 */
export function stampSource(source: string): void {
  const { visits, at } = get();
  const visit = visits[at];
  if (!visit) return;
  const { place } = visit;
  const top = place.kind === 'home' || (place.kind === 'contents' && place.sectionId === null);
  if (!top || place.source !== undefined) return;
  const next = [...visits];
  next[at] = { ...visit, place: { ...place, source } };
  set({ visits: next });
}

/** A new game: the reader starts at its landing page. */
export function resetReader(): void {
  set({ visits: [TOP], at: 0 });
}
