import {
  isOwnId,
  MAX_PAGE_TITLE_LENGTH,
  parseId,
  type GuideEntry,
  type OwnPage,
  type OwnPages,
  type OwnSection,
  type PagesLayout,
  type Section,
  type WikiChangeChoice,
} from '@atlas/schema';
import { aliasedId, linksThrough, sortGuides, type GuidePages } from './contents';
import { guideLinksIn, placePagesByLinks } from './pageTree';

/**
 * A person's own pages laid over a pack's (see `ownPages.ts` in the schema
 * package): the pages as they changed them, their own pages and sections,
 * the contents as they arranged it, without the pages they hid. Every
 * function here is pure: it returns new records and leaves the ones it was
 * given as they were, so a change can be undone by keeping the ones from
 * before.
 *
 * The contents is handled as a layout: what is at the top (sections, and
 * pages), and what each section holds, by id, in order. The pack's layout
 * is its contents; once the person moves, adds or removes anything, their
 * whole layout is kept. Laid over a pack read again later, their layout
 * wins; a page or section the pack has that their layout does not name
 * (one the wiki added since) goes where the pack puts it, after the entry
 * the pack has before it; and a page or section of their own their layout
 * does not name goes at the end of the top, so nothing of theirs is ever
 * out of sight.
 *
 * A layout also holds, by a page's id, the pages put under that page by
 * hand. The pages a pack leaves to be placed by their links (a section
 * marked `placeByLinks`, see `pageTree.ts`) are placed when the contents
 * is shown, never written into a layout: a page the person's layout still
 * has in such a section is placed by its links like any other, and one the
 * pack has since placed elsewhere goes there. Only where the person put a
 * page by hand stays theirs.
 */

/** Where an entry of the contents is: in a section, or at the top (`null`). */
export type ContentsParent = string | null;

/** The pack's layout: its contents as a pack gives it. */
export function packLayout(data: GuidePages['data']): PagesLayout {
  const sections = data.sections ?? [];
  if (sections.length === 0) {
    // With no contents, a game with no map lists every guide, in order.
    return {
      top: data.maps.length === 0 ? sortGuides(data.guides).map((guide) => guide.id) : [],
      sections: {},
    };
  }
  const listed = new Set(sections.flatMap((section) => section.items));
  const layout: PagesLayout = {
    top: sections.filter((section) => !listed.has(section.id)).map((section) => section.id),
    sections: {},
  };
  for (const section of sections) {
    // A section listed twice in a file keeps its first entry, as the contents shows it.
    layout.sections[section.id] ??= [...section.items];
  }
  return layout;
}

/** A record without one key. */
const withoutKey = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

/** A copy of a layout, to change. */
function copyLayout(layout: PagesLayout): PagesLayout {
  return {
    top: [...layout.top],
    sections: Object.fromEntries(
      Object.entries(layout.sections).map(([id, items]) => [id, [...items]]),
    ),
  };
}

const listOf = (layout: PagesLayout, parent: ContentsParent): string[] | undefined =>
  parent === null ? layout.top : layout.sections[parent];

/**
 * The person's layout laid over the pack's (see the top of this file).
 * `exists` says whether a page or section is there to show; `own` are the
 * ids of the person's own pages and sections.
 */
