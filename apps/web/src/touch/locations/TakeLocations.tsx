import type { LoadedPack, PackEntry } from '@atlas/core';
import { floorsOf } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { notify } from '../../state/actions';
import { numberFormat } from '../../state/derived';
import { useGameGroups } from '../../state/gameGroups';
import { packAt } from '../../state/guideLinks';
import { changeOwnAll } from '../../state/ownLocations';
import { useAtlas, type LoadedGame } from '../../state/store';
import {
  castFrom,
  planTake,
  readyToTake,
  sameGameSources,
  takeIntoOwn,
  type TakePlan,
  type TakeReady,
  type TakeTarget,
} from '../../state/takeLocations';
import { openSide, undoLocationChange } from './locationEditorState';

/*
 * "Take locations from another pack…", in Edit locations (see
 * `state/takeLocations.ts`): another pack of the same game is chosen, then
 * which of its maps, and what would be added is shown, with what lands off
 * the map shown and what has no surface below it, before anything is.
 */

/** How many names a list of the review shows before "and n more". */
const NAMES_SHOWN = 8;

type Step =
  | { kind: 'choose' }
  | { kind: 'finding' }
  | {
      kind: 'review';
      plan: TakePlan;
      ready: TakeReady[];
      /** Why the heights could not be found, when they could not. */
      problem: string | null;
    };

/** The map shown, as locations are put on it; null when it cannot take them (no world position). */
function useTarget(game: LoadedGame): TakeTarget | null {
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  return useMemo(() => {
    const map = mapId ? game.pack.maps.get(mapId) : undefined;
    if (!map?.worldTransform) return null;
    const layers = game.pack.layersOf(map.id);
    return {
      map,
      layers,
      floors: floorsOf(layers, map.id),
      shownLayer: layers.some((layer) => layer.id === layerId) ? layerId : null,
      hasScene: map.scene !== undefined,
      existing: game.pack.data.locations.filter((location) => location.mapId === map.id),
    };
  }, [game, mapId, layerId]);
}

/** Names of some locations, the first few and how many more. */
function Names({
  items,
  testId,
}: {
  items: { source: { id: string; name: string } }[];
  testId: string;
}) {
  const shown = items.slice(0, NAMES_SHOWN);
  const more = items.length - shown.length;
  return (
    <ul className="take-names" data-testid={testId}>
      {shown.map((item) => (
        <li key={item.source.id}>{item.source.name}</li>
      ))}
      {more > 0 ? <li className="take-more">and {numberFormat.format(more)} more</li> : null}
    </ul>
  );
}

const count = (n: number, one: string, many: string) =>
  n === 1 ? `one ${one}` : `${numberFormat.format(n)} ${many}`;

