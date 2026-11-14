import { useEffect, useId, useRef, useState } from 'react';
import type { GameGroup } from '@atlas/schema';
import {
  acceptOffer,
  canChangeGameGroups,
  dismissOffer,
  namesOfSources,
  offeredTitle,
  presentMembers,
  renameTitle,
  showSeparately,
  showWithAnother,
  takeOutOfTitle,
  useGameGroups,
  useOfferFor,
  useSourceNames,
  useTitleOf,
  whyGroupsCannotChange,
} from '../state/gameGroups';
import { useAtlas } from '../state/store';

/**
 * Games shown under one title (see `state/gameGroups.ts`), where they are
 * made and undone: in Games (the Android app, a browser) and in the
 * Library (the desktop app), in either layout. Every part says the same
 * plain thing: each source stays a whole game, with its own found marks,
 * lists, locations, notes and progress, and nothing is lost when they are
 * shown separately again.
 */

/** The sentence said wherever a title is made. */
export const KEPT_APART =
  'Each source stays a whole game: found marks, lists, locations, notes and progress stay with the source they were made on.';

/** "Sources: A, B", for a title's row. */
export function SourcesLine({ group, className }: { group: GameGroup; className?: string }) {
  const names = useSourceNames(group);
  const catalog = useAtlas((s) => s.catalog);
  const listed = presentMembers(group, catalog).map((entry) => names.get(entry.id) ?? entry.title);
  return (
    <span className={className} data-testid="title-sources">
      Sources: {listed.join(', ')}
    </span>
  );
}

/**
 * "Show with another game under one title": choose the other game, then
 * the title (the first game's, or one typed). A game under a title already
 * brings its title's other games along.
 */