export function mergeLayouts(
  pack: PagesLayout,
  mine: PagesLayout | undefined,
  exists: (id: string) => boolean,
  own: readonly string[],
  /** The pack's sections whose pages are placed by their links. */
  loose: ReadonlySet<string> = new Set(),
): PagesLayout {
  const result: PagesLayout = { top: [], sections: {} };
  const sectionIds = new Set([...Object.keys(mine?.sections ?? {}), ...Object.keys(pack.sections)]);
  // What the pack places itself, outside the sections it leaves to links.
  const packPlaced = new Set<string>(pack.top);
  for (const [id, items] of Object.entries(pack.sections)) {
    if (!loose.has(id)) for (const item of items) packPlaced.add(item);
  }
  for (const id of sectionIds) {
    if (!exists(id)) continue;
    let items = mine?.sections[id] ?? pack.sections[id] ?? [];
    // A page the person left among those placed by links goes where the pack places it now.
    if (loose.has(id) && mine?.sections[id]) items = items.filter((item) => !packPlaced.has(item));
    result.sections[id] = items.filter(exists);
  }
  result.top = (mine ? mine.top : pack.top).filter(exists);
  const mentioned = new Set([...result.top, ...Object.values(result.sections).flat()]);

  if (mine) {
    // What the pack has that the person's layout does not name: where the pack puts it.
    const place = (parent: ContentsParent, items: readonly string[]) => {
      items.forEach((id, i) => {
        if (mentioned.has(id) || !exists(id)) return;
        const target = (parent === null ? result.top : result.sections[parent]) ?? result.top;
        let at = 0;
        for (let k = i - 1; k >= 0; k--) {
          const before = target.indexOf(items[k]!);
          if (before >= 0) {
            at = before + 1;
            break;
          }
        }
        target.splice(at, 0, id);
        mentioned.add(id);
      });
    };
    place(null, pack.top);
    for (const [id, items] of Object.entries(pack.sections)) place(id, items);
  }

  // The person's own, and sections no one lists any more: at the end of the top.
  for (const id of own) {
    if (!mentioned.has(id) && exists(id)) {
      result.top.push(id);
      mentioned.add(id);
    }
  }
  for (const id of Object.keys(result.sections)) {
    if (!mentioned.has(id) && (mine !== undefined || isOwnId(id))) {
      result.top.push(id);
      mentioned.add(id);
    }
  }
  return result;
}

/** The text a pack's page shows with the person's change: theirs, unless they chose the wiki's. */
export function shownBody(pack: GuideEntry, page: OwnPage | undefined): string {
  if (page?.body === undefined) return pack.body;
  return wikiChangedSince(pack, page) && page.whenWikiChanges === 'take' ? pack.body : page.body;
}

/** Whether the wiki's text of a page changed since the person changed it. */
export function wikiChangedSince(pack: GuideEntry, page: OwnPage | undefined): boolean {
  return page?.body !== undefined && page.basedOn !== undefined && page.basedOn !== pack.body;
}

/** What the person did to one page, for what the app says about it. */
export interface PageChange {
  /** The person's own page. */
  own: boolean;
  /** A pack's page whose title or text the person changed. */
  changed: boolean;
  /** Its text was changed, and the wiki's text changed since. */
  wikiChanged: boolean;
  /** The wiki's new text is shown, as the person chose (`take`). */
  showsWiki: boolean;
  hidden: boolean;
  whenWikiChanges: WikiChangeChoice;
}

export function pageChange(pack: GuideEntry | undefined, page: OwnPage | undefined): PageChange {
  const own = page !== undefined && isOwnId(page.id);
  const wikiChanged = pack !== undefined && wikiChangedSince(pack, page);
  const whenWikiChanges = page?.whenWikiChanges ?? 'keep';
  return {
    own,
    changed: !own && page !== undefined && (page.body !== undefined || page.title !== undefined),
    wikiChanged,
    showsWiki: wikiChanged && whenWikiChanges === 'take',
    hidden: page?.hidden === true,
    whenWikiChanges,
  };
}

/** The ids of the person's own pages and sections. */
function ownIdsOf(own: OwnPages): string[] {
  return [
    ...own.pages.filter((page) => isOwnId(page.id)).map((page) => page.id),
    ...own.sections.filter((section) => isOwnId(section.id)).map((section) => section.id),
  ];
}

/** The pack's sections and pages there are, with the person's own. */
function existing(data: GuidePages['data'], own: OwnPages): (id: string) => boolean {
  const ids = new Set([
    ...data.guides.map((guide) => guide.id),
    ...(data.sections ?? []).map((section) => section.id),
    ...ownIdsOf(own),
  ]);
  return (id) => ids.has(id);
}

