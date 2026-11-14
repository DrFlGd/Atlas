import { isOwnId, type GuideEntry, type Section } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';
import { guideLinks, placePagesByLinks } from './pageTree';

/**
 * A pack's guides as pages to browse: its contents (`sections.json`), the
 * sections that hold sections and guides in the source's own order.
 *
 * With a contents, the pages are the guides it lists; the pack's other
 * guides (walkthroughs of its lists, notes of its locations) stay where
 * they were. A pack with no contents and no map either (a game of guides
 * and lists only) is browsed as one list of all its guides, in order.
 */
export type ContentsEntry =
  | { kind: 'section'; section: Section; /** Pages in it, however deep. */ pages: number }
  | { kind: 'page'; guide: GuideEntry; /** Pages under it, however deep. */ pages: number };

/** A step of the way from the top of the contents to an entry: a section, or a page. */
export type ContentsStep =
  { kind: 'section'; section: Section } | { kind: 'page'; guide: GuideEntry };

/**
 * Guides to browse as pages: a pack's data, or a pack's pages with a
 * person's own laid over them (see `applyOwnPages`). With `top`, the top of
 * the contents is that list, of sections and pages, and the pages are those
 * it and its sections hold, however deep; without it, the top is every
 * section no other section lists, as a pack's contents says. With `under`,
 * the pages the person put under a page, by that page's id.
 */
export interface GuidePages {
  data: Pick<LoadedPack['data'], 'guides' | 'sections' | 'maps'>;
  top?: readonly string[];
  under?: Readonly<Record<string, readonly string[]>>;
}

/**
 * The contents as shown: sections that hold sections and pages, and pages
 * that hold pages. A page of a section marked `placeByLinks` is shown
 * under the page that leads to it (see `pageTree.ts`); every entry has one
 * home, its first place in the contents, top to bottom, which the way to
 * it (`trail`) follows.
 */
export class GuideContents {
  /** Whether the pack has guides to browse as pages: a contents, or no map but guides. */
  readonly browsable: boolean;
  /** Whether the pack has a contents of its own. */
  readonly hasContents: boolean;
  private readonly sections: ReadonlyMap<string, Section>;
  private readonly guides: ReadonlyMap<string, GuideEntry>;
  /** What the pack and the person list: by section id, and by page id the pages put under it. */
  private readonly baseLists: ReadonlyMap<string, readonly string[]>;
  private readonly baseTop: readonly string[];
  private readonly byLinkSections: ReadonlySet<string>;
  /** The contents as shown (see {@link shown}). */
  private tree: { top: readonly string[]; lists: ReadonlyMap<string, readonly string[]> } | null =
    null;
  /** Each entry's home: the section or page of its first place, or null at the top. */
  private readonly home = new Map<string, string | null>();
  /** Every entry at its home, top to bottom. */
  private readonly inOrder: string[] = [];
  /** With no contents, the guides listed at the top, in guide order. */
  private readonly loose: GuideEntry[];
  /** Every guide the contents lists, however deep. */
  private readonly listed = new Set<string>();
  private readonly pageCounts = new Map<string, number>();
  /** The pages placed under a page by their links: by page id, that page. */
  private byLinks: ReadonlyMap<string, string> = new Map();
  /** By page id, the pages of the contents that link to it, in contents order; when first asked. */
  private linkedTo: Map<string, string[]> | null = null;

  constructor(pack: GuidePages) {
    const sections = pack.data.sections ?? [];
    const guides = sortGuides(pack.data.guides);
    this.sections = new Map(sections.map((s) => [s.id, s]));
    this.guides = new Map(guides.map((g) => [g.id, g]));
    const top = pack.top;
    this.hasContents = top !== undefined || sections.length > 0;
    const hasMap = pack.data.maps.length > 0;
    this.browsable =
      top !== undefined
        ? top.some((id) => this.sections.has(id) || this.guides.has(id))
        : this.hasContents || (!hasMap && guides.length > 0);

    // What the pack and the person list: sections, and pages under pages.
    const lists = new Map<string, readonly string[]>();
    const listedBy = new Set<string>();
    for (const section of sections) {
      if (lists.has(section.id)) continue;
      lists.set(section.id, section.items);
      for (const item of section.items) {
        if (this.sections.has(item)) listedBy.add(item);
        else if (this.guides.has(item)) this.listed.add(item);
      }
    }
    for (const [id, items] of Object.entries(pack.under ?? {})) {
      if (!this.guides.has(id)) continue;
      lists.set(id, items);
      for (const item of items) if (this.guides.has(item)) this.listed.add(item);
    }
    let topIds: string[];
    if (top !== undefined) {
      topIds = top.filter((id) => this.sections.has(id) || this.guides.has(id));
      for (const id of topIds) if (this.guides.has(id)) this.listed.add(id);
    } else {
      topIds = sections.filter((s) => !listedBy.has(s.id)).map((s) => s.id);
    }

    this.baseTop = topIds;
    this.baseLists = lists;
    this.byLinkSections = new Set(sections.filter((s) => s.placeByLinks === true).map((s) => s.id));
    this.loose = this.browsable && !this.hasContents ? guides : [];
  }

