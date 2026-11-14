import {
  addCarriedGroup,
  groupOf,
  joinGames,
  randomId,
  renameGroup,
  sameTitleGames,
  sourceNames,
  sourceToOpen,
  takeOut,
  titleRows,
  ungroup,
  type PackEntry,
  type TitleRow,
} from '@atlas/core';
import {
  GAME_GROUPS_VERSION,
  NO_GAME_GROUPS,
  readGameGroupFile,
  readGameGroupsFile,
  writeGameGroupsFile,
  type GameGroup,
} from '@atlas/schema';
import { useEffect } from 'react';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { downloadsOffered } from '../features';
import { notify, saveSetting, showMap, switchGame } from './actions';
import { progressStore, SETTINGS } from './services';
import { useAtlas } from './store';

/**
 * Games shown under one title (see `gameGroups.ts` in the schema package,
 * and in core for the rows and the changes): a person's record of which
 * games on this device are the same game from several sources, so Games
 * and the Library list them as one title, the maps menu lists the maps of
 * every source, and Guides shows the wikis of the title with every source.
 * No game is ever changed or merged.
 *
 * Where it is kept:
 *
 * - in the desktop app, one file in the maps folder (`game-groups.json`),
 *   through the shell (`desktop.gameGroups`), so the viewer and an app with
 *   downloads, which share the maps folder, show the same titles;
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept (the `gameGroups` setting).
 *
 * Each change reads the record again first and is saved at once, so two
 * apps on one computer never write over each other's titles. A file a newer
 * Atlas wrote is used and not written over; one with titles this app could
 * not read is kept as a copy at the first change.
 *
 * Which source a title opened last is this device's own (a setting), never
 * in the record.
 */

/** What is known of one game of a title, from its pack, to name it and list its maps. */
export interface SourceFacts {
  gameId: string;
  title: string;
  /** The importer that made it (its manifest's `source.importer.title`). */
  importerTitle: string | null;
  madeInApp: boolean;
  /** Its maps, in order; empty for a game of pages with no map. */
  maps: { id: string; name: string }[];
}

/** The Importer's offer to show a game just added with games of the same title. */
export interface SameTitleOffer {
  gameId: string;
  /** The games here with the same title, tidied. */
  others: string[];
}

export interface GameGroupsState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Why the titles can be used but not changed here (a newer app wrote them), or null. */
  readOnly: string | null;
  groups: readonly GameGroup[];
  /** A change is being saved. */
  busy: boolean;
  /** What is known of the games of titles, by game id, as far as read. */
  facts: Readonly<Record<string, SourceFacts>>;
  /** The source last shown under each title, by the title's id. */
  last: Readonly<Record<string, string>>;
  /** The Importer's offers not answered yet. */
  offers: readonly SameTitleOffer[];
}

export const useGameGroups = create<GameGroupsState>()(() => ({
  status: 'idle',
  error: null,
  readOnly: null,
  groups: NO_GAME_GROUPS,
  busy: false,
  facts: {},
  last: {},
  offers: [],
}));

const get = useGameGroups.getState;
const set = useGameGroups.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Where they are kept

interface Backend {
  read(): Promise<string | null>;
  write(text: string, keepCopy?: string): Promise<void>;
}

const browserBackend: Backend = {
  async read() {
    const value = await progressStore().getSetting(SETTINGS.gameGroups);
    return typeof value === 'string' ? value : null;
  },
  async write(text, keepCopy) {
    const store = progressStore();
    if (keepCopy) {
      const before = await store.getSetting(SETTINGS.gameGroups);
      if (typeof before === 'string') {
        await store.putSetting(`${SETTINGS.gameGroups}:copy:${keepCopy}`, before);
      }
    }
    await store.putSetting(SETTINGS.gameGroups, text);
  },
};

/** Where the titles are kept on this device (see the top of this file). */
export function gameGroupsBackend(): Backend {
  const { app } = useAtlas.getState();
  if (desktop && app?.gameGroupsFile === true) {
    const bridge = desktop;
    return {
      read: () => bridge.gameGroups.read(),
      write: async (text, keepCopy) => {
        await bridge.gameGroups.write(text, keepCopy);
      },
    };
  }
  return browserBackend;
}

// ---------------------------------------------------------------------------
// Reading

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const NEWER =
  'The titles of your games were saved by a newer version of Atlas, so they can be used here but changed only there.';
