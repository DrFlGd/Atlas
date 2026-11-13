import { percent } from '@atlas/core';
import { lazy, Suspense, useEffect, useState } from 'react';
import { keepScreenOn } from '../androidBars';
import { ActivityLogDialog } from '../components/ActivityLogDialog';
import { AddMapDialog } from '../components/AddMapDialog';
import { UiIcon, type UiIconName } from '../components/icons';
import { MapPageStatus } from '../components/MapPageStatus';
import { MapPane, type TouchMapOptions } from '../components/MapPane';
import { MapsDialog } from '../components/MapsDialog';
import { ProfileDialog } from '../components/ProfileDialog';
import { downloadsOffered, keyboardHintsOffered } from '../features';
import { setShortcutOverrides } from '../keyboard';
import { jumpToNearestUnfound, setProfileDialogOpen, showMap } from '../state/actions';
import { checklistScreenTitle } from '../state/checklists';
import { numberFormat, useSummary } from '../state/derived';
import { useOwnLists } from '../state/ownLists';
import { useAtlas } from '../state/store';
import { handleBack, mapMoved, revealSelection, revealWhenSettled } from './back';
import type { Section } from './backStack';
import { FiltersSheet, FiltersPanel, ChipRow } from './FiltersView';
import { GamesScreen } from './GamesScreen';
import { withKey } from './keys';
import { KeysDialog } from './KeysDialog';
import { EditorMapHint, EditorOutline, EditorSide, PreviewBar } from './editor/ListEditor';
import { setPreview, stopEditing, useEditor } from './editor/editorState';
import { arrangementFor, panelWidthFor, type Arrangement } from './layout';
import { ListOnlyChip } from './ListMapChips';
import { NextUpCard } from './ListNextUp';
import { ListsScreen } from './ListsScreen';
import { followOpenList, loadListPrefs, orderKeyDone, orderKeyNext, useLists } from './listViews';
import { PlaceSheet } from './PlaceSheet';
import { ProgressScreen } from './ProgressScreen';
import { SearchField, SearchScreen, SearchResults } from './SearchView';
import {
  focusSearchField,
  loadKeepScreenOn,
  loadRecent,
  markFromHold,
  markFromMenu,
  openSearch,
  setFiltersOpen,
  setKeysOpen,
  setMapsMenuOpen,
  setPlaceExpanded,
  showSection,
  toggleLists,
  useKeyHints,
  useTouch,
} from './state';
import { KeysButton, SaveButton } from './DesktopTools';
import { TouchToast } from './TouchToast';
import { KeyHint, ProgressRing } from './widgets';
import '../styles/touch.css';

const PackFileDialog = lazy(() =>
  import('../components/PackFileDialog').then((module) => ({ default: module.PackFileDialog })),
);

// Opened rarely, so loaded when first opened, as in the classic layout.
const SaveDialog = lazy(() =>
  import('../components/SaveDialog').then((module) => ({ default: module.SaveDialog })),
);

declare global {
  interface Window {
    /**
     * Asked by the Android app's activity when Back is pressed: closes the
     * thing on top and returns true, or returns false when nothing is left
     * to close and the app should go to the background.
     */
    atlasBack?: () => boolean;
  }
}

/**
 * The standard layout: the Android app's interface, made for a phone or a
 * tablet beside the game, and the desktop app's and a browser's, made for
 * a mouse and keyboard (`input`). Compact (a phone, a tablet held upright,
 * a narrow window): the map fills the screen, sections are in a bar at the
 * bottom, and sheets rise over the map. Wide (a tablet or phone on its
 * side, a computer's window): a rail of sections, a panel and the map.
 * Everything it does goes through the app's store and actions, as the
 * classic layout does, and the desktop app's dialogs are the same ones.
 */
