import { memo, useEffect, useId, useState } from 'react';
import type { GameGroup } from '@atlas/schema';
import { DeletePackConfirm } from '../components/DeletePackConfirm';
import { GamesListBar, GamesSections, TagChips, TagsDialog } from '../components/GameListTools';
import { useRowWords, useGamesList } from '../state/gamesList';
import { ShowWithAnotherForm, SourcesLine, TitleSourcesPanel } from '../components/GameTitles';
import { UiIcon } from '../components/icons';
import { PackSummary } from '../components/PackSummary';
import { PackDetailsView } from '../components/PackFacts';
import { desktop, type PackDetails } from '../desktop';
import {
  copiesPickedFiles,
  foldersOffered,
  layoutChoiceOffered,
  readsPackFilesOnly,
} from '../features';
import { setLayout, setTheme, switchGame } from '../state/actions';
import { openActivityLog } from '../state/activityLog';
import type { TagGroup, TaggedRow } from '../state/gameTags';
import { loadMissingDetails } from '../state/gameFacts';
import { openTitle, showSource, useSourceNames, useTitleRows } from '../state/gameGroups';
import { reveal } from '../state/library';
import { ownGamesOffered } from '../state/ownGames';
import { importPickedPackFile, loadPackDetails, pickPackFile } from '../state/packFile';
import { useAtlas } from '../state/store';
import { ProgressTools } from './DesktopTools';
import { NewGameButton, OwnGameActions } from './OwnGames';
import { setKeepScreenOn, setKeysOpen, useKeyHints, useTouch } from './state';
import { GroupTitle, SwitchTrack } from './widgets';

/**
 * Games: the games on this device (press one to show it), importing a map
 * pack file (in the desktop app without downloads, adding one to the packs
 * folder), each game's details and delete, then the app's settings.
 * Games shown under one title are one row (see `state/gameGroups.ts`).
 * With two games or more, a game can be found by its name, the games shown
 * as cards or compact rows, and listed under the person's own categories
 * (see `components/GameListTools.tsx`).
 */
export function GamesScreen() {
  const rows = useTitleRows();
  const copies = useAtlas(copiesPickedFiles);
  const folders = useAtlas(foldersOffered);
  // The desktop app without downloads keeps an added pack file a file.
  const reader = useAtlas(readsPackFilesOnly);
  const games = useGamesList(rows, reader ? 'In the maps folder' : 'Imported from a pack file');
  const skip = games.groupBy?.id ?? null;
  // Grouped by what the games hold: what each holds is read once, here.
  const byContents = skip === 'contents';
  const catalog = useAtlas((s) => s.catalog);
  useEffect(() => {
    if (byContents) void loadMissingDetails(catalog.map((entry) => entry.id));
  }, [byContents, catalog]);
  const canImport = desktop !== null && (copies || folders);
  const canMake = useAtlas(ownGamesOffered);
  const compact = games.view === 'compact';
  const list = (items: TaggedRow[], label: string) =>
    compact ? (
      <CompactGames items={items} label={label} tagGroups={games.tagGroups} skip={skip} />
    ) : (
      <ul className="touch-plain-list" data-testid="game-list">
        {items.map((item) => (
          <CardRow key={item.id} item={item} tagGroups={games.tagGroups} skip={skip} />
        ))}
      </ul>
    );
  return (
    <div className="touch-page" data-testid="games-screen">
      <header className="touch-page-head">
        <h1 className="touch-page-title">Games</h1>
      </header>
      <div className="touch-scroll touch-page-body" data-scroll-root>
        <section aria-labelledby="games-heading">
          <GroupTitle id="games-heading">Games on this device</GroupTitle>
          {rows.length > 1 ? (
            <GamesListBar
              filter={games.filter}
              onFilter={games.setFilter}
              view={games.view}
              groupBy={games.groupBy}
              tagGroups={games.tagGroups}
              total={rows.length}
              shown={games.shown.length}
            />
          ) : null}
          <div className="touch-games" data-view={games.view} data-testid="touch-games">
            <GamesSections
              sections={games.sections}
              groupBy={games.groupBy}
              shown={games.shown}
              folded={games.folded}
              finding={games.finding}
              list={list}
            />
          </div>
          {canMake ? <NewGameButton /> : null}
          {canImport && reader ? (
            <>
              <button
                type="button"
                className="touch-button touch-button-primary touch-button-block"
                data-testid="import-pack-file"
                onClick={() => void pickPackFile()}
              >
                <UiIcon name="upload" size={20} />
                Add a pack file…
              </button>
              <button
                type="button"
                className="touch-button touch-button-block"
                data-testid="open-packs-folder"
                onClick={() => {
                  reveal({ kind: 'packs-folder' });
                }}
              >
                <UiIcon name="folder" size={20} />
                Open packs folder
              </button>
              <p className="touch-note">
                Maps, wikis and guides come in pack files (.atlaspack). Add a pack file copies one
                into the packs folder, and Atlas reads every pack file there. You can also put pack
                files into the packs folder yourself, or open one from your file manager.
              </p>
            </>
          ) : canImport ? (
            <>
              <button
                type="button"
                className="touch-button touch-button-primary touch-button-block"
                data-testid="import-pack-file"
                onClick={() => void (copies ? importPickedPackFile() : pickPackFile())}
              >
                <UiIcon name="upload" size={20} />
                Import a pack file…
              </button>
              <p className="touch-note">
                Add a game or a wiki with a pack file (.atlaspack) exported by Atlas on your
                computer: copy it to this device, for example into Download, then import it here.
              </p>
            </>
          ) : null}
        </section>
        <ProgressTools />
        <Settings />
      </div>
    </div>
  );
}

