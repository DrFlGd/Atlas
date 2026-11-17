import { isOwnId, type GuideEntry, type Section } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';
import { guideFiling, isListPage } from './pageFiling';
import { headingSteps } from './headingSteps';
import { guideLinks, placePagesByLinks, type PageListing } from './pageTree';

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
  | { kind: 'page'; guide: GuideEntry; /** Pages under it, however deep. */ pages: number }
  | { kind: 'heading'; heading: ContentsHeading; /** Pages in it, however deep. */ pages: number };

/**
 * A heading of a list page shown as a level under it (see
 * `headingSteps.ts`): no page, but the pages the list page lists under
 * that heading. It opens the list page at the heading.
 */
export interface ContentsHeading {
  /** Its id in the contents: the list page's id, `#`, the heading's section. */
  id: string;
  /** The heading's words. */
  title: string;
  /** The list page it is a heading of. */
  guide: GuideEntry;
  /** The heading's section (see `sections.ts`), which the list page opens at. */
  section: string;
}

/**
 * How the pages of the contents are filed (see {@link GuideContents.filing}):
 * each page of the contents, the home page aside, is counted once.
 */
export interface ContentsFiling {
  /** The pages of the contents. */
  pages: number;
  /** Under the list page that lists them (or at the top, listed by the home page). */
  underListPage: number;
  /** Under a page the source itself files them under (a guide's `filedUnder`). */
  underFiledPage: number;
  /** In a section of the contents placed by the pack itself (a wiki's menu), or at the top by it. */
  inSection: number;
  /** Left in a section of pages placed by links (a wiki's "Pages"): no list page lists them. */
  inPagesSection: number;
  /** Under a page the person put them under. */
  byHand: number;
}

/** A step of the way from the top of the contents to an entry: a section, a page, or a heading of one. */
export type ContentsStep =
  | { kind: 'section'; section: Section }
  | { kind: 'page'; guide: GuideEntry }
  | { kind: 'heading'; heading: ContentsHeading };

/** The id of an entry or a step of the contents: its section's, its page's or its heading's. */
export function entryIdOf(entry: ContentsEntry | ContentsStep): string {
  if (entry.kind === 'section') return entry.section.id;
  return entry.kind === 'page' ? entry.guide.id : entry.heading.id;
}

/** The title of an entry or a step of the contents, as the contents shows it. */
export function entryTitleOf(entry: ContentsEntry | ContentsStep): string {
  if (entry.kind === 'section') return entry.section.title;
  return entry.kind === 'page' ? entry.guide.title : entry.heading.title;
}

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
  /**
   * Other ids of guides, by the id that replaces each (a pack's
   * `idMigrations`): a link to another name of a page is a link to the page.
   */
  aliases?: Readonly<Record<string, string>>;
  /**
   * The home page (a pack's `homePage`, a wiki's main page): shown on its
   * own, not in the contents, and the top of the contents branches from it
   * (see `pageTree.ts`). Not used when the guides have no such page.
   */
  homePage?: string | null;
  /**
   * The person's say on list pages (an own pages file's `listPages`): by
   * page id, `true` when it files the pages it lists whatever share of its
   * links it lists, `false` when it files none.
   */
  listPages?: Readonly<Record<string, boolean>>;
}

/** The id a guide id stands for now, through `aliases` (a few steps at most). */
export function aliasedId(aliases: Readonly<Record<string, string>> | undefined, id: string) {
  let current = id;
  for (let hops = 0; hops < 32 && aliases?.[current] !== undefined; hops++) {
    current = aliases[current]!;
  }
  return current;
}

