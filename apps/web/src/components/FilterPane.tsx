import { percent, type ProgressSummary, type Tally } from '@atlas/core';
import type { Category, CategoryGroup, Region } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  applyPreset,
  deleteUserPreset,
  resetFilters,
  saveUserPreset,
  setCategoriesVisible,
  setHideFound,
} from '../state/actions';
import { numberFormat, useSummary, useVisibleCategories } from '../state/derived';
import { useAtlas } from '../state/store';
import { GlyphBadge, UiIcon } from './icons';

/** Left pane: presets, the "hide found" toggle, the category tree and region progress. */
export function FilterPane() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const summary = useSummary();
  if (!game || !mapId || !summary) return null;
  return (
    <div className="pane-body">
      <Presets />
      <HideFoundToggle />
      <CategoryTree mapId={mapId} summary={summary} />
      <RegionProgress mapId={mapId} summary={summary} />
    </div>
  );
}

function sameSet(a: ReadonlySet<string>, b: readonly string[]): boolean {
  const unique = new Set(b);
  return a.size === unique.size && [...unique].every((id) => a.has(id));
}

function Presets() {
  const game = useAtlas((s) => s.game);
  const userPresets = useAtlas((s) => s.userPresets);
  const visible = useVisibleCategories();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (naming) inputRef.current?.focus();
  }, [naming]);
  if (!game) return null;
  const packPresets = game.pack.data.presets;

  const submit = () => {
    if (!name.trim()) return;
    void saveUserPreset(name).then(() => {
      setName('');
      setNaming(false);
    });
  };

  return (
    <section className="section" aria-labelledby={`${inputId}-heading`}>
      <h2 className="section-title" id={`${inputId}-heading`}>
        Presets
      </h2>
      <div className="chips">
        {packPresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="chip"
            aria-pressed={sameSet(visible, preset.categoryIds)}
            onClick={() => {
              applyPreset(preset.categoryIds);
            }}
          >
            {preset.name}
          </button>
        ))}
        {userPresets.map((preset) => (
          <span key={preset.id} className="chip-group">
            <button
              type="button"
              className="chip chip-user"
              aria-pressed={sameSet(visible, preset.categoryIds)}
              onClick={() => {
                applyPreset(preset.categoryIds);
              }}
            >
              {preset.name}
            </button>
            <button
              type="button"
              className="chip chip-remove"
              aria-label={`Delete preset ${preset.name}`}
              title="Delete preset"
              onClick={() => {
                void deleteUserPreset(preset.id);
              }}
            >
              <UiIcon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      {naming ? (
        <form
          className="inline-form"
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
            className="text-input"
            placeholder="Preset name"
            maxLength={80}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setNaming(false);
            }}
          />
          <button type="submit" className="button button-primary" disabled={!name.trim()}>
            Save
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setNaming(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setNaming(true);
            }}
          >
            Save current as preset…
          </button>
          <button type="button" className="link-button" onClick={resetFilters}>
            Reset filters
          </button>
        </div>
      )}
    </section>
  );
}

function HideFoundToggle() {
  const hideFound = useAtlas((s) => s.hideFound);
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={hideFound}
        onChange={(event) => {
          setHideFound(event.target.checked);
        }}
      />
      <span className="switch-track" aria-hidden="true" />
      Hide found
    </label>
  );
}

function CountBadge({ tally }: { tally: Tally }) {
  if (tally.total === 0) {
    return (
      <span className="count" title={`${tally.count} on this map, not tracked`}>
        {numberFormat.format(tally.count)}
      </span>
    );
  }
  const complete = tally.found === tally.total;
  return (
    <span
      className={complete ? 'count count-complete' : 'count'}
      title={`${tally.found} of ${tally.total} found`}
    >
      {numberFormat.format(tally.found)}/{numberFormat.format(tally.total)}
    </span>
  );
}

function CategoryTree({ mapId, summary }: { mapId: string; summary: ProgressSummary }) {
  const game = useAtlas((s) => s.game)!;
  const visible = useVisibleCategories();
  const groups = useMemo(() => {
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

  const allIds = groups.flatMap((g) => g.categories.map((c) => c.id));
  return (
    <section className="section" aria-labelledby="categories-heading">
      <div className="section-head">
        <h2 className="section-title" id="categories-heading">
          Categories
        </h2>
        <div className="row-actions">
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setCategoriesVisible(allIds, true);
            }}
          >
            Show all
          </button>
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setCategoriesVisible(allIds, false);
            }}
          >
            Hide all
          </button>
        </div>
      </div>
      <ul className="tree" data-testid="category-tree">
        {groups.map(({ group, categories }) => (
          <GroupRow
            key={group.id}
            group={group}
            categories={categories}
            visible={visible}
            tally={summary.group(group.id, mapId)}
            categoryTally={(id) => summary.category(id, mapId)}
          />
        ))}
      </ul>
    </section>
  );
}

