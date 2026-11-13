import { ICON_NAMES, isOwnId, type Category, type OwnLocation, type Region } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { GlyphBadge, UiIcon } from '../../components/icons';
import { goToLocation } from '../../state/actions';
import { numberFormat } from '../../state/derived';
import {
  canChangeOwnLocations,
  changeOwn,
  deleteOwnArea,
  deleteOwnType,
  flushOwnLocations,
  OWN_TYPE_COLOURS,
  ownLocationsOfTypeCount,
  saveOwnArea,
  saveOwnType,
  useOwnLocations,
  type TypeForm,
} from '../../state/ownLocations';
import type { SaveState } from '../../state/ownLists';
import { useAtlas, type LoadedGame } from '../../state/store';
import {
  deleteOwnLocationNow,
  openSide,
  setMoving,
  startLocationEditing,
  stopLocationEditing,
  undoLocationChange,
  useLocationEditor,
} from './locationEditorState';

/*
 * Edit locations, in the standard layout (see `locationEditorState.ts`): the
 * panel beside the rail lists the person's own locations, types and areas
 * with Undo and Done; the panel over the map shows the one open; the bar
 * over the map says what a click does now.
 */

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'saved',
  unsaved: 'saving…',
  saving: 'saving…',
  failed: 'not saved',
};

/** "Edit locations", over the map: enters the mode. */
export function EditLocationsButton() {
  const ready = useOwnLocations((s) => canChangeOwnLocations(s));
  const hasGame = useAtlas((s) => s.game !== null);
  if (!ready || !hasGame) return null;
  return (
    <button
      type="button"
      className="touch-pill locations-enter"
      data-testid="edit-locations"
      onClick={startLocationEditing}
    >
      <UiIcon name="pencil" size={18} strokeWidth={1.8} />
      Edit locations
    </button>
  );
}

/** Leaving the mode puts the focus back on the button that entered it. */
function focusEnterButton() {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>('[data-testid="edit-locations"]')?.focus();
  }, 0);
}

function leave() {
  stopLocationEditing();
  focusEnterButton();
}

