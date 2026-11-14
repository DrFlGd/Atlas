import {
  baseName,
  otherNameOfId,
  PageNameIndex,
  withMentions,
  type NameHit,
  type TargetInfo,
} from '@atlas/core';
import {
  MAX_LINK_TARGETS,
  sameLinkTarget,
  type GuideEntry,
  type LinkChoice,
  type LinkTarget,
} from '@atlas/schema';
import { notify } from './actions';
import {
  canChangeGuideLinks,
  choiceOf,
  forgetChoice,
  linkPage,
  restoreChoice,
  useGuideLinks,
} from './guideLinks';
import { linkablePagesOf, mapNamesOf } from './guideMatches';
import { guideAliases, guidesOf, otherGuidesOf } from './guides';
import type { LoadedGame } from './store';

/**
 * "Search wiki" on a location's card: the saved pages of the game's wiki
 * (and of the other games read with it) that may be about the location,
 * found by its name (see `nameMatch.ts` in core), the best first; and the
 * page the person picks linked to the location, or to every location of
 * its name. Only pages already saved are searched: nothing is fetched.
 */

/** Most pages listed for one search. */
export const WIKI_SEARCH_LIMIT = 20;

const indexByContents = new WeakMap<object, { index: PageNameIndex; pages: GuideEntry[] }>();

/** The index of the pages that can be linked, by their titles and other names. */
function pageIndexOf(game: LoadedGame): { index: PageNameIndex; pages: GuideEntry[] } {
  const { contents } = guidesOf(game);
  let known = indexByContents.get(contents);
  if (!known) {
    const pages = linkablePagesOf(game);
    // A page's other names: the ids it was read under before (the packs' id migrations).
    const aliases = guideAliases([game.pack, ...otherGuidesOf(game).map((other) => other.pack)]);
    const otherNames = new Map<string, string[]>();
    for (const [from, to] of Object.entries(aliases ?? {})) {
      const name = otherNameOfId(from);
      if (!name) continue;
      const list = otherNames.get(to);
      if (list) list.push(name);
      else otherNames.set(to, [name]);
    }
    const index = new PageNameIndex(
      pages.map((page) => {
        const names = otherNames.get(page.id);
        return { id: page.id, title: page.title, ...(names ? { otherNames: names } : {}) };
      }),
    );
    known = { index, pages };
    indexByContents.set(contents, known);
  }
  return known;
}

/** Whether the game has saved pages to search for a location. */
export function hasWikiPages(game: LoadedGame): boolean {
  return game.pack.data.maps.length > 0 && linkablePagesOf(game).length > 0;
}

/** A page found for a name, with the page itself. */
export interface WikiHit extends NameHit {
  guide: GuideEntry;
}

/**
 * The saved pages that fit a name, the best first: those whose title or
 * other name fits, then those whose text only mentions it.
 */
export function searchWiki(game: LoadedGame, name: string, limit = WIKI_SEARCH_LIMIT): WikiHit[] {
  const { index, pages } = pageIndexOf(game);
  const linkable = new Set(pages.map((page) => page.id));
  const byName = index.find(name, limit);
  // A page that mentions the name, a number at its end or a note in brackets left out.
  const mentioned = baseName(name.replace(/\s*\([^)]*\)\s*$/u, '').trim());
  const mentions = guidesOf(game)
    .search.search(mentioned, limit * 2)
    .filter((hit) => !hit.inTitle && linkable.has(hit.guide.id))
    .map((hit) => ({ id: hit.guide.id, title: hit.guide.title }));
  const { contents } = guidesOf(game);
  return withMentions(byName, mentions, limit).flatMap((hit) => {
    const guide = contents.guide(hit.id);
    return guide ? [{ ...hit, guide }] : [];
  });
}

/**
 * The name a location shares with others, as a page would be linked to
 * it: its name without a number at its end, with every location of it;
 * null when the map has none.
 */
export function nameTargetAt(game: LoadedGame, locationId: string): TargetInfo | null {
  return mapNamesOf(game).nameTargetOf(locationId);
}

/** What linking a page from a location's card reaches: every location of its name, or it alone. */
export type LinkReach = 'name' | 'location';

/** Why a page could not be linked, in words; null when it was. */
export function linkPageAt(
  game: LoadedGame,
  guideId: string,
  locationId: string,
  reach: LinkReach,
): string | null {
  if (!canChangeGuideLinks()) {
    return (
      useGuideLinks.getState().readOnly ??
      'Your links between pages and the map cannot be changed now. Try again in a moment.'
    );
  }
  const name = reach === 'name' ? nameTargetAt(game, locationId) : null;
  const target: LinkTarget = name ? name.target : { to: 'location', id: locationId };
  const choice = choiceOf(guideId);
  const before = choice?.state === 'linked' ? choice.targets : [];
  if (before.some((t) => sameLinkTarget(t, target))) return null;
  if (before.length >= MAX_LINK_TARGETS) {
    return `That page is linked to ${MAX_LINK_TARGETS} things on the map already, the most there can be. Take one of its links off in Link pages to the map first.`;
  }
  linkPage(guideId, [...before, target]);
  return null;
}

/**
 * Takes the link off that puts a page on a location's card (`via`, one of
 * the page's targets), and says so with a way to undo it.
 */
export function unlinkPageAt(guide: GuideEntry, via: TargetInfo): boolean {
  if (!canChangeGuideLinks()) return false;
  const before: LinkChoice | undefined = choiceOf(guide.id);
  if (before?.state !== 'linked') return false;
  const rest = before.targets.filter((t) => !sameLinkTarget(t, via.target));
  if (rest.length === before.targets.length) return false;
  if (rest.length === 0) forgetChoice(guide.id);
  else linkPage(guide.id, rest);
  notify(`“${guide.title}” is no longer linked to ${linkWords(via)}.`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        if (restoreChoice(guide.id, before)) notify(`“${guide.title}” is linked again.`);
      },
    },
  });
  return true;
}

/** "every location named Wolf den", "this location", "the type Waystone": a link's reach in words. */
export function linkWords(via: TargetInfo): string {
  switch (via.what) {
    case 'location':
      return 'this location alone';
    case 'name':
      return `every location named ${via.label}`;
    case 'type':
      return `the type ${via.label}`;
    case 'region':
      return `the region ${via.label}`;
  }
}
