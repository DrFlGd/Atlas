import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify, switchGame } from './actions';
import { refreshLibrary } from './library';
import type { AtlasState } from './store';
import { useAtlas } from './store';

/**
 * The Library: where the desktop app lists its games, adds maps and wikis,
 * and downloads what a game needs (see `library/` for the screens). In the
 * standard layout it is a section of its own; in the classic layout the
 * folder button opens it over the whole window. Android and the browser
 * have no Library: they keep the Games screen.
 */

/** What the right side of the Library shows. */
export type LibraryPane = 'game' | 'add' | 'settings';

export interface LibraryViewState {
  /** Classic layout: the Library fills the window. */
  windowOpen: boolean;
  /** The game open on the right; null for the one shown. */
  gameId: string | null;
  pane: LibraryPane;
  /** The More menu of the open game. */
  more: boolean;
  /** The Downloads panel. */
  downloads: boolean;
  /** Increases when the address box should take the focus. */
  addFocus: number;
}

export const useLibrary = create<LibraryViewState>()(() => ({
  windowOpen: false,
  gameId: null,
  pane: 'game',
  more: false,
  downloads: false,
  addFocus: 0,
}));

const set = useLibrary.setState;
const get = useLibrary.getState;

/**
 * Whether this app has the Library: the desktop app, not the Android app
 * (which keeps its Games screen) and not a browser (no shell at all).
 */
export function libraryOffered(state: Pick<AtlasState, 'app'>): boolean {
  const app = state.app;
  return (
    desktop !== null &&
    app !== null &&
    app.platform !== 'android' &&
    app.maps !== false &&
    app.folders !== false
  );
}

/** How the layout shows the Library and leaves it: set by the standard layout while it is shown. */
export interface LibraryHost {
  /** Shows the Library section. */
  show(): void;
  /** Leaves the Library for the game shown (its map, or its guides). */
  leave(): void;
  /** Shows the settings. */
  settings(): void;
}

let host: LibraryHost | null = null;

/** The standard layout registers how it shows the Library; null when it goes. */
export function setLibraryHost(next: LibraryHost | null): void {
  host = next;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Opens the Library: its section, or the whole window in the classic layout. */
export function openLibrary(patch: Partial<Omit<LibraryViewState, 'windowOpen'>> = {}): void {
  set({ more: false, ...patch });
  if (host) host.show();
  else set({ windowOpen: true });
  refreshLibrary().catch((error: unknown) => {
    notify(errorText(error), 'error');
  });
}

/** Closes the Library window of the classic layout. */
export function closeLibraryWindow(): void {
  set({ windowOpen: false, more: false, downloads: false });
}

/** Leaves the Library for the game shown. */
export function leaveLibrary(): void {
  set({ more: false, downloads: false });
  if (host) host.leave();
  else closeLibraryWindow();
}

/** "Add a map or a wiki": the steps of adding, on the right. */
export function showLibraryAdd(): void {
  openLibrary({ pane: 'add' });
}

/** Puts the focus in the address box, with the steps of adding on the right. */
export function focusAddBox(): void {
  openLibrary({ pane: 'add', addFocus: get().addFocus + 1 });
}

/** Opens a game on the right. */
export function openLibraryGame(gameId: string): void {
  set({ gameId, pane: 'game', more: false });
}

/** The settings: their own section in the standard layout, the Library's right side in the classic one. */
export function openSettings(): void {
  if (host) host.settings();
  else openLibrary({ pane: 'settings' });
}

/** Back to the open game from adding or the settings. */
export function showLibraryGame(): void {
  set({ pane: 'game', more: false });
}

export function setMoreOpen(more: boolean): void {
  set({ more });
}

export function setDownloadsOpen(downloads: boolean): void {
  set({ downloads, more: false });
}

/** "Show": shows a game and leaves the Library for it. */
export async function showGame(gameId: string): Promise<void> {
  if (useAtlas.getState().game?.entry.id !== gameId) await switchGame(gameId);
  leaveLibrary();
}

/** The game open in the Library: the one chosen, else the one shown. */
export function useOpenGameId(): string | null {
  const chosen = useLibrary((s) => s.gameId);
  const catalog = useAtlas((s) => s.catalog);
  const shown = useAtlas((s) => s.game?.entry.id ?? null);
  if (chosen && catalog.some((entry) => entry.id === chosen)) return chosen;
  return shown;
}