/** What a row of a game says and offers, from what the shell lists of it. */
function useGameRow(id: string) {
  const library = useAtlas((s) => s.library);
  const shown = useAtlas((s) => s.game?.entry.id ?? null);
  const several = useAtlas((s) => s.catalog.length > 1);
  const canMake = useAtlas(ownGamesOffered);
  const listed = library?.packs.find((p) => p.id === id);
  return {
    listed,
    current: id === shown,
    origin: listed?.madeInApp
      ? 'Made in this app'
      : listed?.origin === 'opened-file'
        ? 'Read from a pack file you opened'
        : listed?.origin === 'packs-folder'
          ? 'Read from a pack file in the packs folder'
          : listed?.packFile
            ? 'Read from a pack file in a folder you added'
            : listed && !listed.bundled
              ? 'Imported from a pack file'
              : 'Comes with the app',
    ownGame: canMake && listed?.madeInApp === true && listed.origin === 'maps-folder',
    personalUse: listed?.personalUse === true,
    deletable: listed?.origin === 'maps-folder' && !listed.bundled,
    busy: library?.busy.includes(id) ?? false,
    groupable: several,
  };
}

/** A row of the cards view: a game, or a title with its sources. */
const CardRow = memo(function CardRow({
  item,
  tagGroups,
  skip,
}: {
  item: TaggedRow;
  tagGroups: readonly TagGroup[];
  skip: string | null;
}) {
  const shown = useAtlas((s) => s.game?.entry.id ?? null);
  const { row } = item;
  const chips = (
    <TagChips tags={item.tags} tagGroups={tagGroups} skip={skip} className="touch-game-tags" />
  );
  if (row.kind === 'title') {
    return <TitleRow group={row.group} shownId={shown} chips={chips} />;
  }
  return <GameRow id={row.entry.id} title={row.entry.title} chips={chips} />;
});

function GameRow({
  id,
  title,
  chips,
}: {
  id: string;
  title: string;
  /** The row's tags, as chips. */
  chips: React.ReactNode;
}) {
  const { listed, current, origin, personalUse, busy } = useGameRow(id);
  return (
    <li className="touch-game" data-testid="game-row" data-pack={id} data-current={current}>
      <button
        type="button"
        className="touch-game-main"
        aria-current={current ? 'true' : undefined}
        onClick={() => {
          if (!current) void switchGame(id);
        }}
      >
        <span className="touch-game-text">
          <span className="touch-row-title">{title}</span>
          <span className="touch-row-detail">
            {current ? 'Shown · ' : ''}
            {origin}
            {personalUse ? ' · For personal use' : ''}
            {busy ? ' · moving files…' : ''}
          </span>
          {listed && desktop ? <PackSummary id={id} /> : null}
          {chips}
        </span>
        <span className="touch-row-end">
          {current ? <UiIcon name="check" size={20} strokeWidth={2.2} /> : null}
        </span>
      </button>
      <GameActions id={id} title={title} />
    </li>
  );
}