/**
 * The contents as the person sees it, hidden pages included: the layout
 * their changes to the contents start from.
 */
export function layoutFor(data: GuidePages['data'], own: OwnPages): PagesLayout {
  return mergeLayouts(
    packLayout(data),
    own.contents,
    existing(data, own),
    ownIdsOf(own),
    looseSections(data),
  );
}

/** The pack's sections whose pages are placed by their links. */
export function looseSections(data: GuidePages['data']): Set<string> {
  return new Set(
    (data.sections ?? []).filter((section) => section.placeByLinks === true).map((s) => s.id),
  );
}

const isPageId = (id: string | null) => id !== null && parseId(id)?.kind === 'guide';

/** The contents as the arrange tool shows it: the person's layout with the pages placed by links. */
export interface ShownContents {
  /** What is at the top, and what each section and page holds, as shown. */
  layout: PagesLayout;
  /** The pages placed by their links: by page id, the page it is under. */
  placed: ReadonlyMap<string, string>;
}

/**
 * The contents as the person sees it, hidden pages included (where the
 * person's layout has them), with the pages placed by their links as the
 * Guides section places them: the arrange tool shows this.
 */
export function shownContentsFor(
  data: GuidePages['data'],
  own: OwnPages,
  aliases?: GuidePages['aliases'],
): ShownContents {
  const layout = layoutFor(data, own);
  const guides = new Map(data.guides.map((guide) => [guide.id, guide]));
  const pages = new Map(own.pages.map((page) => [page.id, page]));
  const sectionIds = new Set([
    ...(data.sections ?? []).map((section) => section.id),
    ...own.sections.map((section) => section.id),
  ]);
  const isPage = (id: string) =>
    guides.has(id) || (isOwnId(id) && pages.get(id)?.body !== undefined);
  // A page of the pack, shown: it places and is placed. One hidden does neither.
  const shownPack = (id: string) => guides.has(id) && pages.get(id)?.hidden !== true;
  const lists = new Map<string, string[]>();
  for (const [id, items] of Object.entries(layout.sections)) lists.set(id, items);
  const tree = placePagesByLinks({
    top: layout.top,
    lists,
    isSection: (id) => sectionIds.has(id),
    isPage,
    byLinks: looseSections(data),
    linksOf: (id) => {
      const guide = guides.get(id)!;
      const page = pages.get(id);
      if (page?.body === undefined) return linksThrough(guide, aliases);
      return guideLinksIn(shownBody(guide, page), id).map((link) => aliasedId(aliases, link));
    },
    leads: shownPack,
    movable: shownPack,
  });
  return {
    layout: { top: tree.top, sections: Object.fromEntries(tree.lists) },
    placed: tree.placed,
  };
}

/** Whether anything of the person's changes what the contents shows. */
function changesContents(own: OwnPages): boolean {
  return (
    own.contents !== undefined ||
    own.pages.some((page) => page.hidden === true || isOwnId(page.id)) ||
    own.sections.some((section) => isOwnId(section.id))
  );
}

/**
 * A pack's pages with the person's laid over them, as `GuideContents`
 * takes them. Without anything of theirs, the pack's own data, as it is.
 */