/** The pages a guide links to, through `aliases`, each once, never itself. */
export function linksThrough(
  guide: GuideEntry,
  aliases: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  const links = guideLinks(guide);
  if (!aliases || Object.keys(aliases).length === 0) return links;
  const out: string[] = [];
  const seen = new Set<string>([guide.id]);
  for (const link of links) {
    const id = aliasedId(aliases, link);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The pages the source files a guide under (its `filedUnder`), through `aliases`. */
export function filedUnderThrough(
  guide: GuideEntry,
  aliases: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  const under = guide.filedUnder ?? [];
  if (under.length === 0 || !aliases || Object.keys(aliases).length === 0) return under;
  return under.map((id) => aliasedId(aliases, id));
}

/**
 * What a guide lists (see `pageFiling.ts`), through `aliases`, and whether
 * it is a list page. With `onlyListPage`, the listing of a page that is no
 * list page may be left out (it files nothing, see `pageTree.ts`).
 */
export function listingThrough(
  guide: GuideEntry,
  aliases: Readonly<Record<string, string>> | undefined,
  onlyListPage = false,
): PageListing {
  const filing = guideFiling(guide, onlyListPage);
  const listPage = isListPage(filing);
  const { headings, listedUnder } = filing;
  if (!aliases || Object.keys(aliases).length === 0) {
    return {
      listing: filing.listing,
      listPage,
      ...(headings && listedUnder ? { headings, listedUnder } : {}),
    };
  }
  const listing: string[] = [];
  const under: number[] = [];
  const seen = new Set<string>([guide.id]);
  filing.listing.forEach((link, i) => {
    const id = aliasedId(aliases, link);
    if (!seen.has(id)) {
      seen.add(id);
      listing.push(id);
      under.push(listedUnder?.[i] ?? -1);
    }
  });
  if (!headings || !listedUnder) return { listing, listPage };
  return {
    listing,
    listPage,
    headings: headings.map((heading) =>
      heading.guide === null ? heading : { ...heading, guide: aliasedId(aliases, heading.guide) },
    ),
    listedUnder: under,
  };
}

/**
 * What a guide lists, with the person's say on it (see
 * {@link GuidePages.listPages}): `true` makes it a list page whatever share
 * of its links it lists, `false` makes it list nothing; with no say, as
 * {@link listingThrough} finds.
 */
export function listingWithSay(
  guide: GuideEntry,
  aliases: Readonly<Record<string, string>> | undefined,
  onlyListPage: boolean,
  say: boolean | undefined,
): PageListing {
  if (say === false) return { listing: [], listPage: false };
  if (say === true) return { ...listingThrough(guide, aliases, false), listPage: true };
  return listingThrough(guide, aliases, onlyListPage);
}

/**
 * The pack's unheaded sections (a section's `unheaded`), and a list of the
 * contents with each of them replaced by what it holds, in its place,
 * however deep (an unheaded section in an unheaded section too). A section
 * placed by links is never unheaded: it keeps its heading. A list that
 * names one twice spreads it once, where it is first.
 */
export function spreaderOf(sections: readonly Section[]): {
  unheaded: ReadonlySet<string>;
  items: (items: readonly string[]) => string[];
} {
  const held = new Map<string, readonly string[]>();
  for (const section of sections) {
    if (section.unheaded === true && section.placeByLinks !== true && !held.has(section.id)) {
      held.set(section.id, section.items);
    }
  }
  const unheaded: ReadonlySet<string> = new Set(held.keys());
  const items = (list: readonly string[]): string[] => {
    if (unheaded.size === 0 || !list.some((id) => unheaded.has(id))) return [...list];
    const out: string[] = [];
    const spreadOnce = new Set<string>();
    // Walked without recursion: a contents may be deep.
    const stack: { list: readonly string[]; at: number }[] = [{ list, at: 0 }];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.at >= frame.list.length) {
        stack.pop();
        continue;
      }
      const id = frame.list[frame.at++]!;
      if (!unheaded.has(id)) out.push(id);
      else if (!spreadOnce.has(id)) {
        spreadOnce.add(id);
        stack.push({ list: held.get(id)!, at: 0 });
      }
    }
    return out;
  };
  return { unheaded, items };
}

