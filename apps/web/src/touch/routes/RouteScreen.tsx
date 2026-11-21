import {
  changeRoute,
  changeRouteStep,
  clearRouteCorners,
  moveRouteStep,
  removeRouteStep,
  routeMaps,
  routeTypeName,
  type ChecklistEntry,
  type ShownStep,
} from '@atlas/core';
import { ROUTE_TYPES, type Route, type RouteType } from '@atlas/schema';
import { useEffect, useMemo } from 'react';
import { MarkdownBody } from '../../components/MarkdownBody';
import { UiIcon } from '../../components/icons';
import { showMap } from '../../state/actions';
import { deleteOwnRoute, useOwnRoutes } from '../../state/ownRoutes';
import {
  changeEditedRoute,
  copyPackRoute,
  editRoute,
  goToStep,
  makeRoute,
  makeRouteFromList,
  openRoute,
  setRoutePick,
  stepDone,
  stepIndexOf,
  stepsOf,
  stopRouteEditing,
  tickStep,
  useGameRoutes,
  useRoutes,
  type GameRoute,
} from '../../state/routes';
import { useAtlas, type LoadedGame } from '../../state/store';
import { PageBack } from '../ListRows';
import { listById } from '../listViews';
import { showSection, useTouch } from '../state';
import '../../styles/routes.css';

/** Whether routes can be made and changed here: room for the map beside the panel. */
function useCanChangeRoutes(): boolean {
  const room = useTouch((s) => s.editorRoom && s.arrangement === 'wide');
  const ready = useOwnRoutes((s) => s.status === 'ready' && s.readOnly === null);
  return room && ready;
}

/**
 * The game's routes in Lists: each with its type and number of steps, and,
 * where there is room to change them, New route and a route from a list.
 * Left out when the game has no route and none can be made here.
 */