export function applyOwnPages(data: GuidePages['data'], own: OwnPages): GuidePages {
  if (own.pages.length === 0 && own.sections.length === 0 && own.contents === undefined) {
    return { data };
  }
  const byId = new Map(own.pages.map((page) => [page.id, page]));
  const guides: GuideEntry[] = data.guides.map((guide) => {
    const page = byId.get(guide.id);
    if (!page || (page.title === undefined && page.body === undefined)) return guide;
    return { ...guide, title: page.title ?? guide.title, body: shownBody(guide, page) };
  });
  for (const page of own.pages) {
    if (!isOwnId(page.id) || page.title === undefined || page.body === undefined) continue;
    guides.push({ id: page.id, title: page.title, body: page.body, locationIds: [] });
  }
  const titles = new Map(own.sections.map((section) => [section.id, section.title]));
  const packSections = data.sections ?? [];
  const packIds = new Set(packSections.map((section) => section.id));
  if (!changesContents(own)) {
    // Titles only: the pack's contents, as it is.
    return {
      data: {
        ...data,
        guides,
        sections: packSections.map((section) =>
          titles.has(section.id) ? { ...section, title: titles.get(section.id)! } : section,
        ),
      },
    };
  }
  const layout = layoutFor(data, own);
  const hidden = new Set(
    own.pages.filter((page) => page.hidden === true && !isOwnId(page.id)).map((page) => page.id),
  );
  const shown = (items: readonly string[]) => items.filter((id) => !hidden.has(id));
  const sections: Section[] = [];
  const seen = new Set<string>();
  for (const section of packSections) {
    if (seen.has(section.id)) continue;
    seen.add(section.id);
    sections.push({
      id: section.id,
      title: titles.get(section.id) ?? section.title,
      items: shown(layout.sections[section.id] ?? []),
      ...(section.placeByLinks === true ? { placeByLinks: true } : {}),
    });
  }
  for (const section of own.sections) {
    if (packIds.has(section.id) || !isOwnId(section.id) || seen.has(section.id)) continue;
    seen.add(section.id);
    sections.push({
      id: section.id,
      title: section.title,
      items: shown(layout.sections[section.id] ?? []),
    });
  }
  // The pages put under a page by hand. A hidden page is not shown, so the
  // contents shows its pages where pages nothing leads to are (see `pageTree.ts`).
  const under: Record<string, string[]> = {};
  for (const [id, items] of Object.entries(layout.sections)) {
    if (isPageId(id)) under[id] = shown(items);
  }
  return {
    data: { ...data, guides, sections },
    top: shown(layout.top),
    ...(Object.keys(under).length > 0 ? { under } : {}),
  };
}

// ---------------------------------------------------------------------------
// Changing the contents

/** The sections inside a section, however deep, and itself. */
export function sectionsWithin(layout: PagesLayout, sectionId: string): Set<string> {
  const found = new Set<string>();
  const visit = (id: string) => {
    if (found.has(id)) return;
    found.add(id);
    for (const item of layout.sections[id] ?? []) if (layout.sections[item]) visit(item);
  };
  visit(sectionId);
  return found;
}

/** Everything inside an entry of the contents (sections and pages), however deep, and itself. */
export function entriesWithin(layout: PagesLayout, id: string): Set<string> {
  const found = new Set<string>([id]);
  const queue = [id];
  // The queue grows as it is walked.
  for (const at of queue) {
    for (const item of layout.sections[at] ?? []) {
      if (found.has(item)) continue;
      found.add(item);
      queue.push(item);
    }
  }
  return found;
}

/** Where an entry is: the parent of its first place in the contents, top first. */
export function parentOf(layout: PagesLayout, id: string): ContentsParent | undefined {
  if (layout.top.includes(id)) return null;
  for (const [section, items] of Object.entries(layout.sections)) {
    if (items.includes(id)) return section;
  }
  return undefined;
}

/**
 * Moves an entry of the contents from one parent to another, before the
 * entry `before` there (at the end when it is null or not there). A
 * section never goes inside itself. Returns the layout unchanged when the
 * move cannot be made.
 */
export function moveInLayout(
  layout: PagesLayout,
  id: string,
  from: ContentsParent,
  to: ContentsParent,
  before: string | null,
): PagesLayout {
  if (to !== null && layout.sections[id] && sectionsWithin(layout, id).has(to)) return layout;
  const next = copyLayout(layout);
  const source = listOf(next, from);
  const target = listOf(next, to);
  if (!source || !target) return layout;
  const at = source.indexOf(id);
  if (at < 0) return layout;
  source.splice(at, 1);
  const index = before === null ? -1 : target.indexOf(before);
  target.splice(index < 0 ? target.length : index, 0, id);
  return next;
}

