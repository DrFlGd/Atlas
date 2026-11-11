import { createClock, createMemoryStore, type ProgressStore } from '@atlas/core';
import { createDexieStore } from '@atlas/core/dexie';

/** `updatedAt` values for records written in this session. */
export const clock = createClock();

let store: ProgressStore | null = null;
let persistent = true;

/**
 * Opens the progress store: IndexedDB when the browser allows it, otherwise
 * an in-memory store (progress then lasts until the page closes).
 */
export async function openProgressStore(): Promise<{ store: ProgressStore; persistent: boolean }> {
  if (store) return { store, persistent };
  try {
    const dexie = createDexieStore();
    await dexie.listProfiles();
    store = dexie;
  } catch {
    store = createMemoryStore();
    persistent = false;
  }
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
  panes: 'panes',
  profile: (gameId: string) => `profile:${gameId}`,
  filters: (gameId: string) => `filters:${gameId}`,
  place: (gameId: string) => `place:${gameId}`,
  /** A site's list of games as it was last read, kept so it need not be read each time. */
  catalogue: (importerId: string) => `catalogue:${importerId}`,
} as const;