export function TakeLocationsPanel({ game }: { game: LoadedGame }) {
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const catalog = useAtlas((s) => s.catalog);
  const groups = useGameGroups((s) => s.groups);
  const gameId = game.pack.manifest.gameId;
  const sources = useMemo(
    () => sameGameSources(catalog, groups, gameId),
    [catalog, groups, gameId],
  );
  const target = useTarget(game);
  const mapName = target?.map.name ?? 'this map';
  const [entry, setEntry] = useState<PackEntry | null>(null);
  const [pack, setPack] = useState<LoadedPack | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [mapIds, setMapIds] = useState<ReadonlySet<string>>(new Set());
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const turn = useRef(0);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const close = () => {
    turn.current++;
    openSide(null);
  };

  const choose = (next: PackEntry) => {
    const mine = ++turn.current;
    setEntry(next);
    setPack(null);
    setMapIds(new Set());
    setReading('Reading the pack…');
    packAt(next).then(
      (loaded) => {
        if (turn.current !== mine) return;
        setPack(loaded);
        setReading(null);
        // Every map that can be lined up, to begin with.
        setMapIds(new Set(loaded.data.maps.filter((m) => m.worldTransform).map((m) => m.id)));
      },
      (error: unknown) => {
        if (turn.current !== mine) return;
        setReading(
          `The pack could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  };

  const find = async () => {
    if (!pack || !target) return;
    const mine = ++turn.current;
    const plan = planTake(pack.data, [...mapIds], target);
    let heights: (number | null)[] | null = null;
    let problem: string | null = null;
    if (target.hasScene && plan.inside.length > 0) {
      setStep({ kind: 'finding' });
      try {
        const { probeHeights } = await import('../../scene/probe');
        heights = await probeHeights(
          target.map,
          (file) => game.pack.resolveUrl(file),
          plan.inside.map((candidate) => ({
            x: candidate.x,
            y: candidate.y,
            from: castFrom(candidate.source),
          })),
        );
      } catch (error) {
        problem = `The model could not be read here (${error instanceof Error ? error.message : String(error)}), so the locations get the heights they had, or none.`;
      }
    }
    if (turn.current !== mine) return;
    setStep({ kind: 'review', plan, ready: readyToTake(plan, target, heights), problem });
  };

  const add = (ready: TakeReady[]) => {
    if (!pack || !entry || !target) return;
    const title = pack.manifest.title || entry.title;
    const done = changeOwnAll(
      ({ gameId: ownGame, data, own }) =>
        takeIntoOwn({
          gameId: ownGame,
          data,
          own,
          mapId: target.map.id,
          ready,
          sourceTypes: pack.data.categories,
          packTitle: title,
          now: new Date(),
        }).own,
      `Took ${count(ready.length, 'location', 'locations')} from “${title}”`,
    );
    if (!done) return;
    openSide(null);
    notify(
      `Added ${count(ready.length, 'location', 'locations')} from “${title}” to ${mapName}.`,
      'info',
      { action: { label: 'Undo', run: undoLocationChange } },
    );
  };

  const head = (
    <header className="editor-side-head">
      <h2 id={`${id}-title`} ref={titleRef} className="editor-side-title" tabIndex={-1}>
        Take locations from another pack
      </h2>
      <button
        type="button"
        className="touch-icon-button editor-side-icon"
        aria-label="Close without taking any"
        data-testid="close-side"
        onClick={close}
      >
        <UiIcon name="close" size={22} strokeWidth={1.8} />
      </button>
    </header>
  );

  if (step.kind === 'review') {
    const { plan, ready, problem } = step;
    const flagged = ready.filter((item) => item.noSurface);
    return (
      <aside
        className="editor-side"
        aria-labelledby={`${id}-title`}
        data-testid="take-panel"
        data-step="review"
      >
        {head}
        <div className="editor-side-body" data-testid="take-review">
          <p className="editor-side-line editor-side-lead" data-testid="take-summary">
            {ready.length === 0
              ? `None of them can be added to ${mapName}.`
              : `${count(ready.length, 'location', 'locations')} from “${entry?.title ?? ''}” can be added to ${mapName}, as your own.`}
          </p>
          {problem ? (
            <p className="own-problem" role="alert">
              {problem}
            </p>
          ) : null}
          {flagged.length > 0 ? (
            <section className="take-group" data-testid="take-no-surface">
              <h3 className="own-label">
                No surface below {flagged.length === 1 ? 'it' : 'them'}:{' '}
                {count(flagged.length, 'location', 'locations')}
              </h3>
              <p className="editor-side-line">
                They are added all the same, without a height, and their note says so. Check where
                they are.
              </p>
              <Names items={flagged.map((item) => item.candidate)} testId="take-no-surface-names" />
            </section>
          ) : null}
          {plan.outside.length > 0 ? (
            <section className="take-group" data-testid="take-outside">
              <h3 className="own-label">
                Off {mapName}: {count(plan.outside.length, 'location', 'locations')}
              </h3>
              <p className="editor-side-line">
                They are where this map does not reach, and are left out.
              </p>
              <Names items={plan.outside} testId="take-outside-names" />
            </section>
          ) : null}
          {plan.already.length > 0 ? (
            <p className="editor-side-line" data-testid="take-already">
              {count(plan.already.length, 'location is', 'locations are')} on {mapName} already, and
              left out.
            </p>
          ) : null}
          {plan.unplaced.length > 0 ? (
            <p className="editor-side-line" data-testid="take-unplaced">
              {plan.unplaced.join(', ')} cannot be lined up with {mapName}: a map needs a world
              position to be.
            </p>
          ) : null}
          {ready.length > 0 ? (
            <p className="editor-side-line">
              Types of the same name as this game’s are used; the others are made as types of your
              own. Undo takes all of them back.
            </p>
          ) : null}
        </div>
        <footer className="editor-side-foot">
          <button
            type="button"
            className="own-pill-button"
            onClick={() => {
              setStep({ kind: 'choose' });
            }}
          >
            Back
          </button>
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="own-pill-button own-pill-primary"
            data-testid="take-confirm"
            disabled={ready.length === 0}
            onClick={() => {
              add(ready);
            }}
          >
            {ready.length === 1 ? 'Add it' : `Add ${numberFormat.format(ready.length)}`}
          </button>
        </footer>
      </aside>
    );
  }

  const maps = pack?.data.maps ?? [];
  const counts = new Map<string, number>();
  for (const location of pack?.data.locations ?? []) {
    counts.set(location.mapId, (counts.get(location.mapId) ?? 0) + 1);
  }
  const finding = step.kind === 'finding';
  return (
    <aside
      className="editor-side"
      aria-labelledby={`${id}-title`}
      data-testid="take-panel"
      data-step={step.kind}
    >
      {head}
      <div className="editor-side-body">
        <p className="editor-side-line">
          The locations of another pack of this game are put on {mapName} where they are in the
          game’s world, as your own.
          {target?.hasScene ? ' Each gets the height of the surface below it.' : ''}
        </p>
        {!target ? (
          <p className="own-problem" role="alert">
            {mapName} has no world position, so nothing can be lined up with it.
          </p>
        ) : sources.length === 0 ? (
          <p className="editor-side-line" data-testid="take-none">
            No other pack of this game is here. A pack of the same title, or shown with this game
            under one title, can be used.
          </p>
        ) : (
          <fieldset className="own-field locations-fieldset">
            <legend className="own-label">Pack</legend>
            <ul className="touch-plain-list editor-types">
              {sources.map((source) => (
                <li key={source.id}>
                  <label
                    className={
                      entry?.id === source.id ? 'editor-type editor-type-on' : 'editor-type'
                    }
                    data-testid="take-source"
                  >
                    <input
                      type="radio"
                      className="editor-check"
                      name={`${id}-source`}
                      value={source.id}
                      checked={entry?.id === source.id}
                      disabled={finding}
                      onChange={() => {
                        choose(source);
                      }}
                    />
                    <span className="editor-type-text">
                      <span className="editor-type-name">{source.title}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        {reading ? (
          <p className="editor-side-line" role="status">
            {reading}
          </p>
        ) : null}
        {pack ? (
          <fieldset className="own-field locations-fieldset">
            <legend className="own-label">Its maps</legend>
            <ul className="touch-plain-list editor-types">
              {maps.map((map) => {
                const checked = mapIds.has(map.id);
                return (
                  <li key={map.id}>
                    <label
                      className={checked ? 'editor-type editor-type-on' : 'editor-type'}
                      data-testid="take-map"
                    >
                      <input
                        type="checkbox"
                        className="editor-check"
                        value={map.id}
                        checked={checked}
                        disabled={!map.worldTransform || finding}
                        onChange={() => {
                          const next = new Set(mapIds);
                          if (checked) next.delete(map.id);
                          else next.add(map.id);
                          setMapIds(next);
                        }}
                      />
                      <span className="editor-type-text">
                        <span className="editor-type-name">{map.name}</span>
                        <span className="editor-type-line">
                          {map.worldTransform
                            ? count(counts.get(map.id) ?? 0, 'location', 'locations')
                            : 'No world position: it cannot be lined up'}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        ) : null}
        {finding ? (
          <p className="editor-side-line" role="status" data-testid="take-finding">
            Finding the surface below each location…
          </p>
        ) : null}
      </div>
      <footer className="editor-side-foot">
        <span className="own-space" />
        <button type="button" className="own-pill-button" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          data-testid="take-find"
          disabled={!pack || !target || mapIds.size === 0 || finding}
          onClick={() => {
            void find();
          }}
        >
          Next
        </button>
      </footer>
    </aside>
  );
}
