import { createClock, createMemoryStore, type ProgressStore } from '@atlas/core';
import { createDexieStore } from '@atlas/core/dexie';

/** `updatedAt` values for records written in this session. */
export const clock = createClock();

let store: ProgressStore | null = null;
let persistent = true;

/** Saves that have started and not finished. */
let saving = 0;

/**
 * Says on the page whether a save is under way (`data-saving` on the root
 * element). The app saves without waiting, so whatever is about to reload
 * the page, the browser tests above all, can wait for "false" first: a
 * reload drops a save that has not finished.
 */
function showSaving(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.saving = saving > 0 ? 'true' : 'false';
}

/** `inner`, with its saves counted while they run (see {@link showSaving}). */
function counted(inner: ProgressStore): ProgressStore {
  const track = async <T>(work: Promise<T>): Promise<T> => {
    saving += 1;
    showSaving();
    try {
      return await work;
    } finally {
      saving -= 1;
      showSaving();
    }
  };
  return {
    ...inner,
    putSetting: (key, value) => track(inner.putSetting(key, value)),
    putSettings: (entries) => track(inner.putSettings(entries)),
    write: (batch) => track(inner.write(batch)),
  };
}

/**
 * Opens the progress store: IndexedDB when the browser allows it, otherwise
 * an in-memory store (progress then lasts until the page closes).
 */
export async function openProgressStore(): Promise<{ store: ProgressStore; persistent: boolean }> {
  if (store) return { store, persistent };
  try {
    const dexie = createDexieStore();
    await dexie.listProfiles();
    store = counted(dexie);
  } catch {
    store = counted(createMemoryStore());
    persistent = false;
  }
  showSaving();
  return { store, persistent };
}

/** The store opened by {@link openProgressStore}. */
export function progressStore(): ProgressStore {
  if (!store) throw new Error('The progress store is not open yet');
  return store;
}

/** Keys of device-local settings. */
export const SETTINGS = {
  activePack: 'activePack',
  theme: 'theme',
  /** The layout: the standard one, or the classic one (see `touch/uiMode.ts`). */
  layout: 'layout',
  panes: 'panes',
  profile: (gameId: string) => `profile:${gameId}`,
  filters: (gameId: string) => `filters:${gameId}`,
  place: (gameId: string) => `place:${gameId}`,
  /** Search results chosen in the touch layout, latest first. */
  recentSearches: (gameId: string) => `recentSearches:${gameId}`,
  /** The view each list was last shown in, in the standard layout, by list id. */
  listViews: (gameId: string) => `listViews:${gameId}`,
  /** The list last opened in the standard layout, for Lists to offer to continue. */
  lastList: (gameId: string) => `lastList:${gameId}`,
  /** Whether an open list is shown alone on the map in the standard layout (on unless turned off). */
  listOnlyOnMap: 'listOnlyOnMap',
  /** Whether the Android app keeps the screen on while it is shown. */
  keepScreenOn: 'keepScreenOn',
  /** The game save linked to a profile (see `state/saves.ts`). */
  saveLink: (profileId: string) => `saveLink:${profileId}`,
  /** Which map shows which game world, as the person chose. */
  saveWorlds: (gameId: string) => `saveWorlds:${gameId}`,
  /** World-to-map transforms made from saves, by map id. */
  saveCalibration: (gameId: string) => `saveCalibration:${gameId}`,
  /** Spots the person marked on a map that is not lined up yet, by map id. */
  savePoints: (gameId: string) => `savePoints:${gameId}`,
  /**
   * The table of a game's own map pins, read from the game's files in the
   * desktop app, by the save reader's id. It holds data from the game, so
   * it stays on this device: settings are never exported.
   */
  gamePins: (readerId: string) => `gamePins:${readerId}`,
  /** A site's list of games as it was last read, kept so it need not be read each time. */
  catalogue: (importerId: string) => `catalogue:${importerId}`,
  /** Pages chosen to read that a go did not reach (it was stopped, or the site refused), by game, for an importer that keeps them. */
  pageQueue: (importerId: string) => `pageQueue:${importerId}`,
  /** A wiki's contents as last read, by the page key of its address (see `wikiNotes.ts`). */
  wikiContents: (importerId: string) => `wikiContents:${importerId}`,
  /** Pages of a wiki that could not be read, with why. */
  wikiFailed: (importerId: string) => `wikiFailed:${importerId}`,
  /**
   * The pages of the same wiki each page read links to, all in one record:
   * how version 0.6.1 kept them. Read, moved to {@link SETTINGS.wikiPageLinks}
   * and emptied.
   */
  wikiLinks: (importerId: string) => `wikiLinks:${importerId}`,
  /** The pages of the same wiki one page read links to, a record per page, by its page key. */
  wikiPageLinks: (importerId: string, key: string) => `wikiPageLinks:${importerId}:${key}`,
  /** The start of the keys of {@link SETTINGS.wikiPageLinks}, to read them all. */
  wikiPageLinksOf: (importerId: string) => `wikiPageLinks:${importerId}:`,
  /** Other names of a wiki's pages read: the page key asked, with the address the page was read from. */
  wikiOtherNames: (importerId: string) => `wikiOtherNames:${importerId}`,
  /** Pages of a wiki the person left out. */
  wikiLeftOut: (importerId: string) => `wikiLeftOut:${importerId}`,
  /** How far a go follows the links of a wiki's pages, as last chosen (see `followLinks.ts`). */
  wikiFollow: (importerId: string) => `wikiFollow:${importerId}`,
  /** The person's choices for each site of an importer's wikis, by its key: how it is read, the licence they confirmed (see `wikiNotes.ts`). */
  wikiSites: (importerId: string) => `wikiSites:${importerId}`,
  /**
   * The games shown under one title, where the shell has no file for them
   * (see `gameGroups.ts`): the text of the file, as the desktop app keeps it.
   */
  gameGroups: 'gameGroups',
  /** The source last used under each title, by the title's id: this device's own. */
  gameGroupsLast: 'gameGroupsLast',
  /** Games the Importer offered to show with a game of the same title, once each. */
  gameGroupsAsked: 'gameGroupsAsked',
} as const;
