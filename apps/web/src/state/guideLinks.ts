import { loadPack, type LoadedPack, type PackEntry } from '@atlas/core';
import {
  GUIDE_LINKS_VERSION,
  readGuideLinksFile,
  sameLinkTarget,
  writeGuideLinksFile,
  type GuideLinks,
  type LinkChoice,
  type LinkTarget,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { notify } from './actions';
import type { SaveState } from './ownLists';
import { progressStore } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * A person's links between guide pages and the map of the game shown (see
 * `guideLinks.ts` in the schema package), and where they are kept, as own
 * lists are (see `ownLists.ts`):
 *
 * - in the desktop app, a file beside the game's folder in the maps folder
 *   (`<game id>.guide-links.json`), through the shell (`desktop.guideLinks`);
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, as a setting of the game (`guideLinks:<game id>`).
 *
 * Nothing is linked until the person says so; this keeps what they said.
 * A change is saved a moment after it is made, and at once when the page
 * is hidden or closed. A file a newer Atlas wrote is used and not written
 * over; one with choices this app could not read is kept as a copy at the
 * first save.
 *
 * It also loads the guides of the other games the person chose to read
 * with this one (`guidesFrom`): their packs are read as they are, never
 * changed.
 */

/** Another game's pack whose guides are read with the game shown. */
export interface OtherGuides {
  gameId: string;
  title: string;
  pack: LoadedPack;
}

export interface GuideLinksState {
  /** The game the links are of; null before a game is loaded. */
  gameId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Why the links can be used but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  links: GuideLinks;
  save: SaveState;
  saveError: string | null;
  /** The other games' guides, as far as they are loaded, in the order chosen. */
  others: readonly OtherGuides[];
  /** Other games chosen earlier that are not on this device now. */
  othersMissing: readonly string[];
}

const EMPTY: GuideLinks = { guidesFrom: [], choices: {} };

export const useGuideLinks = create<GuideLinksState>()(() => ({
  gameId: null,
  status: 'idle',
  error: null,
  readOnly: null,
  links: EMPTY,
  save: 'saved',
  saveError: null,
  others: [],
  othersMissing: [],
}));

const get = useGuideLinks.getState;
const set = useGuideLinks.setState;

// ---------------------------------------------------------------------------
// Where they are kept

/** The key of a game's guide links among the settings, where the shell has no file for them. */
export const guideLinksSetting = (gameId: string) => `guideLinks:${gameId}`;

interface Backend {
  read(gameId: string): Promise<string | null>;
  write(gameId: string, text: string, keepCopy?: string): Promise<void>;
}