/**
 * Moves an entry of the contents as shown (`shown`, see
 * {@link shownContentsFor}) to a section, under a page (`to` a page id), or
 * to the top, before the entry `before` there (at the end when it is null
 * or not there), changing the person's layout (`layout`, see
 * {@link layoutFor}). Under a page, the pages shown there are kept there,
 * in the order shown, as the person arranged them: placed by hand from now
 * on, as the moved one is. Only pages go under a page, and never under
 * themselves. Returns the layout unchanged when the move cannot be made.
 */
export function moveInContents(
  layout: PagesLayout,
  shown: PagesLayout,
  id: string,
  to: ContentsParent,
  before: string | null,
  loose: ReadonlySet<string>,
): PagesLayout {
  if (to !== null && entriesWithin(shown, id).has(to)) return layout;
  const toPage = isPageId(to);
  if (toPage && !isPageId(id)) return layout;
  if (!toPage && to !== null && layout.sections[to] === undefined) return layout;
  const next = copyLayout(layout);
  const from = parentOf(next, id);
  if (from !== undefined) {
    const list = listOf(next, from)!;
    list.splice(list.indexOf(id), 1);
    if (list.length === 0 && from !== null && isPageId(from)) {
      next.sections = withoutKey(next.sections, from);
    }
  }
  if (toPage) {
    const list = (shown.sections[to!] ?? []).filter((item) => item !== id);
    const index = before === null ? -1 : list.indexOf(before);
    list.splice(index < 0 ? list.length : index, 0, id);
    // Pages shown there by their links are placed there by hand now: out of the sections left to links.
    const taken = new Set(list);
    for (const section of loose) {
      const items = next.sections[section];
      if (items) next.sections[section] = items.filter((item) => !taken.has(item));
    }
    next.sections[to!] = list;
    return next;
  }
  const target = listOf(next, to)!;
  const index = before === null ? -1 : target.indexOf(before);
  target.splice(index < 0 ? target.length : index, 0, id);
  return next;
}

/** Moves an entry of the contents as shown (see {@link moveInContents}). */
export function moveShownEntry(
  own: OwnPages,
  layout: PagesLayout,
  shown: PagesLayout,
  id: string,
  to: ContentsParent,
  before: string | null,
  loose: ReadonlySet<string>,
): OwnPages {
  const next = moveInContents(layout, shown, id, to, before, loose);
  return next === layout ? own : { ...own, contents: next };
}

/** Puts a new entry in the contents, before `before` (at the end when null). */
export function insertInLayout(
  layout: PagesLayout,
  id: string,
  to: ContentsParent,
  before: string | null,
): PagesLayout {
  const next = copyLayout(layout);
  if (layout.sections[id] === undefined && parseId(id)?.kind === 'section') next.sections[id] = [];
  if (isPageId(to) && next.sections[to!] === undefined) next.sections[to!] = [];
  const target = listOf(next, to) ?? next.top;
  const index = before === null ? -1 : target.indexOf(before);
  target.splice(index < 0 ? target.length : index, 0, id);
  return next;
}

/** Takes an entry out of the contents, everywhere it is. */
function removeFromLayout(layout: PagesLayout, id: string): PagesLayout {
  const next = copyLayout(layout);
  next.top = next.top.filter((item) => item !== id);
  for (const section of Object.keys(next.sections)) {
    next.sections[section] = next.sections[section]!.filter((item) => item !== id);
  }
  return next;
}

/**
 * The entry before or after one in its parent, for Move up and Move down:
 * past the first or the last, it goes out of the section, before or after
 * it. Null when it cannot move that way.
 */
