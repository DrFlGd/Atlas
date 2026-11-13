import { pageChange, setPageHidden } from '@atlas/core';
import { pageKey } from '@atlas/importer-api';
import type { OwnPages } from '@atlas/schema';
import { useEffect, useId, useMemo, useState } from 'react';
import { FollowLinksChoice } from '../components/FollowLinks';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import type { ListedPack, PackDetails } from '../desktop';
import { notify, switchGame } from '../state/actions';
import type { FollowLinks } from '../state/followLinks';
import { guidesOf } from '../state/guides';
import {
  readWikiContents,
  readWikiPages,
  stopRun,
  useImport,
  type WikiSource,
} from '../state/importing';
import { foundText, waitingForPerson } from '../state/importRun';
import { hasLibraryHost, openPageForEditing } from '../state/libraryView';
import { canChangeOwnPages, changeOwnPages, useOwnPages } from '../state/ownPages';
import { useAtlas, type LoadedGame } from '../state/store';
import { loadWikiNotes, NO_WIKI_NOTES, setWikiLeftOut, useWikiNotes } from '../state/wikiNotes';
import {
  WIKI_FILTERS,
  allRows,
  canTick,
  headingPages,
  headingTick,
  matchesFilter,
  readWhen,
  readingTime,
  unread,
  wikiGroups,
  type FoundRows,
  type ReadGuide,
  type WikiFilter,
  type WikiGroup,
  type WikiRow,
} from './wikiRows';

/**
 * The Library's screen of a wiki read as guides: its pages by the headings
 * of the wiki's contents, with where each stands (read, not read, could not
 * be read, left out), filters, a preview of the page chosen, and "Read n
 * pages" for the pages ticked. Everything here comes from this computer:
 * the contents as last read, the pages read, and the notes kept on them
 * (`wikiNotes.ts`). Nothing is fetched until the person starts a go;
 * the choice above "Read n pages" says how far that go follows the links
 * of the pages it reads (`followLinks.ts`).
 *
 * "Changed on the wiki" is not offered: telling would mean reading every
 * page again.
 */