/**
 * The contents as shown: sections that hold sections and pages, and pages
 * that hold pages. A page of a section marked `placeByLinks` is shown
 * under the list page that lists it (see `pageTree.ts`); every entry has one
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
  /** Of those, the pages under a page the source files them under. */
  private filed: ReadonlySet<string> = new Set();
  /** By page id, the pages of the contents that link to it, in contents order; when first asked. */
  private linkedTo: Map<string, string[]> | null = null;
  private readonly aliases: Readonly<Record<string, string>> | undefined;
  /** The person's say on list pages (see {@link GuidePages.listPages}). */
  private readonly listPages: Readonly<Record<string, boolean>> | undefined;
  /** The home page, when the guides have it and there is a contents to branch from it. */
  private readonly homeGuide: GuideEntry | null;
  /** The headings of list pages shown as levels, by id (see `headingSteps.ts`). */
  private readonly headings = new Map<string, ContentsHeading>();

  constructor(pack: GuidePages) {
    const sections = pack.data.sections ?? [];
    const guides = sortGuides(pack.data.guides);
    this.aliases = pack.aliases;
    this.listPages = pack.listPages;
    this.sections = new Map(sections.map((s) => [s.id, s]));
    this.guides = new Map(guides.map((g) => [g.id, g]));
    const top = pack.top;
    this.hasContents = top !== undefined || sections.length > 0;
    const hasMap = pack.data.maps.length > 0;
    this.browsable =
      top !== undefined
        ? top.some((id) => this.sections.has(id) || this.guides.has(id))
        : this.hasContents || (!hasMap && guides.length > 0);

    // What the pack and the person list: sections, and pages under pages. An
    // unheaded section is no entry of its own: what it holds stands in its place.
    const spread = spreaderOf(sections);
    const lists = new Map<string, readonly string[]>();
    const listedBy = new Set<string>();
    for (const section of sections) {
      if (lists.has(section.id) || spread.unheaded.has(section.id)) continue;
      const items = spread.items(section.items);
      lists.set(section.id, items);
      for (const item of items) if (this.guides.has(item)) this.listed.add(item);
    }
    for (const section of sections) {
      for (const item of section.items) if (this.sections.has(item)) listedBy.add(item);
    }
    for (const [id, items] of Object.entries(pack.under ?? {})) {
      if (!this.guides.has(id)) continue;
      lists.set(id, items);
      for (const item of items) if (this.guides.has(item)) this.listed.add(item);
    }
    let topIds: string[];
    if (top !== undefined) {
      topIds = spread
        .items(top)
        .filter((id) => (this.sections.has(id) && !spread.unheaded.has(id)) || this.guides.has(id));
    } else {
      topIds = spread.items(sections.filter((s) => !listedBy.has(s.id)).map((s) => s.id));
    }
    for (const id of topIds) if (this.guides.has(id)) this.listed.add(id);

    this.baseTop = topIds;
    this.baseLists = lists;
    this.byLinkSections = new Set(sections.filter((s) => s.placeByLinks === true).map((s) => s.id));
    this.loose = this.browsable && !this.hasContents ? guides : [];
    const home = pack.homePage ? this.guides.get(pack.homePage) : undefined;
    this.homeGuide = home && this.browsable ? home : null;
    if (this.homeGuide && this.hasContents) this.listed.add(this.homeGuide.id);
  }

  /**
   * The home page, shown on its own as the page the guides open on; null
   * when the guides have none (a landing page is then made from the top of
   * the contents, see `landing.ts`).
   */
  homePage(): GuideEntry | null {
    return this.homeGuide;
  }

  /** Whether a guide is the home page. */
  isHomePage(guideId: string): boolean {
    return this.homeGuide !== null && aliasedId(this.aliases, guideId) === this.homeGuide.id;
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
      linksOf: (id) => linksThrough(this.guides.get(id)!, this.aliases),
      // The home page files what it lists, list page or not.
      filingOf: (id) =>
        listingWithSay(
          this.guides.get(id)!,
          this.aliases,
          id !== this.homeGuide?.id,
          this.listPages?.[id],
        ),
      filedUnderOf: (id) => filedUnderThrough(this.guides.get(id)!, this.aliases),
      leads: shown,
      movable: shown,
      root: this.homeGuide?.id ?? null,
    });
    this.tree = tree;
    this.byLinks = tree.placed;
    this.filed = tree.filed;
    for (const id of tree.top) if (this.guides.has(id)) this.listed.add(id);
    this.walk(tree.top, tree.lists);
    if (this.addHeadingSteps(tree.lists, tree.placed, tree.filed)) {
      // Walked again with the levels: the pages under each page stay as counted.
      this.home.clear();
      this.inOrder.length = 0;
      this.pageCounts.clear();
      this.walk(tree.top, tree.lists);
    }
    return tree;
  }

  /**
   * The headings of each list page as levels under it (see
   * `headingSteps.ts`), put in `lists`; whether any was made.
   */
  private addHeadingSteps(
    lists: Map<string, string[]>,
    placed: ReadonlyMap<string, string>,
    filed: ReadonlySet<string>,
  ): boolean {
    let made = false;
    for (const [id, items] of [...lists]) {
      const guide = this.guides.get(id);
      if (!guide || id === this.homeGuide?.id) continue;
      if (!items.some((item) => placed.get(item) === id && !filed.has(item))) continue;
      const { listing, headings, listedUnder } = listingWithSay(
        guide,
        this.aliases,
        true,
        this.listPages?.[id],
      );
      if (!headings || !listedUnder || headings.length === 0) continue;
      const found = headingSteps({
        page: id,
        title: guide.title,
        items,
        grouped: (item) => placed.get(item) === id && !filed.has(item),
        weight: (item) => 1 + (this.home.get(item) === id ? (this.pageCounts.get(item) ?? 0) : 0),
        listing,
        headings,
        listedUnder,
      });
      if (!found) continue;
      made = true;
      lists.set(id, found.items);
      for (const step of found.steps) {
        lists.set(step.id, step.items);
        this.headings.set(step.id, {
          id: step.id,
          title: step.words || guide.title,
          guide,
          section: step.section,
        });
      }
    }
    return made;
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
      if (
        this.home.has(id) ||
        (!this.sections.has(id) && !this.guides.has(id) && !this.headings.has(id))
      ) {
        continue;
      }
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
      return this.looseShown().map((guide) => ({ kind: 'page', guide, pages: 0 }));
    }
    return this.shown()
      .top.filter((id) => !this.isEmptied(id))
      .flatMap((id) => this.entry(id));
  }

  /** The ids at the top of the contents, in order: sections, and pages (see {@link GuidePages}). */
  topEntryIds(): readonly string[] {
    return this.hasContents
      ? this.shown().top.filter((id) => !this.isEmptied(id))
      : this.looseShown().map((guide) => guide.id);
  }

  /**
   * A section of pages placed by their links that is left with none, each
   * shown under a page that leads to it (as every page the home page leads
   * to is): not shown, as it holds nothing to read.
   */
  private isEmptied(id: string): boolean {
    return (
      this.byLinkSections.has(id) &&
      (this.shown().lists.get(id) ?? []).every(
        (item) => !this.sections.has(item) && !this.guides.has(item),
      )
    );
  }

  /** With no contents, the guides listed at the top: every one but the home page. */
  private looseShown(): GuideEntry[] {
    return this.homeGuide ? this.loose.filter((guide) => guide !== this.homeGuide) : this.loose;
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
    return (this.shown().lists.get(id) ?? [])
      .filter((item) => !this.isEmptied(item))
      .flatMap((item) => this.entry(item));
  }

  /** How many entries a section or a page holds (not counting deeper ones). */
  itemCount(id: string): number {
    return this.shown().lists.get(id)?.length ?? 0;
  }

  private entry(id: string): ContentsEntry[] {
    this.shown();
    const pages = this.pageCounts.get(id) ?? 0;
    const section = this.sections.get(id);
    if (section) return [{ kind: 'section', section, pages }];
    const guide = this.guides.get(id);
    if (guide) return [{ kind: 'page', guide, pages }];
    const heading = this.headings.get(id);
    return heading ? [{ kind: 'heading', heading, pages }] : [];
  }

  /**
   * Where an entry is at home: its section, page or heading of a list
   * page; null at the top, undefined when not listed.
   */
  parentOf(id: string): string | null | undefined {
    this.shown();
    return this.home.get(id);
  }

  /** The page or section an entry is under, past the headings of a list page; null at the top. */
  pageParentOf(id: string): string | null | undefined {
    this.shown();
    let at = this.home.get(id);
    for (let hops = 0; at != null && this.headings.has(at) && hops < 64; hops++) {
      at = this.home.get(at);
    }
    return at;
  }

  /** A heading of a list page shown as a level, by its id (see {@link ContentsHeading}). */
  heading(id: string): ContentsHeading | undefined {
    this.shown();
    return this.headings.get(id);
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
      const heading = section ? undefined : this.headings.get(at);
      if (section) path.push({ kind: 'section', section });
      else if (heading) path.push({ kind: 'heading', heading });
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
   * to bottom, but the page it is under and the home page (which the way
   * above every page leads to): "also linked from".
   */
  linkedFrom(guideId: string): GuideEntry[] {
    if (!this.linkedTo) {
      const linkedTo = new Map<string, string[]>();
      for (const page of this.pages()) {
        for (const target of linksThrough(page, this.aliases)) {
          if (!this.listed.has(target)) continue;
          const from = linkedTo.get(target);
          if (from) from.push(page.id);
          else linkedTo.set(target, [page.id]);
        }
      }
      this.linkedTo = linkedTo;
    }
    const home = this.pageParentOf(guideId);
    const homePage = this.homeGuide?.id;
    return (this.linkedTo.get(guideId) ?? [])
      .filter((id) => id !== home && id !== homePage)
      .map((id) => this.guides.get(id)!);
  }

  /** How the pages of the contents are filed (see {@link ContentsFiling}). */
  filing(): ContentsFiling {
    const counts: ContentsFiling = {
      pages: 0,
      underListPage: 0,
      underFiledPage: 0,
      inSection: 0,
      inPagesSection: 0,
      byHand: 0,
    };
    if (!this.hasContents) return counts;
    this.shown();
    for (const id of this.inOrder) {
      if (!this.guides.has(id) || id === this.homeGuide?.id) continue;
      counts.pages += 1;
      const parent = this.pageParentOf(id) ?? null;
      if (this.filed.has(id)) counts.underFiledPage += 1;
      else if (this.byLinks.has(id)) counts.underListPage += 1;
      else if (parent !== null && this.guides.has(parent)) counts.byHand += 1;
      else if (parent !== null && this.byLinkSections.has(parent)) counts.inPagesSection += 1;
      else counts.inSection += 1;
    }
    return counts;
  }

  /** Every page that can be browsed, in contents order (the home page first), each once. */
  pages(): GuideEntry[] {
    if (!this.hasContents) {
      return this.homeGuide ? [this.homeGuide, ...this.looseShown()] : [...this.loose];
    }
    this.shown();
    const out: GuideEntry[] = this.homeGuide ? [this.homeGuide] : [];
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
  /** Its home page (its pack's `homePage`), listed first under its title. */
  homePage?: string | null;
}

/** The local id of the section that holds another game's pages. */
export const OTHER_GAME_SECTION = 'atlas.from-game';

/**
 * A game's guides together with those of other games (a wiki read as a
 * game of its own), as {@link GuideContents} takes them: each other game's
 * contents under a section of its own, named after that game, after the
 * game's own, its home page first. Ids keep their own game, so nothing is
 * renamed; no pack is changed.
 */
export function guidesTogether(pack: GuidePages, others: readonly GuidesOfGame[]): GuidePages {
  if (others.length === 0) return pack;
  const pageTop = pack.top ? [...pack.top] : undefined;
  const guides = [...pack.data.guides];
  const sections: Section[] = [...(pack.data.sections ?? [])];
  for (const other of others) {
    const own = other.data.sections ?? [];
    const listed = new Set(own.flatMap((section) => section.items));
    const home =
      other.homePage && other.data.guides.some((guide) => guide.id === other.homePage)
        ? other.homePage
        : null;
    const top =
      own.length > 0
        ? own.filter((section) => !listed.has(section.id)).map((section) => section.id)
        : sortGuides(other.data.guides)
            .map((guide) => guide.id)
            .filter((id) => id !== home);
    if (home !== null) top.unshift(home);
    if (top.length === 0) continue;
    guides.push(...other.data.guides);
    const id = `${other.gameId}:section:${OTHER_GAME_SECTION}`;
    sections.push({ id, title: other.title, items: top }, ...own);
    pageTop?.push(id);
  }
  return {
    data: { ...pack.data, guides, sections },
    ...(pageTop ? { top: pageTop } : {}),
    ...(pack.under ? { under: pack.under } : {}),
    ...(pack.homePage ? { homePage: pack.homePage } : {}),
    ...(pack.listPages ? { listPages: pack.listPages } : {}),
  };
}