export function stepInLayout(
  layout: PagesLayout,
  id: string,
  parent: ContentsParent,
  by: -1 | 1,
): { to: ContentsParent; before: string | null } | null {
  const list = listOf(layout, parent);
  if (!list) return null;
  const at = list.indexOf(id);
  if (at < 0) return null;
  const goal = at + by;
  if (goal >= 0 && goal < list.length) {
    // Past the entry next to it.
    const before = by < 0 ? list[goal]! : (list[goal + 1] ?? null);
    return { to: parent, before };
  }
  if (parent === null) return null;
  const outer = parentOf(layout, parent);
  if (outer === undefined) return null;
  const around = listOf(layout, outer)!;
  const sectionAt = around.indexOf(parent);
  return { to: outer, before: by < 0 ? parent : (around[sectionAt + 1] ?? null) };
}

// ---------------------------------------------------------------------------
// Changing the records

const withPage = (own: OwnPages, page: OwnPage | null, id: string): OwnPages => {
  const pages = own.pages.filter((p) => p.id !== id);
  const at = own.pages.findIndex((p) => p.id === id);
  if (page) pages.splice(at < 0 ? pages.length : at, 0, page);
  return { ...own, pages };
};

/** Whether a record of a pack's page says anything: else it is dropped. */
const saysAnything = (page: OwnPage) =>
  page.title !== undefined ||
  page.body !== undefined ||
  page.hidden === true ||
  page.whenWikiChanges !== undefined;

/** A page title, trimmed and cut to length; null when nothing is left. */
export function pageTitle(text: string): string | null {
  const title = text.replace(/\s+/g, ' ').trim().slice(0, MAX_PAGE_TITLE_LENGTH).trim();
  return title === '' ? null : title;
}

/**
 * Keeps a page's title and text as the person saved them. For a pack's
 * page, only what differs from the pack's is kept, with the pack's text it
 * was changed from; saved as the pack has it, the change is gone.
 */
export function savePage(
  own: OwnPages,
  pack: GuideEntry | undefined,
  id: string,
  title: string,
  body: string,
  now: Date,
): OwnPages {
  const before = own.pages.find((page) => page.id === id);
  const updatedAt = now.toISOString();
  if (!pack) {
    return withPage(own, { ...before, id, title, body, updatedAt }, id);
  }
  const page: OwnPage = { id, updatedAt };
  if (before?.whenWikiChanges) page.whenWikiChanges = before.whenWikiChanges;
  if (before?.hidden) page.hidden = true;
  if (title !== pack.title) page.title = title;
  if (body !== pack.body) {
    page.body = body;
    // Saved again over a wiki text that changed since: the person saw this one.
    page.basedOn = pack.body;
  }
  return withPage(own, saysAnything(page) ? page : null, id);
}

/** "Go back to the wiki's version": the person's title and text of a pack's page go. */
export function revertPage(own: OwnPages, id: string, now: Date): OwnPages {
  const before = own.pages.find((page) => page.id === id);
  if (!before || isOwnId(id)) return own;
  const { title: _title, body: _body, basedOn: _basedOn, ...rest } = before;
  const page: OwnPage = { ...rest, updatedAt: now.toISOString() };
  return withPage(own, saysAnything(page) ? page : null, id);
}

/** "Keep my version": the wiki's text as it is now counts as seen. */
export function keepOwnVersion(own: OwnPages, pack: GuideEntry, now: Date): OwnPages {
  const before = own.pages.find((page) => page.id === pack.id);
  if (before?.body === undefined) return own;
  return withPage(own, { ...before, basedOn: pack.body, updatedAt: now.toISOString() }, pack.id);
}

/** What to do when the wiki changes a page. */
export function setWhenWikiChanges(
  own: OwnPages,
  id: string,
  choice: WikiChangeChoice,
  now: Date,
): OwnPages {
  if (isOwnId(id)) return own;
  const before = own.pages.find((page) => page.id === id) ?? { id, updatedAt: '' };
  const page: OwnPage = { ...before, updatedAt: now.toISOString() };
  if (choice === 'keep') delete page.whenWikiChanges;
  else page.whenWikiChanges = choice;
  return withPage(own, saysAnything(page) ? page : null, id);
}