const UNREADABLE =
  'The titles of your games could not be read, so they were left as they are. Nothing will be written over them.';

let keepCopyNext = false;

/** Reads the record as it is now: its groups, or why it cannot be used or changed. */
async function readNow(): Promise<
  | { kind: 'ok'; groups: GameGroup[]; newer: boolean; skipped: number }
  | { kind: 'unreadable'; error: string }
> {
  const text = await gameGroupsBackend().read();
  if (text === null) return { kind: 'ok', groups: [], newer: false, skipped: 0 };
  const read = readGameGroupsFile(parse(text));
  if (!read.ok) return { kind: 'unreadable', error: UNREADABLE };
  return {
    kind: 'ok',
    groups: read.file.groups,
    newer: read.file.version > GAME_GROUPS_VERSION,
    skipped: read.file.skipped,
  };
}

let loading: Promise<void> | null = null;

/** Reads the titles, and which source each opened last on this device. Once, unless asked again. */
export function loadGameGroups(again = false): Promise<void> {
  if (loading && !again) return loading;
  set({ status: 'loading', error: null });
  loading = (async () => {
    try {
      const [read, last] = await Promise.all([
        readNow(),
        (async () => progressStore().getSetting(SETTINGS.gameGroupsLast))().catch(() => null),
      ]);
      set({ last: lastOf(last) });
      if (read.kind === 'unreadable') {
        set({ status: 'error', error: read.error, groups: NO_GAME_GROUPS });
        return;
      }
      set({
        status: 'ready',
        groups: read.groups,
        readOnly: read.newer ? NEWER : null,
      });
      if (read.skipped > 0 && !read.newer) {
        keepCopyNext = true;
        notify(
          `${read.skipped === 1 ? 'One title of your games' : `${read.skipped} titles or games of titles`} could not be read and ${read.skipped === 1 ? 'is' : 'are'} left out. A copy of the file as it was is kept when you next change a title.`,
          'error',
        );
      }
      noteShown(useAtlas.getState().game?.entry.id ?? null);
    } catch (error) {
      set({
        status: 'error',
        error: `The titles of your games could not be read: ${errorText(error)}`,
      });
    }
  })();
  return loading;
}

function lastOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/** Whether the titles can be changed now. */
export function canChangeGameGroups(state: GameGroupsState = get()): boolean {
  return state.status === 'ready' && state.readOnly === null && !state.busy;
}

/** Why the titles cannot be changed now, in words; null when they can. */
export function whyGroupsCannotChange(state: GameGroupsState = get()): string | null {
  if (state.status === 'ready' && state.readOnly === null) return null;
  if (state.readOnly) return state.readOnly;
  if (state.status === 'error') return state.error ?? UNREADABLE;
  return 'The titles of your games are still being read. Try again in a moment.';
}

/** The group a game is in, if any. */
export function titleOf(gameId: string, state: GameGroupsState = get()): GameGroup | undefined {
  return groupOf(state.groups, gameId);
}

/** The group of a game, kept up to date. */
export function useTitleOf(gameId: string | null | undefined): GameGroup | undefined {
  return useGameGroups((s) => (gameId ? groupOf(s.groups, gameId) : undefined));
}

/** The rows of a list of games: a title for each group with two or more games here. */
export function useTitleRows(): TitleRow<PackEntry>[] {
  const catalog = useAtlas((s) => s.catalog);
  const groups = useGameGroups((s) => s.groups);
  return titleRowsKnown(catalog, groups);
}

let rowsKnown: {
  catalog: readonly PackEntry[];
  groups: readonly GameGroup[];
  rows: TitleRow<PackEntry>[];
} | null = null;

function titleRowsKnown(
  catalog: readonly PackEntry[],
  groups: readonly GameGroup[],
): TitleRow<PackEntry>[] {
  if (rowsKnown?.catalog === catalog && rowsKnown.groups === groups) return rowsKnown.rows;
  const rows = titleRows(catalog, groups);
  rowsKnown = { catalog, groups, rows };
  return rows;
}

/** The games of a group on this device, in its order. */
export function presentMembers(
  group: GameGroup,
  catalog: readonly PackEntry[] = useAtlas.getState().catalog,
): PackEntry[] {
  return group.members.flatMap(({ gameId }) => {
    const entry = catalog.find((e) => e.id === gameId);
    return entry ? [entry] : [];
  });
}

