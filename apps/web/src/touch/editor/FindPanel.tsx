import type { StepFinding } from '@atlas/core';
import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { numberFormat } from '../../state/derived';
import type { LoadedGame } from '../../state/store';
import {
  chooseFound,
  closePanel,
  confirmFound,
  showFound,
  useEditor,
  type Finding,
} from './editorState';
import { locationDetail } from './locations';

/** How many possible locations of a step are listed at first, and how many more each press lists. */
const AT_ONCE = 5;

/**
 * "Find on the map", in the panel on the right of the map: what was found
 * for each step of a Build guide that has no location, in three groups.
 * Found: one location, ticked to be used. Several possible: the person
 * chooses one, nearest first to the step before, or none. Not found: the
 * step stays a step with no location. Each location says its type and area
 * and can be shown on the map. Nothing is put on a step until "Put on the
 * steps".
 */
export function FindPanel({ game }: { game: LoadedGame }) {
  const finding = useEditor((s) => s.finding);
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  if (!finding) return null;
  const found = finding.findings.filter((f) => f.outcome === 'found');
  const several = finding.findings.filter((f) => f.outcome === 'several');
  const none = finding.findings.filter((f) => f.outcome === 'none');
  const chosen = Object.values(finding.chosen).filter((id) => id !== null).length;
  const looked = finding.findings.length;
  return (
    <aside className="editor-side" aria-labelledby={titleId} data-testid="find-panel">
      <header className="editor-side-head">
        <h2 id={titleId} ref={title} className="editor-side-title" tabIndex={-1}>
          Find on the map
        </h2>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Close without changing the steps"
          data-testid="find-close"
          onClick={closePanel}
        >
          <UiIcon name="close" size={22} strokeWidth={1.8} />
        </button>
      </header>
      <div className="editor-side-body find-body">
        <p className="editor-side-line" data-testid="find-summary">
          {looked === 0
            ? 'Every step has a location already.'
            : `Looked for ${looked === 1 ? 'the step' : `the ${numberFormat.format(looked)} steps`} with no location: in the links of their pages to the map, by their names, and in their pages. Nothing changes until you put them on the steps.`}
          {finding.located > 0
            ? ` ${finding.located === 1 ? 'One step has' : `${numberFormat.format(finding.located)} steps have`} a location already and ${finding.located === 1 ? 'stays' : 'stay'} as ${finding.located === 1 ? 'it is' : 'they are'}.`
            : ''}
        </p>
        {found.length > 0 ? (
          <FindGroup title="Found" count={found.length} testId="find-found">
            {found.map((f) => (
              <FoundRow key={f.stepId} game={game} finding={f} state={finding} />
            ))}
          </FindGroup>
        ) : null}
        {several.length > 0 ? (
          <FindGroup title="Several possible" count={several.length} testId="find-several">
            {several.map((f) => (
              <SeveralRow key={f.stepId} game={game} finding={f} state={finding} />
            ))}
          </FindGroup>
        ) : null}
        {none.length > 0 ? (
          <FindGroup title="Not found" count={none.length} testId="find-none">
            {none.map((f) => (
              <li key={f.stepId} className="find-step" data-testid="find-step">
                <span className="find-step-name">{f.name}</span>
                <span className="editor-side-line">
                  No location found. It stays a step with no location.
                </span>
              </li>
            ))}
          </FindGroup>
        ) : null}
      </div>
      <footer className="editor-side-foot">
        <button type="button" className="own-pill-button" onClick={closePanel}>
          Cancel
        </button>
        <span className="own-space" />
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          data-testid="find-confirm"
          disabled={chosen === 0}
          onClick={() => {
            confirmFound();
          }}
        >
          {chosen === 0
            ? 'Put on the steps'
            : `Put on ${chosen === 1 ? 'one step' : `${numberFormat.format(chosen)} steps`}`}
        </button>
      </footer>
    </aside>
  );
}

function FindGroup({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count: number;
  testId: string;
  children: React.ReactNode;
}) {
  const id = useId();
  return (
    <section className="find-group" aria-labelledby={id} data-testid={testId}>
      <h3 id={id} className="find-group-title">
        {title} <span className="find-group-count">{numberFormat.format(count)}</span>
      </h3>
      <ul className="touch-plain-list find-steps">{children}</ul>
    </section>
  );
}

/** Where the locations of a step were found, in words. */
function byText(finding: StepFinding): string {
  switch (finding.by) {
    case 'linked':
      return 'Its page is linked to the map';
    case 'name':
      return 'By its name';
    case 'page':
      return 'Named in its page';
    default:
      return '';
  }
}