/** Hides a pack's page from the contents, or shows it again. */
export function setPageHidden(own: OwnPages, id: string, hidden: boolean, now: Date): OwnPages {
  if (isOwnId(id)) return own;
  const before = own.pages.find((page) => page.id === id) ?? { id, updatedAt: '' };
  const page: OwnPage = { ...before, updatedAt: now.toISOString() };
  if (hidden) page.hidden = true;
  else delete page.hidden;
  return withPage(own, saysAnything(page) ? page : null, id);
}

/** A new page of one's own, put in the contents. */
export function addOwnPage(
  own: OwnPages,
  layout: PagesLayout,
  page: { id: string; title: string; body: string },
  to: ContentsParent,
  before: string | null,
  now: Date,
): OwnPages {
  return {
    ...own,
    pages: [...own.pages, { ...page, updatedAt: now.toISOString() }],
    contents: insertInLayout(layout, page.id, to, before),
  };
}

/** Deletes a page of one's own, from the contents too; the pages under it go where it was. */
export function deleteOwnPage(own: OwnPages, layout: PagesLayout, id: string): OwnPages {
  if (!isOwnId(id)) return own;
  const under = layout.sections[id];
  let contents: PagesLayout;
  if (under) {
    contents = copyLayout(layout);
    contents.sections = withoutKey(contents.sections, id);
    const replace = (list: string[]) => list.flatMap((item) => (item === id ? under : [item]));
    contents.top = replace(contents.top);
    for (const key of Object.keys(contents.sections)) {
      contents.sections[key] = replace(contents.sections[key]!);
    }
  } else contents = removeFromLayout(layout, id);
  return { ...own, pages: own.pages.filter((page) => page.id !== id), contents };
}

/** A new section of one's own, put in the contents. */
export function addOwnSection(
  own: OwnPages,
  layout: PagesLayout,
  section: OwnSection,
  to: ContentsParent,
  before: string | null,
): OwnPages {
  return {
    ...own,
    sections: [...own.sections, section],
    contents: insertInLayout(layout, section.id, to, before),
  };
}

/** A section's new title; the pack's own title again when it is the same. */
export function renameSection(
  own: OwnPages,
  packSection: Section | undefined,
  id: string,
  title: string,
): OwnPages {
  const sections = own.sections.filter((section) => section.id !== id);
  const at = own.sections.findIndex((section) => section.id === id);
  if (packSection?.title !== title) {
    sections.splice(at < 0 ? sections.length : at, 0, { id, title });
  }
  return { ...own, sections };
}

/**
 * Deletes a section of one's own: what it holds goes where it was, in its
 * order, so no page is lost.
 */
export function deleteOwnSection(own: OwnPages, layout: PagesLayout, id: string): OwnPages {
  if (!isOwnId(id)) return own;
  const items = layout.sections[id] ?? [];
  const next = copyLayout(layout);
  next.sections = Object.fromEntries(
    Object.entries(next.sections).filter(([section]) => section !== id),
  );
  const replace = (list: string[]) => list.flatMap((item) => (item === id ? items : [item]));
  next.top = replace(next.top);
  for (const section of Object.keys(next.sections)) {
    next.sections[section] = replace(next.sections[section]!);
  }
  return {
    ...own,
    sections: own.sections.filter((section) => section.id !== id),
    contents: next,
  };
}

/** Moves an entry of the contents (see {@link moveInLayout}). */
export function moveEntry(
  own: OwnPages,
  layout: PagesLayout,
  id: string,
  from: ContentsParent,
  to: ContentsParent,
  before: string | null,
): OwnPages {
  const next = moveInLayout(layout, id, from, to, before);
  return next === layout ? own : { ...own, contents: next };
}
