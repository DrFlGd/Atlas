import type { GuideEntry } from '@atlas/schema';
import type { ListingHeading } from './pageFiling';

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
 * - A page the source itself files under a page that is shown (a guide's
 *   `filedUnder`: a wiki's category that is a page of the wiki, the title
 *   of a navigation box) goes under it, before any list page is looked at:
 *   under one of those that lists it, else under the first the source
 *   names, never under a page that is under it.
 * - A page of a `placeByLinks` section goes under the list page that lists
 *   it and is reached first from a placed page (a breadth-first walk
 *   through the pages list pages list). Of two list pages equally close,
 *   the one met first wins: pages placed in the contents in the order the
 *   contents shows them, top to bottom, and further pages in the order
 *   they were listed. So a page has exactly one home, and every walk of
 *   the same pages gives the same tree.
 * - The narrower list wins: when a list page that lists a page also lists
 *   a list page that lists it too, and puts that one under itself, the
 *   page goes under the narrower one (an index of all gear lists "Short
 *   blades" and every short blade, and "Short blades" lists its blades:
 *   Gear › Short blades › Dirk, not Gear › Dirk), and so on down, for as
 *   long as a narrower one lists it. Only a list page that none of the
 *   pages put beside it lists is narrower: a page whose "See also" names
 *   its neighbours is one of them, and takes none of them. What the home
 *   page lists stays at the top as it is.
 * - A heading of a list page that is one link to a page
 *   (`### [Short blades](…)`) says so itself, and comes before the
 *   narrower list: the pages listed under it, at any depth below it, go
 *   under that page, which stays under the list page. Only when that page
 *   is put under the list page too: one placed elsewhere (by the person,
 *   by the source's `filedUnder`, in the menu) or above the list page, or
 *   one that would close a circle, makes the heading a plain one, and the
 *   narrower list decides as above. A plain heading files nothing here: it
 *   is a level of the contents only (see `headingSteps.ts`).
 * - A page many pages link to (a location every item names, see
 *   {@link POPULAR_MIN_LINKERS}) goes only under one of the longest list
 *   pages that list it (see {@link POPULAR_PARENT_SHARE}), never under a
 *   page that merely names it among many others; or under a narrower
 *   list page that such a list page puts under itself, as above (a real
 *   part of that index, however short).
 * - A list page no placed page leads to stays in its section, with the
 *   pages it lists under it (those no other list page took first).
 * - Under a page: the pages the person put there first, in their order,
 *   then the pages the source files under it, then the pages it lists, in
 *   its order.
 * - A page with no clear home (no list page lists it) stays in its
 *   section: when unsure, the contents stays flat.
 *
 * - A home page (`root`, a wiki's main page, see the manifest's
 *   `homePage`) is where the contents starts from before any other page:
 *   it is not shown in the contents (Guides shows it on its own), and the
 *   pages it lists (whether or not it is a list page itself) and those put
 *   under it by hand are at the top of the contents, before the sections
 *   whose pages are placed by links. When the contents already places
 *   most of what it lists (see {@link HOME_LAID_OUT_SHARE}: an importer
 *   made the contents from the home page's blocks, in its order), it files
 *   nothing more at the top: what it lists and the contents left out (a
 *   block of news) is placed by its links like any page of its section.
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

/**
 * The share of the pages a home page lists (of those the pack has) that the
 * contents places itself, from which the contents counts as made from the
 * home page: its blocks are the contents' sections. The home page then
 * files nothing at the top; the pages it lists that the contents left out
 * (a block of news, of the wiki's own affairs) stay where pages nothing
 * places are, placed by their links.
 */
export const HOME_LAID_OUT_SHARE = 0.8;

/**
 * The heading around each heading of a page, by index: the nearest one
 * before it of a lower level; -1 for none.
 */
export function headingParents(headings: readonly ListingHeading[]): number[] {
  const parents: number[] = [];
  const open: number[] = [];
  headings.forEach((heading, i) => {
    while (open.length > 0 && headings[open.at(-1)!]!.level >= heading.level) open.pop();
    parents.push(open.at(-1) ?? -1);
    open.push(i);
  });
  return parents;
}

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
  /** Its headings, and by listed page the innermost heading it is listed under (see `PageFiling`). */
  headings?: readonly ListingHeading[];
  listedUnder?: readonly number[];
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
   * The pages the source itself files a page under (a guide's
   * `filedUnder`), the most fitting first; none when it says nothing.
   */
  filedUnderOf?: (guideId: string) => readonly string[];
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
  /** Of those, the pages placed under a page the source itself files them under. */
  filed: Set<string>;
}

/**
 * Whether the contents already holds most of what the home page lists (see
 * {@link HOME_LAID_OUT_SHARE}): the contents was made from it.
 */
function laidOutFrom(input: PageTreeInput, root: string, placed: ReadonlySet<string>): boolean {
  let listed = 0;
  let there = 0;
  for (const id of input.filingOf(root).listing) {
    if (id === root || !input.isPage(id) || !input.leads(id)) continue;
    listed += 1;
    if (placed.has(id)) there += 1;
  }
  return listed > 0 && there >= HOME_LAID_OUT_SHARE * listed;
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

  // A contents made from the home page (its blocks as sections) already
  // places what it lists: the home page then files nothing more at the top.
  const rootLaidOut = root !== null && laidOutFrom(input, root, reached);

  // Which pages file which: by page, what it lists when it files pages
  // (the home page and list pages); by waiting page, how many pages link
  // to it, and the longest list page that lists it.
  const filing = new Map<string, readonly string[]>();
  /** By list page with headings: where its listed pages are listed (see `PageListing`). */
  const headed = new Map<string, Required<Pick<PageListing, 'headings' | 'listedUnder'>>>();
  const linkers = new Map<string, number>();
  const longest = new Map<string, number>();
  // By waiting page, the pages the source itself files it under.
  const filedUnder = new Map<string, readonly string[]>();
  if (waiting.size > 0) {
    const counted = new Set<string>();
    const count = (id: string) => {
      if (counted.has(id) || !isPage(id) || !input.leads(id)) return;
      counted.add(id);
      if (waiting.has(id)) {
        const under = input.filedUnderOf?.(id) ?? [];
        if (under.length > 0) filedUnder.set(id, under);
      }
      for (const target of input.linksOf(id)) {
        if (waiting.has(target)) linkers.set(target, (linkers.get(target) ?? 0) + 1);
      }
      const { listing, listPage, headings, listedUnder } = input.filingOf(id);
      if (id !== root && !listPage) return;
      filing.set(id, listing);
      if (headings && listedUnder && headings.some((heading) => heading.guide !== null)) {
        headed.set(id, { headings, listedUnder });
      }
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

  // The page the source itself files each waiting page under, before any
  // list page: of the pages it names that are shown, one that lists it
  // first, then in the source's order (the most fitting first); never one
  // that is under the page itself.
  const wikiParent = new Map<string, string>();
  const wikiChildren = new Map<string, string[]>();
  const filed = new Set<string>();
  if (filedUnder.size > 0) {
    const listsIt = new Map<string, Set<string>>();
    const lists = (parent: string, id: string) => {
      const listing = filing.get(parent);
      if (!listing) return false;
      let set = listsIt.get(parent);
      if (!set) listsIt.set(parent, (set = new Set(listing)));
      return set.has(id);
    };
    /** Whether `id` is `page` or under it, by the source's filing or the person's. */
    const within = (id: string, page: string) => {
      const seen = new Set<string>();
      for (
        let at: string | undefined = id;
        at !== undefined;
        at = wikiParent.get(at) ?? handParent.get(at)
      ) {
        if (at === page) return true;
        if (seen.has(at)) return false;
        seen.add(at);
      }
      return false;
    };
    for (const id of waiting) {
      const named = filedUnder.get(id);
      if (!named) continue;
      const candidates = [...new Set(named)]
        .filter((parent) => parent !== id && isPage(parent) && input.leads(parent))
        .map((parent, at) => ({ parent, at, listing: lists(parent, id) ? 0 : 1 }))
        .sort((a, b) => a.listing - b.listing || a.at - b.at);
      const chosen = candidates.find(({ parent }) => !within(parent, id));
      if (!chosen) continue;
      wikiParent.set(id, chosen.parent);
      const children = wikiChildren.get(chosen.parent);
      if (children) children.push(id);
      else wikiChildren.set(chosen.parent, [id]);
    }
    // Under a page, in the order its text links to them, then the others in contents order.
    for (const [parent, children] of wikiChildren) {
      if (children.length < 2) continue;
      const place = new Map(input.linksOf(parent).map((link, at) => [link, at]));
      const last = Number.MAX_SAFE_INTEGER;
      children.sort((a, b) => (place.get(a) ?? last) - (place.get(b) ?? last));
    }
  }

  /**
   * By page, the pages kept for it, in order (see {@link keptHere}): it
   * files them when its turn comes, or keeps them for one of its own.
   */
  const keptBy = new Map<string, string[]>();
  /** The pages each list page lists, as a set, made when first asked. */
  const listSets = new Map<string, ReadonlySet<string>>();
  const listsPage = (page: string, id: string) => {
    let set = listSets.get(page);
    if (!set) {
      const listing = filing.get(page);
      if (!listing) return false;
      listSets.set(page, (set = new Set(listing)));
    }
    return set.has(id);
  };

  /**
   * By page a list page lists under a heading that is a link to another
   * page (`### [Short blades](…)`), at any depth below it: the page of the
   * innermost such heading, which the page goes under (see the top of this
   * file). Made when first asked.
   */
  const headingHosts = new Map<string, ReadonlyMap<string, string>>();
  const headingHostsOf = (page: string): ReadonlyMap<string, string> => {
    let hosts = headingHosts.get(page);
    if (hosts) return hosts;
    const found = new Map<string, string>();
    const info = headed.get(page);
    const listing = filing.get(page);
    if (info && listing) {
      const parents = headingParents(info.headings);
      listing.forEach((target, i) => {
        for (let at = info.listedUnder[i] ?? -1; at >= 0; at = parents[at]!) {
          const guide = info.headings[at]!.guide;
          if (guide !== null && guide !== target && guide !== page && isPage(guide)) {
            found.set(target, guide);
            break;
          }
        }
      });
    }
    headingHosts.set(page, (hosts = found));
    return hosts;
  };

  /**
   * Of the pages put under `page` together (`under`), the narrower list
   * pages its listed pages (`listed`) go under, by page (see the top of
   * this file): a list page among them that lists the page, the first in
   * order. A list page that one of the others lists (an item's "See also"
   * naming its neighbours) is a neighbour, not a narrower list: only list
   * pages none of the others lists count.
   */
  const narrower = (under: readonly string[], listed: readonly string[]) => {
    const found = new Map<string, string>();
    const listPages = under.filter((id) => filing.has(id));
    if (listPages.length === 0 || listed.length === 0) return found;
    const here = new Set(under);
    const named = new Set<string>();
    for (const id of listPages) {
      for (const target of filing.get(id)!) if (here.has(target)) named.add(target);
    }
    const hosts = listPages.filter((id) => !named.has(id));
    if (hosts.length === 0) return found;
    for (const target of listed) {
      const host = hosts.find((id) => id !== target && listsPage(id, target));
      if (host !== undefined) found.set(target, host);
    }
    return found;
  };

  /**
   * Which of the pages `page` files now (`listed`) go under another of the
   * pages put under it together, by page: first the page of the heading it
   * is listed under (the list page says so itself), then a narrower list
   * page. Never in a circle: each page goes under at most one, and a page
   * is never kept for one that is kept, however far, for it.
   */
  const keptHere = (page: string, under: readonly string[], listed: readonly string[]) => {
    const kept = new Map<string, string>();
    if (page === root || listed.length === 0) return kept;
    const leadsTo = (from: string, to: string) => {
      for (let at: string | undefined = from; at !== undefined; at = kept.get(at)) {
        if (at === to) return true;
      }
      return false;
    };
    const together = [...under, ...listed];
    const here = new Set(together);
    const hosts = headingHostsOf(page);
    if (hosts.size > 0) {
      for (const target of listed) {
        const host = hosts.get(target);
        if (host !== undefined && here.has(host) && !leadsTo(host, target)) kept.set(target, host);
      }
    }
    const rest = kept.size > 0 ? listed.filter((target) => !kept.has(target)) : listed;
    for (const [target, host] of narrower(together, rest)) {
      if (!leadsTo(host, target)) kept.set(target, host);
    }
    return kept;
  };

  /**
   * Walks out from `queue`: the pages put under each, then the pages the
   * source files under it, then (with links) the pages kept for it and
   * those it lists.
   */
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
      for (const child of wikiChildren.get(page) ?? []) {
        if (reached.has(child)) continue;
        reached.add(child);
        placed.set(child, page);
        filed.add(child);
        under.push(child);
        queue.push(child);
      }
      // The pages it files: those kept for it, then those it lists that no page took first.
      const listed = keptBy.get(page) ?? [];
      keptBy.delete(page);
      const listing = withLinks && !(page === root && rootLaidOut) ? filing.get(page) : undefined;
      if (listing) {
        for (const target of listing) {
          if (!waiting.has(target) || reached.has(target) || wikiParent.has(target)) continue;
          if (!mayFile(page, listing.length, target)) continue;
          reached.add(target);
          listed.push(target);
        }
      }
      if (listed.length > 0) {
        const kept = keptHere(page, under, listed);
        for (const target of listed) {
          const host = kept.get(target);
          if (host !== undefined) {
            const list = keptBy.get(host);
            if (list) list.push(target);
            else keptBy.set(host, [target]);
            continue;
          }
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
  // no page left there files or lists, each with what it files and lists;
  // then any left (pages that file or list each other only).
  const left = new Set<string>();
  for (const id of sectionsSeen) {
    if (!byLinks.has(id)) continue;
    for (const item of lists.get(id) ?? []) {
      if (isPage(item) && !reached.has(item)) left.add(item);
    }
  }
  const listedThere = new Set<string>();
  for (const page of left) {
    if (wikiParent.has(page)) listedThere.add(page);
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
  return { top, lists: out, placed, filed };
}
