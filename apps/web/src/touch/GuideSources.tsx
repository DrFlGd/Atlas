import type { GuideEntry } from '@atlas/schema';
import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { guidesOf, hasMap } from '../state/guides';
import {
  chooseGuideSource,
  isReadInOrder,
  readingOrder,
  useGuideSources,
} from '../state/guideSources';
import { useOwnPages } from '../state/ownPages';
import type { LoadedGame } from '../state/store';
import { GuidesFromGames } from './GuidesFromGames';
import { typingOrDialog } from './keys';
import { keysOf } from '../input/bindings';
import { openPlace } from './reader';
import type { SourceView } from './sourceView';
import '../styles/guideSources.css';

/**
 * Which source of pages Guides shows (see `state/guideSources.ts`): a
 * switcher at the top of Guides, as the maps menu is at the top of the
 * map, that lists the game's own pages and those of each game read with
 * it, each with its site where known and whether it is a guide or a wiki.
 * It is there when there are two sources or more. The contents, the
 * landing page and the way above a page show the source chosen; a page of
 * another source, opened by a link or a search, shows its source.
 *
 * A guide is read in order: each page ends with Previous and Next, and
 * its landing page offers to continue at the page read last.
 */

// ---------------------------------------------------------------------------
// The switcher

/**
 * The source shown, at the top of Guides, which opens the list of sources.
 * There when there are two or more; with one, a game with a map still
 * offers guides of other games under its landing page.
 */
