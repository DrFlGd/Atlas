import { percent, type Tally } from '@atlas/core';
import { useId } from 'react';
import { desktop } from '../desktop';
import { foldersOffered, importsOffered } from '../features';
import { setProfileDialogOpen, setTheme, showMap, switchGame, togglePane } from '../state/actions';
import { checklistScreenTitle, toggleLeftTab } from '../state/checklists';
import { numberFormat, useSummary } from '../state/derived';
import { setAddMapOpen } from '../state/importing';
import { setMapsDialogOpen } from '../state/library';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/** The bar across the top: panes, game and map switchers, search, overall progress and profile. */
export function TopBar({ search }: { search: React.ReactNode }) {
  const panes = useAtlas((s) => s.panes);
  const leftTab = useAtlas((s) => s.leftTab);
  const game = useAtlas((s) => s.game);
  const checklists = game && !game.checklists.isEmpty ? checklistScreenTitle(game) : null;
  const filtersShown = panes.filters && (leftTab === 'filters' || !checklists);
  const checklistsShown = panes.filters && leftTab === 'checklists' && checklists !== null;
  const theme = useAtlas((s) => s.theme);
  const summary = useSummary();
  const profileName = useAtlas((s) => s.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  const appName = useAtlas((s) => s.app?.name ?? 'Atlas');

  return (
    <header className="topbar">
      <button
        type="button"
        className="icon-button topbar-filters"
        aria-label="Filters"
        title="Filters"
        aria-expanded={filtersShown}
        aria-controls="filters-pane"
        onClick={() => {
          toggleLeftTab('filters');
        }}
      >
        <UiIcon name="filters" />
      </button>
      {checklists ? (
        <button
          type="button"
          className="icon-button topbar-checklists"
          aria-label={checklists}
          title={`${checklists} (C)`}
          aria-expanded={checklistsShown}
          aria-controls="filters-pane"
          aria-keyshortcuts="C"
          data-testid="checklists-button"
          onClick={() => {
            toggleLeftTab('checklists');
          }}
        >
          <UiIcon name="checklist" />
        </button>
      ) : null}
      <span className="brand" aria-hidden="true">
        {appName}
      </span>
      <div className="topbar-switchers">
        <GameSwitcher />
        <MapSwitcher />
        <LibraryButtons />
      </div>
      <div className="topbar-search">{search}</div>
      {summary ? <OverallProgress tally={summary.pack} /> : null}
      <button
        type="button"
        className="profile-button"
        onClick={() => {
          setProfileDialogOpen(true);
        }}
        aria-haspopup="dialog"
        title="Profiles, export and import"
      >
        <UiIcon name="user" size={16} />
        <span className="visually-hidden">Profile: </span>
        <span className="profile-name" data-testid="profile-name">
          {profileName}
        </span>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
        title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
        onClick={() => {
          setTheme(theme === 'dark' ? 'light' : 'dark');
        }}
      >
        <UiIcon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      <button
        type="button"
        className="icon-button topbar-details"
        aria-label="Details"
        title="Details"
        aria-expanded={panes.details}
        aria-controls="details-pane"
        onClick={() => {
          togglePane('details');
        }}
      >
        <UiIcon name="details" />
      </button>
    </header>
  );
}

function GameSwitcher() {
  const catalog = useAtlas((s) => s.catalog);
  const gameId = useAtlas((s) => s.game?.entry.id ?? '');
  const id = useId();
  if (catalog.length < 2) return null;
  return (
    <div className="field-inline">
      <label htmlFor={id} className="visually-hidden">
        Game
      </label>
      <select
        id={id}
        className="select"
        value={gameId}
        onChange={(event) => {
          void switchGame(event.target.value);
        }}
      >
        {catalog.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.title}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * "Add a map" (in builds with importers) and "Maps", in the desktop app
 * only; neither in the Android app, which has no import window or folders.
 */
function LibraryButtons() {
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  const imports = useAtlas(importsOffered);
  const folders = useAtlas(foldersOffered);
  if (!desktop) return null;
  return (
    <>
      {importers > 0 && imports ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Add a map"
          title="Add a map from a web page"
          aria-haspopup="dialog"
          data-testid="add-map-button"
          onClick={() => {
            setAddMapOpen(true);
          }}
        >
          <UiIcon name="mapPlus" />
        </button>
      ) : null}
      {folders ? (
        <button
          type="button"
          className="icon-button"
          aria-label="Maps"
          title="Maps: where they are kept, and packs from other folders"
          aria-haspopup="dialog"
          data-testid="maps-button"
          onClick={() => {
            setMapsDialogOpen(true);
          }}
        >
          <UiIcon name="folder" />
        </button>
      ) : null}
    </>
  );
}

function MapSwitcher() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId ?? '');
  const summary = useSummary();
  const id = useId();
  if (!game) return null;
  const maps = game.pack.data.maps;
  if (maps.length < 2) {
    return <span className="map-title">{maps[0]?.name}</span>;
  }
  return (
    <div className="field-inline">
      <label htmlFor={id} className="visually-hidden">
        Map
      </label>
      <select
        id={id}
        className="select"
        value={mapId}
        onChange={(event) => {
          showMap(event.target.value);
        }}
      >
        {maps.map((map) => {
          const tally = summary?.map(map.id);
          return (
            <option key={map.id} value={map.id}>
              {map.name}
              {tally && tally.total > 0 ? ` (${tally.found}/${tally.total})` : ''}
            </option>
          );
        })}
      </select>
    </div>
  );
}

function OverallProgress({ tally }: { tally: Tally }) {
  const value = percent(tally);
  return (
    <div className="overall" title="Found across every map in this pack">
      <span
        className="overall-text"
        data-testid="overall-progress"
        data-found={tally.found}
        data-total={tally.total}
      >
        <span className="overall-numbers">
          {numberFormat.format(tally.found)}
          <span className="muted"> / {numberFormat.format(tally.total)}</span>
        </span>
        <span className="overall-percent">{value}%</span>
      </span>
      <span
        className="meter"
        role="progressbar"
        aria-label="Overall progress"
        aria-valuemin={0}
        aria-valuemax={tally.total}
        aria-valuenow={tally.found}
        aria-valuetext={`${tally.found} of ${tally.total} found`}
      >
        <span
          className="meter-fill"
          style={{ width: `${(tally.found / Math.max(1, tally.total)) * 100}%` }}
        />
      </span>
    </div>
  );
}