interface GroupRowProps {
  group: CategoryGroup;
  categories: Category[];
  visible: ReadonlySet<string>;
  tally: Tally;
  categoryTally: (categoryId: string) => Tally;
}

function GroupRow({ group, categories, visible, tally, categoryTally }: GroupRowProps) {
  const [open, setOpen] = useState(true);
  const checkboxRef = useRef<HTMLInputElement>(null);
  const shown = categories.filter((c) => visible.has(c.id)).length;
  const all = shown === categories.length;
  const some = shown > 0 && !all;
  const listId = useId();
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = some;
  }, [some]);
  const ids = categories.map((c) => c.id);

  return (
    <li className="tree-group">
      <div className="tree-row tree-row-group" data-testid={`group-${group.id}`}>
        <button
          type="button"
          className="disclosure"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <UiIcon name="chevron" size={14} />
        </button>
        <label className="tree-label">
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={all}
            aria-checked={some ? 'mixed' : all}
            onChange={() => {
              setCategoriesVisible(ids, !all);
            }}
          />
          <span className="tree-name tree-name-group">{group.name}</span>
        </label>
        <CountBadge tally={tally} />
      </div>
      <ul id={listId} className="tree-children" hidden={!open}>
        {categories.map((category) => (
          <li key={category.id}>
            <label className="tree-row tree-label" data-testid={`category-${category.id}`}>
              <input
                type="checkbox"
                checked={visible.has(category.id)}
                onChange={(event) => {
                  setCategoriesVisible([category.id], event.target.checked);
                }}
              />
              <GlyphBadge icon={category.icon} color={category.color} size={20} />
              <span className="tree-name">{category.name}</span>
              <CountBadge tally={categoryTally(category.id)} />
            </label>
          </li>
        ))}
      </ul>
    </li>
  );
}

function RegionProgress({ mapId, summary }: { mapId: string; summary: ProgressSummary }) {
  const game = useAtlas((s) => s.game)!;
  const tree = useMemo(() => {
    const regions = game.pack.data.regions.filter((r) => r.mapId === mapId);
    const children = new Map<string | null, Region[]>();
    for (const region of regions) {
      const parent = region.parentId;
      const list = children.get(parent);
      if (list) list.push(region);
      else children.set(parent, [region]);
    }
    return children;
  }, [game, mapId]);
  const roots = tree.get(null) ?? [];
  const mapTally = summary.map(mapId);
  const mapName = game.pack.maps.get(mapId)?.name ?? 'This map';

  const renderRegions = (regions: Region[], depth: number): React.ReactNode =>
    regions.map((region) => {
      const tally = summary.region(region.id);
      if (tally.count === 0) return null;
      return (
        <li key={region.id}>
          <ProgressRow name={region.name} tally={tally} depth={depth} />
          {tree.get(region.id) ? (
            <ul className="region-list">{renderRegions(tree.get(region.id)!, depth + 1)}</ul>
          ) : null}
        </li>
      );
    });

  return (
    <section className="section" aria-labelledby="regions-heading">
      <h2 className="section-title" id="regions-heading">
        Progress
      </h2>
      <ul className="region-list" data-testid="region-progress">
        <li>
          <ProgressRow name={mapName} tally={mapTally} depth={0} strong />
        </li>
        {renderRegions(roots, 0)}
      </ul>
    </section>
  );
}

function ProgressRow({
  name,
  tally,
  depth,
  strong = false,
}: {
  name: string;
  tally: Tally;
  depth: number;
  strong?: boolean;
}) {
  return (
    <div className="progress-row" style={{ paddingLeft: `${depth * 14}px` }}>
      <span className={strong ? 'progress-name progress-name-strong' : 'progress-name'}>
        {name}
      </span>
      <span className="progress-figure">
        {numberFormat.format(tally.found)}/{numberFormat.format(tally.total)}
        <span className="muted"> {percent(tally)}%</span>
      </span>
      <span className="meter meter-small" aria-hidden="true">
        <span
          className="meter-fill"
          style={{ width: `${(tally.found / Math.max(1, tally.total)) * 100}%` }}
        />
      </span>
    </div>
  );
}
