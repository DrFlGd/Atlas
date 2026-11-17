import {
  entryIdOf,
  madeLanding,
  OTHER_GAME_SECTION,
  readInOrder,
  siteOf,
  type ContentsEntry,
  type ContentsStep,
  type GuideContents,
  type LandingGroup,
  type LoadedPack,
} from '@atlas/core';
import { parseId, readOwnPagesFile, type GuideEntry } from '@atlas/schema';
import { create } from 'zustand';
import { saveSetting } from './actions';
import { useGuideLinks } from './guideLinks';
import { guidesOf, otherGuidesOf, type GameGuides } from './guides';
import { ownPagesBackend, ownPagesOf, useOwnPages } from './ownPages';
import { packSaysPagesInOrder } from './pagesInOrder';
import { progressStore, SETTINGS } from './services';
import { useAtlas, type LoadedGame } from './store';

/**
 * The sources of pages a game's Guides reads (see `guides.ts`): the game's
 * own pages, and those of each other game read with it (see
 * `guideLinks.ts`), each a part of the one contents that holds them all.
 * Guides shows one source at a time, chosen at its top; search, links
 * between the sources, "From the wiki" and the rest work on all of them
 * together, as before.
 *
 * A source is a guide, read in order, when its pack says so (see
 * `pagesInOrder.ts`) or the person said so in that game's contents editor
 * (kept with their own pages, see `pagesInOrder` in the schema); else it is
 * a wiki, read as a collection. A guide's pages end with Previous and Next,
 * in the order of its contents, and it offers to continue at the page read
 * last.
 *
 * Kept on this device, as settings, where other choices of a game are:
 * the source Guides showed last for each game (`guidesSource:<game id>`),
 * and the page read last in each guide (`guideReadLast:<source's game id>`).
 */

/** A source of pages, as Guides shows it. */
export interface GuideSource {
  /** The game the pages are of: the game shown, or another read with it. */
  gameId: string;
  /** The game shown's own pages (the pack's and the person's). */
  own: boolean;
  /** The pack's title. */
  title: string;
  pack: LoadedPack;
  /** The site its pages were read from, where its pack records one. */
  site: string | null;
  /** The section of the contents that holds its pages; null for the game shown's own. */
  sectionId: string | null;
  /** Its home page, which its landing page shows; null for none. */
  home: GuideEntry | null;
  /** What the top of its part of the contents lists, its home page left out. */
  top: readonly ContentsEntry[];
}

interface Sources {
  list: readonly GuideSource[];
  bySection: ReadonlyMap<string, GuideSource>;
  byGame: ReadonlyMap<string, GuideSource>;
  /** By source, its pages in reading order, worked out when first asked. */
  orders: Map<string, readonly GuideEntry[]>;
}

const known = new WeakMap<GameGuides, Sources>();

/** The id of the section of the contents that holds another game's pages (see `guidesTogether`). */
export const otherGameSection = (gameId: string) => `${gameId}:section:${OTHER_GAME_SECTION}`;

/** The site a pack's pages were read from, where its manifest records one. */
function siteOfPack(pack: LoadedPack): string | null {
  const manifest = pack.manifest as { source?: { pages?: readonly { url?: unknown }[] } };
  return siteOf(manifest.source?.pages);
}

function sourcesFor(game: LoadedGame): Sources {
  const guides = guidesOf(game);
  const cached = known.get(guides);
  if (cached) return cached;
  const { contents } = guides;
  const gameId = game.pack.manifest.gameId;
  const others = new Map(
    otherGuidesOf(game).map((other) => [otherGameSection(other.gameId), other]),
  );
  const top = contents.browsable ? contents.top() : [];
  const list: GuideSource[] = [];
  const ownTop = top.filter((entry) => !others.has(entryIdOf(entry)));
  const ownHome = contents.homePage();
  if (ownTop.length > 0 || ownHome) {
    list.push({
      gameId,
      own: true,
      title: game.pack.manifest.title,
      pack: game.pack,
      site: siteOfPack(game.pack),
      sectionId: null,
      home: ownHome,
      top: ownTop,
    });
  }
  for (const entry of top) {
    const sectionId = entryIdOf(entry);
    const other = others.get(sectionId);
    if (!other) continue;
    const items = contents.items(sectionId);
    // Its home page is listed first (see `guidesTogether`); the pages under it are its top.
    const first = items[0];
    const home =
      first?.kind === 'page' && first.guide.id === other.pack.homePage ? first.guide : null;
    list.push({
      gameId: other.gameId,
      own: false,
      title: other.title,
      pack: other.pack,
      site: siteOfPack(other.pack),
      sectionId,
      home,
      top: home ? [...contents.items(home.id), ...items.slice(1)] : items,
    });
  }
  const sources: Sources = {
    list,
    bySection: new Map(list.flatMap((s) => (s.sectionId ? [[s.sectionId, s] as const] : []))),
    byGame: new Map(list.map((s) => [s.gameId, s])),
    orders: new Map(),
  };
  known.set(guides, sources);
  return sources;
}