export function WikiScreen({
  id,
  title,
  source,
  listed,
  details,
  children,
}: {
  id: string;
  title: string;
  source: WikiSource;
  listed: ListedPack | undefined;
  details: PackDetails | null;
  /** Cards shown under the list: the wiki's pictures, what it holds. */
  children?: React.ReactNode;
}) {
  const notes = useWikiNotes((s) => s.byImporter[source.importerId]) ?? NO_WIKI_NOTES;
  const game = useAtlas((s) => (s.game?.entry.id === id ? s.game : null));
  const own = useOwnPages((s) => s.own);
  const ownGameId = useOwnPages((s) => s.gameId);
  const phase = useImport((s) => s.phase);
  const [filter, setFilter] = useState<WikiFilter>('all');
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(null);
  const [contentsError, setContentsError] = useState<string | null>(null);

  useEffect(() => {
    void loadWikiNotes(source.importerId);
  }, [source.importerId]);

  const contents = source.address ? (notes.contents[pageKey(source.address)] ?? null) : null;
  const guides = useMemo(
    () => (game ? readGuides(game, ownGameId === id ? own : null) : []),
    [game, own, ownGameId, id],
  );
  const read = useMemo(() => details?.source.pages ?? listed?.pages ?? [], [details, listed]);
  const groups = useMemo(
    () => wikiGroups({ contents, read, guides, notes }),
    [contents, read, guides, notes],
  );
  const rows = useMemo(() => allRows(groups), [groups]);
  const byKey = useMemo(() => new Map(rows.map((row) => [row.key, row])), [rows]);
  const running =
    (phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running';
  // The pages of the go now: the one being read, and those still to come.
  const inRun = useMemo(() => {
    if (phase.kind !== 'run' || phase.run.status !== 'running') return new Map<string, string>();
    return new Map(
      phase.run.pages.flatMap((page): [string, string][] =>
        page.state.kind === 'open' || page.state.kind === 'converting'
          ? [
              [
                pageKey(page.url),
                page.state.kind === 'open' && page.state.attention
                  ? 'Waiting for you in the page window'
                  : 'Reading now',
              ],
            ]
          : page.state.kind === 'waiting'
            ? [
                [
                  pageKey(page.url),
                  page.foundOn ? 'Found by a link, next in this go' : 'Next in this go',
                ],
              ]
            : [],
      ),
    );
  }, [phase]);
  // The go's pages done, of all of them, and how many links found.
  const progress =
    phase.kind === 'run' && running
      ? {
          done: phase.run.pages.filter(
            (page) => page.state.kind === 'added' || page.state.kind === 'failed',
          ).length,
          total: phase.run.pages.length,
          found: foundText(phase.run),
          waiting: waitingForPerson(phase.run),
        }
      : null;

  const tickedRows = rows.filter((row) => ticked.has(row.key) && canTick(row));
  const counts = Object.fromEntries(
    WIKI_FILTERS.map((f) => [f.id, rows.filter((row) => matchesFilter(row, f.id)).length]),
  ) as Record<WikiFilter, number>;
  const selected = chosen ? (byKey.get(chosen) ?? null) : null;
  const shown = game !== null;

  const tick = (keys: readonly string[], on: boolean) => {
    setTicked((before) => {
      const next = new Set(before);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };
  const leaveOut = async (targets: readonly WikiRow[], out: boolean) => {
    await setWikiLeftOut(
      source.importerId,
      targets.map((row) => row.url),
      out,
    );
    tick(
      targets.map((row) => row.key),
      false,
    );
    // A page read is hidden from Guides too (or shown again), among the person's own pages.
    const wasRead = targets.filter((row) => row.readAt !== null || row.guideId !== null);
    if (wasRead.length > 0) {
      await hideInGuides(
        id,
        wasRead.map((row) => row.url),
        out,
      );
    }
  };
  const readNow = async (targets: readonly WikiRow[], follow: FollowLinks) => {
    try {
      await readWikiPages(
        source,
        contents?.game ?? title,
        targets.map((row) => ({
          url: row.url,
          title: row.title,
          ...(row.listed ? { group: row.group } : {}),
        })),
        follow,
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
    tick(
      targets.map((row) => row.key),
      false,
    );
  };

  const shownGroups = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) => matchesFilter(row, filter)),
      found: group.found
        .map((found) => ({ ...found, pages: found.pages.filter((p) => matchesFilter(p, filter)) }))
        .filter((found) => found.pages.length > 0),
    }))
    .filter((group) => group.rows.length > 0 || group.found.length > 0);
  // A short list, or a filter, shows every heading open.
  const allOpen = filter !== 'all' || rows.length <= 30 || groups.length <= 1;

  return (
    <div className="wiki-screen" data-testid="wiki-screen">
      <div className="wiki-filters" role="toolbar" aria-label="Show pages">
        {WIKI_FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`wiki-filter wiki-filter-${f.id}`}
            aria-pressed={filter === f.id}
            data-testid={`wiki-filter-${f.id}`}
            onClick={() => {
              setFilter(f.id);
            }}
          >
            {f.label} <span className="wiki-filter-count">{counts[f.id].toLocaleString('en')}</span>
          </button>
        ))}
      </div>
      <div className="wiki-body">
        <div className="wiki-list touch-scroll" data-testid="wiki-list" data-scroll-root>
          {contents ? null : (
            <div className="wiki-no-contents" data-testid="wiki-no-contents">
              <p>
                {source.address
                  ? 'The wiki’s contents have not been read on this computer yet, so only the pages read are listed.'
                  : 'This wiki’s importer gives no contents page, so only the pages read are listed.'}
              </p>
            </div>
          )}
          {shownGroups.length === 0 ? (
            <p className="muted wiki-empty" data-testid="wiki-empty">
              {filter === 'all' ? 'No pages yet.' : 'No page is in this state.'}
            </p>
          ) : (
            shownGroups.map((group) => (
              <Group
                key={group.title}
                group={group}
                whole={groups.find((g) => g.title === group.title)!}
                open={allOpen || open.has(group.title)}
                onOpen={(on) => {
                  setOpen((before) => {
                    const next = new Set(before);
                    if (on) next.add(group.title);
                    else next.delete(group.title);
                    return next;
                  });
                }}
                ticked={ticked}
                chosen={chosen}
                inRun={inRun}
                onTick={tick}
                onChoose={setChosen}
              />
            ))
          )}
          {source.address ? (
            <div className="wiki-contents-again">
              <button
                type="button"
                className="button"
                data-testid="wiki-read-contents"
                disabled={running}
                onClick={() => {
                  setContentsError(null);
                  void readWikiContents(source).then(setContentsError);
                }}
              >
                {contents ? 'Read the contents again' : 'Read the wiki’s contents'}
              </button>
              <p className="muted small">
                {contents
                  ? `The contents were read ${readWhen(contents.readAt).replace(/^Read /, '')}. Reading them again reads one page, the wiki’s list of pages, to find pages added since; no other page is read.`
                  : 'Reads one page, the wiki’s list of pages, so every page is listed here to tick. No other page is read.'}
              </p>
              {contentsError ? (
                <p className="download-error" role="alert" data-testid="wiki-contents-error">
                  {contentsError}
                </p>
              ) : null}
            </div>
          ) : null}
          {children}
        </div>
        <aside className="wiki-preview" data-testid="wiki-preview" aria-label="The page chosen">
          {selected ? (
            <Preview
              row={selected}
              game={game}
              rows={byKey}
              ticked={ticked.has(selected.key)}
              running={running}
              onTick={tick}
              // Read again and Try again read that page only.
              onRead={(row) => void readNow([row], 'ticked')}
              onLeaveOut={(row, out) => void leaveOut([row], out)}
              onShowGame={() => void switchGame(id)}
            />
          ) : (
            <div className="wiki-preview-empty">
              <p className="muted">
                Choose a page on the left to see where it stands
                {shown ? ', and its text when it was read' : ''}.
              </p>
              {shown ? null : (
                <>
                  <p className="muted small">
                    Show this wiki to see the text of the pages read here, edit them or leave them
                    out of Guides.
                  </p>
                  <button
                    type="button"
                    className="button"
                    data-testid="wiki-show-game"
                    onClick={() => void switchGame(id)}
                  >
                    Show this wiki
                  </button>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
      <footer className="wiki-foot" data-testid="wiki-foot">
        <FollowLinksChoice importerId={source.importerId} disabled={running} />
        <div className="wiki-foot-text">
          <strong data-testid="wiki-ticked">
            {tickedRows.length === 0
              ? 'No page ticked'
              : `${tickedRows.length.toLocaleString('en')} ${tickedRows.length === 1 ? 'page' : 'pages'} ticked`}
          </strong>
          <span className="muted small" data-testid="wiki-foot-sentence">
            {running
              ? `A go is reading pages now, one at a time with a pause${
                  progress
                    ? `: ${progress.done.toLocaleString('en')} of ${progress.total.toLocaleString('en')} done${progress.found ? `, ${progress.found}` : ''}`
                    : ''
                }.${
                  progress?.waiting
                    ? ' The page window is waiting for you: if the page asks you to confirm you are a person, answer it there. This app does not answer it for you.'
                    : ''
                } Stop ends it after the page open now.`
              : tickedRows.length > 0
                ? `${estimate(tickedRows.length, notes.follow, source.inWindow)}${source.pictures ? ' Pictures come with each page.' : ''}`
                : 'Tick the pages to read, then read them: one page at a time with a pause, only when you start.'}
          </span>
        </div>
        <button
          type="button"
          className="button"
          data-testid="wiki-tick-unread"
          disabled={!rows.some((row) => row.listed && unread(row))}
          onClick={() => {
            tick(
              rows.filter((row) => row.listed && unread(row)).map((row) => row.key),
              true,
            );
          }}
        >
          Tick every page not read
        </button>
        {running ? (
          <button
            type="button"
            className="button"
            data-testid="wiki-stop"
            onClick={() => {
              stopRun();
            }}
          >
            <UiIcon name="pause" size={16} />
            Stop after this page
          </button>
        ) : (
          <button
            type="button"
            className="button button-primary"
            data-testid="wiki-read"
            disabled={tickedRows.length === 0}
            onClick={() => void readNow(tickedRows, notes.follow)}
          >
            <UiIcon name="download" size={16} />
            {tickedRows.length === 1
              ? 'Read 1 page'
              : `Read ${tickedRows.length.toLocaleString('en')} pages`}
          </button>
        )}
      </footer>
    </div>
  );
}

/**
 * What a go reads, before it starts: a time only when it reads the pages
 * ticked alone; with links, how many pages there are is known only as
 * they are read.
 */
function estimate(ticked: number, follow: FollowLinks, inWindow: boolean): string {
  switch (follow) {
    case 'ticked':
      return `${readingTime(ticked, inWindow)}, one page at a time with a pause. Nothing else is read.`;
    case 'linked':
      return 'Plus the pages they link to: how many is known only as they are read, so this go may take a while. One page at a time with a pause.';
    case 'all':
      return 'Plus every page their links lead to, until no new page is found or you stop the go: how many is known only as they are read, so this go may take long, and the bar shows the count as it grows. One page at a time with a pause.';
  }
}

/**
 * Hides pages read from Guides, or shows them again, among the person's
 * own pages: those are changed for the game shown, so the wiki is shown
 * first (its files are read; nothing is fetched).
 */
async function hideInGuides(gameId: string, urls: readonly string[], hidden: boolean) {
  if (useAtlas.getState().game?.entry.id !== gameId) await switchGame(gameId);
  const game = useAtlas.getState().game;
  if (game?.entry.id !== gameId) return;
  await ownPagesSettled(gameId);
  if (!canChangeOwnPages()) {
    notify('Your pages of this wiki cannot be changed here, so the page stays in Guides.', 'error');
    return;
  }
  const keys = new Set(urls.map(pageKey));
  const ids = game.pack.data.guides
    .filter((guide) => guide.source && keys.has(pageKey(guide.source.url)))
    .map((guide) => guide.id);
  if (ids.length === 0) return;
  changeOwnPages(
    (pages) =>
      ids.reduce((next, guideId) => setPageHidden(next, guideId, hidden, new Date()), pages),
    hidden ? 'Left out a page' : 'Took a page back in',
  );
}

/** Waits until the person's pages of a game are read (or could not be), for a few seconds at most. */
function ownPagesSettled(gameId: string): Promise<void> {
  const settled = (s: ReturnType<typeof useOwnPages.getState>) =>
    s.gameId === gameId && (s.status === 'ready' || s.status === 'error');
  if (settled(useOwnPages.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, 5000);
    const stop = useOwnPages.subscribe((s) => {
      if (settled(s)) done();
    });
    function done() {
      window.clearTimeout(timer);
      stop();
      resolve();
    }
  });
}

/** The guides of the game shown that were read from pages, with whether the person changed each. */
function readGuides(game: LoadedGame, own: OwnPages | null): ReadGuide[] {
  const contents = guidesOf(game).contents;
  return game.pack.data.guides.flatMap((guide): ReadGuide[] => {
    if (!guide.source) return [];
    const page = own?.pages.find((p) => p.id === guide.id);
    return [
      {
        id: guide.id,
        title: guide.title,
        url: guide.source.url,
        section: contents.pathTo(guide.id).at(-1)?.title ?? null,
        changedByYou: pageChange(guide, page).changed,
      },
    ];
  });
}

/** Where a page stands, in a few words. */
function stateText(row: WikiRow, inRun: ReadonlyMap<string, string>): string {
  const now = inRun.get(row.key);
  if (now) return now;
  switch (row.state) {
    case 'left-out':
      return 'Left out';
    case 'failed':
      return `Could not be read: ${shortReason(row.failure?.message ?? '')}`;
    case 'not-read':
      return 'Not read';
    case 'read': {
      const parts = [readWhen(row.readAt)];
      if (row.changedByYou) parts.push('changed by you');
      if (row.links.length > 0) parts.push(`links to ${plural(row.links.length, 'page')}`);
      return parts.join(', ');
    }
  }
}

const plural = (n: number, noun: string) =>
  `${n.toLocaleString('en')} ${n === 1 ? noun : `${noun}s`}`;

/** The first sentence of a reason, short enough for a row. */
function shortReason(message: string): string {
  const first = message.split(/(?<=\.)\s/u)[0] ?? message;
  const plain = first.replace(/\.$/u, '');
  return plain.length > 80 ? `${plain.slice(0, 77)}…` : plain || 'see the page';
}

function Group({
  group,
  whole,
  open,
  onOpen,
  ticked,
  chosen,
  inRun,
  onTick,
  onChoose,
}: {
  group: WikiGroup;
  whole: WikiGroup;
  open: boolean;
  onOpen: (open: boolean) => void;
  ticked: ReadonlySet<string>;
  chosen: string | null;
  inRun: ReadonlyMap<string, string>;
  onTick: (keys: readonly string[], on: boolean) => void;
  onChoose: (key: string) => void;
}) {
  const id = useId();
  const read = whole.rows.filter((row) => row.state === 'read').length;
  // The heading ticks every page shown under it, those found on its pages too; never one left out.
  const tickable = headingPages(group);
  const box = headingTick(tickable, ticked);
  const tickedHere = headingPages(whole).filter((row) => ticked.has(row.key)).length;
  // A heading of thousands of pages shows them a step at a time, so the screen stays quick.
  const [shown, setShown] = useState(ROWS_STEP);
  const rowKeys = useMemo(() => new Set(group.rows.map((row) => row.key)), [group.rows]);
  const foundOn = useMemo(
    () => new Map(group.found.map((found) => [found.from.key, found])),
    [group.found],
  );
  return (
    <section className="wiki-group" data-testid="wiki-group" data-group={group.title}>
      <div className="wiki-group-head">
        <input
          id={id}
          type="checkbox"
          aria-label={`Tick the pages under ${group.title}`}
          data-testid="wiki-group-tick"
          checked={box.checked}
          disabled={box.disabled}
          ref={(input) => {
            if (input) input.indeterminate = box.indeterminate;
          }}
          onChange={() => {
            onTick(
              tickable.map((row) => row.key),
              !box.checked,
            );
          }}
        />
        <button
          type="button"
          className="wiki-group-title"
          aria-expanded={open}
          data-testid="wiki-group-open"
          onClick={() => {
            onOpen(!open);
          }}
        >
          <UiIcon name={open ? 'chevronDown' : 'chevron'} size={14} />
          <span>{group.title}</span>
        </button>
        <span className={`wiki-group-count${read === whole.rows.length ? ' is-done' : ''}`}>
          {read.toLocaleString('en')} of {whole.rows.length.toLocaleString('en')} read
          {tickedHere > 0 ? `, ${tickedHere.toLocaleString('en')} ticked` : ''}
        </span>
      </div>
      {open ? (
        <ul className="wiki-rows">
          {group.rows.slice(0, shown).map((row) => {
            const found = foundOn.get(row.key);
            return (
              <li key={row.key}>
                <PageRow
                  row={row}
                  ticked={ticked.has(row.key)}
                  chosen={chosen === row.key}
                  state={stateText(row, inRun)}
                  onTick={onTick}
                  onChoose={onChoose}
                />
                {found ? (
                  <FoundRow
                    key={`found-${row.key}`}
                    found={found}
                    inRun={inRun}
                    ticked={ticked}
                    onTick={onTick}
                    onChoose={onChoose}
                  />
                ) : null}
              </li>
            );
          })}
          {group.rows.length > shown ? (
            <li>
              <button
                type="button"
                className="button button-small wiki-rows-more"
                data-testid="wiki-rows-more"
                onClick={() => {
                  setShown((before) => before + ROWS_STEP);
                }}
              >
                Show {Math.min(ROWS_STEP, group.rows.length - shown).toLocaleString('en')} more of{' '}
                {(group.rows.length - shown).toLocaleString('en')} not shown
              </button>
            </li>
          ) : null}
          {/* Pages found on a page this filter hides. */}
          {group.found
            .filter((found) => !rowKeys.has(found.from.key))
            .map((found) => (
              <li key={`found-${found.from.key}`}>
                <FoundRow
                  found={found}
                  inRun={inRun}
                  ticked={ticked}
                  onTick={onTick}
                  onChoose={onChoose}
                />
              </li>
            ))}
        </ul>
      ) : null}
    </section>
  );
}

function PageRow({
  row,
  ticked,
  chosen,
  state,
  onTick,
  onChoose,
}: {
  row: WikiRow;
  ticked: boolean;
  chosen: boolean;
  state: string;
  onTick: (keys: readonly string[], on: boolean) => void;
  onChoose: (key: string) => void;
}) {
  return (
    <div
      className={`wiki-row wiki-row-${row.state}${chosen ? ' is-chosen' : ''}`}
      data-testid="wiki-row"
      data-state={row.state}
      data-url={row.url}
    >
      <input
        type="checkbox"
        aria-label={`Tick ${row.title} to read`}
        data-testid="wiki-row-tick"
        checked={ticked && canTick(row)}
        disabled={!canTick(row)}
        onChange={() => {
          onTick([row.key], !ticked);
        }}
      />
      <button
        type="button"
        className="wiki-row-title"
        aria-pressed={chosen}
        data-testid="wiki-row-open"
        onClick={() => {
          onChoose(row.key);
        }}
      >
        {row.title}
      </button>
      <span className={`wiki-row-state wiki-state-${row.state}`} data-testid="wiki-row-state">
        {state}
      </span>
    </div>
  );
}

/** Pages a heading shows at first, and how many more each "Show more" adds. */
const ROWS_STEP = 200;

/** "Daggers, Straight Swords and 94 more: Found on Weapons, not read". */
function FoundRow({
  found,
  inRun,
  ticked,
  onTick,
  onChoose,
}: {
  found: FoundRows;
  inRun: ReadonlyMap<string, string>;
  ticked: ReadonlySet<string>;
  onTick: (keys: readonly string[], on: boolean) => void;
  onChoose: (key: string) => void;
}) {
  const pages = found.pages.filter(canTick);
  const all = pages.length > 0 && pages.every((page) => ticked.has(page.key));
  const names = found.pages.slice(0, 2).map((page) => page.title);
  const more = found.pages.length - names.length;
  return (
    <div className="wiki-row wiki-row-found" data-testid="wiki-found" data-from={found.from.url}>
      <input
        type="checkbox"
        aria-label={`Tick the pages found on ${found.from.title}`}
        data-testid="wiki-found-tick"
        checked={all}
        disabled={pages.length === 0}
        onChange={() => {
          onTick(
            pages.map((page) => page.key),
            !all,
          );
        }}
      />
      <button
        type="button"
        className="wiki-row-title wiki-row-found-names"
        title={`Show ${found.from.title}, the page they were found on`}
        onClick={() => {
          onChoose(found.from.key);
        }}
      >
        {names.join(', ')}
        {more > 0 ? ` and ${more.toLocaleString('en')} more` : ''}
      </button>
      <span className="wiki-row-state">
        Found on {found.from.title},{' '}
        {found.pages.some((page) => inRun.has(page.key)) ? 'being read in this go' : 'not read'}
      </span>
    </div>
  );
}

/** The page chosen: where it stands, its text when read, and what can be done with it. */
function Preview({
  row,
  game,
  rows,
  ticked,
  running,
  onTick,
  onRead,
  onLeaveOut,
  onShowGame,
}: {
  row: WikiRow;
  game: LoadedGame | null;
  rows: ReadonlyMap<string, WikiRow>;
  ticked: boolean;
  running: boolean;
  onTick: (keys: readonly string[], on: boolean) => void;
  onRead: (row: WikiRow) => void;
  onLeaveOut: (row: WikiRow, out: boolean) => void;
  onShowGame: () => void;
}) {
  const ownStatus = useOwnPages((s) => s.status);
  const guide =
    game && row.guideId
      ? (guidesOf(game).contents.guide(row.guideId) ??
        game.pack.data.guides.find((g) => g.id === row.guideId))
      : undefined;
  // The pages it links to that were not read and are not left out.
  const linked = row.links
    .map((url) => rows.get(pageKey(url)))
    .filter((other): other is WikiRow => other !== undefined && unread(other));
  const editable = hasLibraryHost() && ownStatus === 'ready' && row.guideId !== null;
  const leftOut = row.state === 'left-out';

  return (
    <div className="wiki-preview-page" data-testid="wiki-preview-page" data-url={row.url}>
      <h2>{row.title}</h2>
      <p className="muted small" data-testid="wiki-preview-state">
        {leftOut
          ? 'Left out. It is not ticked or read, and if it was read it is hidden from Guides.'
          : row.state === 'read'
            ? `${readWhen(row.readAt)}.${row.changedByYou ? ' Changed by you: your changes are kept apart from the wiki’s text.' : ''}`
            : row.state === 'failed'
              ? `Could not be read: ${row.failure?.message ?? ''}`
              : row.listed
                ? `Not read. Listed under ${row.group} in the wiki’s contents.`
                : 'Not read. A page read links to it; the wiki’s contents do not list it.'}
      </p>
      {row.state === 'read' && row.failure ? (
        <p className="download-note small">Reading it again did not work: {row.failure.message}</p>
      ) : null}
      {row.state === 'read' || (leftOut && row.guideId) ? (
        guide ? (
          <div className="wiki-preview-text" data-testid="wiki-preview-text">
            <MarkdownBody source={guide.body} className="guide-body" page />
          </div>
        ) : (
          <div className="wiki-preview-text wiki-preview-hidden">
            <p className="muted small">Show this wiki to see the text of the pages read here.</p>
            <button
              type="button"
              className="button"
              data-testid="wiki-preview-show"
              onClick={onShowGame}
            >
              Show this wiki
            </button>
          </div>
        )
      ) : null}
      {linked.length > 0 && !leftOut ? (
        <button
          type="button"
          className="button button-primary button-block"
          data-testid="wiki-tick-links"
          onClick={() => {
            onTick(
              linked.map((other) => other.key),
              true,
            );
          }}
        >
          {linked.length === 1
            ? 'Tick the page it links to'
            : `Tick the ${linked.length.toLocaleString('en')} pages it links to`}
        </button>
      ) : null}
      <div className="row-actions wrap">
        {leftOut ? (
          <button
            type="button"
            className="button"
            data-testid="wiki-take-back"
            onClick={() => {
              onLeaveOut(row, false);
            }}
          >
            Take it back in
          </button>
        ) : (
          <>
            {row.state === 'read' ? (
              <button
                type="button"
                className="button"
                data-testid="wiki-read-again"
                disabled={running}
                onClick={() => {
                  onRead(row);
                }}
              >
                Read again
              </button>
            ) : row.state === 'failed' ? (
              <button
                type="button"
                className="button"
                data-testid="wiki-try-again"
                disabled={running}
                onClick={() => {
                  onRead(row);
                }}
              >
                Try again
              </button>
            ) : (
              <button
                type="button"
                className="button"
                data-testid="wiki-tick-page"
                onClick={() => {
                  onTick([row.key], !ticked);
                }}
              >
                {ticked ? 'Untick it' : 'Tick it'}
              </button>
            )}
            {row.guideId && game ? (
              <button
                type="button"
                className="button"
                data-testid="wiki-edit"
                disabled={!editable && hasLibraryHost()}
                onClick={() => void openPageForEditing(row.guideId!, game.entry.id)}
              >
                {hasLibraryHost() ? 'Edit' : 'Read it in Guides'}
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              data-testid="wiki-leave-out"
              onClick={() => {
                onLeaveOut(row, true);
              }}
            >
              Leave out
            </button>
          </>
        )}
      </div>
      <p className="muted small" data-testid="wiki-preview-sentence">
        {leftOut
          ? 'Take it back in lets it be ticked and read again, and shows it in Guides again if it was read.'
          : [
              row.state === 'read'
                ? 'Read again fetches the page from the wiki now.'
                : row.state === 'failed'
                  ? 'Try again fetches the page from the wiki now.'
                  : 'Tick it adds it to the pages to read; nothing is read until you start.',
              row.guideId && game
                ? hasLibraryHost()
                  ? 'Edit changes your copy, in Guides; the wiki’s text is kept apart.'
                  : 'Read it in Guides opens the page there.'
                : null,
              row.state === 'read'
                ? 'Leave out hides it from Guides and skips it from now on.'
                : 'Leave out skips it from now on.',
            ]
              .filter(Boolean)
              .join(' ')}
      </p>
    </div>
  );
}