  /**
   * The contents as shown, worked out when first asked: placing pages by
   * their links reads every page's text, which only the Guides section needs.
   */
  private shown(): { top: readonly string[]; lists: ReadonlyMap<string, readonly string[]> } {
    if (this.tree) return this.tree;
    const shown = (id: string) => this.listed.has(id) && !isOwnId(id);
    const tree = placePagesByLinks({
      top: this.baseTop,
      lists: this.baseLists,
      isSection: (id) => this.sections.has(id),
      isPage: (id) => this.guides.has(id),
      byLinks: this.byLinkSections,
      linksOf: (id) => guideLinks(this.guides.get(id)!),
      leads: shown,
      movable: shown,
    });
    this.tree = tree;
    this.byLinks = tree.placed;
    for (const id of tree.top) if (this.guides.has(id)) this.listed.add(id);
    this.walk(tree.top, tree.lists);
    return tree;
  }

  /** Each entry's home and place, top to bottom, and the pages under each. */
  private walk(top: readonly string[], lists: ReadonlyMap<string, readonly string[]>): void {
    const inOrder = this.inOrder;
    const stack: { parent: string | null; items: readonly string[]; at: number }[] = [
      { parent: null, items: top, at: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.at >= frame.items.length) {
        stack.pop();
        continue;
      }
      const id = frame.items[frame.at++]!;
      if (this.home.has(id) || (!this.sections.has(id) && !this.guides.has(id))) continue;
      this.home.set(id, frame.parent);
      inOrder.push(id);
      const items = lists.get(id);
      if (items && items.length > 0) stack.push({ parent: id, items, at: 0 });
    }
    // From the bottom up: an entry counts the pages it holds, and theirs where they are at home.
    for (let i = inOrder.length - 1; i >= 0; i--) {
      const id = inOrder[i]!;
      let count = 0;
      for (const item of lists.get(id) ?? []) {
        if (this.guides.has(item)) count += 1;
        if (this.home.get(item) === id) count += this.pageCounts.get(item) ?? 0;
      }
      this.pageCounts.set(id, count);
    }
  }

  /** What the top of the contents lists: its sections (or, with no contents, every page). */
  top(): ContentsEntry[] {
    if (!this.hasContents) {
      return this.loose.map((guide) => ({ kind: 'page', guide, pages: 0 }));
    }
    return this.shown().top.flatMap((id) => this.entry(id));
  }

  /** The ids at the top of the contents, in order: sections, and pages (see {@link GuidePages}). */
  topEntryIds(): readonly string[] {
    return this.hasContents ? this.shown().top : this.loose.map((guide) => guide.id);
  }

  /** Whether a guide is one of the pages browsed here. */
  isPage(guideId: string): boolean {
    return this.hasContents ? this.listed.has(guideId) : this.loose.some((g) => g.id === guideId);
  }

  section(id: string): Section | undefined {
    return this.sections.get(id);
  }

  guide(id: string): GuideEntry | undefined {
    return this.guides.get(id);
  }

  /** What a section or a page holds, in order; items the pack lacks are left out. */
  items(id: string): ContentsEntry[] {
    return (this.shown().lists.get(id) ?? []).flatMap((item) => this.entry(item));
  }

  /** How many entries a section or a page holds (not counting deeper ones). */
  itemCount(id: string): number {
    return this.shown().lists.get(id)?.length ?? 0;
  }

  private entry(id: string): ContentsEntry[] {
    this.shown();
    const section = this.sections.get(id);
    if (section) return [{ kind: 'section', section, pages: this.pageCounts.get(id) ?? 0 }];
    const guide = this.guides.get(id);
    return guide ? [{ kind: 'page', guide, pages: this.pageCounts.get(id) ?? 0 }] : [];
  }

