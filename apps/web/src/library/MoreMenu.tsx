import type { ListedPack } from '../desktop';
import { downloadsOffered, foldersOffered, importsOffered, readsPackFilesOnly } from '../features';
import { deleteRow } from '../components/removalText';
import type { GameKind } from '../state/gameFacts';
import { rebuildPack, sessionGoing, updateGame, useImport } from '../state/importing';
import { reveal } from '../state/library';
import { canOpenForEditing, canWritePackFile, madePacksOffered } from '../state/madePacks';
import { setMoreOpen } from '../state/libraryView';
import { openExport, pickPackFile } from '../state/packFile';
import { openPageInBrowser } from '../state/pageView';
import { useAtlas } from '../state/store';
import { UiIcon, type UiIconName } from '../components/icons';

/**
 * What More can ask the game pane to show in its place: a confirmation
 * before deleting, or before starting a wiki again from the beginning, or
 * choosing a game to show this one with under one title, or its tags; for
 * a map made here, the confirmation before writing its pack file, opening
 * it for editing or closing it without writing.
 */
export type MoreConfirm =
  'pack' | 'images' | 'title' | 'restart' | 'tags' | 'write' | 'open' | 'close';

/**
 * "More" on the open game: the things done less often, each with a
 * sentence on what it does. Deleting asks first (see `GamePane.tsx`),
 * saying what happens to the files and to what was found.
 */
