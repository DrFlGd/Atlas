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
import { sortGuides, type GuidePages } from './contents';

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
): PagesLayout {
  const result: PagesLayout = { top: [], sections: {} };
  const sectionIds = new Set([...Object.keys(mine?.sections ?? {}), ...Object.keys(pack.sections)]);
  for (const id of sectionIds) {
    if (!exists(id)) continue;
    const items = mine?.sections[id] ?? pack.sections[id] ?? [];
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
  return mergeLayouts(packLayout(data), own.contents, existing(data, own), ownIdsOf(own));
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
  return { data: { ...data, guides, sections }, top: shown(layout.top) };
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

/** Puts a new entry in the contents, before `before` (at the end when null). */
export function insertInLayout(
  layout: PagesLayout,
  id: string,
  to: ContentsParent,
  before: string | null,
): PagesLayout {
  const next = copyLayout(layout);
  if (layout.sections[id] === undefined && parseId(id)?.kind === 'section') next.sections[id] = [];
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

/** Deletes a page of one's own, from the contents too. */
export function deleteOwnPage(own: OwnPages, layout: PagesLayout, id: string): OwnPages {
  if (!isOwnId(id)) return own;
  return {
    ...own,
    pages: own.pages.filter((page) => page.id !== id),
    contents: removeFromLayout(layout, id),
  };
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
