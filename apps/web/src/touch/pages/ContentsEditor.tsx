import { isOwnId, parseId } from '@atlas/schema';
import {
  addLevelPage,
  addOwnPage,
  addOwnSection,
  deleteOwnPage,
  deleteOwnSection,
  entriesWithin,
  listingThrough,
  moveShownEntries,
  newOwnId,
  pageChange,
  pagesListMarkdown,
  pageTitle,
  parentOf,
  renameSection,
  setListPageSay,
  setPageHidden,
  stepInLayout,
  type ContentsParent,
  type ListedPage,
  type MovedMany,
  type ShownContents,
  type ShownLevel,
} from '@atlas/core';
import type { OwnPages, PagesLayout } from '@atlas/schema';
import { useId, useMemo, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { notify } from '../../state/actions';
import { guideAliases, guidesOf } from '../../state/guides';
import {
  changeContents,
  canChangeOwnPages,
  layoutOf,
  moveInContentsOf,
  shownContentsOf,
  useOwnPages,
} from '../../state/ownPages';
import type { LoadedGame } from '../../state/store';
import { sectionChoices } from './pageActions';
import { MenuItem } from './PageBlocks';
import { ConfirmDialog, Modal } from './PageDialogs';
import { editNewPage, openPageEditor, packPage, usePageEditor } from './pageEditorState';

/**
 * The contents as the person arranges it, beside the page edited: sections
 * that hold pages and sections, and pages that hold pages, each moved by
 * dragging its handle, by Alt+Up and Alt+Down on it, or from its menu
 * ("Move up", "Move down", "Move to…"); new pages and sections of one's
 * own; a wiki page hidden or shown again; one's own deleted.
 *
 * It shows the contents as Guides does, with the pages placed by their
 * links under the pages that lead to them, and the headings of list pages
 * as levels (rows with no handle: they come from the page's text). A page
 * moved by hand stays where it was put; under a page, the pages shown
 * there stay as arranged. A page moved back to a section whose pages are
 * placed by their links is placed by its links again. Only pages go under
 * a page.
 *
 * Pages can be ticked (a box on each page row; Shift ticks a run), and
 * the ticked pages moved together (dragged, or "Move to…"), or made the
 * pages of a new level: a page of one's own put where the first was. A
 * pack's page can be told to file the pages it lists under it, or none,
 * whatever the app would decide.
 */

interface Drop {
  id: string;
  /**
   * Before the entry, after it, or into the section or page (at its end);
   * `level` on a heading level, where nothing can be dropped.
   */
  where: 'before' | 'after' | 'into' | 'level';
}

const isSectionId = (id: string) => parseId(id)?.kind === 'section';

/** Rows of one list shown at first, and more with each press. */
const ROWS_AT_ONCE = 200;

/** The title of an entry of the contents, as shown. */
function titleOf(game: LoadedGame, id: string): string {
  const { contents } = guidesOf(game);
  const own = useOwnPages.getState().own;
  return (
    contents.section(id)?.title ??
    contents.guide(id)?.title ??
    own.sections.find((s) => s.id === id)?.title ??
    game.pack.data.sections?.find((s) => s.id === id)?.title ??
    game.pack.data.guides.find((g) => g.id === id)?.title ??
    id
  );
}

/** Where `id` goes for a drop on another entry: its new parent, and the entry it goes before. */
function dropPlace(layout: PagesLayout, drop: Drop): { to: ContentsParent; before: string | null } {
  if (drop.where === 'into') return { to: drop.id, before: null };
  const parent = parentOf(layout, drop.id) ?? null;
  const items = parent === null ? layout.top : (layout.sections[parent] ?? []);
  const at = items.indexOf(drop.id);
  if (drop.where === 'before') return { to: parent, before: drop.id };
  return { to: parent, before: items[at + 1] ?? null };
}

/**
 * What is said when pages are put among the pages the app files under a
 * page (by the entry they were dropped on, else by `before`): they go
 * with the pages put there by hand, which come first, and the app's keep
 * their order. Empty when they were not.
 */
function filedNote(game: LoadedGame, to: ContentsParent, near: readonly (string | null)[]): string {
  if (to === null || isSectionId(to)) return '';
  const { placed } = shownContentsOf(game);
  if (!near.some((id) => id !== null && placed.get(id) === to)) return '';
  return `Pages put under “${titleOf(game, to)}” by hand come first, and the pages the app files there keep the order of its text.`;
}

/** A sentence and another after it. */
const withSentence = (text: string, more: string) =>
  more === '' ? text : `${text.endsWith('.') ? text : `${text}.`} ${more}`;

function move(
  game: LoadedGame,
  id: string,
  to: ContentsParent,
  before: string | null,
  more = '',
  near: readonly string[] = [],
): void {
  const shown = shownContentsOf(game).layout;
  if (to !== null && entriesWithin(shown, id).has(to)) return;
  if (to !== null && !isSectionId(to) && isSectionId(id)) return;
  const said =
    (to !== null && !isSectionId(to)
      ? `Moved “${titleOf(game, id)}” under “${titleOf(game, to)}”`
      : `Moved “${titleOf(game, id)}”`) + more;
  moveInContentsOf(
    game,
    id,
    to,
    before,
    withSentence(said, filedNote(game, to, near.length > 0 ? near : [before])),
  );
}

function step(game: LoadedGame, id: string, by: -1 | 1, more = ''): void {
  const shown = shownContentsOf(game).layout;
  const place = stepInLayout(shown, id, parentOf(shown, id) ?? null, by);
  // A section never goes under a page.
  if (place && (place.to === null || isSectionId(place.to) || !isSectionId(id))) {
    move(game, id, place.to, place.before, more);
  }
}

const pagesText = (count: number) => (count === 1 ? 'one page' : `${count} pages`);

/** What is said of the pages left where they were by a move of several. */
function leftText(left: number): string {
  if (left === 0) return '';
  return left === 1
    ? ' One page was left where it was: a page cannot go under itself or under a page beneath it.'
    : ` ${left} pages were left where they were: a page cannot go under itself or under a page beneath it.`;
}

/** The ids of the pages and sections of the contents as shown, top to bottom. */
function contentsOrder(layout: PagesLayout): Map<string, number> {
  const order = new Map<string, number>();
  const walk = (items: readonly string[], depth: number) => {
    for (const id of items) {
      if (order.has(id)) continue;
      order.set(id, order.size);
      if (depth < 64) walk(layout.sections[id] ?? [], depth + 1);
    }
  };
  walk(layout.top, 0);
  return order;
}

/** The things a change of the contents works from: the records, the layout and the contents shown. */
function startOf(game: LoadedGame): {
  own: OwnPages;
  layout: PagesLayout;
  shown: PagesLayout;
} {
  return {
    own: useOwnPages.getState().own,
    layout: layoutOf(game),
    shown: shownContentsOf(game).layout,
  };
}

/** Applies a change worked out from the records as they are now, with one way to undo it. */
function applyMany(result: MovedMany, from: OwnPages, said: string): boolean {
  if (result.own === from) return false;
  return changeContents((own) => (own === from ? result.own : own), said);
}

/** Moves several pages together, in contents order, and says how many moved and were left. */
function moveMany(
  game: LoadedGame,
  ids: readonly string[],
  to: ContentsParent,
  before: string | null,
  near: readonly string[] = [],
): boolean {
  const { own, layout, shown } = startOf(game);
  const result = moveShownEntries(own, layout, shown, ids, to, before);
  if (result.moved.length === 0) {
    notify(
      ids.length === 1
        ? 'It cannot go there: a page cannot go under itself or under a page beneath it.'
        : 'None of them can go there: a page cannot go under itself or under a page beneath it.',
      'error',
    );
    return false;
  }
  const where = to !== null && !isSectionId(to) ? ` under “${titleOf(game, to)}”` : '';
  const what =
    result.moved.length === 1
      ? `“${titleOf(game, result.moved[0]!)}”`
      : `${result.moved.length} pages`;
  const note = filedNote(game, to, near.length > 0 ? near : [before]);
  return applyMany(
    result,
    own,
    withSentence(`Moved ${what}${where}.${leftText(result.left.length)}`, note),
  );
}

/** The pages of a level, however deep, in order, and what it holds as a list for a page's text. */
function levelPages(
  game: LoadedGame,
  shown: ShownContents,
  id: string,
): { pages: string[]; list: ListedPage[] } {
  const pages: string[] = [];
  const listOf = (items: readonly string[], depth: number): ListedPage[] =>
    items.map((item) => {
      const step = shown.steps.get(item);
      if (step) {
        return {
          title: step.title,
          under: depth < 16 ? listOf(shown.levels.get(item) ?? [], depth + 1) : [],
        };
      }
      pages.push(item);
      return { id: item, title: titleOf(game, item) };
    });
  const list = listOf(shown.levels.get(id) ?? [], 0);
  return { pages, list };
}

/** A new page of one's own id, not taken by any page there is. */
function newPageId(game: LoadedGame): string {
  const taken = new Set([
    ...game.pack.data.guides.map((g) => g.id),
    ...useOwnPages.getState().own.pages.map((p) => p.id),
  ]);
  return newOwnId(game.pack.manifest.gameId, 'guide', taken);
}

/**
 * Makes a page of one's own named `title` where the first of `ids` is, and
 * moves the pages of `ids` under it; with `list`, its text lists them (as
 * `list` gives them, or as moved). Returns its id when it was made.
 */
function makeLevel(
  game: LoadedGame,
  title: string,
  ids: readonly string[],
  list: boolean | readonly ListedPage[],
): string | null {
  const { own, layout, shown } = startOf(game);
  const id = newPageId(game);
  const result = addLevelPage(own, layout, shown, { id, title, body: '' }, ids, new Date());
  const listed =
    list === true
      ? result.moved.map((page) => ({ id: page, title: titleOf(game, page) }))
      : list === false
        ? []
        : list;
  const body = pagesListMarkdown(listed);
  const made: MovedMany = body
    ? {
        ...result,
        own: {
          ...result.own,
          pages: result.own.pages.map((page) => (page.id === id ? { ...page, body } : page)),
        },
      }
    : result;
  const moved = result.moved.length;
  const said = `Made “${title}”${moved > 0 ? ` with ${pagesText(moved)} under it` : ''}.${leftText(
    result.left.length,
  )}`;
  return applyMany(made, own, said) ? id : null;
}

/** Whether a pack's page files the pages it lists, as the person said; undefined when the app decides. */
const listPageSay = (own: OwnPages, id: string): boolean | undefined => own.listPages?.[id];

/** Tells a pack's page to file the pages it lists, or none, or lets the app decide again. */
function sayListPage(game: LoadedGame, id: string, say: boolean | null): void {
  const title = titleOf(game, id);
  let said: string;
  if (say === true) {
    const guide = guidesOf(game).contents.guide(id);
    const listing = guide
      ? listingThrough(guide, guideAliases([game.pack]) ?? undefined, false).listing
      : [];
    said =
      listing.length === 0
        ? `“${title}” lists no pages in its text, so nothing goes under it until it does.`
        : `“${title}” files the pages it lists under it now.`;
  } else if (say === false) {
    said = `“${title}” files no pages under it now.`;
  } else {
    said = `The app decides again what goes under “${title}”.`;
  }
  const changed = changeContents((own) => setListPageSay(own, id, say), said);
  if (!changed && say === true) notify(said);
}

export function ContentsEditor({ game }: { game: LoadedGame }) {
  // The contents follow the person's changes.
  useOwnPages((s) => s.own);
  const canChange = useOwnPages((s) => canChangeOwnPages(s));
  const shown = shownContentsOf(game);
  const layout = shown.layout;
  const editing = usePageEditor((s) => s.guideId);
  // The home page is not in the contents: it is above them, the page Guides opens on.
  const home = game.pack.homePage;
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null);
  // Pages with pages under them are folded, but the way to the page edited; and as the person chose.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Where each entry is shown: under a heading level, or where the layout has it.
  const shownParent = useMemo(() => {
    const parents = new Map<string, string>();
    for (const [id, items] of shown.levels) for (const item of items) parents.set(item, id);
    return parents;
  }, [shown]);
  const onWay = useMemo(() => {
    const ids = new Set<string>();
    const up = (id: string) => shownParent.get(id) ?? parentOf(layout, id);
    for (let at = editing ? up(editing) : null; at; at = up(at)) {
      if (ids.has(at)) break;
      ids.add(at);
    }
    return ids;
  }, [layout, editing, shownParent]);
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const [dialog, setDialog] = useState<
    | { kind: 'rename'; id: string }
    | { kind: 'move'; ids: string[] }
    | { kind: 'delete'; id: string }
    | { kind: 'new-section' }
    | { kind: 'new-level'; ids: string[] }
    | null
  >(null);
  // The pages ticked, and the last one ticked or unticked (where a run with Shift starts).
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [lastTick, setLastTick] = useState<string | null>(null);
  // The page rows in the order shown, as this render lists them (for a run with Shift).
  const rowOrder: string[] = [];
  const order = useMemo(() => contentsOrder(layout), [layout]);
  const tickedInOrder = [...ticked]
    .filter((id) => order.has(id))
    .sort((a, b) => order.get(a)! - order.get(b)!);
  const tick = (id: string, run: boolean) => {
    const next = new Set(ticked);
    const on = !ticked.has(id);
    const rows = rowOrder;
    const from = lastTick === null ? -1 : rows.indexOf(lastTick);
    const at = rows.indexOf(id);
    if (run && from >= 0 && at >= 0) {
      for (let i = Math.min(from, at); i <= Math.max(from, at); i++) {
        if (on) next.add(rows[i]!);
        else next.delete(rows[i]!);
      }
    } else if (on) next.add(id);
    else next.delete(id);
    setTicked(next);
    setLastTick(id);
  };
  const clearTicks = () => {
    setTicked(new Set());
    setLastTick(null);
  };

  /** The parent and the place a new page or section goes: beside the page edited. */
  const newPlace = (): { to: ContentsParent; before: string | null } => {
    if (!editing) return { to: null, before: null };
    const base = layoutOf(game);
    return { to: parentOf(base, editing) ?? null, before: null };
  };

  /** A new page of one's own under a page, opened for editing. */
  const newPageUnder = (parent: string) => {
    const id = newPageId(game);
    const added = changeContents(
      (o, l) => addOwnPage(o, l, { id, title: 'New page', body: '' }, parent, null, new Date()),
      `Added a page under “${titleOf(game, parent)}”`,
    );
    if (added) {
      setToggled(new Map(toggled).set(parent, true));
      editNewPage(id);
    }
  };

  const startDrag = (id: string, event: React.PointerEvent) => {
    if (!canChange) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ id, drop: null });
  };
  const dragMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const element = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((e) => e instanceof HTMLElement && e.dataset.entry);
    const dragged = ticked.has(drag.id) ? ticked : new Set([drag.id]);
    if (!(element instanceof HTMLElement) || dragged.has(element.dataset.entry!)) {
      setDrag({ ...drag, drop: null });
      return;
    }
    if (element.dataset.kind === 'level') {
      setDrag({ ...drag, drop: { id: element.dataset.entry!, where: 'level' } });
      return;
    }
    const rect = element.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    // Into a section anything; into a page only a page.
    const into =
      element.dataset.kind === 'section' ||
      (element.dataset.kind === 'page' && !isSectionId(drag.id));
    const where: Drop['where'] = into
      ? y < 0.3
        ? 'before'
        : y > 0.7
          ? 'after'
          : 'into'
      : y < 0.5
        ? 'before'
        : 'after';
    setDrag({ ...drag, drop: { id: element.dataset.entry!, where } });
  };
  const endDrag = () => {
    const drop = drag?.drop;
    if (drag && drop?.where === 'level') {
      const level = shown.steps.get(drop.id);
      notify(
        `“${level?.title ?? 'This level'}” comes from the headings of “${titleOf(
          game,
          level?.page ?? '',
        )}”, so nothing can be put in it. Drop the page on “${titleOf(
          game,
          level?.page ?? '',
        )}” to put it under that page.`,
        'error',
      );
    } else if (drag && drop) {
      const place = dropPlace(layout, drop);
      if (ticked.has(drag.id) && ticked.size > 1) {
        if (moveMany(game, tickedInOrder, place.to, place.before, [drop.id])) clearTicks();
      } else move(game, drag.id, place.to, place.before, '', [drop.id]);
    }
    setDrag(null);
  };

  const rowsOf = (key: string, items: readonly string[], depth: number): React.ReactNode => {
    const count = Math.max(
      counts.get(key) ?? ROWS_AT_ONCE,
      Math.ceil((items.findIndex((id) => id === editing || onWay.has(id)) + 1) / ROWS_AT_ONCE) *
        ROWS_AT_ONCE,
    );
    const rows = items.slice(0, count).map((id) => {
      const isSection = isSectionId(id);
      const level = shown.steps.get(id);
      const under = isSection ? [] : (shown.levels.get(id) ?? layout.sections[id] ?? []);
      const open = isSection || (under.length > 0 && (toggled.get(id) ?? onWay.has(id)));
      const dropHere = drag?.drop?.id === id ? drag.drop.where : null;
      if (level) {
        return (
          <li key={id} className="pe-tree-item">
            <LevelRow
              game={game}
              level={level}
              depth={depth}
              under={under.length}
              open={open}
              onFold={(next) => {
                setToggled(new Map(toggled).set(id, next));
              }}
              refused={dropHere === 'level'}
              canChange={canChange}
              onOwn={() => {
                const { pages, list } = levelPages(game, shown, id);
                const made = makeLevel(game, level.title, pages, list);
                if (made) setToggled(new Map(toggled).set(made, true));
              }}
            />
            {open ? <ul className="touch-plain-list">{rowsOf(id, under, depth + 1)}</ul> : null}
          </li>
        );
      }
      if (!isSection) rowOrder.push(id);
      const dragging = drag !== null && (drag.id === id || (ticked.has(drag.id) && ticked.has(id)));
      return (
        <li key={id} className="pe-tree-item">
          <Row
            game={game}
            id={id}
            depth={depth}
            section={isSection}
            under={under.length}
            open={open}
            onFold={(next) => {
              setToggled(new Map(toggled).set(id, next));
            }}
            current={editing === id}
            dropHere={dropHere === 'level' ? null : dropHere}
            dragging={dragging}
            canChange={canChange}
            ticked={ticked.has(id)}
            ticking={ticked.size > 0}
            othersTicked={ticked.size > (ticked.has(id) ? 1 : 0)}
            onTick={(run) => {
              tick(id, run);
            }}
            onDragStart={(event) => {
              startDrag(id, event);
            }}
            onDragMove={dragMove}
            onDragEnd={endDrag}
            onDialog={(kind) => {
              if (kind === 'move') setDialog({ kind, ids: [id] });
              else if (kind === 'new-page') newPageUnder(id);
              else setDialog({ kind, id });
            }}
          />
          {open ? (
            <ul className="touch-plain-list">
              {rowsOf(id, isSection ? (layout.sections[id] ?? []) : under, depth + 1)}
            </ul>
          ) : null}
        </li>
      );
    });
    const left = items.length - count;
    if (left > 0) {
      rows.push(
        <li key="more" className="pe-tree-item">
          <button
            type="button"
            className="pe-tree-rows-more"
            style={{ marginLeft: 4 + depth * 16 }}
            onClick={() => {
              setCounts(new Map(counts).set(key, count + ROWS_AT_ONCE));
            }}
          >
            {left > ROWS_AT_ONCE
              ? `Show ${ROWS_AT_ONCE} more of ${left.toLocaleString('en')}`
              : `Show the other ${left === 1 ? 'one' : left.toLocaleString('en')}`}
          </button>
        </li>,
      );
    }
    return rows;
  };

  return (
    <nav
      className={`pe-contents${ticked.size > 0 ? ' pe-ticking' : ''}`}
      aria-label="Contents"
      data-testid="contents-editor"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && ticked.size > 0 && dialog === null) {
          event.stopPropagation();
          clearTicks();
        }
      }}
    >
      <h2 className="pe-contents-title">Guides</h2>
      <p className="pe-note">
        {game.pack.manifest.title}. Drag to move a page or a section; drop a page on a page to put
        it under that page. Tick pages to move them together or make a level of them.
      </p>
      <div className="pe-contents-actions">
        <button
          type="button"
          className="own-pill-button"
          disabled={!canChange}
          data-testid="new-page"
          onClick={() => {
            const taken = new Set([
              ...game.pack.data.guides.map((g) => g.id),
              ...useOwnPages.getState().own.pages.map((p) => p.id),
            ]);
            const id = newOwnId(game.pack.manifest.gameId, 'guide', taken);
            const place = newPlace();
            const added = changeContents(
              (o, l) =>
                addOwnPage(
                  o,
                  l,
                  { id, title: 'New page', body: '' },
                  place.to,
                  place.before,
                  new Date(),
                ),
              'Added a page',
            );
            if (added) editNewPage(id);
          }}
        >
          <UiIcon name="plus" size={14} /> New page
        </button>
        <button
          type="button"
          className="own-pill-button"
          disabled={!canChange}
          data-testid="new-section"
          onClick={() => {
            setDialog({ kind: 'new-section' });
          }}
        >
          <UiIcon name="folder" size={14} /> New section
        </button>
        {editing && editing !== home && guidesOf(game).contents.isPage(editing) ? (
          <button
            type="button"
            className="own-pill-button"
            disabled={!canChange}
            title={`A new page of your own under “${titleOf(game, editing)}”`}
            data-testid="new-page-under"
            onClick={() => {
              newPageUnder(editing);
            }}
          >
            <UiIcon name="plus" size={14} /> New page under this page
          </button>
        ) : null}
      </div>
      {ticked.size > 0 ? (
        <div
          className="pe-ticked-bar"
          role="group"
          aria-label="Ticked pages"
          data-testid="contents-ticked-bar"
        >
          <span className="pe-ticked-count" aria-live="polite" data-testid="contents-ticked-count">
            {ticked.size === 1 ? 'One page ticked' : `${ticked.size} pages ticked`}
          </span>
          <button
            type="button"
            className="own-pill-button"
            disabled={!canChange}
            data-testid="ticked-move"
            onClick={() => {
              setDialog({ kind: 'move', ids: tickedInOrder });
            }}
          >
            Move to…
          </button>
          <button
            type="button"
            className="own-pill-button"
            disabled={!canChange}
            data-testid="ticked-level"
            onClick={() => {
              setDialog({ kind: 'new-level', ids: tickedInOrder });
            }}
          >
            New level from these
          </button>
          <button
            type="button"
            className="own-pill-button"
            data-testid="ticked-clear"
            onClick={clearTicks}
          >
            Clear
          </button>
        </div>
      ) : null}
      {home ? (
        <div
          className={`pe-tree-row pe-tree-home${editing === home ? ' pe-tree-current' : ''}`}
          data-testid="contents-home"
        >
          <span className="pe-tree-home-mark" aria-hidden="true">
            <UiIcon name="home" size={16} />
          </span>
          <button
            type="button"
            className="pe-tree-name"
            aria-current={editing === home ? 'page' : undefined}
            data-testid="contents-home-page"
            onClick={() => {
              openPageEditor(home);
            }}
          >
            {titleOf(game, home)}
          </button>
          <span className="pe-tag">Home page</span>
        </div>
      ) : null}
      <ul className="touch-plain-list pe-tree" data-testid="contents-tree">
        {rowsOf('', layout.top, 0)}
      </ul>
      {dialog?.kind === 'rename' || dialog?.kind === 'new-section' ? (
        <NameDialog
          title={dialog.kind === 'rename' ? 'Rename the section' : 'New section'}
          initial={dialog.kind === 'rename' ? titleOf(game, dialog.id) : ''}
          action={dialog.kind === 'rename' ? 'Rename' : 'Add the section'}
          onClose={() => {
            setDialog(null);
          }}
          onName={(name) => {
            if (dialog.kind === 'rename') {
              const id = dialog.id;
              const packSection = game.pack.data.sections?.find((s) => s.id === id);
              changeContents(
                (o) => renameSection(o, packSection, id, name),
                `Renamed the section “${name}”`,
              );
            } else {
              const taken = new Set([
                ...(game.pack.data.sections ?? []).map((s) => s.id),
                ...useOwnPages.getState().own.sections.map((s) => s.id),
              ]);
              const id = newOwnId(game.pack.manifest.gameId, 'section', taken);
              const place = newPlace();
              changeContents(
                (o, l) => addOwnSection(o, l, { id, title: name }, place.to, place.before),
                `Added the section “${name}”`,
              );
            }
          }}
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveDialog
          game={game}
          ids={dialog.ids}
          onClose={() => {
            setDialog(null);
          }}
          onMoved={() => {
            if (dialog.ids.length > 1) clearTicks();
          }}
        />
      ) : null}
      {dialog?.kind === 'new-level' ? (
        <LevelDialog
          game={game}
          ids={dialog.ids}
          onClose={() => {
            setDialog(null);
          }}
          onMake={(name, list) => {
            const made = makeLevel(game, name, dialog.ids, list);
            if (made) {
              clearTicks();
              setToggled(new Map(toggled).set(made, true));
            }
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={`Delete “${titleOf(game, dialog.id)}”?`}
          text={
            isSectionId(dialog.id)
              ? 'What the section holds stays, where the section was.'
              : 'The page and its text go; the pages under it stay, where it was. You can undo this for a while.'
          }
          confirm={isSectionId(dialog.id) ? 'Delete the section' : 'Delete the page'}
          testId="delete-entry-dialog"
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={() => {
            const id = dialog.id;
            const title = titleOf(game, id);
            const section = isSectionId(id);
            if (!section && usePageEditor.getState().guideId === id) {
              usePageEditor.setState({
                guideId: null,
                base: { title: '', text: '' },
                title: '',
                text: '',
              });
            }
            changeContents(
              (o, l) => (section ? deleteOwnSection(o, l, id) : deleteOwnPage(o, l, id)),
              `Deleted “${title}”`,
            );
          }}
        />
      ) : null}
    </nav>
  );
}

