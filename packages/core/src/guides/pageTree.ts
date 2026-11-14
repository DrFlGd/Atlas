import type { GuideEntry } from '@atlas/schema';

/**
 * Pages under pages: where each page of a section marked `placeByLinks`
 * goes in the contents, worked out from the links between the pages.
 *
 * A guide's Markdown links to another guide of the pack by its id
 * (`[Knight Armor](game:guide:knight-armor)`), so the pack alone says which
 * pages lead to which: a viewer with no importer works it out the same way
 * as the app that read the pages.
 *
 * Only list pages file pages (see `pageFiling.ts`): a page that is mostly
 * a list or a table of links (Weapons, Armour, Enemies) is an index, and
 * the pages it lists (the main link of a list item, of a cell of a
 * table's name column, of a tile) go under it. A link in a sentence, in a
 * box of facts, in hidden text or in another column of a table is a
 * mention, and never files a page.
 *
 * - The pages placed in the contents (in any other section, at the top,
 *   or under a page by the person) are where the contents starts from.
 * - A page of a `placeByLinks` section goes under the list page that lists
 *   it and is reached first from a placed page (a breadth-first walk
 *   through the pages list pages list). Of two list pages equally close,
 *   the one met first wins: pages placed in the contents in the order the
 *   contents shows them, top to bottom, and further pages in the order
 *   they were listed. So a page has exactly one home, and every walk of
 *   the same pages gives the same tree.
 * - A page many pages link to (a location every item names, see
 *   {@link POPULAR_MIN_LINKERS}) goes only under one of the longest list
 *   pages that list it (see {@link POPULAR_PARENT_SHARE}), never under a
 *   page that merely names it among many others.
 * - A list page no placed page leads to stays in its section, with the
 *   pages it lists under it (those no other list page took first).
 * - Under a page: the pages the person put there first, in their order,
 *   then the pages it lists, in its order.
 * - A page with no clear home (no list page lists it) stays in its
 *   section: when unsure, the contents stays flat.
 *
 * - A home page (`root`, a wiki's main page, see the manifest's
 *   `homePage`) is where the contents starts from before any other page:
 *   it is not shown in the contents (Guides shows it on its own), and the
 *   pages it lists (whether or not it is a list page itself) and those put
 *   under it by hand are at the top of the contents, before the sections
 *   whose pages are placed by links.
 *
 * Every page is reached once, so links in a circle (A to B, B to A) or to
 * the page itself change nothing; one read more adds the new page and may
 * move the pages it lists, and nothing else.
 */

/**
 * A page linked from at least this many pages (in any way) is popular: a
 * location or a character every item names, a page of the game's rules
 * every other page explains itself with. A thing of its own is named by
 * fewer: its list pages and a few pages about related things.
 */
export const POPULAR_MIN_LINKERS = 8;

/**
 * A popular page goes only under a list page that lists at least this
 * share of the pages the longest list page listing it lists: an index of
 * its type (Locations, of 40), not a page that lists a few things among
 * them (an enemy's three haunts), however soon the walk meets that one.
 */
export const POPULAR_PARENT_SHARE = 0.5;

