import {
  MapNames,
  matchPages,
  specificity,
  type LoadedPack,
  type PageMatch,
  type TargetInfo,
} from '@atlas/core';
import type { GuideEntry, LinkChoice } from '@atlas/schema';
import { guidesOf } from './guides';
import { useGuideLinks } from './guideLinks';
import type { LoadedGame } from './store';

/**
 * What the app makes of the guide links: the pages it can link (pages read
 * from a site, of the game and of the other games read with it), how each
 * matches the map, what each linked page stands for on the map, and the
 * pages of each location. Worked out when asked, and again when the links
 * or the guides change.
 */

const namesByPack = new WeakMap<LoadedPack, MapNames>();

/** The names the game's map offers to link pages to (see `MapNames`). */
export function mapNamesOf(game: LoadedGame): MapNames {
  let names = namesByPack.get(game.pack);
  if (!names) {
    names = new MapNames(game.pack.data);
    namesByPack.set(game.pack, names);
  }
  return names;
}

/** Whether a game can have pages linked to its map: a map, and pages read from a site. */
export function canLinkPages(game: LoadedGame | null): boolean {
  if (!game || game.pack.data.maps.length === 0) return false;
  return linkablePagesOf(game).length > 0;
}

/** The pages that can be linked: pages of the Guides section with a source. */
export function linkablePagesOf(game: LoadedGame): GuideEntry[] {
  const { contents } = guidesOf(game);
  return contents.browsable ? contents.pages().filter((guide) => guide.source !== undefined) : [];
}

const matchesByContents = new WeakMap<object, PageMatch[]>();

/** How each page that can be linked matches the map, in contents order. */
export function pageMatchesOf(game: LoadedGame): PageMatch[] {
  const { contents } = guidesOf(game);
  let matches = matchesByContents.get(contents);
  if (!matches) {
    matches = matchPages(mapNamesOf(game), linkablePagesOf(game));
    matchesByContents.set(contents, matches);
  }
  return matches;
}

/** What a page is linked to now, as the map has it (targets it no longer has left out). */
export function linkedTargets(game: LoadedGame, choice: LinkChoice | undefined): TargetInfo[] {
  if (choice?.state !== 'linked') return [];
  const names = mapNamesOf(game);
  return choice.targets.flatMap((target) => names.resolve(target) ?? []);
}

/** The locations a page is linked to, each once. */
export function linkedLocations(game: LoadedGame, guideId: string): string[] {
  const choice = useGuideLinks.getState().links.choices[guideId];
  if (choice?.state !== 'linked') return [];
  return mapNamesOf(game).locationsOf(choice.targets);
}

/** One page of a location: the page, and the target that links it there. */
export interface LocationPage {
  guide: GuideEntry;
  via: TargetInfo;
}

interface PagesIndex {
  choices: Record<string, LinkChoice>;
  byLocation: Map<string, LocationPage[]>;
}

const indexByContents = new WeakMap<object, PagesIndex>();

/**
 * The pages linked to a location, the most specific first: a page of its
 * own name, then of its type, then of its region.
 */
export function pagesAt(game: LoadedGame, locationId: string): LocationPage[] {
  const { contents } = guidesOf(game);
  const links = useGuideLinks.getState();
  const choices =
    links.gameId === game.pack.manifest.gameId
      ? links.links.choices
      : ({} as Record<string, never>);
  let index = indexByContents.get(contents);
  if (index?.choices !== choices) {
    const byLocation = new Map<string, LocationPage[]>();
    for (const [guideId, choice] of Object.entries(choices)) {
      const guide = contents.guide(guideId);
      if (!guide || !contents.isPage(guideId)) continue;
      for (const via of linkedTargets(game, choice)) {
        for (const id of via.locations) {
          const list = byLocation.get(id);
          const page = { guide, via };
          if (!list) byLocation.set(id, [page]);
          else if (!list.some((p) => p.guide.id === guideId)) list.push(page);
          else {
            // The same page by two targets: the more specific one says why.
            const at = list.findIndex((p) => p.guide.id === guideId);
            if (specificity(via) < specificity(list[at]!.via)) list[at] = page;
          }
        }
      }
    }
    for (const list of byLocation.values()) {
      list.sort((a, b) => specificity(a.via) - specificity(b.via));
    }
    index = { choices, byLocation };
    indexByContents.set(contents, index);
  }
  return index.byLocation.get(locationId) ?? [];
}

/** "Waystone (type)": a target in words, with what it is. */
export function targetText(info: TargetInfo): string {
  switch (info.what) {
    case 'type':
      return `${info.label} (type)`;
    case 'region':
      return `${info.label} (region)`;
    case 'name':
      return `${info.label} (location name)`;
    case 'location':
      return `${info.label} (this location only)`;
  }
}

/** "1 location", "44 locations". */
export function locationsText(count: number): string {
  return count === 1 ? '1 location' : `${new Intl.NumberFormat('en').format(count)} locations`;
}