function Row({
  game,
  id,
  depth,
  section,
  under,
  open,
  onFold,
  current,
  dropHere,
  dragging,
  canChange,
  ticked,
  ticking,
  othersTicked,
  onTick,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDialog,
}: {
  game: LoadedGame;
  id: string;
  depth: number;
  section: boolean;
  /** How many pages are under a page (none for a section). */
  under: number;
  open: boolean;
  onFold: (open: boolean) => void;
  current: boolean;
  dropHere: Exclude<Drop['where'], 'level'> | null;
  dragging: boolean;
  canChange: boolean;
  ticked: boolean;
  /** Whether any row is ticked: the boxes then stay in view. */
  ticking: boolean;
  /** Whether rows other than this one are ticked. */
  othersTicked: boolean;
  /** Ticks or unticks the row; with `run`, every row from the last one ticked. */
  onTick: (run: boolean) => void;
  onDragStart: (event: React.PointerEvent) => void;
  onDragMove: (event: React.PointerEvent) => void;
  onDragEnd: () => void;
  onDialog: (kind: 'rename' | 'move' | 'delete' | 'new-page') => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const own = useOwnPages((s) => s.own);
  const title = titleOf(game, id);
  const page = section ? undefined : own.pages.find((p) => p.id === id);
  const change = section ? null : pageChange(packPage(game, id), page);
  const mine = isOwnId(id);
  const say = section || mine ? undefined : listPageSay(own, id);
  const tag = mine
    ? 'Yours'
    : change?.hidden
      ? 'Hidden'
      : change?.changed
        ? 'Changed by you'
        : null;
  return (
    <div
      className={`pe-tree-row${section ? ' pe-tree-section' : ''}${current ? ' pe-tree-current' : ''}${
        dragging ? ' pe-tree-dragging' : ''
      }${dropHere ? ` pe-drop-${dropHere}` : ''}${ticked ? ' pe-tree-ticked' : ''}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      data-entry={id}
      data-kind={section ? 'section' : 'page'}
      data-testid="contents-row"
    >
      <button
        type="button"
        className="pe-drag"
        aria-label={`Move “${title}”: drag, or Alt with an arrow key`}
        title="Drag to move. Alt+Up or Alt+Down moves it too."
        disabled={!canChange}
        data-testid="contents-handle"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            // One row at a time: ticked rows stay where they are.
            step(
              game,
              id,
              event.key === 'ArrowUp' ? -1 : 1,
              othersTicked ? '. Alt with an arrow key moves one page at a time.' : '',
            );
          }
        }}
      >
        <UiIcon name="grip" size={14} />
      </button>
      {section ? (
        <span className="pe-tick-spacer" aria-hidden="true" />
      ) : (
        <input
          type="checkbox"
          className={`pe-tick${ticking ? ' pe-tick-shown' : ''}`}
          checked={ticked}
          aria-label={`Tick “${title}”`}
          title="Tick to move it with other pages. Shift ticks every page from the last one ticked."
          disabled={!canChange}
          data-testid="contents-tick"
          onChange={() => undefined}
          onClick={(event) => {
            onTick(event.shiftKey);
          }}
        />
      )}
      {!section && under > 0 ? (
        <button
          type="button"
          className="pe-tree-fold"
          aria-expanded={open}
          aria-label={open ? `Hide the pages under “${title}”` : `Show the pages under “${title}”`}
          title={open ? 'Hide the pages under it' : 'Show the pages under it'}
          data-testid="contents-fold"
          onClick={() => {
            onFold(!open);
          }}
        >
          <UiIcon name={open ? 'chevronDown' : 'chevron'} size={14} />
        </button>
      ) : null}
      {section ? (
        <span className="pe-tree-name pe-tree-section-name">
          <UiIcon name="folder" size={16} />
          {title}
        </span>
      ) : (
        <button
          type="button"
          className="pe-tree-name"
          aria-current={current ? 'page' : undefined}
          data-testid="contents-page"
          onClick={() => {
            openPageEditor(id);
          }}
        >
          {title}
        </button>
      )}
      {tag ? (
        <span className={`pe-tag${mine ? ' pe-tag-own' : ''}`} data-testid="contents-tag">
          {tag}
        </span>
      ) : null}
      {say !== undefined ? (
        <span
          className="pe-tag"
          title={
            say
              ? 'You said it files the pages it lists under it.'
              : 'You said it files no pages under it.'
          }
          data-testid="contents-say"
        >
          {say ? 'Files its list' : 'Files none'}
        </span>
      ) : null}
      <span className="pe-menu-anchor">
        <button
          type="button"
          className="pe-tree-more"
          aria-label={`More for “${title}”`}
          title="Move, rename, hide or delete"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          disabled={!canChange}
          data-testid="contents-more"
          onClick={() => {
            setMenu(!menu);
          }}
        >
          <UiIcon name="more" size={16} />
        </button>
        {menu ? (
          <div
            id={menuId}
            className="pe-menu pe-menu-right"
            role="menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setMenu(false);
              }
            }}
          >
            <MenuItem
              testId="contents-move-up"
              onClick={() => {
                setMenu(false);
                step(game, id, -1);
              }}
            >
              Move up
            </MenuItem>
            <MenuItem
              testId="contents-move-down"
              onClick={() => {
                setMenu(false);
                step(game, id, 1);
              }}
            >
              Move down
            </MenuItem>
            <MenuItem
              testId="contents-move-to"
              onClick={() => {
                setMenu(false);
                onDialog('move');
              }}
            >
              Move to…
            </MenuItem>
            {section ? (
              <MenuItem
                onClick={() => {
                  setMenu(false);
                  onDialog('rename');
                }}
              >
                Rename the section
              </MenuItem>
            ) : (
              <MenuItem
                testId="contents-new-page-under"
                onClick={() => {
                  setMenu(false);
                  onDialog('new-page');
                }}
              >
                New page under this page
              </MenuItem>
            )}
            {!section && !mine ? (
              <>
                <MenuItem
                  checked={say === true}
                  testId="contents-file-listed"
                  onClick={() => {
                    setMenu(false);
                    sayListPage(game, id, say === true ? null : true);
                  }}
                >
                  File the pages this page lists under it
                </MenuItem>
                <MenuItem
                  checked={say === false}
                  testId="contents-file-none"
                  onClick={() => {
                    setMenu(false);
                    sayListPage(game, id, say === false ? null : false);
                  }}
                >
                  Do not file pages under this page
                </MenuItem>
                {say !== undefined ? (
                  <MenuItem
                    testId="contents-file-auto"
                    onClick={() => {
                      setMenu(false);
                      sayListPage(game, id, null);
                    }}
                  >
                    Let the app decide
                  </MenuItem>
                ) : null}
              </>
            ) : null}
            {!section && !mine ? (
              <MenuItem
                testId="contents-hide"
                onClick={() => {
                  setMenu(false);
                  const hide = !change?.hidden;
                  changeContents(
                    (o) => setPageHidden(o, id, hide, new Date()),
                    hide ? `Hid “${title}” from the contents` : `Showed “${title}” again`,
                  );
                }}
              >
                {change?.hidden ? 'Show the page again' : 'Hide the page'}
              </MenuItem>
            ) : null}
            {mine ? (
              <MenuItem
                danger
                testId="contents-delete"
                onClick={() => {
                  setMenu(false);
                  onDialog('delete');
                }}
              >
                {section ? 'Delete the section' : 'Delete the page'}
              </MenuItem>
            ) : null}
          </div>
        ) : null}
      </span>
    </div>
  );
}

function NameDialog({
  title,
  initial,
  action,
  onName,
  onClose,
}: {
  title: string;
  initial: string;
  action: string;
  onName: (name: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputId = useId();
  const name = pageTitle(text);
  return (
    <Modal title={title} onClose={onClose} testId="name-dialog">
      <form
        className="pe-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name) return;
          onClose();
          onName(name);
        }}
      >
        <label htmlFor={inputId}>Name of the section</label>
        <input
          id={inputId}
          className="own-input"
          autoFocus
          value={text}
          data-testid="name-input"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="own-pill-button own-pill-primary" disabled={!name}>
            {action}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * A heading of a list page shown as a level: no handle, as it comes from
 * the page's text and moves with it. Its pages can be moved out of it, and
 * it can be made a page of one's own.
 */
function LevelRow({
  game,
  level,
  depth,
  under,
  open,
  onFold,
  refused,
  canChange,
  onOwn,
}: {
  game: LoadedGame;
  level: ShownLevel;
  depth: number;
  under: number;
  open: boolean;
  onFold: (open: boolean) => void;
  /** A page is dragged over it, where none can be dropped. */
  refused: boolean;
  canChange: boolean;
  onOwn: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const page = titleOf(game, level.page);
  return (
    <div
      className={`pe-tree-row pe-tree-level${refused ? ' pe-drop-refused' : ''}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      data-entry={level.id}
      data-kind="level"
      data-testid="contents-level"
    >
      <span className="pe-drag-spacer" aria-hidden="true" />
      <span className="pe-tick-spacer" aria-hidden="true" />
      {under > 0 ? (
        <button
          type="button"
          className="pe-tree-fold"
          aria-expanded={open}
          aria-label={
            open ? `Hide the pages under “${level.title}”` : `Show the pages under “${level.title}”`
          }
          title={open ? 'Hide the pages under it' : 'Show the pages under it'}
          data-testid="contents-fold"
          onClick={() => {
            onFold(!open);
          }}
        >
          <UiIcon name={open ? 'chevronDown' : 'chevron'} size={14} />
        </button>
      ) : null}
      <span
        className="pe-tree-name pe-tree-level-name"
        title={`A heading of “${page}”: the pages it lists under this heading are shown here.`}
      >
        <UiIcon name="heading" size={14} />
        {level.title}
      </span>
      <span className="pe-tag" title={`A heading of “${page}”`}>
        Heading
      </span>
      <span className="pe-menu-anchor">
        <button
          type="button"
          className="pe-tree-more"
          aria-label={`More for “${level.title}”`}
          title="Make it a page of your own"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          disabled={!canChange}
          data-testid="contents-more"
          onClick={() => {
            setMenu(!menu);
          }}
        >
          <UiIcon name="more" size={16} />
        </button>
        {menu ? (
          <div
            id={menuId}
            className="pe-menu pe-menu-right"
            role="menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setMenu(false);
              }
            }}
          >
            <MenuItem
              testId="contents-level-own"
              onClick={() => {
                setMenu(false);
                onOwn();
              }}
            >
              Make this a page of my own
            </MenuItem>
            <p className="pe-menu-note">
              {`A page named “${level.title}” under “${page}”, with these pages under it and listed in its text.`}
            </p>
          </div>
        ) : null}
      </span>
    </div>
  );
}

