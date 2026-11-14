import type { ListedPack } from '../desktop';
import { downloadsOffered, foldersOffered, importsOffered } from '../features';
import { rebuildPack, updateGame } from '../state/importing';
import { reveal } from '../state/library';
import { setMoreOpen } from '../state/libraryView';
import { openExport, pickPackFile } from '../state/packFile';
import { openPageInBrowser } from '../state/pageView';
import { useAtlas } from '../state/store';
import { UiIcon, type UiIconName } from '../components/icons';

/**
 * What More can ask the game pane to show in its place: a confirmation
 * before deleting, or choosing a game to show this one with under one title.
 */
export type MoreConfirm = 'pack' | 'images' | 'title';

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
  groupable = false,
  grouped = false,
  onConfirm,
}: {
  id: string;
  title: string;
  /** The game as the shell lists it; undefined for one served from the app itself. */
  listed: ListedPack | undefined;
  updatable: boolean;
  /** Another game is here, so this one can be shown with it under one title. */
  groupable?: boolean;
  /** It is shown under one title already (its card says so). */
  grouped?: boolean;
  onConfirm: (what: MoreConfirm) => void;
}) {
  const folders = useAtlas(foldersOffered);
  const imports = useAtlas(importsOffered);
  const downloads = useAtlas(downloadsOffered);
  const canRebuild = useAtlas((s) =>
    s.config?.importers.some((i) => i.id === listed?.imported?.importerId),
  );
  const busy = useAtlas((s) => s.library?.busy.includes(id) ?? false);
  const source = listed?.pages?.[0]?.url ?? listed?.url ?? null;
  const close = () => {
    setMoreOpen(false);
  };
  const rows: MoreRow[] = [];
  if (updatable && !busy) {
    rows.push({
      id: 'update-pack',
      icon: 'search',
      title: 'Check the site for changes',
      text: 'Reads the game’s page on its site again, one page, and lists the maps to refresh or add. Nothing changes until you choose.',
      run: () => void updateGame(id),
    });
  }
  if (listed?.imported && canRebuild && imports && !busy) {
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
  if (folders && !busy) {
    rows.push({
      id: 'export-pack',
      icon: 'download',
      title: 'Export to a file',
      text: 'Saves this game with its map images in one .atlaspack file, for another computer or Atlas for Android. Your marks are not in it.',
      run: () => {
        openExport(id, title);
      },
    });
  }
  if (folders) {
    rows.push({
      id: 'import-pack-file',
      icon: 'upload',
      title: 'Import a map pack file',
      text: 'Adds a game from an .atlaspack file exported by Atlas on another computer. This game is not changed.',
      run: () => void pickPackFile(),
    });
  }
  if (listed?.path && folders) {
    rows.push({
      id: 'open-pack-folder',
      icon: 'folder',
      title: 'Open its folder',
      text: 'Shows the folder this game is kept in, in your file manager.',
      run: () => {
        reveal({ kind: 'pack', id });
      },
    });
  }
  if (listed?.path && folders && !busy) {
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
  if (listed?.origin === 'maps-folder' && !listed.bundled && !busy) {
    rows.push({
      id: 'delete-pack',
      icon: 'trash',
      title: 'Delete the game',
      text: 'Deletes the game’s folder with its maps and images. You are asked first, and told what happens to the marks you made.',
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
      {rows.length === 0 ? (
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
