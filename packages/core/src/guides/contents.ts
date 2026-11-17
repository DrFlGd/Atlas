import type { GuideEntry, Section } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';
import { guideFiling } from './pageFiling';
import { guideLinks } from './pageLinks';

/**
 * A pack's guides as pages to browse: its contents (`sections.json`), the
 * sections that hold sections and guides in the source's own order.
 *
 * With a contents, the pages are the guides it lists; the pack's other
 * guides (walkthroughs of its lists, notes of its locations) stay where
 * they were. A pack with no contents and no map either (a game of guides
 * and lists only) is browsed as one list of all its guides, in order.
 *
 * The menu (the contents Guides shows beside the page) is only what the
 * source itself gives and what the person arranged by hand: the pack's
 * sections, in its order and nesting, and the pages the person put in a
 * section or under a page. The app never files a page under another by
 * reading pages. A section marked `placeByLinks` holds the pages outside
 * the menu (a wiki's pages its own menu does not name): it is not shown,
 * and its pages are reached by the links in pages, by search, from the
 * home page and from "All pages".
 */
export type ContentsEntry =
  | { kind: 'section'; section: Section; /** Pages in it, however deep. */ pages: number }
  | { kind: 'page'; guide: GuideEntry; /** Pages under it, however deep. */ pages: number };

/**
 * Where the pages of the contents are (see {@link GuideContents.filing}):
 * each page of the contents, the home page aside, is counted once.
 */
export interface ContentsFiling {
  /** The pages of the contents. */
  pages: number;
  /** In the menu: in a section of it or at its top, where the pack or the person put them. */
  inMenu: number;
  /** In the menu, under a page the person put them under. */
  byHand: number;
  /** Outside the menu: in a section marked `placeByLinks`, or put by hand under a page there. */
  outsideMenu: number;
}

/** A step of the way from the top of the contents to an entry: a section, or a page. */
export type ContentsStep =
  { kind: 'section'; section: Section } | { kind: 'page'; guide: GuideEntry };

/** The id of an entry or a step of the contents: its section's or its page's. */
export function entryIdOf(entry: ContentsEntry | ContentsStep): string {
  return entry.kind === 'section' ? entry.section.id : entry.guide.id;
}