/** The sources of pages a game's Guides shows, the game's own first; none without pages. */
export function guideSourcesOf(game: LoadedGame): readonly GuideSource[] {
  return sourcesFor(game).list;
}

/** A source of a game's Guides, by the game id of its pages. */
export function guideSource(game: LoadedGame, gameId: string | null): GuideSource | undefined {
  return gameId ? sourcesFor(game).byGame.get(gameId) : undefined;
}

/**
 * The source an entry of the contents (a page, a section, or a heading of
 * a list page) is shown in: the source whose part of the contents holds
 * it, or, for a page no contents lists, the one its id is of. Undefined
 * when it is of none.
 */
export function sourceOfEntry(game: LoadedGame, id: string): GuideSource | undefined {
  const sources = sourcesFor(game);
  const { contents } = guidesOf(game);
  const section = sources.bySection.get(id);
  if (section) return section;
  const trail = contents.trail(id);
  for (const step of trail) {
    if (step.kind !== 'section') continue;
    const found = sources.bySection.get(step.section.id);
    if (found) return found;
  }
  const ownSource = sources.list.find((source) => source.own);
  if (contents.parentOf(id) !== undefined || contents.isHomePage(id)) return ownSource;
  const of = parseId(id.split('#')[0] ?? id)?.gameId;
  return of ? sources.byGame.get(of) : undefined;
}

/** Whether a page is the home page of a source: the one its landing page shows. */
export function isSourceHome(game: LoadedGame, guideId: string): boolean {
  if (guidesOf(game).contents.isHomePage(guideId)) return true;
  return sourcesFor(game).list.some((source) => source.home?.id === guideId);
}

/**
 * The way from the top of a source's part of the contents down to an
 * entry: as the contents gives it, without the section that holds the
 * source and its home page.
 */
export function trailIn(game: LoadedGame, source: GuideSource | undefined, id: string) {
  let trail: ContentsStep[] = guidesOf(game).contents.trail(id);
  if (source?.sectionId && trail[0]?.kind === 'section') {
    if (trail[0].section.id === source.sectionId) trail = trail.slice(1);
  }
  if (source?.home && trail[0]?.kind === 'page' && trail[0].guide.id === source.home.id) {
    trail = trail.slice(1);
  }
  return trail;
}

/**
 * A source's pages in reading order: its home page, then its contents top
 * to bottom, each page followed by the pages under it (depth first), each
 * page once, at its first place. Hidden pages are not in the contents, so
 * they are never read in order.
 */
export function readingOrder(game: LoadedGame, source: GuideSource): readonly GuideEntry[] {
  const sources = sourcesFor(game);
  const kept = sources.orders.get(source.gameId);
  if (kept) return kept;
  const { contents } = guidesOf(game);
  const hidden = new Set(
    source.own
      ? ownPagesOf(source.gameId)
          .pages.filter((page) => page.hidden)
          .map((page) => page.id)
      : [],
  );
  const order: GuideEntry[] = [];
  const seen = new Set<string>();
  if (source.home) {
    seen.add(source.home.id);
    order.push(source.home);
  }
  // Depth first, without recursion: a contents may be thousands deep.
  const stack: (readonly ContentsEntry[])[] = [];
  const at: number[] = [];
  stack.push(source.top);
  at.push(0);
  while (stack.length > 0) {
    const level = stack.length - 1;
    const entries = stack[level]!;
    const index = at[level]!;
    if (index >= entries.length) {
      stack.pop();
      at.pop();
      continue;
    }
    at[level] = index + 1;
    const entry = entries[index]!;
    const id = entryIdOf(entry);
    if (seen.has(id)) continue;
    seen.add(id);
    if (entry.kind === 'page' && !hidden.has(id)) order.push(entry.guide);
    const items = contents.items(id);
    if (items.length > 0) {
      stack.push(items);
      at.push(0);
    }
  }
  sources.orders.set(source.gameId, order);
  return order;
}

/**
 * The landing page made for a source with no home page: made as for a
 * whole contents (see `landing.ts` in core), from the top of the source's
 * part of it, which is all it reads of the contents.
 */
export function madeLandingOf(game: LoadedGame, source: GuideSource): LandingGroup[] {
  const { contents } = guidesOf(game);
  const part: Pick<GuideContents, 'top' | 'items'> = {
    top: () => [...source.top],
    items: (id) => contents.items(id),
  };
  return madeLanding(part as GuideContents);
}

/** The pages before and after a page in a source's reading order, where there are. */
export function neighbours(
  game: LoadedGame,
  source: GuideSource,
  guideId: string,
): { previous: GuideEntry | null; next: GuideEntry | null } {
  const order = readingOrder(game, source);
  const index = order.findIndex((page) => page.id === guideId);
  if (index < 0) return { previous: null, next: null };
  return { previous: order[index - 1] ?? null, next: order[index + 1] ?? null };
}

