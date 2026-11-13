import type { Candidate, PageMatch, TargetInfo } from '@atlas/core';
import type { LinkChoice } from '@atlas/schema';
import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { notify } from '../state/actions';
import {
  canChangeGuideLinks,
  forgetChoice,
  linkPage,
  linkPages,
  skipPage,
  useGuideLinks,
} from '../state/guideLinks';
import {
  linkedTargets,
  locationsText,
  mapNamesOf,
  pageMatchesOf,
  targetText,
} from '../state/guideMatches';
import type { LoadedGame } from '../state/store';
import { openPlace } from './reader';
import { useTouch } from './state';

/**
 * "Link pages to the map", in the Guides section: the pages read from a
 * site, compared by name with the game's types, location names and
 * regions, in three groups (sure, unsure, no match), each page with what
 * it would link to and how many locations. The person confirms, changes
 * (another target, found by name) or skips each page; "Confirm all sure"
 * confirms the first group at once. Nothing is linked without their say,
 * and what they said is kept (see `guideLinks.ts`).
 *
 * Done where there is room, as the list editor is: on a phone the links
 * are used, and this says it is done on a larger screen.
 */
export function GuideLinksReview({ game }: { game: LoadedGame }) {
  const room = useTouch((s) => s.editorRoom);
  const choices = useGuideLinks((s) => s.links.choices);
  const status = useGuideLinks((s) => s.status);
  const error = useGuideLinks((s) => s.error);
  const readOnly = useGuideLinks((s) => s.readOnly);
  const save = useGuideLinks((s) => s.save);
  const saveError = useGuideLinks((s) => s.saveError);
  // Pages of other games come and go with them.
  useGuideLinks((s) => s.others);
  const matches = pageMatchesOf(game);
  const editable = status === 'ready' && readOnly === null;

  const groups = useMemo(() => {
    const open: Record<'sure' | 'unsure' | 'none', PageMatch[]> = {
      sure: [],
      unsure: [],
      none: [],
    };
    const done: PageMatch[] = [];
    for (const match of matches) {
      if (choices[match.guideId]) done.push(match);
      else open[match.group].push(match);
    }
    return { ...open, done };
  }, [matches, choices]);
  const linked = groups.done.filter((m) => choices[m.guideId]?.state === 'linked').length;
  const skipped = groups.done.length - linked;

  return (
    <div className="guide-links" data-testid="guide-links">
      <h1 className="guides-title">Link pages to the map</h1>
      <p className="guides-lead">
        Atlas compared the names of {matches.length === 1 ? '1 page' : `${matches.length} pages`}{' '}
        with the locations, types and regions of {game.pack.manifest.title}. Nothing is linked until
        you confirm it. A linked page shows on the cards of its locations, and the page can show
        them on the map.
      </p>
      <p className="guide-links-status" data-testid="guide-links-status" aria-live="polite">
        {linked === 1 ? '1 page linked' : `${linked} pages linked`}
        {skipped > 0 ? ` · ${skipped} skipped` : ''}
        {' · '}
        {save === 'saving'
          ? 'Saving…'
          : save === 'unsaved'
            ? 'Not saved yet'
            : save === 'failed'
              ? `Not saved: ${saveError ?? 'unknown error'}`
              : 'Saved'}
      </p>
      {status === 'error' ? <p className="touch-note">{error}</p> : null}
      {readOnly ? <p className="touch-note">{readOnly}</p> : null}
      {!room ? (
        <p className="touch-note" data-testid="guide-links-phone-note">
          Pages are linked to the map on a larger screen: a tablet on its side, or a computer. The
          links made there are used here.
        </p>
      ) : (
        <>
          <ReviewGroup
            game={game}
            title="Sure"
            line="One clear match by name."
            testId="links-sure"
            matches={groups.sure}
            choices={choices}
            editable={editable}
            action={
              groups.sure.length > 1 && editable ? (
                <button
                  type="button"
                  className="touch-button touch-button-primary guide-links-all"
                  data-testid="link-confirm-all"
                  onClick={() => {
                    const all = groups.sure.flatMap((m) =>
                      m.candidates[0]
                        ? [{ guideId: m.guideId, target: m.candidates[0].target }]
                        : [],
                    );
                    if (linkPages(all)) notify(`Linked ${all.length} pages to the map.`);
                  }}
                >
                  <UiIcon name="check" size={18} strokeWidth={2.2} />
                  Confirm all sure
                </button>
              ) : null
            }
          />
          <ReviewGroup
            game={game}
            title="Unsure"
            line="Several possible matches, or only a near one. Check the suggestion."
            testId="links-unsure"
            matches={groups.unsure}
            choices={choices}
            editable={editable}
          />
          <ReviewGroup
            game={game}
            title="No match"
            line="Nothing on the map has this name. Pick something yourself, or skip the page."
            testId="links-none"
            matches={groups.none}
            choices={choices}
            editable={editable}
          />
          <ReviewGroup
            game={game}
            title="Done"
            line="Pages you linked or skipped. Reading the pages again keeps these."
            testId="links-done"
            matches={groups.done}
            choices={choices}
            editable={editable}
          />
        </>
      )}
    </div>
  );
}