  /** Where an entry is at home: its section or page, null at the top, undefined when not listed. */
  parentOf(id: string): string | null | undefined {
    this.shown();
    return this.home.get(id);
  }

  /**
   * The way from the top down to an entry (a guide or a section): the
   * sections and pages it is under, outermost first.
   */
  trail(id: string): ContentsStep[] {
    this.shown();
    const path: ContentsStep[] = [];
    const seen = new Set<string>([id]);
    for (let at = this.home.get(id); at != null && !seen.has(at); at = this.home.get(at)) {
      seen.add(at);
      const section = this.sections.get(at);
      if (section) path.push({ kind: 'section', section });
      else {
        const guide = this.guides.get(at);
        if (!guide) break;
        path.push({ kind: 'page', guide });
      }
    }
    return path.reverse();
  }

  /** The sections from the top down to the one holding `id` (a guide or a section), outermost first. */
  pathTo(id: string): Section[] {
    return this.trail(id).flatMap((step) => (step.kind === 'section' ? [step.section] : []));
  }

  /** Whether a page is where it is because of its links (see `pageTree.ts`). */
  placedByLinks(guideId: string): boolean {
    this.shown();
    return this.byLinks.has(guideId);
  }

  /**
   * The pages of the contents that link to a page, in contents order, top
   * to bottom, but the page it is under: "also linked from".
   */
  linkedFrom(guideId: string): GuideEntry[] {
    if (!this.linkedTo) {
      const linkedTo = new Map<string, string[]>();
      for (const page of this.pages()) {
        for (const target of guideLinks(page)) {
          if (!this.listed.has(target)) continue;
          const from = linkedTo.get(target);
          if (from) from.push(page.id);
          else linkedTo.set(target, [page.id]);
        }
      }
      this.linkedTo = linkedTo;
    }
    const home = this.home.get(guideId);
    return (this.linkedTo.get(guideId) ?? [])
      .filter((id) => id !== home)
      .map((id) => this.guides.get(id)!);
  }

  /** Every page that can be browsed, in contents order, each once. */
  pages(): GuideEntry[] {
    if (!this.hasContents) return [...this.loose];
    this.shown();
    const out: GuideEntry[] = [];
    for (const id of this.inOrder) {
      const guide = this.guides.get(id);
      if (guide) out.push(guide);
    }
    return out;
  }
}

/** Guides in their listed order: by `order`, those without one after, by title. */
export function sortGuides(guides: readonly GuideEntry[]): GuideEntry[] {
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return [...guides].sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;
    return collator.compare(a.title, b.title);
  });
}

/** The guides of another game, read with a game's own (see {@link guidesTogether}). */
export interface GuidesOfGame {
  gameId: string;
  /** The other game's title, the heading its pages are under. */
  title: string;
  data: Pick<LoadedPack['data'], 'guides' | 'sections'>;
}

/** The local id of the section that holds another game's pages. */
export const OTHER_GAME_SECTION = 'atlas.from-game';

/**
 * A game's guides together with those of other games (a wiki read as a
 * game of its own), as {@link GuideContents} takes them: each other game's
 * contents under a section of its own, named after that game, after the
 * game's own. Ids keep their own game, so nothing is renamed; no pack is
 * changed.
 */
export function guidesTogether(pack: GuidePages, others: readonly GuidesOfGame[]): GuidePages {
  if (others.length === 0) return pack;
  const pageTop = pack.top ? [...pack.top] : undefined;
  const guides = [...pack.data.guides];
  const sections: Section[] = [...(pack.data.sections ?? [])];
  for (const other of others) {
    const own = other.data.sections ?? [];
    const listed = new Set(own.flatMap((section) => section.items));
    const top =
      own.length > 0
        ? own.filter((section) => !listed.has(section.id)).map((section) => section.id)
        : sortGuides(other.data.guides).map((guide) => guide.id);
    if (top.length === 0) continue;
    guides.push(...other.data.guides);
    const id = `${other.gameId}:section:${OTHER_GAME_SECTION}`;
    sections.push({ id, title: other.title, items: top }, ...own);
    pageTop?.push(id);
  }
  return { data: { ...pack.data, guides, sections }, ...(pageTop ? { top: pageTop } : {}) };
}
