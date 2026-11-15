import type { ListingHeading } from './pageFiling';
import { headingParents } from './pageTree';

/**
 * The headings of a list page as levels under it in the contents: a list
 * page that lists its pages under headings ("Weapons", "Skills") shows
 * them in those groups, each a step that is no page. A heading that is one
 * link to a page is that page (see `pageTree.ts`); a plain heading is a
 * step here. Nothing of it is stored: it is worked out from the page's
 * text whenever the contents is shown.
 *
 * Only the pages the list page files by its own listing are grouped; the
 * pages the person put under it and those the source files under it stay
 * first, as they are. A page goes in the group of the innermost heading it
 * is first listed under. Then, so the contents stays tidy:
 *
 * - A heading under which nothing is listed is left out.
 * - A group holds at least {@link HEADING_STEP_MIN_PAGES} pages, counting
 *   the pages under them however deep: with fewer, its pages rise to the
 *   level above, in their place (in the end, straight under the list page).
 * - A heading that holds no page itself and one group under it is one step
 *   with that group, named by the outer heading.
 * - A single group over all the pages a list page groups makes no step:
 *   the groups under it are the levels. Steps are made only when they part
 *   the pages into two groups or more, or one group and pages beside it
 *   (grouped or not: a page the person put there counts).
 * - A first-level heading with the page's own title is no level.
 *
 * So the levels are at most as deep as the page's headings go (six), and
 * a level is made only from the page's own headings.
 */

/** A group holds at least this many pages, however deep, or its pages rise to the level above. */
export const HEADING_STEP_MIN_PAGES = 3;

/** What {@link headingSteps} works on: one list page as the contents shows it. */
export interface HeadingStepsInput {
  /** The list page's id and title. */
  page: string;
  title: string;
  /** What it holds as shown, in order. */
  items: readonly string[];
  /** Whether an item is a page it files by its own listing (the others are not grouped). */
  grouped: (id: string) => boolean;
  /** How many pages an item counts for: itself and the pages under it, however deep. */
  weight: (id: string) => number;
  /** What it lists, its headings, and by listed page the innermost heading it is listed under. */
  listing: readonly string[];
  headings: readonly ListingHeading[];
  listedUnder: readonly number[];
}

/** A heading of a list page made a step (see the top of this file). */
export interface HeadingStep {
  /** Its id in the contents: the list page's id, `#`, the heading's section. */
  id: string;
  words: string;
  /** The heading's section, which the list page opens at. */
  section: string;
  /** What it holds, in order: pages, and the ids of the steps under it. */
  items: string[];
}

/** The id of a step of a list page's heading. */
export const headingStepId = (page: string, section: string) => `${page}#${section}`;

interface Node {
  heading: number;
  pages: string[];
  children: Node[];
}

type Item =
  | { kind: 'page'; id: string; first: number; weight: number }
  | { kind: 'step'; heading: number; items: Item[]; first: number; weight: number };

/**
 * The steps of a list page's headings, and what the list page holds with
 * them, in order; null when its headings make no step.
 */
export function headingSteps(
  input: HeadingStepsInput,
): { items: string[]; steps: HeadingStep[] } | null {
  const { headings, listedUnder, listing } = input;
  if (headings.length === 0) return null;
  const at = new Map<string, number>();
  listing.forEach((id, i) => at.set(id, i));
  const chosen = input.items.filter((id) => input.grouped(id) && at.has(id));
  // One page alone makes a level only beside pages put there otherwise.
  const beside = input.items.length > chosen.length;
  if (chosen.length === 0 || (chosen.length < 2 && !beside)) return null;
  const parents = headingParents(headings);
  const title = input.title.trim().toLowerCase();
  // A first-level heading with the page's own title is no level.
  const isTitle = (h: number) =>
    headings[h]!.level === 1 && headings[h]!.words.trim().toLowerCase() === title;
  const root: Node = { heading: -1, pages: [], children: [] };
  const nodes = new Map<number, Node>();
  const nodeOf = (h: number): Node => {
    while (h >= 0 && isTitle(h)) h = parents[h]!;
    if (h < 0) return root;
    let node = nodes.get(h);
    if (node) return node;
    node = { heading: h, pages: [], children: [] };
    nodes.set(h, node);
    nodeOf(parents[h]!).children.push(node);
    return node;
  };
  for (const id of chosen) nodeOf(listedUnder[at.get(id)!] ?? -1).pages.push(id);
  if (nodes.size === 0) return null;

  const pagesOf = (items: readonly Item[]): Item[] =>
    items.flatMap((item) => (item.kind === 'page' ? [item] : pagesOf(item.items)));
  const build = (node: Node): Item[] => {
    const items: Item[] = node.pages.map((id) => ({
      kind: 'page',
      id,
      first: at.get(id)!,
      weight: input.weight(id),
    }));
    for (const child of node.children) {
      const inner = build(child);
      if (inner.length === 0) continue;
      const weight = inner.reduce((sum, item) => sum + item.weight, 0);
      if (weight < HEADING_STEP_MIN_PAGES) {
        // Too few: its pages rise to this level, in their place.
        items.push(...pagesOf(inner));
        continue;
      }
      const first = Math.min(...inner.map((item) => item.first));
      // A heading with nothing of its own but one group: one step, named by it.
      const only = inner.length === 1 && inner[0]!.kind === 'step' ? inner[0] : null;
      items.push({
        kind: 'step',
        heading: child.heading,
        items: only ? only.items : inner,
        first,
        weight,
      });
    }
    return items.sort((a, b) => a.first - b.first);
  };
  let top = build(root);
  // One group over all (and nothing beside it, put there by hand or by the
  // source): no step for it, the groups under it are the levels.
  for (let only = top[0]; !beside && top.length === 1 && only?.kind === 'step'; only = top[0]) {
    top = only.items;
  }
  if (!top.some((item) => item.kind === 'step')) return null;

  const steps: HeadingStep[] = [];
  const idsOf = (items: readonly Item[]): string[] =>
    items.map((item) => {
      if (item.kind === 'page') return item.id;
      const heading = headings[item.heading]!;
      const id = headingStepId(input.page, heading.section);
      steps.push({ id, words: heading.words, section: heading.section, items: idsOf(item.items) });
      return id;
    });
  const grouped = new Set(chosen);
  return {
    items: [...input.items.filter((id) => !grouped.has(id)), ...idsOf(top)],
    steps,
  };
}
