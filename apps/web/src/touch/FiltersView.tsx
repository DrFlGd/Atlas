import type { Category, CategoryGroup } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { GlyphBadge, UiIcon } from '../components/icons';
import {
  applyPreset,
  deleteUserPreset,
  resetFilters,
  saveUserPreset,
  setCategoriesVisible,
  setHideFound,
  setNotesOnly,
} from '../state/actions';
import { numberFormat, useSummary, useVisibleCategories } from '../state/derived';
import { useAtlas, type LoadedGame } from '../state/store';
import { ListOnlyChip } from './ListMapChips';
import { NotesWithoutLocation } from './NotesWithoutLocation';
import { useNotedLocations } from '../state/ownNotes';
import { setFiltersOpen, soloKind, toggleSolo, useTouch } from './state';
import { SwitchTrack } from './widgets';

/** The kinds on a map, grouped and in pack order. */
function useKindGroups(game: LoadedGame, mapId: string | null) {
  return useMemo(() => {
    const present = new Set<string>();
    for (const location of game.pack.data.locations) {
      if (location.mapId === mapId) present.add(location.categoryId);
    }
    const byGroup = new Map<string, Category[]>();
    for (const category of game.pack.data.categories) {
      if (!present.has(category.id)) continue;
      const list = byGroup.get(category.groupId);
      if (list) list.push(category);
      else byGroup.set(category.groupId, [category]);
    }
    return [...game.pack.data.categoryGroups]
      .sort((a, b) => a.order - b.order)
      .flatMap((group) => {
        const categories = byGroup.get(group.id);
        return categories ? [{ group, categories }] : [];
      });
  }, [game, mapId]);
}

/** How many kinds on the map shown are hidden. */
function useHiddenCount(): number {
  const game = useAtlas((s) => s.game)!;
  const mapId = useAtlas((s) => s.mapId);
  const visible = useVisibleCategories();
  const groups = useKindGroups(game, mapId);
  return groups.reduce(
    (sum, { categories }) => sum + categories.filter((c) => !visible.has(c.id)).length,
    0,
  );
}

/**
 * The chips over the map on a phone: the filters, "Hide found", and one
 * chip per kind (tracked kinds first) that shows that kind alone.
 */
export function ChipRow() {
  const game = useAtlas((s) => s.game)!;
  const mapId = useAtlas((s) => s.mapId);
  const hideFound = useAtlas((s) => s.hideFound);
  const notesOnly = useAtlas((s) => s.notesOnly);
  const noted = useNotedLocations(game)?.size ?? 0;
  const overrides = useAtlas((s) => s.overrides);
  const solo = useTouch((s) => soloKind(s, overrides));
  const hidden = useHiddenCount();
  const groups = useKindGroups(game, mapId);
  const kinds = useMemo(() => {
    const all = groups.flatMap((g) => g.categories);
    return [...all.filter((c) => c.trackable), ...all.filter((c) => !c.trackable)];
  }, [groups]);
  return (
    <div className="touch-chip-row" role="toolbar" aria-label="Filters">
      <ListOnlyChip />
      <button
        type="button"
        className="touch-chip touch-chip-float"
        aria-haspopup="dialog"
        data-testid="filters-chip"
        onClick={() => {
          setFiltersOpen(true);
        }}
      >
        <UiIcon name="filters" size={18} />
        Filters
        {hidden > 0 ? <span className="touch-chip-count">{hidden} hidden</span> : null}
      </button>
      <button
        type="button"
        className="touch-chip touch-chip-float"
        aria-pressed={hideFound}
        data-testid="hide-found-chip"
        onClick={() => {
          setHideFound(!hideFound);
        }}
      >
        <UiIcon name="foundCircle" size={18} />
        Hide found
      </button>
      {noted > 0 || notesOnly ? (
        <button
          type="button"
          className="touch-chip touch-chip-float"
          aria-pressed={notesOnly}
          data-testid="notes-only-chip"
          onClick={() => {
            setNotesOnly(!notesOnly);
          }}
        >
          <UiIcon name="pencil" size={18} />
          With my notes
        </button>
      ) : null}
      {kinds.map((category) => (
        <button
          key={category.id}
          type="button"
          className="touch-chip touch-chip-float touch-chip-kind"
          aria-pressed={solo === category.id}
          data-testid="kind-chip"
          data-category={category.id}
          onClick={() => {
            toggleSolo(category.id);
          }}
        >
          <GlyphBadge icon={category.icon} color={category.color} size={26} />
          {category.name}
        </button>
      ))}
    </div>
  );
}