/**
 * "New level from these": names a page of one's own put where the first
 * ticked page is, with the ticked pages under it; its text may list them.
 */
function LevelDialog({
  game,
  ids,
  onMake,
  onClose,
}: {
  game: LoadedGame;
  ids: readonly string[];
  onMake: (name: string, list: boolean) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [list, setList] = useState(true);
  const inputId = useId();
  const listId = useId();
  const name = pageTitle(text);
  const first = ids[0];
  return (
    <Modal title="New level from the ticked pages" onClose={onClose} testId="level-dialog">
      <form
        className="pe-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name) return;
          onClose();
          onMake(name, list);
        }}
      >
        <p className="own-dialog-line">
          {`A page of your own, where “${first ? titleOf(game, first) : ''}” is now, with the ${
            ids.length === 1 ? 'page' : `${ids.length} pages`
          } you ticked under it, in their order.`}
        </p>
        <label htmlFor={inputId}>Name of the level</label>
        <input
          id={inputId}
          className="own-input"
          autoFocus
          value={text}
          data-testid="level-name"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <label className="pe-check" htmlFor={listId}>
          <input
            id={listId}
            type="checkbox"
            checked={list}
            data-testid="level-list"
            onChange={(event) => {
              setList(event.target.checked);
            }}
          />
          List the pages in its text
        </label>
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            disabled={!name}
            data-testid="level-make"
          >
            Make the level
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/**
 * "Move to…": the top of the contents, a section not inside what is moved,
 * or (for pages) under another page, found by its title. Several pages go
 * together, in their order; those that cannot go there stay.
 */
function MoveDialog({
  game,
  ids,
  onClose,
  onMoved,
}: {
  game: LoadedGame;
  ids: readonly string[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const shown = shownContentsOf(game).layout;
  const id = ids[0]!;
  const many = ids.length > 1;
  const inside = new Set(ids.flatMap((one) => [...entriesWithin(shown, one)]));
  const parent = many ? undefined : (parentOf(shown, id) ?? null);
  const choices = sectionChoices(game).filter((s) => !inside.has(s.id));
  const page = ids.every((one) => !isSectionId(one));
  const [query, setQuery] = useState('');
  const queryId = useId();
  const loose = new Set(
    (game.pack.data.sections ?? []).filter((s) => s.placeByLinks === true).map((s) => s.id),
  );
  const words = query.trim().toLowerCase();
  // The first twenty pages whose title has the words, in contents order.
  const pages: { id: string; title: string }[] = [];
  if (page && words !== '') {
    for (const guide of guidesOf(game).contents.pages()) {
      if (inside.has(guide.id) || !guide.title.toLowerCase().includes(words)) continue;
      pages.push({ id: guide.id, title: guide.title });
      if (pages.length >= 20) break;
    }
  }
  const go = (to: ContentsParent) => {
    onClose();
    if (!many) {
      move(game, id, to, null);
      return;
    }
    if (moveMany(game, ids, to, null)) onMoved();
  };
  return (
    <Modal
      title={many ? `Move ${ids.length} pages to…` : `Move “${titleOf(game, id)}” to…`}
      onClose={onClose}
      testId="move-dialog"
    >
      <ul className="touch-plain-list pe-move-list">
        <li>
          <button
            type="button"
            className="pe-move-choice"
            disabled={parent === null}
            onClick={() => {
              go(null);
            }}
          >
            The top of the contents
          </button>
        </li>
        {choices.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="pe-move-choice"
              style={{ paddingLeft: 12 + section.depth * 16 }}
              disabled={section.id === parent}
              data-testid="move-choice"
              onClick={() => {
                go(section.id);
              }}
            >
              {section.title}
              {loose.has(section.id) && page ? (
                <span className="pe-move-note">
                  A page here is put under the page that links to it, when one does.
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {page ? (
        <div className="pe-form pe-move-under">
          <label htmlFor={queryId}>Or under a page: type part of its title</label>
          {many ? (
            <p className="pe-note">
              A page cannot go under itself or under a page beneath it: such pages stay where they
              are.
            </p>
          ) : null}
          <input
            id={queryId}
            className="own-input"
            value={query}
            data-testid="move-page-query"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          {words !== '' && pages.length === 0 ? (
            <p className="pe-note">No other page has that in its title.</p>
          ) : null}
          <ul className="touch-plain-list pe-move-list">
            {pages.map((target) => (
              <li key={target.id}>
                <button
                  type="button"
                  className="pe-move-choice"
                  disabled={target.id === parent}
                  data-testid="move-under-choice"
                  onClick={() => {
                    go(target.id);
                  }}
                >
                  {`Under “${target.title}”`}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <footer className="own-dialog-foot">
        <span className="own-space" />
        <button type="button" className="own-pill-button" onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Modal>
  );
}