/** A location found, with its type and area, and a way to show it on the map. */
function LocationLine({
  game,
  locationId,
  shown,
  labelFor,
}: {
  game: LoadedGame;
  locationId: string;
  shown: boolean;
  /** The choice the location's name and area are the label of, if any. */
  labelFor?: string;
}) {
  const location = game.pack.locations.get(locationId);
  if (!location) return null;
  const text = (
    <>
      <span className="editor-location-name">{location.name}</span>
      <span className="editor-location-detail">{locationDetail(game, locationId)}</span>
    </>
  );
  return (
    <span className="find-location">
      {labelFor ? (
        <label htmlFor={labelFor} className="find-location-text">
          {text}
        </label>
      ) : (
        <span className="find-location-text">{text}</span>
      )}
      <button
        type="button"
        className="own-text-button find-show"
        aria-label={`Show ${location.name} on the map`}
        aria-pressed={shown}
        data-testid="find-show"
        onClick={() => {
          showFound(locationId);
        }}
      >
        <UiIcon name="target" size={16} strokeWidth={1.8} />
        Show
      </button>
    </span>
  );
}

/** A step found for sure: its location, used unless the person unticks it. */
function FoundRow({
  game,
  finding,
  state,
}: {
  game: LoadedGame;
  finding: StepFinding;
  state: Finding;
}) {
  const id = useId();
  const locationId = finding.locationIds[0]!;
  const use = state.chosen[finding.stepId] === locationId;
  return (
    <li className="find-step" data-testid="find-step" data-step={finding.name}>
      <span className="find-step-head">
        <input
          id={id}
          type="checkbox"
          className="find-check"
          checked={use}
          data-testid="find-use"
          onChange={(event) => {
            chooseFound(finding.stepId, event.target.checked ? locationId : null);
          }}
        />
        <label htmlFor={id} className="find-step-name">
          {finding.name}
        </label>
      </span>
      <span className="editor-side-line">{byText(finding)}</span>
      <LocationLine game={game} locationId={locationId} shown={state.shown === locationId} />
    </li>
  );
}

/** A step with several possible locations: one to choose, nearest first, or none. */
function SeveralRow({
  game,
  finding,
  state,
}: {
  game: LoadedGame;
  finding: StepFinding;
  state: Finding;
}) {
  const [count, setCount] = useState(AT_ONCE);
  const groupId = useId();
  const name = `find-${finding.stepId}`;
  const chosen = state.chosen[finding.stepId] ?? null;
  const total = finding.locationIds.length;
  // The one chosen stays listed, however far down it was.
  const listed = finding.locationIds.slice(0, count);
  if (chosen && !listed.includes(chosen)) listed.push(chosen);
  const left = total - count;
  return (
    <li className="find-step" data-testid="find-step" data-step={finding.name}>
      <span id={groupId} className="find-step-name">
        {finding.name}
      </span>
      <span className="editor-side-line">
        {byText(finding)} ·{' '}
        {total === 1
          ? 'one possible location'
          : `${numberFormat.format(total)} possible locations, nearest first`}
      </span>
      <div role="radiogroup" aria-labelledby={groupId} className="find-choices">
        {listed.map((locationId) => (
          <div key={locationId} className="find-choice" data-testid="find-choice">
            <input
              id={`${name}-${locationId}`}
              type="radio"
              name={name}
              checked={chosen === locationId}
              onChange={() => {
                chooseFound(finding.stepId, locationId);
              }}
            />
            <LocationLine
              game={game}
              locationId={locationId}
              shown={state.shown === locationId}
              labelFor={`${name}-${locationId}`}
            />
          </div>
        ))}
        <div className="find-choice find-choice-none" data-testid="find-choice-none">
          <input
            id={`${name}-none`}
            type="radio"
            name={name}
            checked={chosen === null}
            onChange={() => {
              chooseFound(finding.stepId, null);
            }}
          />
          <label htmlFor={`${name}-none`} className="editor-side-line">
            None for now: it stays a step with no location
          </label>
        </div>
      </div>
      {left > 0 ? (
        <button
          type="button"
          className="own-text-button find-more"
          data-testid="find-more"
          onClick={() => {
            setCount(count + AT_ONCE * 2);
          }}
        >
          {left > AT_ONCE * 2
            ? `Show ${AT_ONCE * 2} more of ${numberFormat.format(left)}`
            : `Show the other ${left === 1 ? 'one' : numberFormat.format(left)}`}
        </button>
      ) : null}
    </li>
  );
}