// ---------------------------------------------------------------------------
// What each source is

const factsKnown = new Map<string, Promise<SourceFacts>>();

/** What a game's own files say of it: its title, where it came from and its maps. */
function factsAt(entry: PackEntry): Promise<SourceFacts> {
  let known = factsKnown.get(entry.url);
  if (!known) {
    known = (async () => {
      const json = async (name: string): Promise<unknown> => {
        try {
          const response = await fetch(new URL(name, entry.url));
          return response.ok ? ((await response.json()) as unknown) : null;
        } catch {
          return null;
        }
      };
      const manifest = (await json('manifest.json')) as {
        title?: unknown;
        madeInApp?: unknown;
        source?: { importer?: { title?: unknown } };
        contents?: { counts?: { maps?: unknown } };
      } | null;
      const counted = manifest?.contents?.counts?.maps;
      // A game of pages has no maps file: its manifest says so where it can.
      const maps = counted === 0 ? [] : await json('maps.json');
      const importer = manifest?.source?.importer?.title;
      return {
        gameId: entry.id,
        title: typeof manifest?.title === 'string' ? manifest.title : entry.title,
        importerTitle: typeof importer === 'string' && importer.trim() !== '' ? importer : null,
        madeInApp: manifest?.madeInApp === true,
        maps: Array.isArray(maps)
          ? maps.flatMap((map: unknown) => {
              const { id, name } = (map ?? {}) as { id?: unknown; name?: unknown };
              return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
            })
          : [],
      };
    })();
    factsKnown.set(entry.url, known);
  }
  return known;
}

/** Reads what is known of the games of the titles here, once per game and its files. */
export async function loadSourceFacts(entries: readonly PackEntry[]): Promise<void> {
  const facts = await Promise.all(entries.map((entry) => factsAt(entry)));
  const known = get().facts;
  if (facts.every((f) => known[f.gameId] === f)) return;
  set({ facts: { ...known, ...Object.fromEntries(facts.map((f) => [f.gameId, f])) } });
}

// A game read again (an import, a new map) may have other maps now.
useAtlas.subscribe((state, before) => {
  if (state.library === before.library) return;
  factsKnown.clear();
  set({ facts: {} });
});

/**
 * The name of each source of a title on this device, by game id (see
 * `sourceNames` in core): from what its pack says, or what the Library
 * lists while that is read.
 */
export function namesOfSources(
  group: GameGroup,
  catalog: readonly PackEntry[] = useAtlas.getState().catalog,
  facts: Readonly<Record<string, SourceFacts>> = get().facts,
): Map<string, string> {
  const listing = useAtlas.getState().library;
  return sourceNames(
    presentMembers(group, catalog).map((entry) => {
      const known = facts[entry.id];
      const listed = listing?.packs.find((pack) => pack.id === entry.id);
      return {
        gameId: entry.id,
        title: known?.title ?? entry.title,
        importerTitle: known?.importerTitle ?? listed?.imported?.importerTitle ?? null,
        madeInApp: known?.madeInApp ?? listed?.madeInApp === true,
      };
    }),
  );
}

/** The names of a title's sources, kept up to date, and read when first asked for. */
export function useSourceNames(group: GameGroup | undefined): Map<string, string> {
  const catalog = useAtlas((s) => s.catalog);
  const facts = useGameGroups((s) => s.facts);
  useSourceFacts(group);
  return group ? namesOfSources(group, catalog, facts) : new Map<string, string>();
}

/** Reads what is known of a title's sources while it is shown (see {@link loadSourceFacts}). */
export function useSourceFacts(
  group: GameGroup | undefined,
): Readonly<Record<string, SourceFacts>> {
  const catalog = useAtlas((s) => s.catalog);
  const facts = useGameGroups((s) => s.facts);
  const known = group ? presentMembers(group, catalog).every((e) => facts[e.id]) : true;
  useEffect(() => {
    if (group && !known) void loadSourceFacts(presentMembers(group, catalog));
  }, [group, catalog, known]);
  return facts;
}

/** Whether a source has a map, as far as known; undefined until read. */
function hasMapNow(gameId: string): boolean | undefined {
  const facts = get().facts[gameId];
  return facts ? facts.maps.length > 0 : undefined;
}

// ---------------------------------------------------------------------------
// Showing a title and its sources

