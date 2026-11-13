import { create } from 'zustand';

/**
 * The Guides section's reader: where it is (the contents, a section, a
 * page or a search), and the places it was before and after, so Back and
 * Forward return to them, each where it was scrolled to.
 */

export type ReaderPlace =
  /** The contents: its top (`sectionId` null), or one section. */
  | { kind: 'contents'; sectionId: string | null }
  | { kind: 'page'; guideId: string }
  | { kind: 'search'; query: string }
  /** Linking the pages to the map (see `GuideLinksReview.tsx`). */
  | { kind: 'links' };

interface Visit {
  place: ReaderPlace;
  /** How far down it was scrolled when left. */
  scroll: number;
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
      ? a.guideId === (b as typeof a).guideId
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
  if (here && samePlace(here, place)) return;
  if (here?.kind === 'search' && place.kind === 'search') {
    const next = visits.slice(0, at + 1);
    next[at] = { place, scroll: 0 };
    set({ visits: next });
    return;
  }
  const next = [...visits.slice(0, at + 1), { place, scroll: 0 }].slice(-MAX_VISITS);
  set({ visits: next, at: next.length - 1 });
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