function ReviewGroup({
  game,
  title,
  line,
  testId,
  matches,
  choices,
  editable,
  action,
}: {
  game: LoadedGame;
  title: string;
  line: string;
  testId: string;
  matches: readonly PageMatch[];
  choices: Record<string, LinkChoice>;
  editable: boolean;
  action?: React.ReactNode;
}) {
  const headingId = useId();
  if (matches.length === 0) return null;
  return (
    <section className="guide-links-group" aria-labelledby={headingId} data-testid={testId}>
      <div className="guide-links-group-head">
        <h2 className="guide-links-group-title" id={headingId}>
          {title} <span className="touch-figure">{matches.length}</span>
        </h2>
        {action}
      </div>
      <p className="guide-links-group-line">{line}</p>
      <ul className="touch-plain-list guide-links-rows">
        {matches.map((match) => (
          <ReviewRow
            key={match.guideId}
            game={game}
            match={match}
            choice={choices[match.guideId]}
            editable={editable}
          />
        ))}
      </ul>
    </section>
  );
}

/** One page: its name, what it would link to (or does), and what can be done. */
function ReviewRow({
  game,
  match,
  choice,
  editable,
}: {
  game: LoadedGame;
  match: PageMatch;
  choice: LinkChoice | undefined;
  editable: boolean;
}) {
  const [changing, setChanging] = useState(false);
  const suggestion = match.candidates[0];
  const targets = linkedTargets(game, choice);
  const decided = choice !== undefined;
  return (
    <li
      className="guide-links-row"
      data-testid="link-row"
      data-guide={match.guideId}
      data-group={decided ? choice.state : match.group}
    >
      <div className="guide-links-row-main">
        <button
          type="button"
          className="guide-links-page"
          title="Read the page"
          onClick={() => {
            openPlace({ kind: 'page', guideId: match.guideId });
          }}
        >
          <UiIcon name="book" size={18} />
          <span>{match.title}</span>
        </button>
        <p className="guide-links-target" data-testid="link-target-text">
          {choice?.state === 'skipped' ? (
            'Skipped: not linked'
          ) : choice?.state === 'linked' ? (
            targets.length > 0 ? (
              <>
                Linked to {targets.map(targetText).join(', ')}
                <span className="muted">
                  {' · '}
                  {locationsText(new Set(targets.flatMap((t) => t.locations)).size)}
                </span>
              </>
            ) : (
              'Linked to something this map no longer has'
            )
          ) : suggestion ? (
            <>
              <UiIcon name="chevron" size={14} strokeWidth={2} />
              {targetText(suggestion)}
              <span className="muted">
                {' · '}
                {locationsText(suggestion.locations.length)}
                {match.candidates.length > 1 ? ` · or ${match.candidates.length - 1} more` : ''}
              </span>
            </>
          ) : (
            <span className="muted">No location, type or region has this name.</span>
          )}
        </p>
      </div>
      {editable ? (
        <div className="guide-links-actions">
          {!decided && suggestion ? (
            <button
              type="button"
              className="touch-button touch-button-primary guide-links-button"
              data-testid="link-confirm"
              onClick={() => {
                linkPage(match.guideId, [suggestion.target]);
              }}
            >
              Confirm
            </button>
          ) : null}
          <button
            type="button"
            className="touch-button guide-links-button"
            aria-expanded={changing}
            data-testid="link-change"
            onClick={() => {
              setChanging(!changing);
            }}
          >
            {decided || suggestion ? 'Change' : 'Pick'}
          </button>
          {decided ? (
            <button
              type="button"
              className="touch-text-button guide-links-button"
              data-testid="link-undo"
              onClick={() => {
                forgetChoice(match.guideId);
              }}
            >
              Undo
            </button>
          ) : (
            <button
              type="button"
              className="touch-text-button guide-links-button"
              data-testid="link-skip"
              onClick={() => {
                skipPage(match.guideId);
              }}
            >
              Skip
            </button>
          )}
        </div>
      ) : null}
      {changing && editable ? (
        <TargetFinder
          game={game}
          title={match.title}
          candidates={match.candidates}
          onPick={(info) => {
            setChanging(false);
            if (canChangeGuideLinks()) linkPage(match.guideId, [info.target]);
          }}
          onCancel={() => {
            setChanging(false);
          }}
        />
      ) : null}
    </li>
  );
}

/** Another target for a page: the candidates, then any type, location name or region by name. */
function TargetFinder({
  game,
  title,
  candidates,
  onPick,
  onCancel,
}: {
  game: LoadedGame;
  title: string;
  candidates: readonly Candidate[];
  onPick: (info: TargetInfo) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    input.current?.focus();
  }, []);
  const found = useMemo(() => mapNamesOf(game).find(deferred, 12), [game, deferred]);
  const shown: readonly TargetInfo[] = deferred.trim() ? found : candidates;
  return (
    <div className="guide-links-finder" data-testid="link-finder">
      <label htmlFor={inputId} className="visually-hidden">
        Find a type, location name or region to link “{title}” to
      </label>
      <input
        ref={input}
        id={inputId}
        className="own-input"
        type="search"
        autoComplete="off"
        placeholder="Find a type, location name or region"
        value={query}
        data-testid="link-finder-input"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && shown[0]) {
            event.preventDefault();
            onPick(shown[0]);
          }
        }}
      />
      {!deferred.trim() && candidates.length > 0 ? (
        <p className="guide-links-group-line">Suggested:</p>
      ) : null}
      {shown.length > 0 ? (
        <ul className="touch-plain-list guide-links-hits">
          {shown.map((info) => (
            <li
              key={`${info.what}|${info.label}|${info.target.to === 'name' ? '' : info.target.id}`}
            >
              <button
                type="button"
                className="guide-links-hit"
                data-testid="link-hit"
                onClick={() => {
                  onPick(info);
                }}
              >
                <span>{targetText(info)}</span>
                <span className="muted">{locationsText(info.locations.length)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : deferred.trim() ? (
        <p className="guide-links-group-line">Nothing on the map is called that.</p>
      ) : null}
      <button type="button" className="touch-text-button" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