/**
 * What can be done with a game, under its card or its compact row: its
 * details, showing it with another game, its tags, and delete, each
 * asked or shown under it.
 */
function GameActions({ id, title }: { id: string; title: string }) {
  const { listed, ownGame, deletable, busy, groupable } = useGameRow(id);
  const [open, setOpen] = useState<'details' | 'grouping' | 'tags' | 'delete' | null>(null);
  const toggle = (what: typeof open) => {
    setOpen(open === what ? null : what);
  };
  const close = () => {
    setOpen(null);
  };
  return (
    <>
      <div className="touch-game-actions touch-game-actions-wrap">
        {listed && desktop ? (
          <button
            type="button"
            className="touch-text-button"
            aria-expanded={open === 'details'}
            data-testid="pack-details-toggle"
            onClick={() => {
              toggle('details');
            }}
          >
            Details
          </button>
        ) : null}
        {groupable ? (
          <button
            type="button"
            className="touch-text-button"
            aria-expanded={open === 'grouping'}
            data-testid="show-with-another"
            onClick={() => {
              toggle('grouping');
            }}
          >
            Show with another game…
          </button>
        ) : null}
        <button
          type="button"
          className="touch-text-button"
          aria-haspopup="dialog"
          data-testid="game-tags-open"
          onClick={() => {
            setOpen('tags');
          }}
        >
          Tags…
        </button>
        {deletable && !busy ? (
          <button
            type="button"
            className="touch-text-button touch-text-button-danger"
            data-testid="delete-pack"
            onClick={() => {
              setOpen('delete');
            }}
          >
            Delete…
          </button>
        ) : null}
      </div>
      {ownGame && !busy ? <OwnGameActions id={id} title={title} /> : null}
      {open === 'details' ? <GameDetails id={id} /> : null}
      {open === 'grouping' ? (
        <div className="touch-game-confirm">
          <ShowWithAnotherForm gameId={id} onClose={close} />
        </div>
      ) : null}
      {open === 'tags' ? <TagsDialog gameId={id} title={title} onClose={close} /> : null}
      {open === 'delete' ? (
        <div className="touch-game-confirm">
          <DeletePackConfirm id={id} title={title} onClose={close} />
        </div>
      ) : null}
    </>
  );
}

/**
 * A title with its sources on this device: pressing it shows the source
 * last shown under it; Sources lists them, to show one, take one out,
 * rename the title or show them separately again.
 */
function TitleRow({
  group,
  shownId,
  chips,
}: {
  group: GameGroup;
  shownId: string | null;
  /** The row's tags, as chips. */
  chips: React.ReactNode;
}) {
  const names = useSourceNames(group);
  const current = group.members.some((member) => member.gameId === shownId);
  return (
    <li className="touch-game" data-testid="title-row" data-group={group.id} data-current={current}>
      <button
        type="button"
        className="touch-game-main"
        aria-current={current ? 'true' : undefined}
        onClick={() => {
          if (!current) void openTitle(group);
        }}
      >
        <span className="touch-game-text">
          <span className="touch-row-title">{group.title}</span>
          <SourcesLine group={group} className="touch-row-detail" />
          {current && shownId ? (
            <span
              className="touch-row-detail"
              title={`Shown: ${names.get(shownId) ?? shownId}`}
              data-testid="title-shown"
            >
              Shown: {names.get(shownId) ?? shownId}
            </span>
          ) : null}
          {chips}
        </span>
        <span className="touch-row-end">
          {current ? <UiIcon name="check" size={20} strokeWidth={2.2} /> : null}
        </span>
      </button>
      <TitleActions group={group} shownId={shownId} />
    </li>
  );
}

