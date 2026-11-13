import type { GuideEntry, Section } from '@atlas/schema';
import type { LoadedPack } from '../pack/loadedPack';

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
  | { kind: 'page'; guide: GuideEntry };

/**
 * Guides to browse as pages: a pack's data, or a pack's pages with a
 * person's own laid over them (see `applyOwnPages`). With `top`, the top of
 * the contents is that list, of sections and pages, and the pages are those
 * it and its sections hold, however deep; without it, the top is every
 * section no other section lists, as a pack's contents says.
 */
export interface GuidePages {
  data: Pick<LoadedPack['data'], 'guides' | 'sections' | 'maps'>;
  top?: readonly string[];
}

export class GuideContents {
  /** Whether the pack has guides to browse as pages: a contents, or no map but guides. */
  readonly browsable: boolean;
  /** Whether the pack has a contents of its own. */
  readonly hasContents: boolean;
  private readonly sections: ReadonlyMap<string, Section>;
  private readonly guides: ReadonlyMap<string, GuideEntry>;
  private readonly parent = new Map<string, string>();
  private readonly topIds: string[];
  /** With no contents, the guides listed at the top, in guide order. */
  private readonly loose: GuideEntry[];
  /** Every guide the contents lists, however deep. */
  private readonly listed = new Set<string>();
  private readonly pageCounts = new Map<string, number>();

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

    for (const section of sections) {
      for (const item of section.items) {
        if (this.sections.has(item)) {
          if (!this.parent.has(item)) this.parent.set(item, section.id);
        } else if (this.guides.has(item)) this.listed.add(item);
      }
    }
    if (top !== undefined) {
      this.topIds = top.filter((id) => this.sections.has(id) || this.guides.has(id));
      for (const id of this.topIds) {
        if (this.guides.has(id)) this.listed.add(id);
        // A section at the top is listed by none.
        else this.parent.delete(id);
      }
    } else {
      this.topIds = sections.filter((s) => !this.parent.has(s.id)).map((s) => s.id);
    }
    this.loose = this.browsable && !this.hasContents ? guides : [];
    // Only sections listed from the top count; a pack checked for integrity has no loops.
    for (const id of this.topIds) if (this.sections.has(id)) this.countPages(id, new Set());
  }

  private countPages(id: string, seen: Set<string>): Set<string> {
    const pages = new Set<string>();
    const section = this.sections.get(id);
    if (!section || seen.has(id)) return pages;
    seen.add(id);
    for (const item of section.items) {
      if (this.sections.has(item)) for (const page of this.countPages(item, seen)) pages.add(page);
      else if (this.guides.has(item)) pages.add(item);
    }
    this.pageCounts.set(id, pages.size);
    return pages;
  }

  /** What the top of the contents lists: its sections (or, with no contents, every page). */
  top(): ContentsEntry[] {
    if (!this.hasContents) return this.loose.map((guide) => ({ kind: 'page', guide }));
    return this.topIds.flatMap((id) => this.entry(id));
  }

  /** The ids at the top of the contents, in order: sections, and pages (see {@link GuidePages}). */
  topEntryIds(): readonly string[] {
    return this.hasContents ? this.topIds : this.loose.map((guide) => guide.id);
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

  /** The guides and sections in a section, in order; items the pack lacks are left out. */
  items(sectionId: string): ContentsEntry[] {
    return (this.sections.get(sectionId)?.items ?? []).flatMap((id) => this.entry(id));
  }

  private entry(id: string): ContentsEntry[] {
    const section = this.sections.get(id);
    if (section) return [{ kind: 'section', section, pages: this.pageCounts.get(id) ?? 0 }];
    const guide = this.guides.get(id);
    return guide ? [{ kind: 'page', guide }] : [];
  }

  /** The sections from the top down to the one holding `id` (a guide or a section), outermost first. */
  pathTo(id: string): Section[] {
    let at: string | undefined = this.sections.has(id) ? this.parent.get(id) : this.holderOf(id);
    const path: Section[] = [];
    const seen = new Set<string>();
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const section = this.sections.get(at);
      if (!section) break;
      path.unshift(section);
      at = this.parent.get(at);
    }
    return path;
  }

  /** The first section, in contents order, that lists a guide. */
  private holderOf(guideId: string): string | undefined {
    const visit = (id: string, seen: Set<string>): string | undefined => {
      const section = this.sections.get(id);
      if (!section || seen.has(id)) return undefined;
      seen.add(id);
      for (const item of section.items) {
        if (item === guideId) return id;
        const inner = this.sections.has(item) ? visit(item, seen) : undefined;
        if (inner) return inner;
      }
      return undefined;
    };
    const seen = new Set<string>();
    for (const id of this.topIds) {
      const found = visit(id, seen);
      if (found) return found;
    }
    return undefined;
  }

  /** Every page that can be browsed, in contents order, each once. */
  pages(): GuideEntry[] {
    const out: GuideEntry[] = [];
    const seen = new Set<string>();
    const add = (guide: GuideEntry) => {
      if (!seen.has(guide.id)) {
        seen.add(guide.id);
        out.push(guide);
      }
    };
    const visit = (id: string, sections: Set<string>) => {
      if (sections.has(id)) return;
      sections.add(id);
      for (const entry of this.items(id)) {
        if (entry.kind === 'page') add(entry.guide);
        else visit(entry.section.id, sections);
      }
    };
    const sections = new Set<string>();
    for (const id of this.topIds) {
      const guide = this.sections.has(id) ? undefined : this.guides.get(id);
      if (guide) add(guide);
      else visit(id, sections);
    }
    this.loose.forEach(add);
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
