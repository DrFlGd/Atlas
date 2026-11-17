import type { GuideEntry } from '@atlas/schema';
import { useEffect } from 'react';
import { useGameName } from '../state/gameGroups';
import { useGuideLinks } from '../state/guideLinks';
import {
  chooseGuideSource,
  guideSource,
  guideSourcesOf,
  isReadInOrder,
  isSourceHome,
  loadGuideSourcePrefs,
  loadReadLast,
  neighbours,
  noteReadInGuide,
  readingOrder,
  sourceOfEntry,
  useGuideSources,
  type GuideSource,
} from '../state/guideSources';
import { useOwnPages } from '../state/ownPages';
import type { LoadedGame } from '../state/store';
import { currentPlace, stampSource, useReader, type ReaderPlace } from './reader';

/**
 * What Guides shows of the sources of a game's pages (see
 * `state/guideSources.ts`, and `GuideSources.tsx` for the switcher): the
 * source shown, its name, whether it is a guide, and the place shown
 * followed, so the source of a page opened by a link or a search is the
 * one chosen from then on.
 */

/** What Guides shows of its sources now. */
export interface SourceView {
  sources: readonly GuideSource[];
  /** The source shown: the one of the place shown, else the one chosen; none without pages. */
  shown: GuideSource | undefined;
  /** The name of the source shown, as the landing page and the way above a page name it. */
  name: string;
  /** Each source's name, by its game id. */
  names: ReadonlyMap<string, string>;
  /** Whether the source shown is a guide, read in order. */
  inOrder: boolean;
}

/** The source a place is of, where it says. */
function sourceOfPlace(game: LoadedGame, place: ReaderPlace): GuideSource | undefined {
  switch (place.kind) {
    case 'page':
      return sourceOfEntry(game, place.guideId);
    case 'contents':
      return place.sectionId
        ? sourceOfEntry(game, place.sectionId)
        : guideSource(game, place.source ?? null);
    case 'home':
    case 'all':
      return guideSource(game, place.source ?? null);
    default:
      return undefined;
  }
}

/**
 * The name of each source: the game's own goes by the game's name, another
 * by its title; two of one name are told apart by their sites, else by
 * number.
 */
function namesOf(sources: readonly GuideSource[], gameName: string): Map<string, string> {
  const base = sources.map((source) => (source.own ? gameName : source.title));
  const key = (name: string) => name.trim().toLowerCase();
  const names = new Map<string, string>();
  sources.forEach((source, i) => {
    const name = base[i]!;
    const same = sources.flatMap((other, j) => (key(base[j]!) === key(name) ? [other] : []));
    if (same.length < 2) names.set(source.gameId, name);
    else if (source.site && same.filter((other) => other.site === source.site).length === 1) {
      names.set(source.gameId, `${name} (${source.site})`);
    } else names.set(source.gameId, `${name} ${same.indexOf(source) + 1}`);
  });
  return names;
}

/** What Guides shows of its sources, kept up to date. */
export function useSourceView(game: LoadedGame): SourceView {
  const gameId = game.pack.manifest.gameId;
  // The pages of other games, and the person's own, change the sources.
  useGuideLinks((s) => s.others);
  const own = useOwnPages();
  const state = useGuideSources();
  const place = useReader(currentPlace);
  const gameName = useGameName(game);
  const sources = guideSourcesOf(game);
  const chosen = guideSource(game, state.gameId === gameId ? state.chosen : null) ?? sources[0];
  const shown = sourceOfPlace(game, place) ?? chosen;
  const names = namesOf(sources, gameName);
  return {
    sources,
    shown,
    name: shown ? (names.get(shown.gameId) ?? gameName) : gameName,
    names,
    inOrder: shown ? isReadInOrder(shown, state, own) : false,
  };
}

/**
 * Follows the place shown: its source is the one chosen from now on, and
 * kept for the next time; a page of a guide is kept as the one read last.
 * Used once, by Guides.
 */
export function useFollowSource(game: LoadedGame, view: SourceView): void {
  const gameId = game.pack.manifest.gameId;
  const place = useReader(currentPlace);
  const ready = useGuideSources((s) => s.gameId === gameId && s.ready);
  const chosen = useGuideSources((s) => (s.gameId === gameId ? s.chosen : null));
  const { shown, inOrder, sources } = view;
  const placeSource = sourceOfPlace(game, place);
  useEffect(() => {
    void loadGuideSourcePrefs(gameId);
  }, [gameId]);
  const guides = sources.filter((source) => isReadInOrder(source)).map((source) => source.gameId);
  const guideKey = guides.join(' ');
  useEffect(() => {
    if (guideKey) void loadReadLast(guideKey.split(' '));
  }, [guideKey]);
  // The source kept is known, and here (its pages may still be read).
  const settled = ready && (chosen === null || sources.some((source) => source.gameId === chosen));
  useEffect(() => {
    // The landing page shown first is of the source shown, for Back to return to it.
    if (settled && shown) stampSource(shown.gameId);
  }, [settled, shown, place]);
  useEffect(() => {
    if (placeSource && placeSource.gameId !== chosen) chooseGuideSource(gameId, placeSource.gameId);
  }, [placeSource, chosen, gameId]);
  // Only a page of the guide's order is read in it: a page outside its menu has no place there.
  const readId =
    place.kind === 'page' &&
    inOrder &&
    shown &&
    placeSource === shown &&
    !isSourceHome(game, place.guideId) &&
    readingOrder(game, shown).some((page) => page.id === place.guideId)
      ? place.guideId
      : null;
  useEffect(() => {
    if (readId && shown) noteReadInGuide(shown.gameId, readId);
  }, [readId, shown]);
}

/**
 * The pages before and after a page in the order of the guide shown (with
 * none, `guideId` null: the landing page made from the contents, before
 * the first page); null for a wiki. A page outside the guide's menu is in
 * no order: it has neither.
 */
export function sequenceOf(
  game: LoadedGame,
  view: SourceView,
  guideId: string | null,
): { previous: GuideEntry | null; next: GuideEntry | null } | null {
  const { shown, inOrder } = view;
  if (!shown || !inOrder) return null;
  if (guideId === null) return { previous: null, next: readingOrder(game, shown)[0] ?? null };
  return neighbours(game, shown, guideId);
}