const browserBackend: Backend = {
  async read(gameId) {
    const value = await progressStore().getSetting(guideLinksSetting(gameId));
    return typeof value === 'string' ? value : null;
  },
  async write(gameId, text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(guideLinksSetting(gameId));
      if (typeof before === 'string') {
        await store.putSetting(`${guideLinksSetting(gameId)}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(guideLinksSetting(gameId), text);
  },
};

function backend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownListFiles === true) {
    const bridge = desktop;
    return {
      read: (gameId) => bridge.guideLinks.read(gameId),
      write: async (gameId, text, keepCopy) => {
        await bridge.guideLinks.write(gameId, text, keepCopy);
      },
    };
  }
  return browserBackend;
}

// ---------------------------------------------------------------------------
// Reading

let loadingFor: string | null = null;
let loading: Promise<void> | null = null;

/** Reads the guide links of a game, once per game, then the other games' guides it names. */
export function loadGuideLinks(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (loadingFor === gameId && loading) return loading;
  void flushGuideLinks();
  loadingFor = gameId;
  keepCopyNext = false;
  set({
    gameId,
    status: 'loading',
    error: null,
    readOnly: null,
    links: EMPTY,
    save: 'saved',
    saveError: null,
    others: [],
    othersMissing: [],
  });
  loading = (async () => {
    try {
      const text = await backend().read(gameId);
      if (loadingFor !== gameId) return;
      if (text !== null) {
        let value: unknown = null;
        try {
          value = JSON.parse(text);
        } catch {
          // Not JSON: said below.
        }
        const read = readGuideLinksFile(value);
        if (!read.ok || read.file.gameId !== gameId) {
          set({
            status: 'error',
            error:
              'Your links between pages and the map could not be read, so they were left as they are. Nothing will be written over them.',
          });
          return;
        }
        const { file } = read;
        const newer = file.version > GUIDE_LINKS_VERSION;
        set({
          links: { guidesFrom: file.guidesFrom, choices: file.choices },
          readOnly: newer
            ? 'These links were saved by a newer version of Atlas, so they can be used here but changed only there.'
            : null,
        });
        if (file.skipped > 0 && !newer) {
          keepCopyNext = true;
          notify(
            `${file.skipped === 1 ? 'One of your links' : `${file.skipped} of your links`} between pages and the map could not be read and ${file.skipped === 1 ? 'is' : 'are'} left out. A copy of the file as it was is kept when you next change a link.`,
            'error',
          );
        }
      }
      set({ status: 'ready' });
      await loadOthers(gameId);
    } catch (error) {
      if (loadingFor !== gameId) return;
      set({
        status: 'error',
        error: `Your links between pages and the map could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  })();
  return loading;
}

/** Packs of other games read in this session, by address: their guides do not change while shown. */
const otherPacks = new Map<string, Promise<LoadedPack>>();

function packAt(entry: PackEntry): Promise<LoadedPack> {
  let pack = otherPacks.get(entry.url);
  if (!pack) {
    pack = loadPack(entry.url);
    otherPacks.set(entry.url, pack);
    pack.catch(() => otherPacks.delete(entry.url));
  }
  return pack;
}

/** Loads the guides of the other games named in the links, those on this device. */
async function loadOthers(gameId: string): Promise<void> {
  const { catalog } = useAtlas.getState();
  const others: OtherGuides[] = [];
  const missing: string[] = [];
  for (const id of get().links.guidesFrom) {
    const entry = catalog.find((p) => p.id === id);
    if (!entry) {
      missing.push(id);
      continue;
    }
    try {
      const pack = await packAt(entry);
      if (pack.manifest.gameId !== id) {
        missing.push(id);
        continue;
      }
      others.push({ gameId: id, title: pack.manifest.title, pack });
    } catch {
      missing.push(id);
    }
  }
  if (get().gameId !== gameId) return;
  set({ others, othersMissing: missing });
}

/** Whether the links can be changed now. */
export function canChangeGuideLinks(state: GuideLinksState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null;
}

/** What the person said about a page, if anything. */
export function choiceOf(guideId: string): LinkChoice | undefined {
  return get().links.choices[guideId];
}

// ---------------------------------------------------------------------------
// Changing them

const SAVE_DELAY_MS = 500;
let timer: number | undefined;
let writing: Promise<void> = Promise.resolve();
let dirty = false;
let keepCopyNext = false;

function changed(links: GuideLinks): void {
  set({ links, save: 'unsaved', saveError: null });
  dirty = true;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    void flushGuideLinks();
  }, SAVE_DELAY_MS);
}

/** Saves what has changed now, after any save under way. */
export function flushGuideLinks(): Promise<void> {
  window.clearTimeout(timer);
  timer = undefined;
  if (!dirty) return writing;
  const { gameId, links } = get();
  if (!gameId || !canChangeGuideLinks()) return writing;
  dirty = false;
  let text: string;
  try {
    text = writeGuideLinksFile(gameId, links, new Date());
  } catch (error) {
    set({ save: 'failed', saveError: 'Your links could not be saved: they are not valid.' });
    console.error(error);
    return writing;
  }
  const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
  keepCopyNext = false;
  set({ save: 'saving' });
  writing = writing
    .then(() => backend().write(gameId, text, keepCopy))
    .then(
      () => {
        if (get().gameId === gameId && !dirty) set({ save: 'saved', saveError: null });
      },
      (error: unknown) => {
        if (get().gameId !== gameId) return;
        dirty = true;
        const message = error instanceof Error ? error.message : String(error);
        set({ save: 'failed', saveError: message });
        notify(`Your links between pages and the map could not be saved: ${message}`, 'error');
      },
    );
  return writing;
}

function setChoices(change: (choices: Record<string, LinkChoice>) => void): boolean {
  if (!canChangeGuideLinks()) return false;
  const { links } = get();
  const choices = { ...links.choices };
  change(choices);
  changed({ ...links, choices });
  return true;
}

/** Links a page to these targets (replacing what it was linked to). */
export function linkPage(guideId: string, targets: readonly LinkTarget[]): boolean {
  if (targets.length === 0) return false;
  const unique = targets.filter((t, i) => targets.findIndex((u) => sameLinkTarget(t, u)) === i);
  return setChoices((choices) => {
    choices[guideId] = { state: 'linked', targets: unique };
  });
}

/** Links several pages at once, each to its targets ("Confirm all sure"). */
export function linkPages(links: readonly { guideId: string; target: LinkTarget }[]): boolean {
  if (links.length === 0) return false;
  return setChoices((choices) => {
    for (const { guideId, target } of links)
      choices[guideId] = { state: 'linked', targets: [target] };
  });
}

