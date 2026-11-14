import { create } from 'zustand';

/**
 * The Guides section's reader: where it is (the contents, a section, a
 * page or a search), and the places it was before and after, so Back and
 * Forward return to them, each where it was scrolled to.
 *
 * A page can be opened at a section of it (a heading's name, see
 * `sections.ts` in `@atlas/core`): the visit is scrolled to that heading
 * when it is first shown, and kept as any other place, so Back returns to
 * where the reader was before the jump, on another page or on the same
 * one. A jump to the section shown already scrolls to it again.
 */

export type ReaderPlace =
  /** The contents: its top (`sectionId` null), or one section. */
  | { kind: 'contents'; sectionId: string | null }
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
}

export interface ReaderState {
  visits: Visit[];
  /** The visit shown. */
  at: number;
}

/** Places kept for Back, at most. */
const MAX_VISITS = 100;

const TOP: Visit = { place: { kind: 'contents', sectionId: null }, scroll: 0 };

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
    ? a.sectionId === (b as typeof a).sectionId
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
 * Goes to a place: Forward is forgotten, and Back returns here. A search
 * typed on from a search replaces it, so Back skips the letters typed.
 */
export function openPlace(place: ReaderPlace): void {
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
    next[at] = { place, scroll: 0 };
    set({ visits: next });
    return;
  }
  const next = [...visits.slice(0, at + 1), { place, scroll: 0, ...toSection }].slice(-MAX_VISITS);
  set({ visits: next, at: next.length - 1 });
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
  next[at] = { place: visit.place, scroll };
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

/** A new game: the reader starts at the top of its contents. */
export function resetReader(): void {
  set({ visits: [TOP], at: 0 });
}
