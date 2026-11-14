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
 * - The pages placed in the contents (in any other section, at the top,
 *   or under a page by the person) are where the contents starts from.
 * - A page of a `placeByLinks` section goes under the page it is reached
 *   from by the fewest links from a placed page (a breadth-first walk).
 *   Of two pages equally close, the one met first wins: pages placed in
 *   the contents in the order the contents shows them, top to bottom, and
 *   further pages in the order they were reached (a page's links in the
 *   order its text has them). So a page has exactly one home, and every
 *   walk of the same pages gives the same tree.
 * - Under a page: the pages the person put there first, in their order,
 *   then the pages placed there by links, in the order the page links to
 *   them.
 * - A page no placed page leads to stays in its section.
 *
 * Every page is reached once, so links in a circle (A to B, B to A) or to
 * the page itself change nothing; one read more adds the new page and may
 * move the pages it reaches sooner, and nothing else.
 */

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
  /** The pages a page links to, in order. */
  linksOf: (guideId: string) => readonly string[];
  /** Whether a page's links place other pages (a pack's page that is shown). */
  leads: (guideId: string) => boolean;
  /** Whether a page may be placed by links (a pack's page that is shown). */
  movable: (guideId: string) => boolean;
}

/** The contents with the pages placed (see the top of this file). */
export interface PageTree {
  top: string[];
  /** What each section and each page holds, as shown. */
  lists: Map<string, string[]>;
  /** The pages placed by links: by page id, the page it is under. */
  placed: Map<string, string>;
}

/** Places the pages of `placeByLinks` sections under the pages that lead to them. */
export function placePagesByLinks(input: PageTreeInput): PageTree {
  const { lists, isSection, isPage, byLinks } = input;
  const out = new Map<string, string[]>();
  const placed = new Map<string, string>();
  const top = [...input.top];

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

  /** Walks out from `queue`: the pages put under each, then (with links) those it leads to. */
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
      if (withLinks && input.leads(page)) {
        for (const target of input.linksOf(page)) {
          if (!waiting.has(target) || reached.has(target)) continue;
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

  // The sections as shown: one placed by links keeps only the pages nothing led to.
  for (const [id, items] of lists) {
    if (!isSection(id)) continue;
    out.set(id, byLinks.has(id) ? items.filter((item) => !reached.has(item)) : [...items]);
  }
  // The pages left there keep the pages put under them by hand.
  const left: string[] = [];
  for (const id of sectionsSeen) {
    if (!byLinks.has(id)) continue;
    for (const item of out.get(id) ?? []) {
      if (isPage(item) && !reached.has(item)) {
        reached.add(item);
        left.push(item);
      }
    }
  }
  walk(left, false);

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
  return { top, lists: out, placed };
}
