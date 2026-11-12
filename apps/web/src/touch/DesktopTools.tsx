import { UiIcon, type UiIconName } from '../components/icons';
import { desktop } from '../desktop';
import { foldersOffered, importsOffered, mapsOffered, touchUiOffered } from '../features';
import { setProfileDialogOpen } from '../state/actions';
import { setAddMapOpen } from '../state/importing';
import { setMapsDialogOpen } from '../state/library';
import { saveReaderOf, setSaveDialogOpen } from '../state/saves';
import { useAtlas } from '../state/store';
import { setKeysOpen, useKeyHints } from './state';

/**
 * The desktop app's tools in the standard layout: the same dialogs as the
 * classic layout's top bar opens (Add a map, Maps, Game save, profiles),
 * with the same names, so what the help and the release notes say still
 * leads there.
 */

/** Whether the game shown has saves Atlas can read here (as the classic top bar's "Game save"). */
function useSaveReadable(): boolean {
  // Reading a save needs a folder or file chosen on this device, which the
  // Android app cannot offer yet.
  const folders = useAtlas(foldersOffered);
  return useAtlas((s) => folders && saveReaderOf(s.game) !== null);
}

/** "Game save" in the rail, for a game whose saves Atlas can read. */
export function SaveButton() {
  const readable = useSaveReadable();
  const linked = useAtlas((s) => s.save.link !== null);
  const busy = useAtlas((s) => s.save.busy);
  if (!readable) return null;
  return (
    <button
      type="button"
      className={
        linked
          ? 'touch-round-button touch-rail-tool touch-rail-tool-on'
          : 'touch-round-button touch-rail-tool'
      }
      aria-label="Game save"
      title={linked ? 'Game save: linked' : 'Game save: read your progress from a save'}
      aria-haspopup="dialog"
      aria-busy={busy}
      data-testid="save-button"
      onClick={() => {
        setSaveDialogOpen(true);
      }}
    >
      <UiIcon name="save" size={20} />
    </button>
  );
}

/** The list of keys, in the rail where there is a keyboard. */
export function KeysButton() {
  const hints = useKeyHints();
  if (!hints) return null;
  return (
    <button
      type="button"
      className="touch-round-button touch-rail-tool"
      aria-label="Keys and mouse"
      title="Keys and mouse (?)"
      aria-haspopup="dialog"
      aria-keyshortcuts="?"
      data-testid="keys-button"
      onClick={() => {
        setKeysOpen(true);
      }}
    >
      <UiIcon name="keyboard" size={20} />
    </button>
  );
}

/** One tool as a row of the Games screen. */
function ToolRow({
  icon,
  title,
  detail,
  testId,
  onClick,
}: {
  icon: UiIconName;
  title: string;
  detail: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="touch-row touch-row-button touch-tool-row"
      aria-haspopup="dialog"
      data-testid={testId}
      onClick={onClick}
    >
      <span className="touch-row-icon">
        <UiIcon name={icon} size={20} />
      </span>
      <span className="touch-row-text">
        <span className="touch-row-title">{title}</span>
        <span className="touch-row-detail">{detail}</span>
      </span>
      <span className="touch-row-end">
        <UiIcon name="chevron" size={18} strokeWidth={1.8} />
      </span>
    </button>
  );
}

/**
 * "Add a map" (in builds with importers, not in the Android app) and
 * "Maps" (the maps folder, other folders, updates from the site, exports,
 * deleting), at the top of Games in the desktop app.
 */
export function LibraryTools() {
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  const imports = useAtlas(importsOffered);
  const maps = useAtlas(mapsOffered);
  const folders = useAtlas(foldersOffered);
  const android = useAtlas(touchUiOffered);
  // The Android app keeps its own Games screen as it was: no Maps dialog
  // there, since this screen already lists its games and imports files.
  if (!desktop || android) return null;
  return (
    <div className="touch-tools" data-testid="library-tools">
      {importers > 0 && imports ? (
        <ToolRow
          icon="mapPlus"
          title="Add a map"
          detail="From a map page on the web, or a whole game"
          testId="add-map-button"
          onClick={() => {
            setAddMapOpen(true);
          }}
        />
      ) : null}
      {maps ? (
        <ToolRow
          icon="folder"
          title="Maps"
          detail={
            folders
              ? 'Where maps are kept, packs from other folders, updates, export and delete'
              : 'The games on this device, and importing map pack files'
          }
          testId="maps-button"
          onClick={() => {
            setMapsDialogOpen(true);
          }}
        />
      ) : null}
    </div>
  );
}

/** "Game save" and "Profiles" as rows of the Games screen, for a window too narrow for the rail. */
export function ProgressTools() {
  const readable = useSaveReadable();
  const linked = useAtlas((s) => s.save.link !== null);
  const profileName = useAtlas((s) => s.profiles.find((p) => p.id === s.profileId)?.name ?? '');
  const android = useAtlas(touchUiOffered);
  if (android) return null;
  return (
    <div className="touch-tools">
      {readable ? (
        <ToolRow
          icon="save"
          title="Game save"
          detail={
            linked ? 'Linked: read again, follow new saves' : 'Read your progress from a save'
          }
          testId="save-row"
          onClick={() => {
            setSaveDialogOpen(true);
          }}
        />
      ) : null}
      <ToolRow
        icon="user"
        title="Profiles, export and import"
        detail={`Shown: ${profileName}`}
        testId="profiles-row"
        onClick={() => {
          setProfileDialogOpen(true);
        }}
      />
    </div>
  );
}