/** The title of an entry or a step of the contents, as the contents shows it. */
export function entryTitleOf(entry: ContentsEntry | ContentsStep): string {
  return entry.kind === 'section' ? entry.section.title : entry.guide.title;
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
   * own, as the page the guides open on, not in the menu. Not used when the
   * guides have no such page.
   */
  homePage?: string | null;
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
  return throughAliases(guide.id, guideLinks(guide), aliases);
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
 * The pages a guide lists (its listing links, see `pageFiling.ts`), in
 * order, through `aliases`, each once, never itself: what the arrange
 * tool's "File the pages this page lists under it" puts under it.
 */
export function listingThrough(
  guide: GuideEntry,
  aliases: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  return throughAliases(guide.id, guideFiling(guide).listing, aliases);
}

/** Guide ids through `aliases`, each once, never `self`. */
function throughAliases(
  self: string,
  ids: readonly string[],
  aliases: Readonly<Record<string, string>> | undefined,
): readonly string[] {
  if (!aliases || Object.keys(aliases).length === 0) return ids;
  const out: string[] = [];
  const seen = new Set<string>([self]);
  for (const link of ids) {
    const id = aliasedId(aliases, link);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * The pack's unheaded sections (a section's `unheaded`), and a list of the
 * contents with each of them replaced by what it holds, in its place,
 * however deep (an unheaded section in an unheaded section too). A section
 * of pages outside the menu (`placeByLinks`) is never unheaded. A list that
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

/** The most pages the way above a page outside the menu names (see {@link GuideContents.outsideTrail}). */
export const OUTSIDE_TRAIL_STEPS = 6;

/**
 * The contents as shown: the menu (sections that hold sections and pages,
 * and pages that hold the pages put under them by hand), and the pages
 * outside it. Every entry of the menu has one home, its first place in
 * the menu, top to bottom, which the way to it (`trail`) follows. Every
 * page the contents lists is one of its pages (`pages`), in the menu or
 * not, so none is ever lost.
 */
export class GuideContents {
  /** Whether the pack has guides to browse as pages: a contents, or no map but guides. */
  readonly browsable: boolean;
  /** Whether the pack has a contents of its own. */
  readonly hasContents: boolean;
  private readonly sections: ReadonlyMap<string, Section>;
  private readonly guides: ReadonlyMap<string, GuideEntry>;
  /**
   * What each section holds as shown (without the sections of pages outside
   * the menu, and the home page), and by page id the pages put under it by
   * hand.
   */
  private readonly lists = new Map<string, readonly string[]>();
  /** The top of the menu, as shown. */
  private readonly menuTop: readonly string[];
  /** The sections that hold the pages outside the menu (`placeByLinks`). */
  private readonly outsideSections: ReadonlySet<string>;
  /** Each entry of the menu's home: the section or page of its first place, or null at the top. */
  private readonly home = new Map<string, string | null>();
  /** Every entry of the menu at its home, top to bottom. */
  private readonly inOrder: string[] = [];
  /** The pages outside the menu, in the source's order, each followed by those put under it by hand. */
  private readonly outsideOrder: string[] = [];
  /** By page, the page the person first put it under. */
  private readonly handParent = new Map<string, string>();
  /** With no contents, the guides listed at the top, in guide order. */
  private readonly loose: GuideEntry[];
  /** Every guide the contents lists, however deep, in the menu or not. */
  private readonly listed = new Set<string>();
  private readonly pageCounts = new Map<string, number>();
  /** By page id, the pages of the contents that link to it, in contents order; when first asked. */
  private linkedTo: Map<string, string[]> | null = null;
  private readonly aliases: Readonly<Record<string, string>> | undefined;
  /** The home page, when the guides have it. */
  private readonly homeGuide: GuideEntry | null;

  constructor(pack: GuidePages) {
    const sections = pack.data.sections ?? [];
    const guides = sortGuides(pack.data.guides);
    this.aliases = pack.aliases;
    this.sections = new Map(sections.map((s) => [s.id, s]));
    this.guides = new Map(guides.map((g) => [g.id, g]));
    const top = pack.top;
    this.hasContents = top !== undefined || sections.length > 0;
    const hasMap = pack.data.maps.length > 0;
    this.browsable =
      top !== undefined
        ? top.some((id) => this.sections.has(id) || this.guides.has(id))
        : this.hasContents || (!hasMap && guides.length > 0);
    this.loose = this.browsable && !this.hasContents ? guides : [];
    const home = pack.homePage ? this.guides.get(pack.homePage) : undefined;
    this.homeGuide = home && this.browsable ? home : null;
    const homeId = this.homeGuide?.id ?? null;
    this.outsideSections = new Set(
      sections.filter((s) => s.placeByLinks === true).map((s) => s.id),
    );

    // What the pack and the person list: sections, and pages under pages. An
    // unheaded section is no entry of its own: what it holds stands in its place.
    const spread = spreaderOf(sections);
    const given = new Map<string, readonly string[]>();
    const listedBy = new Set<string>();
    for (const section of sections) {
      if (given.has(section.id) || spread.unheaded.has(section.id)) continue;
      const items = spread.items(section.items);
      given.set(section.id, items);
      for (const item of items) if (this.guides.has(item)) this.listed.add(item);
    }
    for (const section of sections) {
      for (const item of section.items) if (this.sections.has(item)) listedBy.add(item);
    }
    for (const [id, items] of Object.entries(pack.under ?? {})) {
      if (!this.guides.has(id)) continue;
      given.set(id, items);
      for (const item of items) {
        if (!this.guides.has(item) || item === id) continue;
        this.listed.add(item);
        if (!this.handParent.has(item)) this.handParent.set(item, id);
      }
    }
    const topIds =
      top !== undefined
        ? spread
            .items(top)
            .filter(
              (id) => (this.sections.has(id) && !spread.unheaded.has(id)) || this.guides.has(id),
            )
        : spread.items(sections.filter((s) => !listedBy.has(s.id)).map((s) => s.id));
    for (const id of topIds) if (this.guides.has(id)) this.listed.add(id);
    if (this.homeGuide && this.hasContents) this.listed.add(this.homeGuide.id);

    // As shown: the home page on its own, and no section of pages outside the menu.
    const shown = (items: readonly string[]) =>
      items.filter((id) => id !== homeId && !this.outsideSections.has(id));
    for (const [id, items] of given) this.lists.set(id, shown(items));
    this.menuTop = this.hasContents ? shown(topIds) : [];
    if (!this.hasContents) return;

    const menuCounts = this.walk(this.menuTop, this.home, this.inOrder);
    // The pages outside the menu: those of the sections that hold them, in
    // their order, then any other page no shown page holds (put by hand
    // under a page that is hidden or gone), each with the pages put under it.
    const outside = new Map<string, string | null>();
    const held = (id: string) => {
      const parent = this.handParent.get(id);
      return parent !== undefined && parent !== homeId && this.listed.has(parent);
    };
    const free = (id: string) =>
      this.guides.has(id) && id !== homeId && !this.home.has(id) && !outside.has(id);
    const first: string[] = [];
    for (const section of sections) {
      if (!this.outsideSections.has(section.id)) continue;
      for (const id of given.get(section.id) ?? []) if (free(id) && !held(id)) first.push(id);
    }
    for (const id of this.listed) if (free(id) && !held(id)) first.push(id);
    const outsideCounts = this.walk(first, outside, this.outsideOrder);
    // Pages put under each other by hand in a circle, and nothing else: still shown.
    const left = [...this.listed].filter(free);
    const leftCounts = this.walk(left, outside, this.outsideOrder);
    for (const counts of [menuCounts, outsideCounts, leftCounts]) {
      for (const [id, count] of counts) this.pageCounts.set(id, count);
    }
  }

  /**
   * Walks entries from `top` through what each holds, giving each its home
   * (in `homes`) and its place (in `order`), top to bottom; an entry with a
   * home already, in the menu or here, is passed. Returns how many pages
   * each entry walked holds, theirs counted where they are at home.
   */
  private walk(
    top: readonly string[],
    homes: Map<string, string | null>,
    order: string[],
  ): Map<string, number> {
    const from = order.length;
    // Walked without recursion: a contents may be thousands deep.
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
      if (this.home.has(id) || homes.has(id) || (!this.sections.has(id) && !this.guides.has(id))) {
        continue;
      }
      homes.set(id, frame.parent);
      order.push(id);
      const items = this.lists.get(id);
      if (items && items.length > 0) stack.push({ parent: id, items, at: 0 });
    }
    // From the bottom up: an entry counts the pages it holds, and theirs where they are at home.
    const counts = new Map<string, number>();
    for (let i = order.length - 1; i >= from; i--) {
      const id = order[i]!;
      let count = 0;
      for (const item of this.lists.get(id) ?? []) {
        if (this.guides.has(item)) count += 1;
        if (homes.get(item) === id) count += counts.get(item) ?? 0;
      }
      counts.set(id, count);
    }
    return counts;
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

  /** What the top of the menu lists: its sections and pages (or, with no contents, every page). */
  top(): ContentsEntry[] {
    if (!this.hasContents) {
      return this.looseShown().map((guide) => ({ kind: 'page', guide, pages: 0 }));
    }
    return this.menuTop.flatMap((id) => this.entry(id));
  }

  /** The ids at the top of the menu, in order: sections, and pages (see {@link GuidePages}). */
  topEntryIds(): readonly string[] {
    return this.hasContents ? this.menuTop : this.looseShown().map((guide) => guide.id);
  }

  /** With no contents, the guides listed at the top: every one but the home page. */
  private looseShown(): GuideEntry[] {
    return this.homeGuide ? this.loose.filter((guide) => guide !== this.homeGuide) : this.loose;
  }

  /** Whether a guide is one of the pages browsed here, in the menu or not. */
  isPage(guideId: string): boolean {
    return this.hasContents ? this.listed.has(guideId) : this.loose.some((g) => g.id === guideId);
  }

  /** Whether an entry (a section or a page) is in the menu; the home page is on its own, not in it. */
  isInMenu(id: string): boolean {
    if (!this.hasContents) return this.looseShown().some((guide) => guide.id === id);
    return this.home.has(id);
  }

  /** Whether the pack has a section of pages outside the menu (`placeByLinks`). */
  hasPagesOutsideMenu(): boolean {
    return this.outsideOrder.length > 0;
  }

  section(id: string): Section | undefined {
    return this.sections.get(id);
  }

  guide(id: string): GuideEntry | undefined {
    return this.guides.get(id);
  }

  /**
   * What a section or a page holds, in order: a section's sections and
   * pages, a page's pages put under it by hand (also for a page outside the
   * menu, which lists them at its foot). Items the pack lacks are left out.
   */
  items(id: string): ContentsEntry[] {
    return (this.lists.get(id) ?? []).flatMap((item) => this.entry(item));
  }

  /**
   * A section's own page, which leads it: the first entry the section shows
   * (see {@link items}), when that is a page whose title has the same words
   * as the section's (spaces and case aside). A source's menu has entries
   * that are pages with pages under them; the pack writes each as a section
   * of that title whose first item is the page, and the menu shows the
   * section as that page. Null for any other section, for a section of
   * pages outside the menu (`placeByLinks`), for the section that holds
   * another game's pages (its first page is that game's home page), and for
   * an id that is no section here.
   */
  leadPage(sectionId: string): GuideEntry | null {
    const section = this.sections.get(sectionId);
    if (!this.hasContents || !section || this.outsideSections.has(sectionId)) return null;
    if (sectionId.endsWith(`:section:${OTHER_GAME_SECTION}`)) return null;
    const first = this.lists.get(sectionId)?.find((id) => this.entry(id).length > 0);
    const guide = first === undefined ? undefined : this.guides.get(first);
    return guide && sameWords(guide.title, section.title) ? guide : null;
  }

  /**
   * What the menu shows under an entry: what it holds (see {@link items});
   * under a section led by its own page (see {@link leadPage}), which the
   * menu shows as that page, the pages put under the page by hand, then
   * the section's other entries.
   */
  menuItems(id: string): ContentsEntry[] {
    const items = this.items(id);
    const lead = this.leadPage(id);
    return lead ? [...this.items(lead.id), ...items.slice(1)] : items;
  }

  /** How many entries a section or a page holds (not counting deeper ones). */
  itemCount(id: string): number {
    return this.lists.get(id)?.length ?? 0;
  }

  private entry(id: string): ContentsEntry[] {
    const pages = this.pageCounts.get(id) ?? 0;
    const section = this.sections.get(id);
    if (section) return [{ kind: 'section', section, pages }];
    const guide = this.guides.get(id);
    return guide ? [{ kind: 'page', guide, pages }] : [];
  }

  /**
   * Where an entry of the menu is at home: its section or page; null at the
   * top, undefined when it is not in the menu.
   */
  parentOf(id: string): string | null | undefined {
    return this.home.get(id);
  }

  /**
   * The way from the top of the menu down to an entry (a guide or a
   * section): the sections and pages it is under, outermost first. None
   * for an entry outside the menu (see {@link outsideTrail}).
   */
  trail(id: string): ContentsStep[] {
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

  /**
   * The pages above a page outside the menu, for the line above it,
   * outermost first: the page the person put it under by hand, else the
   * first page of its `filedUnder` that is a page here (through other names
   * of pages), the source's own filing; then that page's, and so on up,
   * never the same page twice, at most {@link OUTSIDE_TRAIL_STEPS}. It
   * stops at the home page, which the line starts with. None for a page
   * the source files under nothing, and for a page in the menu (see
   * {@link trail}). Only the line above a page reads it: the menu never
   * shows it.
   */
  outsideTrail(guideId: string): ContentsStep[] {
    if (this.home.has(guideId) || !this.guides.has(guideId)) return [];
    const path: ContentsStep[] = [];
    const seen = new Set<string>([guideId]);
    let at = guideId;
    while (path.length < OUTSIDE_TRAIL_STEPS) {
      const up = this.handParent.get(at) ?? this.filedParent(at);
      if (up === undefined || seen.has(up) || this.isHomePage(up)) break;
      seen.add(up);
      path.push({ kind: 'page', guide: this.guides.get(up)! });
      at = up;
    }
    return path.reverse();
  }

  /** The first page of a page's `filedUnder` that is a page here, through other names of pages. */
  private filedParent(guideId: string): string | undefined {
    const guide = this.guides.get(guideId);
    if (!guide?.filedUnder) return undefined;
    return filedUnderThrough(guide, this.aliases).find(
      (id) => id !== guideId && this.guides.has(id) && this.isPage(id),
    );
  }

  /**
   * The pages of the contents that link to a page, in contents order, the
   * home page aside (the line above every page leads to it): "Linked from".
   * The links of every page are read the first time it is asked.
   */
  linkedFrom(guideId: string): GuideEntry[] {
    if (!this.linkedTo) {
      const linkedTo = new Map<string, string[]>();
      for (const page of this.pages()) {
        if (page === this.homeGuide) continue;
        for (const target of linksThrough(page, this.aliases)) {
          if (!this.isPage(target)) continue;
          const from = linkedTo.get(target);
          if (from) from.push(page.id);
          else linkedTo.set(target, [page.id]);
        }
      }
      this.linkedTo = linkedTo;
    }
    return (this.linkedTo.get(aliasedId(this.aliases, guideId)) ?? []).map((id) =>
      this.guides.get(id)!,
    );
  }

  /** Where the pages of the contents are (see {@link ContentsFiling}). */
  filing(): ContentsFiling {
    const counts: ContentsFiling = { pages: 0, inMenu: 0, byHand: 0, outsideMenu: 0 };
    if (!this.hasContents) return counts;
    for (const id of this.inOrder) {
      if (!this.guides.has(id)) continue;
      counts.pages += 1;
      const parent = this.home.get(id) ?? null;
      if (parent !== null && this.guides.has(parent)) counts.byHand += 1;
      else counts.inMenu += 1;
    }
    for (const id of this.outsideOrder) {
      if (!this.guides.has(id)) continue;
      counts.pages += 1;
      counts.outsideMenu += 1;
    }
    return counts;
  }

  /**
   * Every page that can be browsed, each once: the home page first, then
   * the menu top to bottom, then the pages outside it in the source's
   * order.
   */
  pages(): GuideEntry[] {
    if (!this.hasContents) {
      return this.homeGuide ? [this.homeGuide, ...this.looseShown()] : [...this.loose];
    }
    const out: GuideEntry[] = this.homeGuide ? [this.homeGuide] : [];
    for (const id of [...this.inOrder, ...this.outsideOrder]) {
      const guide = this.guides.get(id);
      if (guide) out.push(guide);
    }
    return out;
  }
}

/** Whether two titles have the same words: spaces at the ends, runs of spaces and case aside. */
function sameWords(a: string, b: string): boolean {
  const words = (title: string) => title.trim().replace(/\s+/gu, ' ').toLowerCase();
  return words(a) === words(b);
}

/**
 * A way down the menu (see {@link GuideContents.trail}) as the menu shows
 * it, to the entry `id`: a section led by its own page (see
 * {@link GuideContents.leadPage}) is that page in the menu, so it is left
 * out where the way goes on to that page, or ends at it. A way to a page
 * that leads its section is the way to the section; a way to a page put
 * under it by hand names the page once.
 */
export function withoutLedSteps(
  contents: GuideContents,
  steps: readonly ContentsStep[],
  id: string,
): ContentsStep[] {
  return steps.filter((step, at) => {
    if (step.kind !== 'section') return true;
    const lead = contents.leadPage(step.section.id);
    if (!lead) return true;
    const next = steps[at + 1];
    const to = next ? (next.kind === 'page' ? next.guide.id : null) : id;
    return to !== lead.id;
  });
}

/**
 * A way down the menu as its rows, top down: the ids of a way's steps
 * (see {@link GuideContents.trail}), then `id`. A page that leads the
 * section before it is left out, as the menu shows the section as the
 * page: the way to that page ends at its section, and the way to a page
 * put under it by hand goes from the section to that page.
 */
export function menuWayOf(
  contents: GuideContents,
  steps: readonly ContentsStep[],
  id: string,
): string[] {
  const ids = [...steps.map(entryIdOf), id];
  return ids.filter((entry, at) => at === 0 || contents.leadPage(ids[at - 1]!)?.id !== entry);
}

/**
 * Whether a way down the menu, as its rows (see {@link menuWayOf}), is one
 * the menu shows and leads to the entry `id`: its first entry is one of
 * `top`, each other is shown under the one before it (see
 * {@link GuideContents.menuItems}), and it ends at `id` or at a section
 * `id` leads. A way remembered when a row was pressed is checked before it
 * is followed, since the contents may have changed since (the person
 * arranged them, the pack was read again).
 */
export function isMenuWayTo(
  contents: GuideContents,
  top: readonly string[],
  way: readonly string[],
  id: string,
): boolean {
  const last = way.at(-1);
  if (last === undefined || !top.includes(way[0]!)) return false;
  if (last !== id && contents.leadPage(last)?.id !== id) return false;
  for (let at = 1; at < way.length; at++) {
    const next = way[at];
    if (!contents.menuItems(way[at - 1]!).some((entry) => entryIdOf(entry) === next)) {
      return false;
    }
  }
  return true;
}

/** The steps of a way down the menu (see {@link menuWayOf}): its sections and pages, in order. */
export function stepsOfWay(contents: GuideContents, way: readonly string[]): ContentsStep[] {
  return way.flatMap((id): ContentsStep[] => {
    const section = contents.section(id);
    if (section) return [{ kind: 'section', section }];
    const guide = contents.guide(id);
    return guide ? [{ kind: 'page', guide }] : [];
  });
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
  };
}