export function TouchShell({ input = 'touch' }: { input?: 'touch' | 'mouse' }) {
  const arrangement = useArrangement(input);
  const wide = arrangement.kind === 'wide';
  const section = useTouch((s) => s.section);
  const search = useTouch((s) => s.search);
  const filters = useTouch((s) => s.filters);
  const ownLists = useOwnLists((s) => s.lists.length > 0);
  // Lists is there from a tablet's width up, where lists can be made.
  const hasLists =
    useAtlas((s) => s.game !== null && (!s.game.checklists.isEmpty || wide)) || ownLists;
  const editorMode = useEditor((s) => (s.listId === null || !wide ? null : s.mode));
  const game = useAtlas((s) => s.game);
  const selected = useAtlas((s) => s.selectedId !== null && editorMode !== 'edit');
  const loading = useAtlas((s) => s.status.kind === 'loading');
  const packFileOpen = useAtlas((s) => s.packFileDialog !== null);
  const saveDialogOpen = useAtlas((s) => s.saveDialogOpen);
  const pageViews = useAtlas(downloadsOffered);
  useTouchEffects(wide);

  useEffect(() => {
    if (!hasLists && section === 'lists') showSection('map');
  }, [hasLists, section]);

  const [mapOptions] = useState<TouchMapOptions>(() => ({
    input,
    onLongPress: markFromHold,
    onMarkerMenu: markFromMenu,
    onPick: (id) => {
      if (id) revealSelection();
    },
  }));

  const placeShown = selected && (wide || (section === 'map' && !search && !filters));
  const map = (
    <main className="touch-map" aria-label="Map">
      <MapPane touch={mapOptions} />
      {wide ? (
        <WideMapControls editing={editorMode === 'edit'} />
      ) : section === 'map' ? (
        <CompactMapControls />
      ) : null}
      {editorMode === 'edit' && game ? <EditorSide game={game} /> : null}
      {__ATLAS_DOWNLOADS__ && pageViews ? <MapPageStatus /> : null}
    </main>
  );

  return (
    <div
      className="touch"
      data-input={input}
      data-arrangement={arrangement.kind}
      data-section={section}
      data-place={placeShown ? 'shown' : 'none'}
      aria-busy={loading}
      style={{ '--touch-panel': `${arrangement.panel}px` } as React.CSSProperties}
    >
      {wide ? (
        <>
          <Rail hasLists={hasLists} />
          <aside
            className={editorMode === 'edit' ? 'touch-panel touch-panel-editor' : 'touch-panel'}
            aria-label={
              editorMode === 'edit' ? 'List editor' : PANEL_LABEL[search ? 'search' : section]
            }
          >
            {editorMode === 'edit' && game ? (
              <EditorOutline game={game} />
            ) : editorMode === 'preview' ? (
              <div className="editor-preview">
                <PreviewBar />
                <SectionContent section={section} />
              </div>
            ) : section === 'map' ? (
              <MapPanel />
            ) : (
              <SectionContent section={section} />
            )}
          </aside>
          {map}
        </>
      ) : (
        <>
          {map}
          {section !== 'map' ? (
            <div className="touch-screen">
              <SectionContent section={section} />
            </div>
          ) : null}
          <BottomBar hasLists={hasLists} />
          {search ? <SearchScreen /> : null}
          {filters ? <FiltersSheet /> : null}
        </>
      )}
      {placeShown ? <PlaceSheet wide={wide} /> : null}
      {wide && editorMode !== 'edit' ? <NextUpCard /> : null}
      <MapsMenu wide={wide} />
      <TouchToast wide={wide} />
      <ProfileDialog />
      {saveDialogOpen ? (
        <Suspense fallback={null}>
          <SaveDialog />
        </Suspense>
      ) : null}
      <MapsDialog />
      <AddMapDialog />
      <ActivityLogDialog />
      {packFileOpen ? (
        <Suspense fallback={null}>
          <PackFileDialog />
        </Suspense>
      ) : null}
      <KeysDialog />
    </div>
  );
}