/**
 * Shows a title: the source last shown under it on this device, else its
 * first one here, a source with a map before a wiki (a wiki of the title
 * shows in the Guides of every source).
 */
export async function openTitle(group: GameGroup): Promise<void> {
  const entries = presentMembers(group);
  await loadSourceFacts(entries);
  const id = sourceToOpen(
    group,
    new Set(entries.map((entry) => entry.id)),
    get().last[group.id] ?? null,
    hasMapNow,
  );
  if (id) await switchGame(id);
}

/** The source of a title to open, as {@link openTitle} would choose it, if known now. */
export function sourceToOpenNow(group: GameGroup): string | null {
  const entries = presentMembers(group);
  return sourceToOpen(
    group,
    new Set(entries.map((entry) => entry.id)),
    get().last[group.id] ?? null,
    hasMapNow,
  );
}

/**
 * Shows another source of the title shown, on one of its maps: that game
 * opens as itself, and the map is shown. Where the person was in each
 * source is remembered as it always is, by game.
 */
export async function showSource(gameId: string, mapId?: string): Promise<void> {
  if (useAtlas.getState().game?.entry.id !== gameId) await switchGame(gameId);
  if (mapId && useAtlas.getState().game?.entry.id === gameId) showMap(mapId);
}

/** Remembers the source shown under its title, for the title to open it next time. */
export function noteShown(gameId: string | null): void {
  if (!gameId) return;
  const group = groupOf(get().groups, gameId);
  if (!group || get().last[group.id] === gameId) return;
  const last = { ...get().last, [group.id]: gameId };
  set({ last });
  saveSetting(SETTINGS.gameGroupsLast, last);
}

useAtlas.subscribe((state, before) => {
  const id = state.game?.entry.id ?? null;
  if (id !== (before.game?.entry.id ?? null)) noteShown(id);
});

// ---------------------------------------------------------------------------
// Changing them

/** A new group's id. */
const newGroupId = () => `title-${randomId().slice(0, 12)}`;

/**
 * Changes the titles: reads them again, applies `edit` and saves at once.
 * With `said`, says so, with Undo that puts back the titles as they were.
 * Returns whether it was saved.
 */
async function changeGroups(
  edit: (groups: readonly GameGroup[]) => GameGroup[],
  said: string | null,
): Promise<boolean> {
  const why = whyGroupsCannotChange();
  if (why || get().busy) {
    if (why) notify(why, 'error');
    return false;
  }
  set({ busy: true });
  try {
    const read = await readNow();
    if (read.kind === 'unreadable') {
      set({ status: 'error', error: read.error });
      notify(read.error, 'error');
      return false;
    }
    if (read.newer) {
      set({ readOnly: NEWER, groups: read.groups });
      notify(NEWER, 'error');
      return false;
    }
    if (read.skipped > 0) keepCopyNext = true;
    const before = read.groups;
    const next = edit(before);
    const text = writeGameGroupsFile(next, new Date());
    const keepCopy = keepCopyNext ? new Date().toISOString() : undefined;
    await gameGroupsBackend().write(text, keepCopy);
    keepCopyNext = false;
    set({ groups: next });
    if (said) {
      notify(said, 'info', {
        action: {
          label: 'Undo',
          run: () => {
            void changeGroups(() => [...before], null).then((done) => {
              if (done) notify('Undone.');
            });
          },
        },
      });
    }
    return true;
  } catch (error) {
    notify(`The titles of your games could not be saved: ${errorText(error)}`, 'error');
    return false;
  } finally {
    set({ busy: false });
  }
}

/**
 * Shows `other` with `first` under one title (more games may share it: a
 * game under a title already brings its title's games). `first` keeps its
 * place, and is opened the first time unless it already was part of a title.
 */
export function showWithAnother(first: string, other: string, title: string): Promise<boolean> {
  return changeGroups(
    (groups) => joinGames(groups, first, other, title, newGroupId()),
    `Shown under one title: ${title.trim()}.`,
  );
}

/** Gives a title another name. */
export function renameTitle(groupId: string, title: string): Promise<boolean> {
  return changeGroups((groups) => renameGroup(groups, groupId, title), null);
}

/** Shows the games of a title separately again. Nothing of theirs changes. */
export function showSeparately(group: GameGroup): Promise<boolean> {
  return changeGroups(
    (groups) => ungroup(groups, group.id),
    `${group.title} is shown as separate games again.`,
  );
}