/** Leaves a page unlinked, and says so, so it is not offered again. */
export function skipPage(guideId: string): boolean {
  return setChoices((choices) => {
    choices[guideId] = { state: 'skipped' };
  });
}

/** Forgets what was said about a page: it is offered again, unlinked. */
export function forgetChoice(guideId: string): boolean {
  if (!canChangeGuideLinks()) return false;
  const { links } = get();
  const choices = Object.fromEntries(
    Object.entries(links.choices).filter(([id]) => id !== guideId),
  );
  changed({ ...links, choices });
  return true;
}

/** Reads another game's guides with this game's, and remembers that. */
export async function addGuidesFrom(gameId: string): Promise<void> {
  const { links, gameId: shown } = get();
  if (!shown || gameId === shown || links.guidesFrom.includes(gameId) || !canChangeGuideLinks()) {
    return;
  }
  changed({ ...links, guidesFrom: [...links.guidesFrom, gameId] });
  await loadOthers(shown);
}

/** Stops reading another game's guides with this game's. What was linked is kept. */
export function removeGuidesFrom(gameId: string): void {
  const { links, others, othersMissing } = get();
  if (!canChangeGuideLinks()) return;
  changed({ ...links, guidesFrom: links.guidesFrom.filter((id) => id !== gameId) });
  set({
    others: others.filter((other) => other.gameId !== gameId),
    othersMissing: othersMissing.filter((id) => id !== gameId),
  });
}

// ---------------------------------------------------------------------------
// Other games that have guides to read with this one

/** A game on this device with pages and no map, offered to read with the game shown. */
export interface GuideGame {
  id: string;
  title: string;
  /** Its number of guides, when its manifest says. */
  guides: number | null;
}

const kinds = new Map<string, Promise<GuideGame | null>>();

/** Whether a game of the catalogue has guides and no map, from its manifest (or its files). */
function guideGameAt(entry: PackEntry): Promise<GuideGame | null> {
  let known = kinds.get(entry.url);
  if (!known) {
    known = (async () => {
      const json = async (name: string): Promise<unknown> => {
        const response = await fetch(new URL(name, entry.url));
        return response.ok ? ((await response.json()) as unknown) : null;
      };
      try {
        const manifest = (await json('manifest.json')) as {
          title?: unknown;
          contents?: { counts?: { maps?: unknown; guides?: unknown } };
        } | null;
        const title = typeof manifest?.title === 'string' ? manifest.title : entry.title;
        const counts = manifest?.contents?.counts;
        if (typeof counts?.maps === 'number' && typeof counts.guides === 'number') {
          return counts.maps === 0 && counts.guides > 0
            ? { id: entry.id, title, guides: counts.guides }
            : null;
        }
        // An older manifest: its files say.
        const maps = await json('maps.json').catch(() => null);
        if (Array.isArray(maps) && maps.length > 0) return null;
        const guides = await json('guides.json').catch(() => null);
        return Array.isArray(guides) && guides.length > 0
          ? { id: entry.id, title, guides: guides.length }
          : null;
      } catch {
        return null;
      }
    })();
    kinds.set(entry.url, known);
  }
  return known;
}

/** The games on this device, other than `gameId`, that have pages and no map. */
export async function guideGames(gameId: string): Promise<GuideGame[]> {
  const { catalog } = useAtlas.getState();
  const found = await Promise.all(
    catalog.filter((entry) => entry.id !== gameId).map((entry) => guideGameAt(entry)),
  );
  return found.filter((game): game is GuideGame => game !== null);
}

/** Whether any other game on this device has pages and no map (so Guides offers to add them). */
export const useGuideGamesOffered = create<{ gameId: string | null; offered: boolean }>()(() => ({
  gameId: null,
  offered: false,
}));

/** Looks for such games once per game shown. */
export async function lookForGuideGames(game: LoadedGame): Promise<void> {
  const gameId = game.pack.manifest.gameId;
  if (useGuideGamesOffered.getState().gameId === gameId) return;
  useGuideGamesOffered.setState({ gameId, offered: false });
  if (game.pack.data.maps.length === 0) return;
  const games = await guideGames(gameId);
  if (useGuideGamesOffered.getState().gameId === gameId) {
    useGuideGamesOffered.setState({ offered: games.length > 0 });
  }
}

// ---------------------------------------------------------------------------
// Saving when the page goes

if (typeof window !== 'undefined') {
  const flush = () => {
    void flushGuideLinks();
  };
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