const PANEL_LABEL: Record<Section | 'search', string> = {
  map: 'Find and filter',
  search: 'Search',
  lists: 'Lists',
  progress: 'Progress',
  games: 'Games',
};

function SectionContent({ section }: { section: Section }) {
  switch (section) {
    case 'lists':
      return <ListsScreen />;
    case 'progress':
      return <ProgressScreen />;
    case 'games':
      return <GamesScreen />;
    case 'map':
      return null;
  }
}

/** The wide panel on the map section: search at the top, and the filters or the results under it. */
function MapPanel() {
  const search = useTouch((s) => s.search);
  return (
    <div className="touch-map-panel">
      <SearchField inPanel />
      {search ? <SearchResults /> : <FiltersPanel />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Arrangement

function measure(input: 'touch' | 'mouse') {
  const width = window.innerWidth;
  const height = window.innerHeight;
  return { kind: arrangementFor(width, height, input), panel: panelWidthFor(width, height) };
}

/** The arrangement for the window, following rotation and resizing. */
function useArrangement(input: 'touch' | 'mouse'): { kind: Arrangement; panel: number } {
  const [arrangement, setArrangement] = useState(() => measure(input));
  useEffect(() => {
    const onResize = () => {
      const next = measure(input);
      setArrangement((prev) =>
        prev.kind === next.kind && prev.panel === next.panel ? prev : next,
      );
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
    };
  }, [input]);
  useEffect(() => {
    useTouch.setState({ arrangement: arrangement.kind });
  }, [arrangement.kind]);
  // Set before the children render, so they know what they are made for.
  if (useTouch.getState().input !== input) useTouch.setState({ input });
  return arrangement;
}

// ---------------------------------------------------------------------------
// What follows the app's store

function useTouchEffects(wide: boolean) {
  const game = useAtlas((s) => s.game);

  useEffect(() => {
    void loadKeepScreenOn();
    // Switching to the classic layout lets the screen turn off as usual.
    return () => {
      keepScreenOn(false);
    };
  }, []);

  useEffect(() => {
    if (!game) return;
    useTouch.setState({ solo: null });
    void loadRecent(game);
    void loadListPrefs(game);
  }, [game]);

  // The open list: remembered, and alone on the map while that is on.
  useEffect(() => {
    followOpenList();
    const stopLists = useLists.subscribe((state, previous) => {
      if (state.onlyOnMap !== previous.onlyOnMap) followOpenList();
    });
    // An own list changes as it is edited; the editor shows the whole map.
    const stopOwn = useOwnLists.subscribe((state, previous) => {
      if (state.lists !== previous.lists) followOpenList();
    });
    const stopEditor = useEditor.subscribe((state, previous) => {
      if (state.listId !== previous.listId || state.mode !== previous.mode) followOpenList();
    });
    const stopAtlas = useAtlas.subscribe((state, previous) => {
      if (state.checklistPages !== previous.checklistPages || state.game !== previous.game) {
        followOpenList();
      }
    });
    return () => {
      stopLists();
      stopOwn();
      stopEditor();
      stopAtlas();
      // The classic layout shows every place again, and only the pages it knows.
      const { game, checklistPages } = useAtlas.getState();
      const pages = checklistPages.filter(
        (page) =>
          page.kind !== 'checklist' ||
          (page.area === undefined && game?.checklists.checklist(page.id) !== undefined),
      );
      useAtlas.setState({ listOnly: null, checklistPages: pages });
    };
  }, []);

  useEffect(
    () =>
      useAtlas.subscribe((state, previous) => {
        const touch = useTouch.getState();
        // The map moves to show something (a place from a list, a region):
        // on a phone, the map is shown.
        if (state.fly !== previous.fly && state.fly && touch.arrangement === 'compact') {
          if (touch.section !== 'map' || touch.search || touch.filters) showSection('map');
        }
        // A checklist or guide was opened (from search, a place, a link).
        const page = state.checklistPages.at(-1);
        if (
          state.checklistPages !== previous.checklistPages &&
          page &&
          page.kind !== 'index' &&
          page !== previous.checklistPages.at(-1)
        ) {
          showSection('lists');
        }
        if (state.selectedId !== previous.selectedId && touch.placeExpanded) {
          setPlaceExpanded(false);
        }
        // The map was sent to the selected place (from search, a list, the
        // next nearest): once it has stopped, it moves again if the place
        // ended up under the sheet or card.
        if (state.fly !== previous.fly && state.fly) revealWhenSettled();
        else if (state.view !== previous.view) mapMoved();
      }),
    [],
  );

  // Back, as the Android app's activity asks for it.
  useEffect(() => {
    window.atlasBack = handleBack;
    return () => {
      delete window.atlasBack;
    };
  }, []);

  // The keys this layout handles its own way: Esc closes what is on top,
  // as Back does; `/` goes to search; C opens the lists; `?` lists the keys.
  useEffect(() => {
    setShortcutOverrides({
      search: focusSearchField,
      checklists: toggleLists,
      escape: () => {
        handleBack();
      },
      keys: () => {
        if (keyboardHintsOffered(useAtlas.getState())) setKeysOpen(true);
      },
      // In a list shown in order: the next step done, and on to the one after.
      found: orderKeyDone,
      nearest: orderKeyNext,
    });
    return () => {
      setShortcutOverrides(null);
      setKeysOpen(false);
    };
  }, []);

  // Closing a section's sheet when the arrangement changes keeps one thing open.
  useEffect(() => {
    if (wide) setFiltersOpen(false);
  }, [wide]);

  // The editor is for a tablet's width and up, and for the list it opened
  // with: narrower, another section or another page closes it (what changed
  // is saved at once).
  useEffect(() => {
    if (!wide) stopEditing();
  }, [wide]);
  useEffect(() => {
    const check = () => {
      const { listId, mode } = useEditor.getState();
      if (listId === null) return;
      const page = useAtlas.getState().checklistPages.at(-1);
      const onList = page?.kind === 'checklist' && page.id === listId && page.area === undefined;
      if (useTouch.getState().section !== 'lists' || !onList) {
        if (mode === 'preview') setPreview(false);
        stopEditing();
      }
    };
    const stopTouch = useTouch.subscribe((state, previous) => {
      if (state.section !== previous.section) check();
    });
    const stopAtlas = useAtlas.subscribe((state, previous) => {
      if (state.checklistPages !== previous.checklistPages) check();
    });
    return () => {
      stopTouch();
      stopAtlas();
      stopEditing();
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Sections

const SECTIONS: { id: Section; label: string; icon: UiIconName }[] = [
  { id: 'map', label: 'Map', icon: 'map' },
  { id: 'lists', label: 'Lists', icon: 'checklist' },
  { id: 'progress', label: 'Progress', icon: 'bars' },
  { id: 'games', label: 'Games', icon: 'folder' },
];

function SectionButtons({ hasLists, className }: { hasLists: boolean; className: string }) {
  const section = useTouch((s) => s.section);
  const hints = useKeyHints();
  const listsName = useAtlas((s) => (s.game ? checklistScreenTitle(s.game) : 'Lists'));
  return SECTIONS.filter((s) => s.id !== 'lists' || hasLists).map((s) => (
    <button
      key={s.id}
      type="button"
      className={className}
      aria-current={s.id === section ? 'page' : undefined}
      title={hints ? (s.id === 'lists' ? withKey(listsName, 'C', true) : s.label) : undefined}
      aria-keyshortcuts={hints && s.id === 'lists' ? 'C' : undefined}
      data-testid={`section-${s.id}`}
      onClick={() => {
        if (s.id === section && s.id === 'lists') {
          // Lists again: back to the list of lists.
          useAtlas.setState({ checklistPages: [] });
        }
        showSection(s.id);
      }}
    >
      <span className="touch-section-icon">
        <UiIcon name={s.icon} size={22} />
      </span>
      {s.label}
    </button>
  ));
}

function BottomBar({ hasLists }: { hasLists: boolean }) {
  return (
    <nav className="touch-bar" aria-label="Sections">
      <SectionButtons hasLists={hasLists} className="touch-bar-button" />
    </nav>
  );
}

function Rail({ hasLists }: { hasLists: boolean }) {
  const profileName = useAtlas((s) => s.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  return (
    <nav className="touch-rail" aria-label="Sections">
      <SectionButtons hasLists={hasLists} className="touch-rail-button" />
      <span className="touch-rail-space" />
      <KeysButton />
      <SaveButton />
      <button
        type="button"
        className="touch-round-button touch-rail-profile"
        aria-label={`Profile: ${profileName}`}
        title={`Profile: ${profileName}. Profiles, export and import`}
        aria-haspopup="dialog"
        onClick={() => {
          setProfileDialogOpen(true);
        }}
      >
        <UiIcon name="user" size={20} />
      </button>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Controls over the map

function CompactMapControls() {
  const placeShown = useAtlas((s) => s.selectedId !== null);
  return (
    <>
      <div className="touch-map-top">
        <SearchPill />
        {placeShown ? null : <ChipRow />}
      </div>
      {placeShown ? null : (
        <div className="touch-map-bottom">
          <MapChip />
          <span className="touch-map-bottom-space" />
          <NearestButton />
        </div>
      )}
    </>
  );
}

function WideMapControls({ editing }: { editing: boolean }) {
  const section = useTouch((s) => s.section);
  if (editing) {
    return (
      <div className="touch-map-top editor-map-top">
        <EditorMapHint />
        <MapChip />
      </div>
    );
  }
  return (
    <>
      <div className="touch-map-top">
        <ListOnlyChip />
        <MapChip />
        <span className="touch-map-bottom-space" />
        <ProgressPill />
      </div>
      {section === 'map' ? (
        <div className="touch-map-bottom">
          <NearestButton />
        </div>
      ) : null}
    </>
  );
}

function SearchPill() {
  const summary = useSummary();
  const hasLists = useAtlas((s) => !(s.game?.checklists.isEmpty ?? true));
  const value = summary ? percent(summary.pack) : 0;
  return (
    <div className="touch-search-pill">
      <button
        type="button"
        className="touch-search-pill-button"
        data-testid="open-search"
        onClick={openSearch}
      >
        <UiIcon name="search" size={20} />
        {hasLists ? 'Search locations, lists and guides' : 'Search locations'}
      </button>
      <button
        type="button"
        className="touch-ring-button"
        aria-label={`Progress: ${value} percent found`}
        data-testid="progress-ring"
        data-found={summary?.pack.found ?? 0}
        data-total={summary?.pack.total ?? 0}
        onClick={() => {
          showSection('progress');
        }}
      >
        <ProgressRing value={value} size={40} stroke={3.5} />
        <span className="touch-ring-text">{value}%</span>
      </button>
    </div>
  );
}

function ProgressPill() {
  const summary = useSummary();
  if (!summary) return null;
  const tally = summary.pack;
  const value = percent(tally);
  return (
    <button
      type="button"
      className="touch-pill touch-progress-pill"
      aria-label={`Progress: ${numberFormat.format(tally.found)} of ${numberFormat.format(tally.total)} found, ${value} percent`}
      data-testid="progress-ring"
      data-found={tally.found}
      data-total={tally.total}
      onClick={() => {
        showSection('progress');
      }}
    >
      <ProgressRing value={value} size={36} stroke={4} />
      <span>
        {numberFormat.format(tally.found)}{' '}
        <span className="muted touch-pill-light">
          / {numberFormat.format(tally.total)} · {value}%
        </span>
      </span>
    </button>
  );
}

function NearestButton() {
  const hints = useKeyHints();
  return (
    <button
      type="button"
      className="touch-fab"
      data-testid="nearest-unfound"
      title={hints ? 'The nearest location not yet found (N)' : undefined}
      aria-keyshortcuts={hints ? 'N' : undefined}
      onClick={jumpToNearestUnfound}
    >
      <UiIcon name="target" size={22} strokeWidth={1.8} />
      Nearest unfound
      <KeyHint k="N" />
    </button>
  );
}

/** The map shown, and its level when it has several; opens the list of maps. */
function MapChip() {
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const open = useTouch((s) => s.mapsMenu);
  if (!game || !mapId) return null;
  const maps = game.pack.data.maps;
  const layers = game.pack.layersOf(mapId);
  if (maps.length < 2 && layers.length < 2) return null;
  const layer = layers.length > 1 ? game.pack.layers.get(layerId ?? '') : undefined;
  return (
    <button
      type="button"
      className="touch-pill touch-map-chip"
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="map-chip"
      onClick={() => {
        setMapsMenuOpen(!open);
      }}
    >
      <UiIcon name="layers" size={18} />
      <span className="touch-map-chip-name">
        {game.pack.maps.get(mapId)?.name}
        {layer ? <span className="muted"> · {layer.name}</span> : null}
      </span>
      <UiIcon name="chevronDown" size={14} strokeWidth={2} />
    </button>
  );
}

/** The game's maps with their progress, and the levels of the map shown. */
function MapsMenu({ wide }: { wide: boolean }) {
  const open = useTouch((s) => s.mapsMenu);
  const game = useAtlas((s) => s.game);
  const mapId = useAtlas((s) => s.mapId);
  const layerId = useAtlas((s) => s.layerId);
  const summary = useSummary();
  if (!open || !game || !mapId || !summary) return null;
  const layers = game.pack.layersOf(mapId);
  const close = () => {
    setMapsMenuOpen(false);
  };
  const row = (
    key: string,
    name: string,
    tally: { found: number; total: number },
    current: boolean,
    onChoose: () => void,
  ) => (
    <li key={key}>
      <button
        type="button"
        className="touch-menu-row"
        aria-current={current ? 'true' : undefined}
        onClick={() => {
          onChoose();
          close();
        }}
      >
        <span className="touch-menu-row-name">{name}</span>
        {tally.total > 0 ? (
          <span className="touch-figure">
            {numberFormat.format(tally.found)} / {numberFormat.format(tally.total)}
          </span>
        ) : null}
        <span className="touch-menu-row-check">
          {current ? <UiIcon name="check" size={18} strokeWidth={2.2} /> : null}
        </span>
      </button>
    </li>
  );
  return (
    <>
      <div className="touch-scrim touch-scrim-light" aria-hidden="true" onClick={close} />
      <section
        className={wide ? 'touch-menu touch-menu-wide' : 'touch-menu touch-sheet'}
        aria-label="Maps"
        role="dialog"
        data-testid="maps-menu"
      >
        <div className="touch-sheet-head">
          <h2 className="touch-sheet-title">Maps</h2>
          <button type="button" className="touch-round-button" aria-label="Close" onClick={close}>
            <UiIcon name="close" size={18} strokeWidth={1.8} />
          </button>
        </div>
        <ul className="touch-plain-list">
          {game.pack.data.maps.map((map) =>
            row(map.id, map.name, summary.map(map.id), map.id === mapId, () => {
              showMap(map.id);
            }),
          )}
        </ul>
        {layers.length > 1 ? (
          <>
            <h3 className="touch-group-title">Levels of {game.pack.maps.get(mapId)?.name}</h3>
            <ul className="touch-plain-list">
              {layers.map((layer) =>
                row(layer.id, layer.name, summary.layer(layer.id), layer.id === layerId, () => {
                  showMap(mapId, layer.id);
                }),
              )}
            </ul>
          </>
        ) : null}
      </section>
    </>
  );
}