/** Takes one source out of its title; it is shown on its own again. */
export function takeOutOfTitle(gameId: string, name: string): Promise<boolean> {
  const group = groupOf(get().groups, gameId);
  if (!group) return Promise.resolve(false);
  return changeGroups(
    (groups) => takeOut(groups, gameId),
    `${name} is shown on its own again, apart from ${group.title}.`,
  );
}

/**
 * A game deleted leaves its title: the other games of the title stay
 * together while two or more are left. Says nothing; the delete is said.
 */
export async function forgetDeletedGame(gameId: string): Promise<void> {
  if (get().status === 'idle') await loadGameGroups();
  if (!groupOf(get().groups, gameId) || whyGroupsCannotChange()) return;
  await changeGroups((groups) => takeOut(groups, gameId), null);
}

/**
 * Adds the title a map pack file carried for its game: the game joins the
 * title here one of its games is under, or the file's title is added, its
 * games not on this device included, so it shows once they are. Returns
 * the title the game is under afterwards, or null.
 */
export async function addImportedGameGroup(gameId: string, text: string): Promise<string | null> {
  const read = readGameGroupFile(parse(text));
  if (!read.ok || read.group.gameId !== gameId) {
    throw new Error('The title in the file could not be read.');
  }
  if (get().status === 'idle') await loadGameGroups();
  const why = whyGroupsCannotChange();
  if (why) throw new Error(why);
  let title: string | null = null;
  const done = await changeGroups((groups) => {
    const added = addCarriedGroup(groups, read.group, newGroupId());
    title = added.group?.title ?? null;
    return added.groups;
  }, null);
  if (!done) throw new Error('It could not be saved.');
  return title;
}

// ---------------------------------------------------------------------------
// The Importer's offer: a game added with the title of one already here

/**
 * After a game is added in an app with downloads (the Importer): when a
 * game here has the same title (tidied: case, accents, punctuation), offers
 * once to show them under one title. Nothing is grouped unless the person
 * says so.
 */
export async function offerSameTitle(gameId: string): Promise<void> {
  if (!__ATLAS_DOWNLOADS__ || !downloadsOffered(useAtlas.getState())) return;
  if (get().status === 'idle') await loadGameGroups();
  if (get().status !== 'ready' || groupOf(get().groups, gameId)) return;
  const others = sameTitleGames(useAtlas.getState().catalog, gameId).map((entry) => entry.id);
  if (others.length === 0) return;
  const store = progressStore();
  const asked = await store.getSetting(SETTINGS.gameGroupsAsked).catch(() => null);
  const list = Array.isArray(asked) ? asked.filter((id) => typeof id === 'string') : [];
  if (list.includes(gameId)) return;
  saveSetting(SETTINGS.gameGroupsAsked, [...list, gameId].slice(-500));
  set({ offers: [...get().offers.filter((o) => o.gameId !== gameId), { gameId, others }] });
}

/** The offer for a game, if one waits. */
export function useOfferFor(gameId: string | null): SameTitleOffer | undefined {
  return useGameGroups((s) => (gameId ? s.offers.find((o) => o.gameId === gameId) : undefined));
}

/** The title the games of an offer would be shown under: that of the game here first. */
export function offeredTitle(offer: SameTitleOffer): string {
  const first = offer.others[0] ?? offer.gameId;
  return (
    groupOf(get().groups, first)?.title ??
    useAtlas.getState().catalog.find((entry) => entry.id === first)?.title ??
    ''
  );
}

/** Says yes to an offer: the game joins the games of the same title, under `title`. */
export async function acceptOffer(offer: SameTitleOffer, title: string): Promise<boolean> {
  const [first, ...rest] = offer.others;
  if (!first) return false;
  const done = await changeGroups((groups) => {
    let next = joinGames(groups, first, offer.gameId, title, newGroupId());
    for (const other of rest) next = joinGames(next, first, other, title, newGroupId());
    return next;
  }, `Shown under one title: ${title.trim()}.`);
  if (done) dismissOffer(offer);
  return done;
}

/** Leaves the games apart; the offer is not made again. */
export function dismissOffer(offer: SameTitleOffer): void {
  set({ offers: get().offers.filter((o) => o.gameId !== offer.gameId) });
}