/** The filters on a phone: a sheet over the map. */
export function FiltersSheet() {
  const game = useAtlas((s) => s.game)!;
  const mapId = useAtlas((s) => s.mapId);
  const groups = useKindGroups(game, mapId);
  const close = () => {
    setFiltersOpen(false);
  };
  return (
    <>
      <div className="touch-scrim" aria-hidden="true" onClick={close} />
      <section
        className="touch-sheet touch-filters-sheet"
        role="dialog"
        aria-labelledby="filters-title"
        data-testid="filters-sheet"
      >
        <div className="touch-sheet-grip" aria-hidden="true" />
        <div className="touch-sheet-head">
          <h1 className="touch-sheet-title" id="filters-title">
            Filters
          </h1>
          <ShowAll groups={groups} />
          <button
            type="button"
            className="touch-round-button"
            aria-label="Close the filters"
            onClick={close}
          >
            <UiIcon name="close" size={18} strokeWidth={1.8} />
          </button>
        </div>
        <div className="touch-scroll" data-scroll-root>
          <FilterBody groups={groups} />
        </div>
      </section>
    </>
  );
}

/** The filters in the wide panel, under the search field. */
export function FiltersPanel() {
  const game = useAtlas((s) => s.game)!;
  const mapId = useAtlas((s) => s.mapId);
  const groups = useKindGroups(game, mapId);
  return (
    <div className="touch-scroll" data-scroll-root data-testid="filters-panel">
      <FilterBody
        groups={groups}
        showAll={
          <span className="touch-kinds-actions">
            <ShowAll groups={groups} />
            <HideAll groups={groups} />
          </span>
        }
      />
    </div>
  );
}

type KindGroups = ReturnType<typeof useKindGroups>;

function ShowAll({ groups }: { groups: KindGroups }) {
  const ids = groups.flatMap((g) => g.categories.map((c) => c.id));
  return (
    <button
      type="button"
      className="touch-text-button"
      data-testid="show-all-kinds"
      onClick={() => {
        setCategoriesVisible(ids, true);
      }}
    >
      Show all
    </button>
  );
}

/** "Hide all", beside "Show all" in the wide panel, as the classic filters have it. */
function HideAll({ groups }: { groups: KindGroups }) {
  const ids = groups.flatMap((g) => g.categories.map((c) => c.id));
  return (
    <button
      type="button"
      className="touch-text-button"
      data-testid="hide-all-kinds"
      onClick={() => {
        setCategoriesVisible(ids, false);
      }}
    >
      Hide all
    </button>
  );
}

function FilterBody({ groups, showAll }: { groups: KindGroups; showAll?: React.ReactNode }) {
  const game = useAtlas((s) => s.game)!;
  const hideFound = useAtlas((s) => s.hideFound);
  const notesOnly = useAtlas((s) => s.notesOnly);
  const noted = useNotedLocations(game)?.size ?? 0;
  return (
    <div className="touch-filters">
      <button
        type="button"
        role="switch"
        aria-checked={hideFound}
        className="touch-switch-card"
        data-testid="hide-found-switch"
        onClick={() => {
          setHideFound(!hideFound);
        }}
      >
        <span className="touch-switch-label">Hide what I have found</span>
        <SwitchTrack on={hideFound} />
      </button>
      {noted > 0 || notesOnly ? (
        <button
          type="button"
          role="switch"
          aria-checked={notesOnly}
          className="touch-switch-card"
          data-testid="notes-only-switch"
          onClick={() => {
            setNotesOnly(!notesOnly);
          }}
        >
          <span className="touch-switch-label">
            With my notes
            <span className="touch-switch-note">
              {notesOnly
                ? `Only the ${noted === 1 ? 'location' : `${numberFormat.format(noted)} locations`} with a note of yours, whatever types are shown.`
                : `Show only the ${noted === 1 ? 'location' : `${numberFormat.format(noted)} locations`} with a note of yours.`}
            </span>
          </span>
          <SwitchTrack on={notesOnly} />
        </button>
      ) : null}
      <NotesWithoutLocation game={game} />
      <Presets />
      {showAll ? (
        <div className="touch-group-head touch-kinds-head">
          <h2 className="touch-group-title">Types on this map</h2>
          {showAll}
        </div>
      ) : null}
      {groups.map(({ group, categories }) => (
        <KindGroup key={group.id} group={group} categories={categories} />
      ))}
    </div>
  );
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  const unique = new Set(b);
  return a.size === unique.size && [...unique].every((id) => a.has(id));
}

