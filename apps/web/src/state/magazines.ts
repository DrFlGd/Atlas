import { useMemo } from 'react';
import { create } from 'zustand';
import type { GameGroup } from '@atlas/schema';
import { desktop, type ListedPack } from '../desktop';
import { useGameGroups } from './gameGroups';
import { closeGuidebook, useGuidebooks } from './guidebooks';
import type { GuidebookHit } from './guidebookData';
import {
  coverageOf,
  parseMagazineList,
  searchCoverage,
  type Coverage,
  type Magazine,
} from './magazineData';
import { useAtlas } from './store';

/**
 * The magazines on this device (see `magazineData.ts`): the list of each
 * pack of magazines the shell lists, read again with every listing; which
 * issues cover each game; and the shelf of magazines, which lists them
 * title by title. An issue is read in the guidebook reader, which keeps
 * the text of its pages and the page it was left at (`guidebooks.ts`).
 * Atlas only reads packs of magazines: another app writes them.
 */

/** The list of one pack of magazines, as read. */
export interface PackMagazine {
  url: string;
  status: 'loading' | 'ready' | 'error';
  magazine: Magazine | null;
  /** Why it cannot be read, in a sentence. */
  error: string | null;
}

export interface MagazinesState {
  lists: Readonly<Record<string, PackMagazine>>;
  /** The shelf: closed, open on every title, or open on one title's issues (its pack id). */
  shelf: { packId: string | null } | null;
}

export const useMagazines = create<MagazinesState>()(() => ({
  lists: {},
  shelf: null,
}));

const get = useMagazines.getState;
const set = useMagazines.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Reading the lists

let generation = 0;

/** Reads the list of every pack of magazines listed (again), and forgets packs no longer listed. */
export async function loadMagazineLists(packs: readonly ListedPack[]): Promise<void> {
  const mine = ++generation;
  const shelves = packs.filter((pack) => pack.magazines === true);
  const before = get().lists;
  const lists: Record<string, PackMagazine> = {};
  for (const pack of shelves) {
    const was = before[pack.id];
    lists[pack.id] =
      was?.url === pack.url
        ? { ...was, status: was.status === 'error' ? 'loading' : was.status }
        : { url: pack.url, status: 'loading', magazine: null, error: null };
  }
  set({ lists });
  const read = await Promise.all(
    shelves.map(async (pack): Promise<[string, PackMagazine]> => {
      try {
        const base = pack.url.endsWith('/') ? pack.url : `${pack.url}/`;
        const response = await fetch(new URL('magazines.json', base), { cache: 'no-store' });
        if (!response.ok) throw new Error('The list of this magazine’s issues cannot be read.');
        const magazine = parseMagazineList(await response.text(), pack);
        return [pack.id, { url: pack.url, status: 'ready', magazine, error: null }];
      } catch (error) {
        return [
          pack.id,
          { url: pack.url, status: 'error', magazine: null, error: errorText(error) },
        ];
      }
    }),
  );
  if (mine !== generation) return;
  set({ lists: Object.fromEntries(read) });
  closeIfGone();
}

/** The reader closes when its issue is no longer listed, and the shelf leaves a title that went. */
function closeIfGone(): void {
  const { lists, shelf } = get();
  const open = useGuidebooks.getState().open?.guidebook;
  if (open && 'issue' in open) {
    const still = lists[open.packId]?.magazine?.issues.some(
      (issue) => issue.key === open.key && issue.bytes === open.bytes,
    );
    if (!still) closeGuidebook();
  }
  if (shelf?.packId && !lists[shelf.packId]) set({ shelf: { packId: null } });
}

/**
 * Follows the listings of the shell: the lists of the packs of magazines
 * are read again with each one. Returns the way to stop.
 */
export function followMagazines(): () => void {
  if (!desktop) return () => undefined;
  const packs = useAtlas.getState().library?.packs;
  if (packs) void loadMagazineLists(packs);
  return useAtlas.subscribe((state, before) => {
    if (state.library && state.library !== before.library) {
      void loadMagazineLists(state.library.packs);
    }
  });
}

// ---------------------------------------------------------------------------
// What the app shows

const NO_MAGAZINES: readonly Magazine[] = [];

/** The magazines read, by title. */
export function magazinesOf(lists: MagazinesState['lists']): Magazine[] {
  return Object.values(lists)
    .flatMap((list) => (list.magazine ? [list.magazine] : []))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}

/** The magazines on this device, by title, kept up to date. */
export function useMagazineList(): readonly Magazine[] {
  const lists = useMagazines((s) => s.lists);
  return useMemo(() => {
    const magazines = magazinesOf(lists);
    return magazines.length > 0 ? magazines : NO_MAGAZINES;
  }, [lists]);
}

/** Whether there are packs of magazines on this device, read or not. */
export function useHasMagazines(): boolean {
  return useAtlas((s) => s.library?.packs.some((pack) => pack.magazines === true) ?? false);
}

const NO_COVERAGE: readonly Coverage[] = [];

/** The issues that cover a game, now. */
export function coverageNow(
  gameId: string,
  lists: MagazinesState['lists'] = get().lists,
  packs: readonly ListedPack[] = useAtlas.getState().library?.packs ?? [],
  groups: readonly GameGroup[] = useGameGroups.getState().groups,
): Coverage[] {
  const magazines = magazinesOf(lists);
  if (magazines.length === 0) return [];
  const listed = new Set(packs.map((pack) => pack.id));
  const games = [
    ...packs,
    // The games that come with the app that are not listed.
    ...useAtlas
      .getState()
      .bundledCatalog.filter((entry) => !listed.has(entry.id))
      .map(({ id, title }) => ({ id, title })),
  ];
  return coverageOf(gameId, magazines, games, groups);
}

/** The issues that cover a game, newest first, with the pages about it, kept up to date. */
export function useGameCoverage(gameId: string | null | undefined): readonly Coverage[] {
  const lists = useMagazines((s) => s.lists);
  const packs = useAtlas((s) => s.library?.packs);
  const groups = useGameGroups((s) => s.groups);
  return useMemo(() => {
    if (!gameId || !packs) return NO_COVERAGE;
    const coverage = coverageNow(gameId, lists, packs, groups);
    return coverage.length > 0 ? coverage : NO_COVERAGE;
  }, [gameId, lists, packs, groups]);
}

/** The pages about a game in the issues that cover it that have the words looked for. */
export function useMagazineHits(
  gameId: string | null | undefined,
  query: string,
  limit = 100,
): GuidebookHit[] {
  const coverage = useGameCoverage(gameId);
  const texts = useGuidebooks((s) => s.texts);
  return useMemo(
    () => (query.trim() ? searchCoverage(coverage, texts, query, limit) : []),
    [coverage, texts, query, limit],
  );
}

// ---------------------------------------------------------------------------
// The shelf

/** Opens the shelf of magazines: on one title's issues, or on every title. */
export function openShelf(packId: string | null = null): void {
  set({ shelf: { packId } });
}

export function closeShelf(): void {
  set({ shelf: null });
}
