import type { Section } from '@atlas/schema';
import type { ContentsEntry, GuideContents } from './contents';

/**
 * The landing page made for guides that have no home page of their own (a
 * wiki read before its home page was kept, or one whose home page was never
 * read): the top of the contents as the main areas a home page would lead
 * to. Each section at the top is a group of tiles, its sections and pages
 * in order, the first few shown and the rest counted; pages at the top are
 * groups of their own, in their place, a few rows at most. A tile shows the first picture its
 * page shows (see {@link firstPictureIn}), or, for a section, the first of
 * its pages that has one. Nothing of it is stored: it is worked out from
 * the contents whenever it is shown.
 */

/** A section or a page on the landing page. */
export interface LandingTile {
  entry: ContentsEntry;
  /** The id of the picture the tile shows, or null for none. */
  picture: string | null;
}

/** A group of tiles: a section at the top with what it holds, or pages at the top. */
export interface LandingGroup {
  /** The section, or null for pages at the top of the contents. */
  section: Section | null;
  tiles: LandingTile[];
  /** How many entries the group holds that are not shown as tiles. */
  more: number;
  /** How many pages it holds, however deep. */
  pages: number;
}

/** How many tiles a group shows at most. */
export const LANDING_TILES = 8;

/** A picture this tall or wide or less stands in a line of text: an icon, not a page's picture. */
const ICON_SIZE = 48;

/** A picture of a pack in Markdown, by id, with the size its title may give. */
const PICTURE =
  /!\[[^\]\n]*\]\(\s*<?([a-z0-9][a-z0-9-]*:picture:[A-Za-z0-9][A-Za-z0-9_.-]*)>?(?:\s+"([^"\n]*)")?\s*\)/g;

/** Bars that start or end hidden text (`||like this||`), not escaped. */
const BARS = /(?<!\\)\|\|/g;

/**
 * The id of the first picture a guide's Markdown shows as a picture of its
 * own: not one sized as an icon in a line of text (`"=28x13"`), and not one
 * inside hidden text, which a tile must never give away. Null for none.
 */
export function firstPictureIn(body: string): string | null {
  if (!body.includes(':picture:')) return null;
  PICTURE.lastIndex = 0;
  for (let match = PICTURE.exec(body); match; match = PICTURE.exec(body)) {
    const size = /^=(\d+)(?:x(\d+))?$/u.exec(match[2]?.trim() ?? '');
    if (size && (Number(size[1]) <= ICON_SIZE || Number(size[2] ?? ICON_SIZE + 1) <= ICON_SIZE)) {
      continue;
    }
    // Inside hidden text when an odd number of bars stand before it.
    const bars = body.slice(0, match.index).match(BARS)?.length ?? 0;
    if (bars % 2 === 1) continue;
    return match[1]!;
  }
  return null;
}

/**
 * The picture of an entry: its page's, or the first of a section's pages
 * (or a heading's, see `headingSteps.ts`) that has one.
 */
function pictureOf(contents: GuideContents, entry: ContentsEntry): string | null {
  if (entry.kind === 'page') return firstPictureIn(entry.guide.body);
  const id = entry.kind === 'section' ? entry.section.id : entry.heading.id;
  for (const item of contents.items(id)) {
    if (item.kind !== 'page') continue;
    const picture = firstPictureIn(item.guide.body);
    if (picture) return picture;
  }
  return null;
}

/** The landing page made from the top of the contents (see the top of this file). */
export function madeLanding(
  contents: GuideContents,
  tilesPerGroup: number = LANDING_TILES,
): LandingGroup[] {
  const groups: LandingGroup[] = [];
  const tile = (entry: ContentsEntry): LandingTile => ({
    entry,
    picture: pictureOf(contents, entry),
  });
  let pages: ContentsEntry[] = [];
  const pagesDone = () => {
    if (pages.length === 0) return;
    // Pages at the top may be every page of a game with no contents: a few rows at most.
    const shown = tilesPerGroup * 3;
    groups.push({
      section: null,
      tiles: pages.slice(0, shown).map(tile),
      more: Math.max(0, pages.length - shown),
      pages: pages.reduce((sum, entry) => sum + 1 + entry.pages, 0),
    });
    pages = [];
  };
  for (const entry of contents.top()) {
    // A heading of a list page is never at the top: it stands with the pages there if it were.
    if (entry.kind !== 'section') {
      pages.push(entry);
      continue;
    }
    pagesDone();
    const items = contents.items(entry.section.id);
    groups.push({
      section: entry.section,
      tiles: items.slice(0, tilesPerGroup).map(tile),
      more: Math.max(0, items.length - tilesPerGroup),
      pages: entry.pages,
    });
  }
  pagesDone();
  return groups;
}