function Presets() {
  const game = useAtlas((s) => s.game)!;
  const userPresets = useAtlas((s) => s.userPresets);
  const visible = useVisibleCategories();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);
  const presets = game.pack.data.presets;
  const submit = () => {
    if (!name.trim()) return;
    void saveUserPreset(name).then(() => {
      setName('');
      setNaming(false);
    });
  };
  return (
    <section className="touch-presets" aria-labelledby={`${inputId}-heading`}>
      <div className="touch-presets-row">
        <h2 className="touch-presets-label" id={`${inputId}-heading`}>
          Presets
        </h2>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="touch-chip"
            aria-pressed={sameSet(visible, preset.categoryIds)}
            onClick={() => {
              applyPreset(preset.categoryIds);
            }}
          >
            {preset.name}
          </button>
        ))}
        {userPresets.map((preset) => (
          <span key={preset.id} className="touch-chip-pair">
            <button
              type="button"
              className="touch-chip"
              aria-pressed={sameSet(visible, preset.categoryIds)}
              onClick={() => {
                applyPreset(preset.categoryIds);
              }}
            >
              {preset.name}
            </button>
            <button
              type="button"
              className="touch-chip touch-chip-remove"
              aria-label={`Delete preset ${preset.name}`}
              onClick={() => {
                void deleteUserPreset(preset.id);
              }}
            >
              <UiIcon name="close" size={14} strokeWidth={2} />
            </button>
          </span>
        ))}
      </div>
      {naming ? (
        <form
          className="touch-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId} className="visually-hidden">
            Preset name
          </label>
          <input
            ref={inputRef}
            id={inputId}
            className="touch-text-input"
            placeholder="Preset name"
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button
            type="submit"
            className="touch-button touch-button-primary"
            disabled={!name.trim()}
          >
            Save
          </button>
          <button
            type="button"
            className="touch-button"
            onClick={() => {
              setNaming(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="touch-presets-actions">
          <button
            type="button"
            className="touch-text-button"
            onClick={() => {
              setNaming(true);
            }}
          >
            Save current as preset…
          </button>
          <button
            type="button"
            className="touch-text-button"
            data-testid="reset-filters"
            onClick={resetFilters}
          >
            Reset filters
          </button>
        </div>
      )}
    </section>
  );
}

/** A group of kinds: its heading switches the whole group, each row one kind. */
function KindGroup({ group, categories }: { group: CategoryGroup; categories: Category[] }) {
  const mapId = useAtlas((s) => s.mapId);
  const summary = useSummary();
  const visible = useVisibleCategories();
  const shown = categories.filter((c) => visible.has(c.id)).length;
  const all = shown === categories.length;
  const tally = summary?.group(group.id, mapId);
  const headingId = useId();
  return (
    <section className="touch-kind-group" aria-labelledby={headingId}>
      <div className="touch-group-head">
        <h2 className="touch-group-title" id={headingId}>
          {group.name}
        </h2>
        {tally && tally.total > 0 ? (
          <span className="touch-figure">
            {numberFormat.format(tally.found)} of {numberFormat.format(tally.total)}
          </span>
        ) : null}
        <button
          type="button"
          role="switch"
          aria-checked={all}
          aria-label={`All of ${group.name}`}
          className="touch-group-switch"
          data-testid="group-switch"
          onClick={() => {
            setCategoriesVisible(
              categories.map((c) => c.id),
              !all,
            );
          }}
        >
          <SwitchTrack on={all} />
        </button>
      </div>
      {categories.map((category) => {
        const on = visible.has(category.id);
        const kindTally = summary?.category(category.id, mapId);
        return (
          <button
            key={category.id}
            type="button"
            role="switch"
            aria-checked={on}
            className={on ? 'touch-kind-row' : 'touch-kind-row touch-kind-row-off'}
            data-testid="kind-switch"
            data-category={category.id}
            onClick={() => {
              setCategoriesVisible([category.id], !on);
            }}
          >
            <GlyphBadge icon={category.icon} color={category.color} size={32} muted={!on} />
            <span className="touch-kind-name">{category.name}</span>
            <span className="touch-figure">
              {kindTally
                ? kindTally.total > 0
                  ? `${numberFormat.format(kindTally.found)} / ${numberFormat.format(kindTally.total)}`
                  : numberFormat.format(kindTally.count)
                : ''}
            </span>
            <SwitchTrack on={on} />
          </button>
        );
      })}
    </section>
  );
}