export function RoutesSection({
  game,
  lists,
}: {
  game: LoadedGame;
  /** The lists a route can be started from. */
  lists: readonly ChecklistEntry[];
}) {
  const routes = useGameRoutes();
  const canChange = useCanChangeRoutes();
  const fromLists = lists.filter((entry) =>
    entry.items.some((row) => row.item.locationIds.length > 0),
  );
  if (routes.length === 0 && !canChange) return null;
  return (
    <section aria-labelledby="map-routes-heading" data-testid="map-routes">
      <h2 className="touch-group-title touch-lists-heading" id="map-routes-heading">
        Routes on the map
      </h2>
      {routes.length > 0 ? (
        <ul className="touch-plain-list touch-list-cards">
          {routes.map((entry) => (
            <li key={entry.route.id}>
              <RouteLink game={game} entry={entry} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="touch-note route-note">
          A route is a path on the map with a short guide at each step. Make one with New route.
        </p>
      )}
      {canChange ? (
        <div className="route-make">
          <button
            type="button"
            className="own-pill-button"
            data-testid="new-route"
            onClick={() => {
              makeRoute();
            }}
          >
            <UiIcon name="plus" size={18} strokeWidth={1.8} />
            New route
          </button>
          {fromLists.length > 0 ? (
            <label className="route-from-list">
              <span className="visually-hidden">Make a route from a list</span>
              <select
                data-testid="route-from-list"
                value=""
                onChange={(event) => {
                  const entry = listById(game, event.target.value);
                  if (entry) makeRouteFromList(entry);
                }}
              >
                <option value="">Make a route from a list…</option>
                {fromLists.map((entry) => (
                  <option key={entry.checklist.id} value={entry.checklist.id}>
                    {entry.checklist.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RouteLink({ game, entry }: { game: LoadedGame; entry: GameRoute }) {
  const found = useAtlas((s) => s.found);
  const { route } = entry;
  const steps = useMemo(() => stepsOf(game, route), [game, route]);
  const done = steps.filter((shown) => stepDone(game, found, route, shown)).length;
  return (
    <button
      type="button"
      className="touch-list-card"
      data-testid="route-link"
      data-route-id={route.id}
      onClick={() => {
        openRoute(route.id);
      }}
    >
      <span className="route-swatch" style={route.color ? { background: route.color } : {}} />
      <span className="touch-list-card-text">
        <span className="touch-list-card-head">
          <span className="touch-list-card-name">{route.title}</span>
          <span className="touch-figure">
            {entry.own ? 'Mine · ' : ''}
            {routeTypeName(route.type)} · {done} of {steps.length} steps
          </span>
        </span>
      </span>
      <UiIcon name="chevron" size={20} strokeWidth={1.8} />
    </button>
  );
}

/**
 * One route: its title, type and description, its steps in order with the
 * open one's text, Previous and Next, and a tick for each step. One of the
 * person's own can be changed here where there is room (see
 * {@link RouteEditor}). While it is open, the map draws it.
 */
export function RouteScreen({ game, id }: { game: LoadedGame; id: string }) {
  const routes = useGameRoutes();
  const entry = routes.find((r) => r.route.id === id);
  const editing = useRoutes((s) => s.editing === id);
  const ownStatus = useOwnRoutes((s) => s.status);
  // Changing it ends when it is closed (not when a copy of it opens to be changed).
  useEffect(
    () => () => {
      stopRouteEditing(id);
    },
    [id],
  );
  if (!entry) {
    return (
      <div className="touch-page">
        <header className="touch-page-head touch-page-head-back">
          <PageBack />
        </header>
        <p className="touch-empty">
          {ownStatus === 'loading' ? 'Reading your routes…' : 'This route is not here any more.'}
        </p>
      </div>
    );
  }
  return editing && entry.own ? (
    <RouteEditor game={game} route={entry.route} />
  ) : (
    <RouteView game={game} entry={entry} />
  );
}

function RouteView({ game, entry }: { game: LoadedGame; entry: GameRoute }) {
  const { route } = entry;
  const found = useAtlas((s) => s.found);
  const mapId = useAtlas((s) => s.mapId);
  const canChange = useCanChangeRoutes();
  const steps = useMemo(() => stepsOf(game, route), [game, route]);
  const current = useRoutes((s) => stepIndexOf(route.id, steps.length, s));
  const done = steps.filter((shown) => stepDone(game, found, route, shown)).length;
  const maps = routeMaps(steps);
  const shown = steps[current];
  // The route's first map is shown when it opens, if the map shown has none of it.
  useEffect(() => {
    const first = steps[current] ?? steps[0];
    if (first && !maps.includes(useAtlas.getState().mapId ?? '')) showMap(first.mapId);
    // Only when the route opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.id]);
  return (
    <div className="touch-page route-page" data-testid="route-screen" data-route-id={route.id}>
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack />
          <div className="touch-page-head-text">
            <h1 className="touch-page-subtitle">{route.title}</h1>
            <p
              className="touch-page-figure"
              data-testid="route-done"
              data-done={done}
              data-total={steps.length}
            >
              {routeTypeName(route.type)} · {done} of {steps.length} steps done
              {maps.length > 1 ? ` · ${maps.length} maps` : ''}
            </p>
          </div>
          {entry.own && canChange ? (
            <button
              type="button"
              className="own-edit-button"
              data-testid="edit-route"
              onClick={() => {
                editRoute(route.id);
              }}
            >
              <UiIcon name="pencil" size={18} strokeWidth={1.8} />
              Edit
            </button>
          ) : null}
        </div>
      </header>
      <div className="touch-scroll touch-page-body route-body" data-scroll-root>
        {route.description ? (
          <MarkdownBody source={route.description} className="route-description markdown" />
        ) : null}
        {shown ? (
          <section className="route-current" aria-label="The step open" data-testid="route-current">
            <p className="route-current-kicker">
              Step {shown.number} of {steps.length}
              {maps.length > 1 ? ` · ${game.pack.maps.get(shown.mapId)?.name ?? ''}` : ''}
            </p>
            <h2 className="route-current-title">{shown.step.title}</h2>
            {shown.step.text ? (
              <MarkdownBody source={shown.step.text} className="route-step-text markdown" />
            ) : null}
            <div className="route-current-actions">
              <button
                type="button"
                className="touch-button"
                data-testid="route-previous"
                disabled={current === 0}
                onClick={() => {
                  goToStep(route, current - 1);
                }}
              >
                <UiIcon name="back" size={18} strokeWidth={1.8} />
                Previous
              </button>
              <StepTick game={game} route={route} shown={shown} found={found} />
              <button
                type="button"
                className="touch-button touch-button-primary"
                data-testid="route-next"
                disabled={current >= steps.length - 1}
                onClick={() => {
                  goToStep(route, current + 1);
                }}
              >
                Next
                <UiIcon name="forward" size={18} strokeWidth={1.8} />
              </button>
            </div>
            {shown.mapId !== mapId ? (
              <button
                type="button"
                className="touch-link-button"
                onClick={() => {
                  goToStep(route, current);
                }}
              >
                Show this step on {game.pack.maps.get(shown.mapId)?.name ?? 'its map'}
              </button>
            ) : null}
          </section>
        ) : (
          <p className="touch-empty">This route has no step yet.</p>
        )}
        <ol className="route-steps" data-testid="route-steps">
          {steps.map((step, i) => (
            <li key={step.step.id} className="route-step" aria-current={i === current}>
              <StepTick game={game} route={route} shown={step} found={found} compact />
              <button
                type="button"
                className="route-step-open"
                data-testid="route-step"
                onClick={() => {
                  goToStep(route, i);
                }}
              >
                <span className="route-step-number" aria-hidden="true">
                  {step.number}
                </span>
                <span className="route-step-title">{step.step.title}</span>
              </button>
            </li>
          ))}
        </ol>
        {!entry.own && canChange ? (
          <p className="route-copy">
            <button
              type="button"
              className="own-pill-button"
              data-testid="copy-route"
              onClick={() => {
                copyPackRoute(route);
              }}
            >
              <UiIcon name="copy" size={18} strokeWidth={1.8} />
              Make a copy to change
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** A step's tick: a step on a location marks it found. */
function StepTick({
  game,
  route,
  shown,
  found,
  compact = false,
}: {
  game: LoadedGame;
  route: Route;
  shown: ShownStep;
  found: ReadonlyMap<string, unknown>;
  compact?: boolean;
}) {
  const done = stepDone(game, found, route, shown);
  const label = `Step ${shown.number}, ${shown.step.title}: ${done ? 'done' : 'not done'}`;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={compact ? label : undefined}
      className={compact ? 'route-tick route-tick-compact' : 'touch-button route-tick'}
      data-testid={compact ? 'route-step-tick' : 'route-tick'}
      onClick={() => {
        tickStep(route, shown, !done);
      }}
    >
      <UiIcon name="check" size={compact ? 16 : 18} strokeWidth={2} />
      {compact ? null : done ? 'Done' : 'Mark done'}
    </button>
  );
}

const TYPE_LABEL: Record<RouteType, string> = {
  walkthrough: 'Walkthrough',
  collection: 'Collection',
  build: 'Build',
};

/**
 * Changing a route of the person's own: its title, type, colour and
 * description; its steps, added by pressing locations or free points on
 * the map, each with a title and text, moved up and down, removed; and the
 * corner points of the line before a step, added by pressing the map.
 */
function RouteEditor({ game, route }: { game: LoadedGame; route: Route }) {
  const steps = useMemo(() => stepsOf(game, route), [game, route]);
  const current = useRoutes((s) => stepIndexOf(route.id, steps.length, s));
  const pick = useRoutes((s) => s.pick);
  const now = () => new Date();
  return (
    <div className="touch-page route-page route-editor" data-testid="route-editor">
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <div className="touch-page-head-text">
            <p className="touch-page-kicker">Change the route</p>
            <h1 className="touch-page-subtitle">{route.title}</h1>
          </div>
          <button
            type="button"
            className="touch-button touch-button-primary"
            data-testid="route-editor-done"
            onClick={() => {
              stopRouteEditing();
            }}
          >
            Done
          </button>
        </div>
      </header>
      <div className="touch-scroll touch-page-body route-body" data-scroll-root>
        <div className="route-fields">
          <label className="route-field">
            <span>Title</span>
            <input
              type="text"
              data-testid="route-title"
              defaultValue={route.title}
              maxLength={200}
              onBlur={(event) => {
                const title = event.target.value.trim();
                if (title && title !== route.title) {
                  changeEditedRoute((r) => changeRoute(r, { title }, now()), 'Title changed');
                }
              }}
            />
          </label>
          <div className="route-field-row">
            <label className="route-field">
              <span>Type</span>
              <select
                data-testid="route-type"
                value={route.type ?? 'walkthrough'}
                onChange={(event) => {
                  const type = event.target.value as RouteType;
                  changeEditedRoute((r) => changeRoute(r, { type }, now()), 'Type changed');
                }}
              >
                {ROUTE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="route-field route-field-colour">
              <span>Colour</span>
              <input
                type="color"
                data-testid="route-colour"
                value={route.color ?? '#e0533d'}
                onChange={(event) => {
                  const color = event.target.value;
                  changeEditedRoute((r) => changeRoute(r, { color }, now()));
                }}
              />
            </label>
          </div>
          <label className="route-field">
            <span>Description</span>
            <textarea
              rows={2}
              data-testid="route-description"
              defaultValue={route.description ?? ''}
              onBlur={(event) => {
                const description = event.target.value;
                if (description !== (route.description ?? '')) {
                  changeEditedRoute(
                    (r) => changeRoute(r, { description }, now()),
                    'Description changed',
                  );
                }
              }}
            />
          </label>
        </div>
        <div className="route-pick" role="group" aria-label="What a press on the map does">
          <button
            type="button"
            className="own-pill-button"
            aria-pressed={pick?.kind === 'step'}
            data-testid="route-add-steps"
            onClick={() => {
              setRoutePick(pick?.kind === 'step' ? null : { kind: 'step' });
            }}
          >
            <UiIcon name="pin" size={18} strokeWidth={1.8} />
            {pick?.kind === 'step' ? 'Adding steps' : 'Add steps'}
          </button>
          <p className="touch-note" data-testid="route-pick-hint">
            {pick?.kind === 'step'
              ? 'Press a location on the map to add it as a step, or press an empty spot for a free point. Each step goes after the open one.'
              : pick?.kind === 'corner'
                ? `Press the map where the line to step ${steps.findIndex((s) => s.step.id === pick.stepId) + 1} should bend. Press Done bending when it goes around every corner.`
                : 'Press Add steps, then press the map.'}
          </p>
        </div>
        {steps.length === 0 ? (
          <p className="touch-empty">No step yet.</p>
        ) : (
          <ol className="route-steps route-steps-editor" data-testid="route-editor-steps">
            {steps.map((shown, i) => (
              <EditorStep
                key={shown.step.id}
                route={route}
                shown={shown}
                open={i === current}
                first={i === 0}
                last={i === steps.length - 1}
                bending={pick?.kind === 'corner' && pick.stepId === shown.step.id}
                sameMapAsBefore={i > 0 && steps[i - 1]!.mapId === shown.mapId}
              />
            ))}
          </ol>
        )}
        <p className="route-delete">
          <button
            type="button"
            className="own-pill-button"
            data-testid="delete-route"
            onClick={() => {
              stopRouteEditing();
              if (deleteOwnRoute(route.id, route.title)) {
                useAtlas.setState({
                  checklistPages: useAtlas.getState().checklistPages.slice(0, -1),
                });
              }
            }}
          >
            <UiIcon name="trash" size={18} strokeWidth={1.8} />
            Delete this route
          </button>
        </p>
      </div>
    </div>
  );
}

function EditorStep({
  route,
  shown,
  open,
  first,
  last,
  bending,
  sameMapAsBefore,
}: {
  route: Route;
  shown: ShownStep;
  open: boolean;
  first: boolean;
  last: boolean;
  bending: boolean;
  sameMapAsBefore: boolean;
}) {
  const { step } = shown;
  const now = () => new Date();
  const corners = step.via?.length ?? 0;
  return (
    <li className="route-step route-step-edit" aria-current={open} data-testid="route-editor-step">
      <button
        type="button"
        className="route-step-open"
        onClick={() => {
          goToStep(route, shown.number - 1);
        }}
      >
        <span className="route-step-number" aria-hidden="true">
          {shown.number}
        </span>
        <span className="route-step-title">
          {step.title}
          {shown.location ? null : <span className="route-step-free"> · free point</span>}
        </span>
      </button>
      {open ? (
        <div className="route-step-fields">
          <label className="route-field">
            <span>Title of the step</span>
            <input
              type="text"
              data-testid="route-step-title"
              defaultValue={step.title}
              maxLength={200}
              onBlur={(event) => {
                const title = event.target.value.trim();
                if (title && title !== step.title) {
                  changeEditedRoute(
                    (r) => changeRouteStep(r, step.id, { title }, now()),
                    'Step changed',
                  );
                }
              }}
            />
          </label>
          <label className="route-field">
            <span>What to do here</span>
            <textarea
              rows={3}
              data-testid="route-step-text"
              defaultValue={step.text ?? ''}
              onBlur={(event) => {
                const text = event.target.value;
                if (text !== (step.text ?? '')) {
                  changeEditedRoute(
                    (r) => changeRouteStep(r, step.id, { text }, now()),
                    'Step changed',
                  );
                }
              }}
            />
          </label>
          <div className="route-step-buttons">
            <button
              type="button"
              className="own-pill-button"
              disabled={first}
              data-testid="route-step-up"
              onClick={() => {
                changeEditedRoute((r) => moveRouteStep(r, step.id, -1, now()), 'Step moved');
                goToStepIndex(route.id, shown.number - 2);
              }}
            >
              Move up
            </button>
            <button
              type="button"
              className="own-pill-button"
              disabled={last}
              data-testid="route-step-down"
              onClick={() => {
                changeEditedRoute((r) => moveRouteStep(r, step.id, 1, now()), 'Step moved');
                goToStepIndex(route.id, shown.number);
              }}
            >
              Move down
            </button>
            {sameMapAsBefore ? (
              <button
                type="button"
                className="own-pill-button"
                aria-pressed={bending}
                data-testid="route-step-bend"
                onClick={() => {
                  setRoutePick(bending ? null : { kind: 'corner', stepId: step.id });
                }}
              >
                {bending
                  ? 'Done bending'
                  : corners > 0
                    ? `Bend the line (${corners} ${corners === 1 ? 'corner' : 'corners'})`
                    : 'Bend the line'}
              </button>
            ) : null}
            {corners > 0 ? (
              <button
                type="button"
                className="own-pill-button"
                data-testid="route-step-straighten"
                onClick={() => {
                  if (bending) setRoutePick(null);
                  changeEditedRoute(
                    (r) => clearRouteCorners(r, step.id, now()),
                    'Line made straight',
                  );
                }}
              >
                Make it straight
              </button>
            ) : null}
            <button
              type="button"
              className="own-pill-button"
              data-testid="route-step-remove"
              onClick={() => {
                if (bending) setRoutePick(null);
                changeEditedRoute((r) => removeRouteStep(r, step.id, now()), 'Step removed');
              }}
            >
              <UiIcon name="trash" size={16} strokeWidth={1.8} />
              Remove
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Keeps the open step on a step that moved. */
function goToStepIndex(routeId: string, index: number): void {
  useRoutes.setState((s) => ({ steps: { ...s.steps, [routeId]: Math.max(0, index) } }));
}

/**
 * The open route on the map of a phone: the step open, Previous and Next,
 * and a way back to its steps.
 */
export function RouteBar() {
  const game = useAtlas((s) => s.game);
  const page = useAtlas((s) => s.checklistPages.at(-1));
  const routes = useGameRoutes();
  const found = useAtlas((s) => s.found);
  const id = page?.kind === 'route' ? page.id : null;
  const entry = routes.find((r) => r.route.id === id);
  const steps = useMemo(() => (game && entry ? stepsOf(game, entry.route) : []), [game, entry]);
  const current = useRoutes((s) => (entry ? stepIndexOf(entry.route.id, steps.length, s) : 0));
  if (!game || !entry || steps.length === 0) return null;
  const shown = steps[current]!;
  return (
    <div className="route-bar" data-testid="route-bar">
      <button
        type="button"
        className="touch-icon-button"
        aria-label="Previous step"
        disabled={current === 0}
        onClick={() => {
          goToStep(entry.route, current - 1);
        }}
      >
        <UiIcon name="back" size={22} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="route-bar-text"
        onClick={() => {
          openRoute(entry.route.id);
          showSection('lists');
        }}
      >
        <span className="route-bar-kicker">
          {entry.route.title} · Step {shown.number} of {steps.length}
        </span>
        <span className="route-bar-title">{shown.step.title}</span>
      </button>
      <StepTick game={game} route={entry.route} shown={shown} found={found} compact />
      <button
        type="button"
        className="touch-icon-button"
        aria-label="Next step"
        disabled={current >= steps.length - 1}
        onClick={() => {
          goToStep(entry.route, current + 1);
        }}
      >
        <UiIcon name="forward" size={22} strokeWidth={1.8} />
      </button>
    </div>
  );
}