/** What can be done with a title: its sources, and its tags. */
function TitleActions({ group, shownId }: { group: GameGroup; shownId: string | null }) {
  const [open, setOpen] = useState<'sources' | 'tags' | null>(null);
  const first = group.members[0]?.gameId ?? '';
  return (
    <>
      <div className="touch-game-actions">
        <button
          type="button"
          className="touch-text-button"
          aria-expanded={open === 'sources'}
          data-testid="title-sources-toggle"
          onClick={() => {
            setOpen(open === 'sources' ? null : 'sources');
          }}
        >
          Sources…
        </button>
        <button
          type="button"
          className="touch-text-button"
          aria-haspopup="dialog"
          data-testid="game-tags-open"
          onClick={() => {
            setOpen('tags');
          }}
        >
          Tags…
        </button>
      </div>
      {open === 'sources' ? (
        <div className="touch-game-confirm">
          <TitleSourcesPanel
            group={group}
            shownId={shownId}
            onOpen={(gameId) => void showSource(gameId)}
          />
        </div>
      ) : null}
      {open === 'tags' ? (
        <TagsDialog
          gameId={first}
          title={group.title}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The compact view: one short row for each game or title, with its name,
 * where it came from, what it holds when that is known already, and its
 * tags; More shows what the card offers under the row. Nothing is read
 * for a row: what it holds is said once a card or the Library has read it.
 */
function CompactGames({
  items,
  label,
  tagGroups,
  skip,
}: {
  items: TaggedRow[];
  label: string;
  tagGroups: readonly TagGroup[];
  skip: string | null;
}) {
  const shown = useAtlas((s) => s.game?.entry.id ?? null);
  const words = useRowWords(items, 'Imported from a pack file');
  return (
    <ul className="touch-compact-list" aria-label={label} data-testid="game-list">
      {items.map((item) => {
        const { row } = item;
        const ids = row.kind === 'title' ? row.entries.map((e) => e.id) : [row.entry.id];
        const said = words.get(item.id);
        return (
          <CompactRow
            key={item.id}
            item={item}
            tagGroups={tagGroups}
            skip={skip}
            current={shown !== null && ids.includes(shown)}
            shownId={row.kind === 'title' && shown !== null && ids.includes(shown) ? shown : null}
            sources={said?.sources ?? ''}
            holds={said?.holds ?? null}
          />
        );
      })}
    </ul>
  );
}

const CompactRow = memo(function CompactRow({
  item,
  tagGroups,
  skip,
  current,
  shownId,
  sources,
  holds,
}: {
  item: TaggedRow;
  tagGroups: readonly TagGroup[];
  /** The group the games are grouped by: its tags are not repeated under its heading. */
  skip: string | null;
  current: boolean;
  /** The game shown, when it is a source of this row's title. */
  shownId: string | null;
  sources: string;
  holds: string | null;
}) {
  const [more, setMore] = useState(false);
  const { row } = item;
  const title = row.kind === 'title' ? row.group.title : row.entry.title;
  const line = holds ? `${sources} · ${holds}` : sources;
  const actionsId = useId();
  return (
    <li
      className="touch-compact"
      data-testid={row.kind === 'title' ? 'title-row' : 'game-row'}
      data-pack={row.kind === 'game' ? row.entry.id : undefined}
      data-group={row.kind === 'title' ? row.group.id : undefined}
      data-current={current}
    >
      <div className="touch-compact-row">
        <button
          type="button"
          className="touch-compact-main"
          aria-current={current ? 'true' : undefined}
          onClick={() => {
            if (current) return;
            if (row.kind === 'title') void openTitle(row.group);
            else void switchGame(row.entry.id);
          }}
        >
          <span className="touch-compact-name">
            {title}
            {current ? <span className="visually-hidden">, shown</span> : null}
          </span>
          <span className="touch-compact-line" data-testid="game-compact-line">
            {line}
          </span>
        </button>
        <TagChips
          tags={item.tags}
          tagGroups={tagGroups}
          skip={skip}
          limit={2}
          className="touch-compact-tags"
        />
        {current ? (
          <span className="touch-compact-shown" aria-hidden="true">
            <UiIcon name="check" size={18} strokeWidth={2.2} />
          </span>
        ) : null}
        <button
          type="button"
          className="touch-compact-more"
          aria-label={`More for ${title}`}
          aria-expanded={more}
          aria-controls={more ? actionsId : undefined}
          data-testid="game-compact-more"
          onClick={() => {
            setMore(!more);
          }}
        >
          <UiIcon name="more" size={20} />
        </button>
      </div>
      {more ? (
        <div className="touch-compact-actions" id={actionsId}>
          {row.kind === 'title' ? (
            <TitleActions group={row.group} shownId={shownId} />
          ) : (
            <GameActions id={row.entry.id} title={title} />
          )}
        </div>
      ) : null}
    </li>
  );
});

/** What is known about a game, read when asked for, as the Maps dialog shows it. */
function GameDetails({ id }: { id: string }) {
  const library = useAtlas((s) => s.library);
  const [details, setDetails] = useState<PackDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadPackDetails(id).then(
      (loaded) => {
        if (!live) return;
        setDetails(loaded);
        setError(null);
      },
      (reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [id, library]);
  return (
    <div className="touch-game-details">
      {details ? (
        <PackDetailsView details={details} />
      ) : (
        <p className="touch-note">{error ?? 'Reading…'}</p>
      )}
    </div>
  );
}

/**
 * The app's settings: theme, layout, keeping the screen on, the list of
 * keys, and (with `withLog`) the activity log and the app's version. The
 * desktop app shows them on its Settings page, with the maps folder.
 */
export function Settings({ withLog = true }: { withLog?: boolean }) {
  const theme = useAtlas((s) => s.theme);
  const app = useAtlas((s) => s.app);
  const keepOn = useTouch((s) => s.keepScreenOn);
  const offered = useTouch((s) => s.screenOnOffered);
  const layoutOffered = useAtlas(layoutChoiceOffered);
  const hints = useKeyHints();
  return (
    <section aria-labelledby="settings-heading" className="touch-settings">
      <GroupTitle id="settings-heading">Settings</GroupTitle>
      <div className="touch-setting-row touch-setting-row-noted">
        <span className="touch-setting-label" id="theme-label">
          Theme
        </span>
        <div
          className="touch-segmented"
          role="group"
          aria-labelledby="theme-label"
          aria-describedby="theme-note"
        >
          {(['dark', 'light'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="touch-segment"
              aria-pressed={theme === value}
              onClick={() => {
                setTheme(value);
              }}
            >
              {value === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
        <span className="touch-switch-note touch-setting-note" id="theme-note">
          Dark or light colours for the whole app, the map included.
        </span>
      </div>
      {layoutOffered ? (
        <div className="touch-setting-row touch-setting-row-noted" data-testid="layout-setting">
          <span className="touch-setting-label" id="layout-label">
            Layout
          </span>
          <div
            className="touch-segmented"
            role="group"
            aria-labelledby="layout-label"
            aria-describedby="layout-note"
          >
            {(['standard', 'classic'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className="touch-segment"
                aria-pressed={value === 'standard'}
                data-testid={`layout-${value}`}
                onClick={() => {
                  setLayout(value);
                }}
              >
                {value === 'standard' ? 'Standard' : 'Classic'}
              </button>
            ))}
          </div>
          <span className="touch-switch-note touch-setting-note" id="layout-note">
            Classic is the earlier layout: a bar at the top and panes on both sides of the map.
          </span>
        </div>
      ) : null}
      {offered ? (
        <button
          type="button"
          role="switch"
          aria-checked={keepOn}
          className="touch-switch-card"
          data-testid="keep-screen-on"
          onClick={() => {
            setKeepScreenOn(!keepOn);
          }}
        >
          <span className="touch-switch-label">
            Keep the screen on
            <span className="touch-switch-note">While Atlas is shown</span>
          </span>
          <SwitchTrack on={keepOn} />
        </button>
      ) : null}
      {hints ? (
        <button
          type="button"
          className="touch-row touch-row-button"
          aria-haspopup="dialog"
          data-testid="open-keys"
          onClick={() => {
            setKeysOpen(true);
          }}
        >
          <span className="touch-row-text">
            <span className="touch-row-title">Keys and mouse</span>
            <span className="touch-row-detail">
              The keyboard shortcuts, and what the mouse does
            </span>
          </span>
          <span className="touch-row-end">
            <UiIcon name="chevron" size={18} strokeWidth={1.8} />
          </span>
        </button>
      ) : null}
      {desktop && withLog ? (
        <button
          type="button"
          className="touch-row touch-row-button"
          data-testid="open-activity-log"
          onClick={() => {
            openActivityLog();
          }}
        >
          <span className="touch-row-text">
            <span className="touch-row-title">Activity log</span>
            <span className="touch-row-detail">
              What this app did with the games on this device, such as imports and deletes
            </span>
          </span>
          <span className="touch-row-end">
            <UiIcon name="chevron" size={18} strokeWidth={1.8} />
          </span>
        </button>
      ) : null}
      {withLog ? (
        <p className="touch-app-version" data-testid="app-version">
          {app?.name ?? 'Atlas'}
          {app?.version ? ` ${app.version}` : ''}
        </p>
      ) : null}
    </section>
  );
}