export function ShowWithAnotherForm({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const catalog = useAtlas((s) => s.catalog);
  const groups = useGameGroups((s) => s.groups);
  const own = useTitleOf(gameId);
  const entry = catalog.find((e) => e.id === gameId);
  const ownIds = new Set(own?.members.map((m) => m.gameId) ?? [gameId]);
  const choices = catalog.filter((e) => !ownIds.has(e.id));
  const [other, setOther] = useState<string | null>(choices.length === 1 ? choices[0]!.id : null);
  const [title, setTitle] = useState(own?.title ?? entry?.title ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const titleId = useId();
  const choiceName = useId();
  const blocked = useGameGroups((s) => whyGroupsCannotChange(s));
  const name = own ? own.title : (entry?.title ?? gameId);
  const groupOfOther = (id: string) =>
    groups.find((g) => g.members.some((member) => member.gameId === id));
  return (
    <form
      className="download-confirm title-form"
      aria-label="Show with another game under one title"
      data-testid="title-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!other) {
          setProblem('Choose the other game.');
          return;
        }
        if (!title.trim()) {
          setProblem('Give the title a name.');
          return;
        }
        setWorking(true);
        void showWithAnother(gameId, other, title).then((done) => {
          setWorking(false);
          if (done) onClose();
        });
      }}
    >
      <p>
        <strong>Show {name} with another game under one title</strong>
      </p>
      {choices.length === 0 ? (
        <p className="muted">No other game is on this device yet.</p>
      ) : (
        <fieldset className="title-choices">
          <legend className="title-legend">The other game</legend>
          {choices.map((choice) => {
            const under = groupOfOther(choice.id);
            return (
              <label key={choice.id} className="title-choice" data-testid="title-choice">
                <input
                  type="radio"
                  name={choiceName}
                  value={choice.id}
                  checked={other === choice.id}
                  disabled={working}
                  onChange={() => {
                    setOther(choice.id);
                    setProblem(null);
                  }}
                />
                <span>
                  {choice.title}
                  {under ? (
                    <span className="muted"> · under {under.title}, which comes along</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </fieldset>
      )}
      <label htmlFor={titleId} className="title-legend">
        Title
      </label>
      <input
        id={titleId}
        className="text-input title-input"
        maxLength={200}
        data-testid="title-name"
        value={title}
        disabled={working}
        onChange={(event) => {
          setTitle(event.target.value);
          setProblem(null);
        }}
      />
      <p className="muted small title-kept">{KEPT_APART} You can show them separately again.</p>
      {(problem ?? blocked) ? (
        <p className="download-error" role="alert">
          {problem ?? blocked}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="submit"
          className="button button-primary"
          data-testid="title-save"
          disabled={working || choices.length === 0 || blocked !== null}
        >
          {working ? 'Saving…' : 'Show under one title'}
        </button>
        <button type="button" className="button" disabled={working} onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * A title's sources, each with its name and its game's title, the one
 * shown marked, a way to open each (`onOpen`) and to take it out; renaming
 * the title, adding another game, and "Show separately again".
 */
export function TitleSourcesPanel({
  group,
  shownId,
  openLabel = 'Show',
  onOpen,
}: {
  group: GameGroup;
  /** The source shown, or open in the Library. */
  shownId: string | null;
  openLabel?: string;
  onOpen: (gameId: string) => void;
}) {
  const catalog = useAtlas((s) => s.catalog);
  const names = useSourceNames(group);
  const editable = useGameGroups((s) => canChangeGameGroups(s));
  const why = useGameGroups((s) => whyGroupsCannotChange(s));
  const [mode, setMode] = useState<'rename' | 'add' | null>(null);
  const present = presentMembers(group, catalog);
  const away = group.members.length - present.length;
  return (
    <div className="title-panel" data-testid="title-panel" data-group={group.id}>
      <ul className="title-sources-list">
        {present.map((entry) => {
          const name = names.get(entry.id) ?? entry.title;
          const shown = entry.id === shownId;
          return (
            <li
              key={entry.id}
              className="title-source"
              data-testid="title-source"
              data-pack={entry.id}
            >
              <span className="title-source-text">
                <span className="title-source-name">{name}</span>
                <span className="muted small">
                  {entry.title}
                  {shown ? ' · shown' : ''}
                </span>
              </span>
              {!shown ? (
                <button
                  type="button"
                  className="button button-small"
                  data-testid="title-source-open"
                  aria-label={`${openLabel} ${name}`}
                  onClick={() => {
                    onOpen(entry.id);
                  }}
                >
                  {openLabel}
                </button>
              ) : null}
              {editable ? (
                <button
                  type="button"
                  className="button button-small"
                  data-testid="title-source-out"
                  aria-label={`Take ${name} out of ${group.title}`}
                  onClick={() => void takeOutOfTitle(entry.id, name)}
                >
                  Take out
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {away > 0 ? (
        <p className="muted small" data-testid="title-away">
          {away === 1
            ? 'One more source of this title is not on this device. It shows here once it is.'
            : `${away} more sources of this title are not on this device. They show here once they are.`}
        </p>
      ) : null}
      <p className="muted small title-kept">{KEPT_APART}</p>
      {why && !editable ? <p className="muted small">{why}</p> : null}
      {editable ? (
        <div className="row-actions">
          <button
            type="button"
            className="button button-small"
            aria-expanded={mode === 'rename'}
            data-testid="title-rename"
            onClick={() => {
              setMode(mode === 'rename' ? null : 'rename');
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            className="button button-small"
            aria-expanded={mode === 'add'}
            data-testid="title-add"
            onClick={() => {
              setMode(mode === 'add' ? null : 'add');
            }}
          >
            Add another game…
          </button>
          <button
            type="button"
            className="button button-small"
            data-testid="title-separate"
            onClick={() => void showSeparately(group)}
          >
            Show separately again
          </button>
        </div>
      ) : null}
      {mode === 'rename' ? (
        <RenameTitleForm
          group={group}
          onClose={() => {
            setMode(null);
          }}
        />
      ) : null}
      {mode === 'add' && present[0] ? (
        <ShowWithAnotherForm
          gameId={present[0].id}
          onClose={() => {
            setMode(null);
          }}
        />
      ) : null}
    </div>
  );
}

function RenameTitleForm({ group, onClose }: { group: GameGroup; onClose: () => void }) {
  const [title, setTitle] = useState(group.title);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <form
      className="inline-form title-rename"
      data-testid="title-rename-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim()) {
          setProblem('Give the title a name.');
          return;
        }
        setWorking(true);
        void renameTitle(group.id, title).then((done) => {
          setWorking(false);
          if (done) onClose();
        });
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        New name of {group.title}
      </label>
      <input
        ref={ref}
        id={inputId}
        className="text-input"
        maxLength={200}
        data-testid="title-rename-input"
        value={title}
        disabled={working}
        onChange={(event) => {
          setTitle(event.target.value);
          setProblem(null);
        }}
      />
      <button type="submit" className="button button-small button-primary" disabled={working}>
        Rename
      </button>
      <button type="button" className="button button-small" disabled={working} onClick={onClose}>
        Cancel
      </button>
      {problem ? (
        <p className="download-error" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The Importer's offer, once, after a game is added whose title is the
 * same as one here: show them under one title, or keep them apart.
 */
export function SameTitleOfferCard({ gameId }: { gameId: string | null }) {
  const offer = useOfferFor(gameId);
  const catalog = useAtlas((s) => s.catalog);
  const groups = useGameGroups((s) => s.groups);
  const [title, setTitle] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const inputId = useId();
  if (!offer) return null;
  const entry = catalog.find((e) => e.id === offer.gameId);
  const others = offer.others.flatMap((id) => {
    const other = catalog.find((e) => e.id === id);
    if (!other) return [];
    const under = groups.find((g) => g.members.some((m) => m.gameId === id));
    return [under ? `${other.title} (under ${under.title})` : other.title];
  });
  const shownTitle = title ?? offeredTitle(offer);
  const group = groups.find((g) => g.members.some((m) => m.gameId === offer.others[0]));
  const names = group ? namesOfSources(group) : null;
  return (
    <section
      className="download-confirm title-offer"
      aria-label="Show under one title?"
      data-testid="title-offer"
      data-pack={offer.gameId}
    >
      <p>
        <strong>{entry?.title ?? offer.gameId}</strong> has the same title as {others.join(' and ')}
        , already here. Show them under one title?
      </p>
      {names && names.size > 0 ? (
        <p className="muted small">Sources now: {[...names.values()].join(', ')}.</p>
      ) : null}
      <label htmlFor={inputId} className="title-legend">
        Title
      </label>
      <input
        id={inputId}
        className="text-input title-input"
        maxLength={200}
        data-testid="title-offer-name"
        value={shownTitle}
        disabled={working}
        onChange={(event) => {
          setTitle(event.target.value);
        }}
      />
      <p className="muted small title-kept">{KEPT_APART}</p>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="title-offer-accept"
          disabled={working || shownTitle.trim() === ''}
          onClick={() => {
            setWorking(true);
            void acceptOffer(offer, shownTitle).then(() => {
              setWorking(false);
            });
          }}
        >
          Show under one title
        </button>
        <button
          type="button"
          className="button"
          data-testid="title-offer-dismiss"
          disabled={working}
          onClick={() => {
            dismissOffer(offer);
          }}
        >
          Keep them apart
        </button>
      </div>
    </section>
  );
}