export function MoreMenu({
  id,
  title,
  listed,
  updatable,
  checkOnCard = false,
  groupable = false,
  grouped = false,
  kind = 'maps',
  wikiStart = null,
  onConfirm,
}: {
  id: string;
  title: string;
  /** The game as the shell lists it; undefined for one served from the app itself. */
  listed: ListedPack | undefined;
  updatable: boolean;
  /**
   * The game's card shows "Check the site for changes…" (or a wiki's "Choose
   * pages to read…", which does the same), so More does not offer it again.
   */
  checkOnCard?: boolean;
  /** Another game is here, so this one can be shown with it under one title. */
  groupable?: boolean;
  /** It is shown under one title already (its card says so). */
  grouped?: boolean;
  /** What it is: the delete row is named for it. */
  kind?: GameKind;
  /** For a wiki read by an importer of this app, where reading it starts: it can be started again. */
  wikiStart?: string | null;
  onConfirm: (what: MoreConfirm) => void;
}) {
  const folders = useAtlas(foldersOffered);
  const imports = useAtlas(importsOffered);
  const downloads = useAtlas(downloadsOffered);
  // The desktop app without downloads keeps an added pack file a file.
  const reader = useAtlas(readsPackFilesOnly);
  // Maps made here become pack files (the desktop app without downloads).
  const madePacks = useAtlas(madePacksOffered);
  const canRebuild = useAtlas((s) =>
    s.config?.importers.some((i) => i.id === listed?.imported?.importerId),
  );
  const busy = useAtlas((s) => s.library?.busy.includes(id) ?? false);
  // A session of reading pages, or a game built again, is going: nothing is started again meanwhile.
  const reading = useImport((s) => sessionGoing(s.phase) || s.licenceAsk !== null);
  const source = listed?.pages?.[0]?.url ?? listed?.url ?? null;
  // Read from a pack file where it lies: Atlas never changes the file, so
  // nothing that would change the game's own files is offered.
  const packFile = listed?.packFile === true;
  const close = () => {
    setMoreOpen(false);
  };
  const rows: MoreRow[] = [];
  const madeFile = madePacks && canOpenForEditing(listed);
  const editing = madePacks && canWritePackFile(listed) && listed?.editing !== undefined;
  if (madePacks && canWritePackFile(listed) && !busy) {
    rows.push({
      id: 'write-pack-file',
      icon: 'download',
      title: 'Write the pack file…',
      text: 'Writes this map with your own locations, lists and notes of it as one pack file, checks it, then removes its folder from the maps folder. You are asked first.',
      run: () => {
        onConfirm('write');
      },
    });
  }
  if (editing && !busy) {
    rows.push({
      id: 'close-editing',
      icon: 'undo',
      title: 'Close without writing…',
      text: 'Removes the folder this map was opened into, and leaves its pack file as it was. You are asked first.',
      danger: true,
      run: () => {
        onConfirm('close');
      },
    });
  }
  if (madeFile && !busy) {
    rows.push({
      id: 'open-editing',
      icon: 'pencil',
      title: 'Open for editing…',
      text: 'Unpacks this map from its pack file into a folder in the maps folder, where you can change it. The pack file stays as it is until you write it again. You are asked first.',
      run: () => {
        onConfirm('open');
      },
    });
  }
  if (updatable && !busy && !checkOnCard && !packFile) {
    rows.push({
      id: 'update-pack',
      icon: 'search',
      title: 'Check the site for changes',
      text: 'Reads the game’s page on its site again, one page, and lists the maps to refresh or add. Nothing changes until you choose.',
      run: () => void updateGame(id),
    });
  }
  if (listed?.imported && canRebuild && imports && !busy && !packFile) {
    rows.push({
      id: 'rebuild-pack',
      icon: 'layers',
      title: 'Build again from saved pages',
      text: 'Makes the game again from the page data kept with it, without visiting the site. Use it after the app was updated. What you found is kept.',
      run: () => void rebuildPack(id),
    });
  }
  if (__ATLAS_DOWNLOADS__ && downloads && listed?.imported && source) {
    rows.push({
      id: 'open-source-page',
      icon: 'external',
      title: 'Open the page it came from',
      text: 'Opens the page this game was made from in your own browser.',
      run: () => void openPageInBrowser(id, source),
    });
  }
  if (groupable && !grouped) {
    rows.push({
      id: 'show-with-another',
      icon: 'layers',
      title: 'Show with another game under one title',
      text: 'Lists this game and another source of the same game as one title, to change source from the maps menu. Each stays a whole game, with its own found marks.',
      run: () => {
        onConfirm('title');
      },
    });
  }
  rows.push({
    id: 'game-tags',
    icon: 'bullets',
    title: 'Tags…',
    text: grouped
      ? 'Gives the title tags of your own, such as its system and genre, for each of its sources. Group by lists your games under the tags of one group.'
      : 'Gives this game tags of your own, such as its system and genre. Group by lists your games under the tags of one group.',
    run: () => {
      onConfirm('tags');
    },
  });
  if (folders && !busy && !packFile) {
    rows.push({
      id: 'export-pack',
      icon: 'download',
      title: 'Export to a file…',
      text:
        kind === 'wiki'
          ? 'Saves this wiki with its pages and pictures in one pack file (.atlaspack), for another computer or Atlas for Android. Your progress is not in it.'
          : 'Saves this game with its map images in one pack file (.atlaspack), for another computer or Atlas for Android. Your marks are not in it.',
      run: () => {
        openExport(id, title);
      },
    });
  }
  if (folders) {
    rows.push({
      id: 'import-pack-file',
      icon: 'upload',
      title: reader ? 'Add a pack file…' : 'Import a pack file…',
      text: reader
        ? 'Copies a pack file (.atlaspack) exported by Atlas into the packs folder, where Atlas reads it. This game is not changed.'
        : 'Adds a game or a wiki from a pack file (.atlaspack) exported by Atlas on another computer. This game is not changed.',
      run: () => void pickPackFile(),
    });
  }
  if (listed?.path && folders) {
    rows.push({
      id: 'open-pack-folder',
      icon: 'folder',
      title: packFile ? 'Open the folder of its pack file' : 'Open its folder',
      text: packFile
        ? 'Shows the folder that holds the pack file this map, wiki or guide is read from, in your file manager.'
        : 'Shows the folder this game is kept in, in your file manager.',
      run: () => {
        reveal({ kind: 'pack', id });
      },
    });
  }
  if (listed?.path && folders && !busy && !packFile) {
    rows.push({
      id: 'delete-images',
      icon: 'trash',
      title: 'Delete downloaded images',
      text: 'Frees space: deletes the map images downloaded for this game and keeps the game and your found marks. You are asked first.',
      danger: true,
      run: () => {
        onConfirm('images');
      },
    });
  }
  // A map open for editing is closed without writing instead: its pack file is the map.
  const deletable = listed?.origin === 'maps-folder' && !listed.bundled && !busy && !editing;
  if (deletable && kind === 'wiki' && wikiStart && imports && !reading) {
    rows.push({
      id: 'restart-wiki',
      icon: 'undo',
      title: 'Start this wiki again from the beginning',
      text: 'Deletes the pages read from this wiki and what this app remembers of its site, then asks again how its pages are read. Your own pages, notes, lists and found marks stay. You are asked first.',
      danger: true,
      run: () => {
        onConfirm('restart');
      },
    });
  }
  if (deletable) {
    rows.push({
      id: 'delete-pack',
      icon: 'trash',
      ...deleteRow(kind, grouped),
      danger: true,
      run: () => {
        onConfirm('pack');
      },
    });
  }
  return (
    <div
      className="library-more"
      role="menu"
      aria-label={`More for ${title}`}
      data-testid="library-more-menu"
    >
      {packFile && madeFile ? (
        <p className="muted small library-more-empty" data-testid="pack-file-note">
          This map is read from its pack file, and Atlas never changes a pack file by itself. So it
          cannot be exported, deleted or refreshed here, and no map images are downloaded for it.
          Open for editing unpacks it into a folder where you can change it. Your lists, notes and
          found marks are kept by Atlas, not in the file.
        </p>
      ) : packFile ? (
        <p className="muted small library-more-empty" data-testid="pack-file-note">
          This map, wiki or guide is read from its pack file, and Atlas never changes a pack file.
          So it cannot be exported, deleted or refreshed here, and no map images are downloaded for
          it.{reader ? '' : ' To change it, import the pack file first with Import a pack file.'}{' '}
          Your lists, notes and found marks are kept by Atlas, not in the file.
        </p>
      ) : rows.length === 0 ? (
        <p className="muted small library-more-empty">
          Nothing else can be done with this game here: it comes with the app.
        </p>
      ) : null}
      {rows.map((row) => (
        <button
          key={row.id}
          type="button"
          role="menuitem"
          className={row.danger ? 'library-more-row library-more-danger' : 'library-more-row'}
          data-testid={row.id}
          onClick={() => {
            close();
            row.run();
          }}
        >
          <span className="library-more-icon">
            <UiIcon name={row.icon} size={18} />
          </span>
          <span className="library-more-text">
            <span className="library-more-title">{row.title}</span>
            <span className="library-more-sentence">{row.text}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

interface MoreRow {
  id: string;
  icon: UiIconName;
  title: string;
  text: string;
  danger?: boolean;
  run: () => void;
}