export function SourceSwitcher({ game, view }: { game: LoadedGame; view: SourceView }) {
  const [open, setOpen] = useState(false);
  const chip = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { sources, shown, names } = view;
  if (sources.length < 2 || !shown) return null;
  const close = (focusChip = true) => {
    setOpen(false);
    if (focusChip) chip.current?.focus();
  };
  return (
    <div className="guides-sources" data-testid="guides-sources">
      <button
        ref={chip}
        type="button"
        className="guides-source-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Pages shown: ${names.get(shown.gameId) ?? shown.title}, ${view.inOrder ? 'a guide' : 'a wiki'}. Choose which to read`}
        data-testid="guides-source-chip"
        data-source={shown.gameId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <UiIcon name="book" size={18} />
        <span className="guides-source-chip-name">{names.get(shown.gameId) ?? shown.title}</span>
        <TypeTag inOrder={view.inOrder} />
        <UiIcon name="chevronDown" size={14} strokeWidth={2} />
      </button>
      {open ? (
        <SourcesMenu
          id={menuId}
          game={game}
          view={view}
          onClose={close}
          onChoose={(source) => {
            close();
            chooseGuideSource(game.pack.manifest.gameId, source);
            openPlace({ kind: 'home', source });
          }}
        />
      ) : null}
    </div>
  );
}

/** "Guide" or "Wiki", beside a source's name. */
function TypeTag({ inOrder }: { inOrder: boolean }) {
  return (
    <span className="guides-source-type" data-testid="guides-source-type">
      {inOrder ? 'Guide' : 'Wiki'}
    </span>
  );
}

function SourcesMenu({
  id,
  game,
  view,
  onClose,
  onChoose,
}: {
  id: string;
  game: LoadedGame;
  view: SourceView;
  onClose: (focusChip?: boolean) => void;
  onChoose: (source: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const state = useGuideSources();
  const own = useOwnPages();
  const { sources, shown, names } = view;
  // The source shown has the focus, so the arrow keys and Enter choose from there.
  useEffect(() => {
    list.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
  }, []);
  return (
    <>
      <div
        className="guides-sources-scrim"
        aria-hidden="true"
        onClick={() => {
          onClose(false);
        }}
      />
      <div
        ref={list}
        id={id}
        className="guides-sources-menu"
        role="dialog"
        aria-label="Pages to read"
        data-testid="guides-sources-menu"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const rows = [
              ...(list.current?.querySelectorAll<HTMLButtonElement>('.guides-source-row') ?? []),
            ];
            const at = rows.indexOf(document.activeElement as HTMLButtonElement);
            const step = event.key === 'ArrowDown' ? 1 : rows.length - 1;
            rows[(at + step) % rows.length]?.focus();
          }
        }}
      >
        <h2 className="guides-sources-title">Pages to read</h2>
        <ul className="touch-plain-list">
          {sources.map((source) => {
            const current = source.gameId === shown?.gameId;
            const inOrder = isReadInOrder(source, state, own);
            return (
              <li key={source.gameId}>
                <button
                  type="button"
                  className="guides-source-row"
                  aria-current={current ? 'true' : undefined}
                  data-testid="guides-source"
                  data-source={source.gameId}
                  onClick={() => {
                    onChoose(source.gameId);
                  }}
                >
                  <UiIcon name="book" size={20} />
                  <span className="guides-source-row-text">
                    <span className="guides-source-row-name">
                      {names.get(source.gameId) ?? source.title}
                    </span>
                    {source.site ? (
                      <span className="guides-source-row-site" data-testid="guides-source-site">
                        {source.site}
                      </span>
                    ) : null}
                  </span>
                  <TypeTag inOrder={inOrder} />
                  <span className="touch-menu-row-check">
                    {current ? <UiIcon name="check" size={18} strokeWidth={2.2} /> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {hasMap(game) ? (
          <div className="guides-sources-add">
            <GuidesFromGames
              game={game}
              addOnly
              onAdded={(source) => {
                onChoose(source);
              }}
            />
          </div>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reading a guide in order

/** Keys that turn the pages of a guide: `[` the previous page, `]` the next (see `input/bindings.ts`). */
const [PREVIOUS_KEY, NEXT_KEY] = keysOf('turn-page') as [string, string];

/**
 * At the end of a page of a guide (or on its landing page): the page
 * before it and the page after it in the guide's order, each with its
 * title. `[` and `]` turn the pages too.
 */
export function PreviousNext({
  previous,
  next,
  name,
  home,
}: {
  previous: GuideEntry | null;
  next: GuideEntry | null;
  /** The source's name, which its home page goes by. */
  name: string;
  home: string | null;
}) {
  const go = (page: GuideEntry) => {
    openPlace({ kind: 'page', guideId: page.id });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || typingOrDialog(event)) return;
      const page = event.key === PREVIOUS_KEY ? previous : event.key === NEXT_KEY ? next : null;
      if (!page) return;
      event.preventDefault();
      go(page);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [previous, next]);
  if (!previous && !next) return null;
  const title = (page: GuideEntry) => (page.id === home ? name : page.title);
  return (
    <nav className="guides-sequence" aria-label="Read in order" data-testid="guides-sequence">
      {previous ? (
        <button
          type="button"
          className="guides-sequence-link"
          aria-keyshortcuts={PREVIOUS_KEY}
          data-testid="guides-previous"
          onClick={() => {
            go(previous);
          }}
        >
          <span className="guides-sequence-word">
            <UiIcon name="back" size={16} />
            Previous
          </span>
          <span className="guides-sequence-title">{title(previous)}</span>
        </button>
      ) : (
        <span aria-hidden="true" />
      )}
      {next ? (
        <button
          type="button"
          className="guides-sequence-link guides-sequence-next"
          aria-keyshortcuts={NEXT_KEY}
          data-testid="guides-next"
          onClick={() => {
            go(next);
          }}
        >
          <span className="guides-sequence-word">
            Next
            <UiIcon name="forward" size={16} />
          </span>
          <span className="guides-sequence-title">{title(next)}</span>
        </button>
      ) : null}
    </nav>
  );
}

/**
 * On the landing page of a guide: "Continue", to the page read last in it,
 * when there is one and it is still in the guide.
 */
export function ContinueReading({ game, view }: { game: LoadedGame; view: SourceView }) {
  const { shown, inOrder } = view;
  const last = useGuideSources((s) => (shown ? s.readLast[shown.gameId] : undefined));
  if (!shown || !inOrder || !last) return null;
  const page = readingOrder(game, shown).find((entry) => entry.id === last);
  if (!page || page.id === shown.home?.id) return null;
  const title = guidesOf(game).contents.guide(page.id)?.title ?? page.title;
  return (
    <div className="guides-continue" data-testid="guides-continue">
      <button
        type="button"
        className="touch-button guides-continue-button"
        data-testid="guides-continue-button"
        onClick={() => {
          openPlace({ kind: 'page', guideId: page.id });
        }}
      >
        <UiIcon name="forward" size={18} />
        Continue
      </button>
      <span className="guides-continue-title">
        You last read <strong>{title}</strong>.
      </span>
    </div>
  );
}