/** What a click on the map does now, over the map. */
export function LocationMapHint() {
  const moving = useLocationEditor((s) => s.moving);
  const name = useOwnLocations((s) =>
    moving ? s.own.locations.find((l) => l.id === moving)?.name : undefined,
  );
  return (
    <div className="touch-pill editor-map-hint" role="status" data-testid="locations-map-hint">
      <UiIcon name={moving ? 'pin' : 'plus'} size={18} strokeWidth={1.9} />
      <span className="editor-map-hint-text">
        {moving
          ? `Click where “${name ?? 'the location'}” goes`
          : 'Click the map to put a location there'}
      </span>
      {moving ? (
        <button
          type="button"
          className="editor-hint-cancel"
          onClick={() => {
            setMoving(null);
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel beside the rail

/** The types of a game in their groups, in order. */
function typeGroups(game: LoadedGame): { id: string; name: string; types: Category[] }[] {
  const groups = [...game.pack.data.categoryGroups].sort((a, b) => a.order - b.order);
  return groups
    .map((group) => ({
      id: group.id,
      name: group.name,
      types: game.pack.data.categories.filter((c) => c.groupId === group.id),
    }))
    .filter((group) => group.types.length > 0);
}

/** The areas of a map: the game's and the person's own, by name. */
function areasOf(game: LoadedGame, mapId: string): Region[] {
  return game.pack.data.regions
    .filter((r) => r.mapId === mapId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

export function LocationEditorOutline({ game }: { game: LoadedGame }) {
  const own = useOwnLocations((s) => s.own);
  const save = useOwnLocations((s) => s.save);
  const saveError = useOwnLocations((s) => s.saveError);
  const canUndo = useOwnLocations((s) => s.undo.length > 0);
  const side = useLocationEditor((s) => s.side);
  const mapId = useAtlas((s) => s.mapId);
  const map = game.pack.maps.get(mapId ?? '');
  const mapName = map?.name ?? 'this map';
  const titleId = useId();
  const locations = useMemo(
    () => own.locations.filter((l) => l.mapId === mapId).sort(byName),
    [own.locations, mapId],
  );
  const types = useMemo(() => [...own.categories].sort(byName), [own.categories]);
  const areas = useMemo(
    () => own.regions.filter((r) => r.mapId === mapId).sort(byName),
    [own.regions, mapId],
  );
  const counts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const location of own.locations) {
      counts.set(location.categoryId, (counts.get(location.categoryId) ?? 0) + 1);
    }
    return counts;
  }, [own.locations]);
  const total = own.locations.length;
  const openId = side && 'id' in side ? side.id : null;

  return (
    <div className="editor-outline locations-outline" data-testid="location-editor">
      <header className="editor-head">
        <button
          type="button"
          className="touch-icon-button editor-back"
          aria-label="Leave Edit locations"
          onClick={leave}
        >
          <UiIcon name="back" size={22} strokeWidth={1.8} />
        </button>
        <div className="editor-head-text">
          <h1 id={titleId} className="editor-name locations-title">
            Edit locations
          </h1>
          <p className="editor-head-figure">
            {total === 1
              ? 'one location of yours'
              : `${numberFormat.format(total)} locations of yours`}{' '}
            ·{' '}
            <span
              className={save === 'failed' ? 'editor-save editor-save-failed' : 'editor-save'}
              data-testid="locations-save-state"
              data-state={save}
              title={saveError ?? undefined}
            >
              {SAVE_TEXT[save]}
            </span>
          </p>
        </div>
        <span className="editor-badge">Editing</span>
      </header>
      {save === 'failed' ? (
        <p className="editor-save-problem" role="alert">
          Your changes could not be saved{saveError ? `: ${saveError}` : '.'}{' '}
          <button
            type="button"
            className="own-text-button"
            onClick={() => {
              void flushOwnLocations();
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="editor-head-actions">
        <button
          type="button"
          className="own-pill-button"
          data-testid="locations-undo"
          disabled={!canUndo}
          onClick={undoLocationChange}
        >
          <UiIcon name="undo" size={18} strokeWidth={1.8} />
          Undo
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          data-testid="locations-done"
          onClick={leave}
        >
          Done
        </button>
      </div>
      <div className="locations-scroll" aria-labelledby={titleId} role="region">
        <p className="locations-lead">
          Click the map to put a location there. Click one of yours to change, move or delete it.
          The game’s own locations stay as they are.
        </p>
        <section className="locations-section" aria-labelledby={`${titleId}-locations`}>
          <h2 id={`${titleId}-locations`} className="locations-heading">
            Your locations on {mapName}
          </h2>
          {locations.length === 0 ? (
            <p className="locations-empty">None yet.</p>
          ) : (
            <ul className="touch-plain-list locations-rows" data-testid="own-locations">
              {locations.map((location) => (
                <OwnLocationRow
                  key={location.id}
                  game={game}
                  location={location}
                  open={openId === location.id}
                />
              ))}
            </ul>
          )}
        </section>
        <section className="locations-section" aria-labelledby={`${titleId}-types`}>
          <h2 id={`${titleId}-types`} className="locations-heading">
            Your types
          </h2>
          {types.length === 0 ? (
            <p className="locations-empty">
              None yet. Your locations can be of the game’s types or of your own.
            </p>
          ) : (
            <ul className="touch-plain-list locations-rows" data-testid="own-types">
              {types.map((type) => (
                <li key={type.id}>
                  <button
                    type="button"
                    className="locations-row"
                    aria-current={openId === type.id ? 'true' : undefined}
                    data-testid="own-type-row"
                    onClick={() => {
                      openSide({ kind: 'type', id: type.id, forLocation: null });
                    }}
                  >
                    <GlyphBadge icon={type.icon} color={type.color} size={28} />
                    <span className="locations-row-text">
                      <span className="locations-row-name">{type.name}</span>
                      <span className="locations-row-detail">
                        {game.pack.categoryGroups.get(type.groupId)?.name ?? ''} ·{' '}
                        {counts.get(type.id) === 1
                          ? 'one location'
                          : `${numberFormat.format(counts.get(type.id) ?? 0)} locations`}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="own-pill-button locations-new"
            data-testid="new-type"
            onClick={() => {
              openSide({ kind: 'type', id: null, forLocation: null });
            }}
          >
            <UiIcon name="plus" size={18} strokeWidth={1.9} />
            New type
          </button>
        </section>
        <section className="locations-section" aria-labelledby={`${titleId}-areas`}>
          <h2 id={`${titleId}-areas`} className="locations-heading">
            Your areas on {mapName}
          </h2>
          {areas.length === 0 ? (
            <p className="locations-empty">None yet.</p>
          ) : (
            <ul className="touch-plain-list locations-rows" data-testid="own-areas">
              {areas.map((area) => (
                <li key={area.id}>
                  <button
                    type="button"
                    className="locations-row"
                    aria-current={openId === area.id ? 'true' : undefined}
                    data-testid="own-area-row"
                    onClick={() => {
                      openSide({ kind: 'area', id: area.id, forLocation: null });
                    }}
                  >
                    <span className="locations-row-text">
                      <span className="locations-row-name">{area.name}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="own-pill-button locations-new"
            data-testid="new-area"
            disabled={!mapId}
            onClick={() => {
              openSide({ kind: 'area', id: null, forLocation: null });
            }}
          >
            <UiIcon name="plus" size={18} strokeWidth={1.9} />
            New area
          </button>
        </section>
      </div>
    </div>
  );
}

function OwnLocationRow({
  game,
  location,
  open,
}: {
  game: LoadedGame;
  location: OwnLocation;
  open: boolean;
}) {
  const type = game.pack.categories.get(location.categoryId);
  const area = location.regionId ? game.pack.regions.get(location.regionId) : undefined;
  const level =
    game.pack.layersOf(location.mapId).length > 1
      ? game.pack.layers.get(location.layerId)?.name
      : undefined;
  return (
    <li>
      <button
        type="button"
        className="locations-row"
        aria-current={open ? 'true' : undefined}
        data-testid="own-location-row"
        onClick={() => {
          openSide({ kind: 'location', id: location.id });
          goToLocation(location.id);
        }}
      >
        {type ? <GlyphBadge icon={type.icon} color={type.color} size={28} /> : null}
        <span className="locations-row-text">
          <span className="locations-row-name">{location.name}</span>
          <span className="locations-row-detail">
            {[type?.name, area?.name, level].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// The panel over the map

export function LocationEditorSide({ game }: { game: LoadedGame }) {
  const side = useLocationEditor((s) => s.side);
  const location = useOwnLocations((s) =>
    side?.kind === 'location' ? s.own.locations.find((l) => l.id === side.id) : undefined,
  );
  if (!side) return null;
  switch (side.kind) {
    case 'location':
      return location ? <LocationForm key={location.id} game={game} location={location} /> : null;
    case 'game-location':
      return <GameLocationNote game={game} id={side.id} />;
    case 'type':
      return (
        <TypePanel key={side.id ?? 'new'} game={game} id={side.id} forLocation={side.forLocation} />
      );
    case 'area':
      return (
        <AreaPanel key={side.id ?? 'new'} game={game} id={side.id} forLocation={side.forLocation} />
      );
  }
}

/** The title of the panel over the map takes the focus when it opens, unless a field does. */
function useSideTitle(skip = false) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!skip) ref.current?.focus();
  }, [skip]);
  return ref;
}

function SideHead({
  id,
  title,
  titleRef,
  onClose,
  closeLabel,
}: {
  id: string;
  title: string;
  titleRef: React.RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
  closeLabel: string;
}) {
  return (
    <header className="editor-side-head">
      <h2 id={id} ref={titleRef} className="editor-side-title" tabIndex={-1}>
        {title}
      </h2>
      <button
        type="button"
        className="touch-icon-button editor-side-icon"
        aria-label={closeLabel}
        data-testid="close-side"
        onClick={onClose}
      >
        <UiIcon name="close" size={22} strokeWidth={1.8} />
      </button>
    </header>
  );
}

/** A text field kept as typed and changed when it is left or Enter is pressed. */
function useDraft(value: string, commit: (text: string) => void) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    // Changed elsewhere (Undo): show what it is now.
    setShown(value);
    setDraft(value);
  }
  return {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setDraft(event.target.value);
    },
    onBlur: () => {
      if (draft !== value) commit(draft);
    },
    reset: () => {
      setDraft(value);
    },
  };
}

function LocationForm({ game, location }: { game: LoadedGame; location: OwnLocation }) {
  const focusName = useLocationEditor((s) => s.focusName);
  const [focusedFor] = useState(focusName);
  const fresh = focusName > 0 && focusName === focusedFor && location.name === 'New location';
  const titleRef = useSideTitle(fresh);
  const nameRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const moving = useLocationEditor((s) => s.moving === location.id);
  const groups = useMemo(() => typeGroups(game), [game]);
  const areas = useMemo(() => areasOf(game, location.mapId), [game, location.mapId]);
  const type = game.pack.categories.get(location.categoryId);

  useEffect(() => {
    if (!fresh) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [fresh]);

  const name = useDraft(location.name, (text) => {
    if (text.trim()) changeOwn(location.id, { name: text.trim() }, 'Location renamed');
  });
  const note = useDraft(location.note ?? '', (text) => {
    changeOwn(location.id, { note: text }, 'Note changed');
  });

  return (
    <aside className="editor-side" aria-labelledby={`${id}-title`} data-testid="location-panel">
      <SideHead
        id={`${id}-title`}
        title="Your location"
        titleRef={titleRef}
        closeLabel="Close the location"
        onClose={() => {
          openSide(null);
        }}
      />
      <div className="editor-side-body">
        <label className="own-field">
          <span className="own-label">Name</span>
          <input
            ref={nameRef}
            className="own-input"
            data-testid="location-name"
            maxLength={200}
            required
            {...name}
            onBlur={() => {
              if (!name.value.trim()) name.reset();
              else name.onBlur();
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                (event.target as HTMLInputElement).blur();
              } else if (event.key === 'Escape') {
                name.reset();
              }
            }}
          />
        </label>
        <div className="own-field">
          <label className="own-label" htmlFor={`${id}-type`}>
            Type
          </label>
          <div className="locations-pick">
            {type ? <GlyphBadge icon={type.icon} color={type.color} size={28} /> : null}
            <select
              id={`${id}-type`}
              className="own-input locations-select"
              data-testid="location-type"
              value={location.categoryId}
              onChange={(event) => {
                changeOwn(location.id, { categoryId: event.target.value }, 'Type changed');
              }}
            >
              {groups.map((group) => (
                <optgroup key={group.id} label={group.name}>
                  {group.types.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="locations-links">
            <button
              type="button"
              className="own-text-button"
              data-testid="location-new-type"
              onClick={() => {
                openSide({ kind: 'type', id: null, forLocation: location.id });
              }}
            >
              <UiIcon name="plus" size={16} strokeWidth={1.9} />
              New type
            </button>
            {type && game.pack.categories.has(type.id) && isOwnId(type.id) ? (
              <button
                type="button"
                className="own-text-button"
                onClick={() => {
                  openSide({ kind: 'type', id: type.id, forLocation: location.id });
                }}
              >
                <UiIcon name="pencil" size={16} strokeWidth={1.8} />
                Change “{type.name}”
              </button>
            ) : null}
          </div>
        </div>
        <div className="own-field">
          <label className="own-label" htmlFor={`${id}-area`}>
            Area
          </label>
          <select
            id={`${id}-area`}
            className="own-input locations-select"
            data-testid="location-area"
            value={location.regionId ?? ''}
            onChange={(event) => {
              changeOwn(
                location.id,
                { regionId: event.target.value === '' ? null : event.target.value },
                'Area changed',
              );
            }}
          >
            <option value="">No area</option>
            {areas.map((area) => (
              <option key={area.id} value={area.id}>
                {area.name}
              </option>
            ))}
          </select>
          <div className="locations-links">
            <button
              type="button"
              className="own-text-button"
              data-testid="location-new-area"
              onClick={() => {
                openSide({ kind: 'area', id: null, forLocation: location.id });
              }}
            >
              <UiIcon name="plus" size={16} strokeWidth={1.9} />
              New area
            </button>
          </div>
        </div>
        <label className="own-field">
          <span className="own-label">Note (optional)</span>
          <textarea
            className="own-input locations-note"
            data-testid="location-note"
            rows={4}
            maxLength={20_000}
            placeholder="What is here, how to get to it"
            {...note}
          />
        </label>
        <div className="own-field">
          <span className="own-label">Where it is</span>
          <p className="editor-side-line" data-testid="location-position">
            {Math.round(location.x)}, {Math.round(location.y)}
            {game.pack.layersOf(location.mapId).length > 1
              ? ` on ${game.pack.layers.get(location.layerId)?.name ?? 'its level'}`
              : ''}
            . Drag the ring on the map, or give it the focus and use the arrow keys.
          </p>
          <button
            type="button"
            className="own-pill-button locations-move"
            aria-pressed={moving}
            data-testid="location-move"
            onClick={() => {
              setMoving(moving ? null : location.id);
            }}
          >
            <UiIcon name="pin" size={18} strokeWidth={1.8} />
            {moving ? 'Click the map, or press to cancel' : 'Move to a point on the map'}
          </button>
        </div>
      </div>
      <footer className="editor-side-foot">
        <button
          type="button"
          className="own-text-button editor-danger"
          data-testid="delete-location"
          onClick={() => {
            deleteOwnLocationNow(location.id);
            focusOutline();
          }}
        >
          <UiIcon name="trash" size={18} strokeWidth={1.8} />
          Delete location
        </button>
      </footer>
    </aside>
  );
}

function focusOutline() {
  window.setTimeout(() => {
    document.querySelector<HTMLElement>('[data-testid="locations-undo"]')?.focus();
  }, 0);
}

function GameLocationNote({ game, id }: { game: LoadedGame; id: string }) {
  const location = game.pack.locations.get(id);
  const titleRef = useSideTitle();
  const titleId = useId();
  return (
    <aside className="editor-side" aria-labelledby={titleId} data-testid="game-location-panel">
      <SideHead
        id={titleId}
        title={location?.name ?? 'Location'}
        titleRef={titleRef}
        closeLabel="Close"
        onClose={() => {
          openSide(null);
        }}
      />
      <div className="editor-side-body">
        <p className="editor-side-line editor-side-lead">
          This location comes with the game, so it is not changed here. Click the map off the
          markers to put a location of your own there.
        </p>
      </div>
    </aside>
  );
}

/** The name of an icon, for its button. */
const iconLabel = (icon: string) => icon.charAt(0).toUpperCase() + icon.slice(1);

function TypePanel({
  game,
  id,
  forLocation,
}: {
  game: LoadedGame;
  id: string | null;
  forLocation: string | null;
}) {
  const before = id ? game.pack.categories.get(id) : undefined;
  const ownGroups = useOwnLocations((s) => s.own.categoryGroups);
  const used = useOwnLocations((s) => (id ? ownLocationsOfTypeCount(s.own, id) : 0));
  const groups = useMemo(
    () => [...game.pack.data.categoryGroups].sort((a, b) => a.order - b.order),
    [game],
  );
  const firstOwnGroup = ownGroups[0]?.id ?? null;
  const [form, setForm] = useState<TypeForm>(() => ({
    name: before?.name ?? '',
    color: before?.color ?? OWN_TYPE_COLOURS[0],
    icon: before?.icon ?? 'pin',
    groupId: before?.groupId ?? firstOwnGroup,
    newGroup: firstOwnGroup ? '' : 'My types',
  }));
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useSideTitle(true);
  const nameRef = useRef<HTMLInputElement>(null);
  const id2 = useId();
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const back = () => {
    openSide(forLocation ? { kind: 'location', id: forLocation } : null);
  };
  const submit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setProblem('Give the type a name.');
      nameRef.current?.focus();
      return;
    }
    if (form.groupId === null && !form.newGroup.trim()) {
      setProblem('Give the new group a name.');
      return;
    }
    const saved = saveOwnType(form, id ?? undefined);
    if (!saved) return;
    if (forLocation) changeOwn(forLocation, { categoryId: saved }, 'Type changed');
    back();
  };

  return (
    <aside className="editor-side" aria-labelledby={`${id2}-title`} data-testid="type-panel">
      <SideHead
        id={`${id2}-title`}
        title={id ? `Type “${before?.name ?? ''}”` : 'New type'}
        titleRef={titleRef}
        closeLabel="Close without saving"
        onClose={back}
      />
      <form className="locations-form" onSubmit={submit} noValidate>
        <div className="editor-side-body">
          <label className="own-field">
            <span className="own-label">Name</span>
            <input
              ref={nameRef}
              className="own-input"
              data-testid="type-name"
              maxLength={200}
              value={form.name}
              onChange={(event) => {
                setForm({ ...form, name: event.target.value });
                setProblem(null);
              }}
            />
          </label>
          <fieldset className="own-field locations-fieldset">
            <legend className="own-label">Colour</legend>
            <div className="locations-swatches" data-testid="type-colours">
              {OWN_TYPE_COLOURS.map((colour, index) => (
                <label key={colour} className="locations-swatch" title={`Colour ${index + 1}`}>
                  <input
                    type="radio"
                    name={`${id2}-colour`}
                    className="visually-hidden"
                    value={colour}
                    aria-label={`Colour ${index + 1} of ${OWN_TYPE_COLOURS.length}`}
                    checked={form.color === colour}
                    onChange={() => {
                      setForm({ ...form, color: colour });
                    }}
                  />
                  <span className="locations-swatch-dot" style={{ background: colour }} />
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="own-field locations-fieldset">
            <legend className="own-label">Icon</legend>
            <div className="locations-icons" data-testid="type-icons">
              {ICON_NAMES.map((icon) => (
                <label key={icon} className="locations-icon" title={iconLabel(icon)}>
                  <input
                    type="radio"
                    name={`${id2}-icon`}
                    className="visually-hidden"
                    value={icon}
                    aria-label={iconLabel(icon)}
                    checked={form.icon === icon}
                    onChange={() => {
                      setForm({ ...form, icon });
                    }}
                  />
                  <GlyphBadge icon={icon} color={form.color} size={30} />
                </label>
              ))}
            </div>
          </fieldset>
          <div className="own-field">
            <label className="own-label" htmlFor={`${id2}-group`}>
              Group
            </label>
            <select
              id={`${id2}-group`}
              className="own-input locations-select"
              data-testid="type-group"
              value={form.groupId ?? ''}
              onChange={(event) => {
                setForm({
                  ...form,
                  groupId: event.target.value === '' ? null : event.target.value,
                  newGroup: form.newGroup || 'My types',
                });
              }}
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
              <option value="">A new group…</option>
            </select>
          </div>
          {form.groupId === null ? (
            <label className="own-field">
              <span className="own-label">New group’s name</span>
              <input
                className="own-input"
                data-testid="type-new-group"
                maxLength={200}
                value={form.newGroup}
                onChange={(event) => {
                  setForm({ ...form, newGroup: event.target.value });
                  setProblem(null);
                }}
              />
            </label>
          ) : null}
          {problem ? (
            <p className="own-problem" role="alert">
              {problem}
            </p>
          ) : null}
          <p className="editor-side-line">
            Locations of a new type are shown on the map and can be marked found.
          </p>
        </div>
        <footer className="editor-side-foot">
          {id ? (
            <button
              type="button"
              className="own-text-button editor-danger"
              data-testid="delete-type"
              disabled={used > 0}
              title={
                used > 0
                  ? 'Your locations of this type need another type first'
                  : 'Delete this type'
              }
              onClick={() => {
                if (deleteOwnType(id)) {
                  openSide(null);
                  focusOutline();
                }
              }}
            >
              <UiIcon name="trash" size={18} strokeWidth={1.8} />
              Delete type
            </button>
          ) : null}
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={back}>
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            data-testid="save-type"
          >
            {id ? 'Save' : 'Make type'}
          </button>
        </footer>
      </form>
    </aside>
  );
}

function AreaPanel({
  game,
  id,
  forLocation,
}: {
  game: LoadedGame;
  id: string | null;
  forLocation: string | null;
}) {
  const before = id ? game.pack.regions.get(id) : undefined;
  const mapId = useAtlas((s) => s.mapId);
  const location = useOwnLocations((s) =>
    forLocation ? s.own.locations.find((l) => l.id === forLocation) : undefined,
  );
  const areaMap = before?.mapId ?? location?.mapId ?? mapId;
  const [name, setName] = useState(before?.name ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const titleRef = useSideTitle(true);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  const back = () => {
    openSide(forLocation ? { kind: 'location', id: forLocation } : null);
  };
  const submit = (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (!name.trim()) {
      setProblem('Give the area a name.');
      nameRef.current?.focus();
      return;
    }
    if (!areaMap) return;
    const saved = saveOwnArea(areaMap, name, id ?? undefined);
    if (saved && forLocation) changeOwn(forLocation, { regionId: saved }, 'Area changed');
    back();
  };
  const mapName = game.pack.maps.get(areaMap ?? '')?.name ?? 'this map';
  return (
    <aside className="editor-side" aria-labelledby={titleId} data-testid="area-panel">
      <SideHead
        id={titleId}
        title={id ? `Area “${before?.name ?? ''}”` : `New area of ${mapName}`}
        titleRef={titleRef}
        closeLabel="Close without saving"
        onClose={back}
      />
      <form className="locations-form" onSubmit={submit} noValidate>
        <div className="editor-side-body">
          <label className="own-field">
            <span className="own-label">Name</span>
            <input
              ref={nameRef}
              className="own-input"
              data-testid="area-name"
              maxLength={200}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
            />
          </label>
          {problem ? (
            <p className="own-problem" role="alert">
              {problem}
            </p>
          ) : null}
          <p className="editor-side-line">
            An area is a name that locations on {mapName} can be in, for lists and search. It has no
            outline on the map.
          </p>
        </div>
        <footer className="editor-side-foot">
          {id ? (
            <button
              type="button"
              className="own-text-button editor-danger"
              data-testid="delete-area"
              onClick={() => {
                if (deleteOwnArea(id)) {
                  openSide(null);
                  focusOutline();
                }
              }}
            >
              <UiIcon name="trash" size={18} strokeWidth={1.8} />
              Delete area
            </button>
          ) : null}
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={back}>
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            data-testid="save-area"
          >
            {id ? 'Save' : 'Make area'}
          </button>
        </footer>
      </form>
    </aside>
  );
}
