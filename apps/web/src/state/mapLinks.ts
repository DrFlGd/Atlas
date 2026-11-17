import { mapLinkTarget, type LoadedPack } from '@atlas/core';
import type { MapLink } from '@atlas/schema';
import { create } from 'zustand';
import { goToLocation } from './actions';
import { loadSourceFacts, presentMembers, showSource, titleOf, useGameGroups } from './gameGroups';
import { packAt, useGuideLinks } from './guideLinks';
import { chooseGuideSource } from './guideSources';
import { onPackSaved } from './packTurns';
import { useAtlas, type LoadedGame } from './store';

/**
 * Web links in the pages shown that name a location of a map by the id its
 * site gives it (the manifest's `mapLinks`, see `mapLinks.ts` in core): the
 * entries of the pages shown, and the maps a link may lead to.
 *
 * The entries are those of the game shown and of the games whose pages are
 * read with it (see `guideLinks.ts`): a wiki of its title, or one chosen
 * for it. A link that fits one is looked up among the locations of the
 * game shown, then of the other games of its title that have a map (see
 * `gameGroups.ts`), in the title's order. Those games' packs are read only
 * when some page shown has entries, once per session for as long as their
 * files stay as they are, as the pages of other games are; nothing is ever
 * written.
 *
 * A link that finds its location is shown as an in-app link (see
 * `markdown.ts`), and following it shows the location: on the map of the
 * game shown, or on that of another game of the title, which then opens as
 * itself, as a map of the maps menu does.
 */

/** Another game of the title shown, with a map, whose locations a link may lead to. */
export interface MapLinkSource {
  gameId: string;
  pack: LoadedPack;
}

export interface MapLinksState {
  /** The game shown that these are for, by its id in the catalogue; null before one is. */
  gameId: string | null;
  /** The entries of the pages shown, each once. */
  links: readonly MapLink[];
  /** The other games of its title that have a map, as far as they are read. */
  sources: readonly MapLinkSource[];
}

export const useMapLinks = create<MapLinksState>()(() => ({
  gameId: null,
  links: [],
  sources: [],
}));

const get = useMapLinks.getState;
const set = useMapLinks.setState;

/** The entries of the game shown and of the games whose pages are read with it, each once. */
function linksOf(game: LoadedGame): MapLink[] {
  const others = useGuideLinks.getState();
  const packs = [
    game.pack,
    ...(others.gameId === game.pack.manifest.gameId ? others.others.map((o) => o.pack) : []),
  ];
  const seen = new Set<string>();
  const links: MapLink[] = [];
  for (const pack of packs) {
    for (const link of pack.manifest.mapLinks ?? []) {
      const key = JSON.stringify([link.hosts, link.address, link.query ?? null]);
      if (seen.has(key)) continue;
      seen.add(key);
      links.push(link);
    }
  }
  return links;
}

/** The other games of a game's title that have a map, read. None when it is under no title. */
async function sourcesOf(gameId: string): Promise<MapLinkSource[]> {
  const group = titleOf(gameId);
  if (!group) return [];
  const entries = presentMembers(group).filter((entry) => entry.id !== gameId);
  await loadSourceFacts(entries);
  const facts = useGameGroups.getState().facts;
  const sources: MapLinkSource[] = [];
  for (const entry of entries) {
    if ((facts[entry.id]?.maps.length ?? 0) === 0) continue;
    try {
      const pack = await packAt(entry);
      if (pack.data.locations.length > 0) sources.push({ gameId: entry.id, pack });
    } catch {
      // A game whose files cannot be read now: its locations are not linked to.
    }
  }
  return sources;
}

let refreshing = 0;

/** Works out the entries for the game shown, then reads the other maps of its title if needed. */
async function refresh(): Promise<void> {
  const token = ++refreshing;
  const game = useAtlas.getState().game;
  if (!game) {
    set({ gameId: null, links: [], sources: [] });
    return;
  }
  const gameId = game.entry.id;
  const links = linksOf(game);
  const before = get();
  const same = before.gameId === gameId;
  set({
    gameId,
    links: sameLinks(before.links, links) ? before.links : links,
    sources: same ? before.sources : [],
  });
  if (links.length === 0) return;
  const sources = await sourcesOf(gameId);
  if (token !== refreshing) return;
  const now = get().sources;
  const unchanged =
    now.length === sources.length && now.every((s, i) => s.pack === sources[i]!.pack);
  if (!unchanged) set({ sources });
}

const sameLinks = (a: readonly MapLink[], b: readonly MapLink[]) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Refreshes without ever failing: these run as the stores change, where
 * nothing could take a failure. A game whose pack cannot be read here has
 * no entries, so the links of its pages stay web links.
 */
function refreshSafely(): void {
  refresh().catch(() => {
    set({ gameId: null, links: [], sources: [] });
  });
}

useAtlas.subscribe((state, before) => {
  if (state.game !== before.game) refreshSafely();
});
useGuideLinks.subscribe((state, before) => {
  if (state.others !== before.others) refreshSafely();
});
useGameGroups.subscribe((state, before) => {
  if (state.groups !== before.groups) refreshSafely();
});
// A map of the title was saved (a check for changes, a pack file): it is read again.
onPackSaved((packId) => {
  const { sources } = get();
  if (!sources.some((source) => source.gameId === packId)) return;
  set({ sources: sources.filter((source) => source.gameId !== packId) });
  refreshSafely();
});

/**
 * The location a web link of a page shown names, as {@link MarkdownOptions.mapLink}
 * takes it: its id, and the game it is in when that is another game of the
 * title. Null when it names none, or none is found.
 */
export function mapLinkOf(
  game: LoadedGame,
  href: string,
): { locationId: string; gameId?: string } | null {
  const state = get();
  const shownId = game.entry.id;
  const current = state.gameId === shownId;
  const links = current ? state.links : (game.pack.manifest.mapLinks ?? []);
  if (links.length === 0) return null;
  const found = mapLinkTarget(links, href, [
    { gameId: shownId, locations: game.pack.data.locations },
    ...(current
      ? state.sources.map((s) => ({ gameId: s.gameId, locations: s.pack.data.locations }))
      : []),
  ]);
  if (!found) return null;
  return found.gameId === shownId
    ? { locationId: found.locationId }
    : { locationId: found.locationId, gameId: found.gameId };
}

/**
 * Follows a link to a location of another game of the title: that game
 * opens as itself (see `showSource`), and the location is shown on its map.
 * The game the link was followed from, when its pages are read with that
 * game (a guide or a wiki of the same title), is the source its Guides
 * show from then on: going back to Guides shows the pages the person was
 * reading, not another source of the title.
 */
export async function followMapLink(gameId: string, locationId: string): Promise<void> {
  const from = useAtlas.getState().game;
  await showSource(gameId);
  const game = useAtlas.getState().game;
  if (game?.entry.id !== gameId) return;
  if (from && from.entry.id !== gameId) {
    const group = titleOf(gameId);
    const together = group && presentMembers(group).some((entry) => entry.id === from.entry.id);
    if (together) chooseGuideSource(game.pack.manifest.gameId, from.pack.manifest.gameId);
  }
  if (game.pack.locations.has(locationId)) goToLocation(locationId);
}

refreshSafely();