// ---------------------------------------------------------------------------
// What is kept on this device

export interface GuideSourcesState {
  /** The game the choice below is of; null before one is read. */
  gameId: string | null;
  /** The source Guides showed last for that game, by its game id; null for none kept. */
  chosen: string | null;
  /** Whether what is kept of that game was read (`chosen` is then as kept, or chosen since). */
  ready: boolean;
  /** The page read last in each guide, by the game id of its pages. */
  readLast: Readonly<Record<string, string>>;
  /** Other games' own say on reading their pages in order, as their own pages file keeps it. */
  othersSay: Readonly<Record<string, boolean>>;
}

export const useGuideSources = create<GuideSourcesState>()(() => ({
  gameId: null,
  chosen: null,
  ready: false,
  readLast: {},
  othersSay: {},
}));

const get = useGuideSources.getState;
const set = useGuideSources.setState;

/** Reads a setting; nothing when the store is not open or it cannot be read. */
async function setting(key: string): Promise<unknown> {
  try {
    return await progressStore().getSetting(key);
  } catch {
    return undefined;
  }
}

/** The page read last of these sources, read once in a session. */
const readLastAsked = new Set<string>();

/** Reads what is kept of a game's Guides: the source shown last. Once per game. */
export async function loadGuideSourcePrefs(gameId: string): Promise<void> {
  if (get().gameId === gameId) return;
  set({ gameId, chosen: null, ready: false, othersSay: {} });
  const value = await setting(SETTINGS.guidesSource(gameId));
  if (get().gameId !== gameId) return;
  // One chosen while it was read is newer.
  if (get().chosen === null && typeof value === 'string') set({ chosen: value });
  set({ ready: true });
}

/** Reads the page read last in each of these guides, once each in a session. */
export async function loadReadLast(sourceIds: readonly string[]): Promise<void> {
  const asked = sourceIds.filter((id) => !readLastAsked.has(id));
  if (asked.length === 0) return;
  for (const id of asked) readLastAsked.add(id);
  const values = await Promise.all(asked.map((id) => setting(SETTINGS.guideReadLast(id))));
  const found: Record<string, string> = {};
  asked.forEach((id, i) => {
    const value = values[i];
    // One read since is newer.
    if (typeof value === 'string' && get().readLast[id] === undefined) found[id] = value;
  });
  if (Object.keys(found).length > 0) set({ readLast: { ...get().readLast, ...found } });
}

/** Shows a source in a game's Guides, and keeps that for the next time. */
export function chooseGuideSource(gameId: string, sourceId: string): void {
  const state = get();
  if (state.gameId === gameId && state.chosen === sourceId) return;
  set(state.gameId === gameId ? { chosen: sourceId } : { gameId, chosen: sourceId, ready: false });
  saveSetting(SETTINGS.guidesSource(gameId), sourceId);
}

/** Keeps the page read last in a guide, to continue at. */
export function noteReadInGuide(sourceId: string, guideId: string): void {
  if (get().readLast[sourceId] === guideId) return;
  readLastAsked.add(sourceId);
  set({ readLast: { ...get().readLast, [sourceId]: guideId } });
  saveSetting(SETTINGS.guideReadLast(sourceId), guideId);
}

/**
 * Whether a source is a guide, read in order: the person's say, kept with
 * the own pages of the game its pages are of, else its pack's.
 */
export function isReadInOrder(
  source: GuideSource,
  state: GuideSourcesState = get(),
  own = useOwnPages.getState(),
): boolean {
  const packSays = packSaysPagesInOrder(source.pack);
  if (source.own) return readInOrder(ownPagesOf(source.gameId, own), packSays);
  return state.othersSay[source.gameId] ?? packSays;
}

/**
 * Reads the say of each other game read with the game shown on reading its
 * pages in order, from that game's own pages file (kept as it is; only
 * read). A game whose file cannot be read says nothing.
 */
async function readOthersSay(gameId: string): Promise<void> {
  const others = useGuideLinks.getState().gameId === gameId ? useGuideLinks.getState().others : [];
  const says: Record<string, boolean> = {};
  await Promise.all(
    others.map(async (other) => {
      try {
        const text = await ownPagesBackend().read(other.gameId);
        if (text === null) return;
        const read = readOwnPagesFile(JSON.parse(text) as unknown);
        if (
          read.ok &&
          read.file.gameId === other.gameId &&
          read.file.own.pagesInOrder !== undefined
        ) {
          says[other.gameId] = read.file.own.pagesInOrder;
        }
      } catch {
        // Nothing said.
      }
    }),
  );
  if (get().gameId !== gameId) return;
  set({ othersSay: says });
}

// The other games read with the game shown change: their says are read again.
useGuideLinks.subscribe((state, before) => {
  if (state.others === before.others || !state.gameId) return;
  if (useAtlas.getState().game?.pack.manifest.gameId !== state.gameId) return;
  void loadGuideSourcePrefs(state.gameId).then(() => readOthersSay(state.gameId!));
});