/** A guide id in a Markdown link: `](game:guide:local`, with or without `<`. */
const GUIDE_LINK = /\]\(\s*<?([a-z0-9][a-z0-9-]*:guide:[A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/** The guide ids a guide's Markdown links to, in order, each once, never itself. */
export function guideLinksIn(body: string, self?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!body.includes(':guide:')) return out;
  GUIDE_LINK.lastIndex = 0;
  for (let match = GUIDE_LINK.exec(body); match; match = GUIDE_LINK.exec(body)) {
    const id = match[1]!;
    if (id !== self && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The links of each guide object, read once: a guide is never changed in place. */
const linksOfGuide = new WeakMap<GuideEntry, readonly string[]>();

/** The guide ids a guide links to (see {@link guideLinksIn}), read once per guide. */
export function guideLinks(guide: GuideEntry): readonly string[] {
  let links = linksOfGuide.get(guide);
  if (!links) {
    links = guideLinksIn(guide.body, guide.id);
    linksOfGuide.set(guide, links);
  }
  return links;
}

/** What a page lists, for {@link PageTreeInput.filingOf}. */
export interface PageListing {
  /** The pages it lists (its listing links, see `pageFiling.ts`), in order. */
  listing: readonly string[];
  /** Whether it is a list page (see `isListPage`), whose listing links file pages. */
  listPage: boolean;
}

/** What {@link placePagesByLinks} works on. */
export interface PageTreeInput {
  /** The top of the contents: sections and pages. */
  top: readonly string[];
  /** What each section holds, by section id; and by page id, the pages put under it by hand. */
  lists: ReadonlyMap<string, readonly string[]>;
  isSection: (id: string) => boolean;
  isPage: (id: string) => boolean;
  /** The sections whose pages are placed by their links. */
  byLinks: ReadonlySet<string>;
  /** The pages a page links to, in order, each once. */
  linksOf: (guideId: string) => readonly string[];
  /** What a page lists, and whether it is a list page. */
  filingOf: (guideId: string) => PageListing;
  /** Whether a page's links place other pages (a pack's page that is shown). */
  leads: (guideId: string) => boolean;
  /** Whether a page may be placed by links (a pack's page that is shown). */
  movable: (guideId: string) => boolean;
  /**
   * The home page the top of the contents branches from, if any: walked
   * first, left out of the contents, and the pages it lists placed at
   * the top.
   */
  root?: string | null;
}

/** The contents with the pages placed (see the top of this file). */
export interface PageTree {
  top: string[];
  /** What each section and each page holds, as shown. */
  lists: Map<string, string[]>;
  /** The pages placed by links: by page id, the page it is under (the home page for one at the top). */
  placed: Map<string, string>;
}

/** Places the pages of `placeByLinks` sections under the list pages that list them. */
export function placePagesByLinks(input: PageTreeInput): PageTree {
  const { isSection, isPage, byLinks } = input;
  const root = input.root != null && isPage(input.root) ? input.root : null;
  // The home page is shown on its own, wherever else it is listed.
  const lists: ReadonlyMap<string, readonly string[]> =
    root === null
      ? input.lists
      : new Map([...input.lists].map(([id, items]) => [id, items.filter((item) => item !== root)]));
  const out = new Map<string, string[]>();
  const placed = new Map<string, string>();
  const top = input.top.filter((id) => id !== root);

  // The pages put under a page by hand: they stay there.
  const byHand = new Set<string>();
  const handParent = new Map<string, string>();
  for (const [id, items] of lists) {
    if (!isPage(id)) continue;
    for (const item of items) {
      if (!isPage(item)) continue;
      byHand.add(item);
      if (!handParent.has(item)) handParent.set(item, id);
    }
  }

  // The pages placed in the contents, in the order it shows them; and the
  // pages waiting to be placed by links.
  const seeds: string[] = [];
  const reached = new Set<string>();
  const waiting = new Set<string>();
  const sectionsSeen = new Set<string>();
  // Walked without recursion: a contents may be deep.
  if (root !== null) {
    // The home page first: the top of the contents branches from it.
    reached.add(root);
    seeds.push(root);
  }
  const stack: { items: readonly string[]; at: number; loose: boolean }[] = [
    { items: top, at: 0, loose: false },
  ];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.at >= frame.items.length) {
      stack.pop();
      continue;
    }
    const id = frame.items[frame.at++]!;
    if (isSection(id)) {
      if (sectionsSeen.has(id)) continue;
      sectionsSeen.add(id);
      stack.push({ items: lists.get(id) ?? [], at: 0, loose: byLinks.has(id) });
    } else if (isPage(id)) {
      if (frame.loose && input.movable(id) && !byHand.has(id)) waiting.add(id);
      else if (!frame.loose && !reached.has(id)) {
        reached.add(id);
        seeds.push(id);
      }
    }
  }
  // A page placed in the contents is not waiting, wherever else it is listed.
  for (const id of reached) waiting.delete(id);

  // Which pages file which: by page, what it lists when it files pages
  // (the home page and list pages); by waiting page, how many pages link
  // to it, and the longest list page that lists it.
  const filing = new Map<string, readonly string[]>();
  const linkers = new Map<string, number>();
  const longest = new Map<string, number>();
  if (waiting.size > 0) {
    const counted = new Set<string>();
    const count = (id: string) => {
      if (counted.has(id) || !isPage(id) || !input.leads(id)) return;
      counted.add(id);
      for (const target of input.linksOf(id)) {
        if (waiting.has(target)) linkers.set(target, (linkers.get(target) ?? 0) + 1);
      }
      const { listing, listPage } = input.filingOf(id);
      if (id !== root && !listPage) return;
      filing.set(id, listing);
      for (const target of listing) {
        if (waiting.has(target) && (longest.get(target) ?? 0) < listing.length) {
          longest.set(target, listing.length);
        }
      }
    };
    if (root !== null) count(root);
    for (const id of top) count(id);
    for (const [id, items] of lists) {
      count(id);
      for (const item of items) count(item);
    }
  }
  /** Whether `page` may file `target`: a popular page goes only under one of its longest list pages. */
  const mayFile = (page: string, listed: number, target: string) =>
    page === root ||
    (linkers.get(target) ?? 0) < POPULAR_MIN_LINKERS ||
    listed >= POPULAR_PARENT_SHARE * (longest.get(target) ?? 0);

  /** Walks out from `queue`: the pages put under each, then (with links) those it lists. */
  const walk = (queue: string[], withLinks: boolean) => {
    // The queue grows as it is walked: breadth first.
    for (const page of queue) {
      const under: string[] = [];
      for (const item of lists.get(page) ?? []) {
        if (isPage(item) && !reached.has(item)) {
          reached.add(item);
          under.push(item);
          queue.push(item);
        }
      }
      const listing = withLinks ? filing.get(page) : undefined;
      if (listing) {
        for (const target of listing) {
          if (!waiting.has(target) || reached.has(target)) continue;
          if (!mayFile(page, listing.length, target)) continue;
          reached.add(target);
          placed.set(target, page);
          under.push(target);
          queue.push(target);
        }
      }
      if (under.length > 0) out.set(page, under);
    }
  };
  walk(seeds, true);

  // The pages nothing placed leads to stay in their section: first those
  // no list page left there lists either, each with what it lists; then
  // any left (list pages that list each other only).
  const left = new Set<string>();
  for (const id of sectionsSeen) {
    if (!byLinks.has(id)) continue;
    for (const item of lists.get(id) ?? []) {
      if (isPage(item) && !reached.has(item)) left.add(item);
    }
  }
  const listedThere = new Set<string>();
  for (const page of left) {
    const listing = filing.get(page);
    if (!listing) continue;
    for (const target of listing) {
      if (target !== page && waiting.has(target) && !reached.has(target)) {
        if (mayFile(page, listing.length, target)) listedThere.add(target);
      }
    }
  }
  const stays = new Set<string>();
  const stay = (ids: readonly string[]) => {
    const queue = ids.filter((id) => !reached.has(id));
    for (const id of queue) {
      reached.add(id);
      stays.add(id);
    }
    walk(queue, true);
  };
  stay([...left].filter((id) => !listedThere.has(id)));
  for (const id of left) stay([id]);

  // The sections as shown: one placed by links keeps only the pages that stay there.
  for (const [id, items] of lists) {
    if (!isSection(id)) continue;
    out.set(
      id,
      byLinks.has(id)
        ? items.filter((item) => (isPage(item) ? stays.has(item) : !reached.has(item)))
        : [...items],
    );
  }

  // A page put under a page that is not shown (hidden, gone, or under
  // itself) is shown where pages nothing leads to are, so none is lost.
  const shelter = [...sectionsSeen].find((id) => byLinks.has(id));
  const lost: string[] = [];
  for (const id of byHand) {
    if (reached.has(id)) continue;
    // The outermost page of those lost together, so they stay together.
    let root = id;
    const climbed = new Set([id]);
    for (let up = handParent.get(root); up !== undefined; up = handParent.get(up)) {
      if (climbed.has(up) || reached.has(up) || !byHand.has(up)) break;
      climbed.add(up);
      root = up;
    }
    reached.add(root);
    lost.push(root);
    walk([root], false);
  }
  if (lost.length > 0) {
    if (shelter) out.set(shelter, [...(out.get(shelter) ?? []), ...lost]);
    else top.push(...lost);
  }
  if (root !== null) {
    // What the home page leads to is the top of the contents, before the
    // sections of pages placed by links (those nothing else leads to).
    const branches = out.get(root) ?? [];
    out.delete(root);
    const at = top.findIndex((id) => byLinks.has(id));
    top.splice(at < 0 ? top.length : at, 0, ...branches);
  }
  return { top, lists: out, placed };
}
