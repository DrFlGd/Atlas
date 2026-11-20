import { useEffect, useState } from 'react';
import type {
  FolderChoice,
  LocationInfo,
  OpenedFileInfo,
  PacksFolderChanged,
  PacksFolderChoice,
} from '../desktop';
import { downloadsOffered, readsPackFilesOnly } from '../features';
import { notify } from '../state/actions';
import { loadDownloadSettings } from '../state/downloads';
import {
  addPacksFolder,
  applyMapsFolder,
  chooseMapsFolder,
  forgetPackFile,
  openPackFolder,
  refreshLibrary,
  removeLocation,
  reveal,
} from '../state/library';
import { useAtlas } from '../state/store';
import { DownloadSettingsSection } from '../components/DownloadSettings';
import { openActivityLog } from '../state/activityLog';
import { pickPackFile } from '../state/packFile';
import {
  applyPacksFolder,
  choosePacksFolder,
  defaultPacksFolder,
  packsFolderChangeable,
  packsFolderFacts,
  packsFolderQuestion,
} from '../state/packsFolder';

/**
 * The settings that were in the Maps dialog: where maps are kept, map
 * packs kept in other folders (and those not shown), how fast downloads
 * go, and the activity log. Each says what it is for.
 */

/** The maps folder, with Change and Open folder. */
export function MapsFolder() {
  const library = useAtlas((s) => s.library);
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  const downloads = useAtlas(downloadsOffered);
  const reader = useAtlas(readsPackFilesOnly);
  const [choice, setChoice] = useState<FolderChoice | null>(null);
  const [working, setWorking] = useState(false);
  if (!library) return null;
  const folder = library.mapsFolder;
  return (
    <section className="settings-group" aria-label="Maps folder" data-testid="settings-maps-folder">
      <h2 className="settings-group-title">Where maps are saved</h2>
      <p className="muted small">
        {__ATLAS_DOWNLOADS__ && downloads
          ? importers > 0
            ? 'Maps you add and map images you download are saved here. '
            : 'Map images you download are saved here. '
          : reader
            ? 'A map you make in Atlas is kept here while you work on it, and the maps in it are shown. Maps, wikis and guides from pack files are read from the packs folder instead (see Games in other folders below). '
            : importers > 0
              ? 'Maps you add are saved here, and the maps in it are shown. '
              : 'The maps in this folder are shown. '}
        Every Atlas app on this computer uses the same folder.
      </p>
      <p className="path" data-testid="maps-folder-path">
        {folder.path}
        {folder.isDefault ? <span className="badge">Default</span> : null}
      </p>
      {choice ? (
        <div className="download-confirm" role="group" aria-label="Use the new maps folder?">
          <p>
            Use <span className="path-inline">{choice.path}</span> for maps from now on?
          </p>
          {choice.packs > 0 ? (
            <p className="muted small">
              {choice.canMove
                ? `The ${choice.packs} map pack${choice.packs === 1 ? '' : 's'} in the current folder can be moved there quickly, with their map images.`
                : `The ${choice.packs} map pack${choice.packs === 1 ? '' : 's'} in the current folder cannot be moved for you, because the new folder is on another drive. You can copy the pack folders there yourself (with the app closed) and then delete them from the old folder; until then the old folder stays in the list below.`}
            </p>
          ) : null}
          <div className="row-actions wrap">
            {choice.packs > 0 && choice.canMove ? (
              <button
                type="button"
                className="button button-primary"
                disabled={working}
                onClick={() => {
                  setWorking(true);
                  void applyMapsFolder(true).then((ok) => {
                    setWorking(false);
                    if (ok) setChoice(null);
                  });
                }}
              >
                {working ? 'Moving…' : 'Move my maps there'}
              </button>
            ) : null}
            <button
              type="button"
              className={choice.packs > 0 && choice.canMove ? 'button' : 'button button-primary'}
              disabled={working}
              onClick={() => {
                setWorking(true);
                void applyMapsFolder(false).then((ok) => {
                  setWorking(false);
                  if (ok) setChoice(null);
                });
              }}
            >
              {choice.packs > 0 ? 'Use it for new maps only' : 'Use this folder'}
            </button>
            <button
              type="button"
              className="button"
              disabled={working}
              onClick={() => {
                setChoice(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small">
            Change chooses another folder and then asks whether to move your maps there. Open folder
            shows it in your file manager.
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button"
              data-testid="change-maps-folder"
              onClick={() => {
                void chooseMapsFolder().then((picked) => {
                  if (picked) setChoice(picked);
                });
              }}
            >
              Change…
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                reveal({ kind: 'maps-folder' });
              }}
            >
              Open folder
            </button>
          </div>
        </>
      )}
    </section>
  );
}

const LOCATION_STATE: Record<LocationInfo['state'], string> = {
  ok: '',
  missing: 'Not found',
  'not-a-pack': 'Not a map pack',
  'no-packs': 'No map packs',
};

/** Map packs kept elsewhere: added folders, and the packs that are not shown. */
export function Locations() {
  const library = useAtlas((s) => s.library);
  const reader = useAtlas(readsPackFilesOnly);
  const following = useAtlas((s) => s.app?.platform !== 'android');
  if (!library) return null;
  return (
    <section
      className="settings-group"
      aria-label="Games in other folders"
      data-testid="settings-locations"
    >
      <h2 className="settings-group-title">Games in other folders</h2>
      <p className="muted small">
        Games kept outside the maps folder, for example on another drive, are remembered between
        runs. Remove from list forgets a folder and deletes no files.
      </p>
      {library.locations.length > 0 ? (
        <ul className="profile-list" data-testid="location-list">
          {library.locations.map((location) => (
            <li
              key={location.path}
              className="profile-row pack-row"
              data-testid="location-row"
              data-state={location.state}
            >
              <div className="pack-info">
                <span className="path">{location.path}</span>
                <span className="muted small">
                  {location.kind === 'pack' ? 'A game’s folder' : 'A folder of games'}
                  {location.state === 'ok' && location.kind === 'folder'
                    ? ` · ${location.packs.length} game${location.packs.length === 1 ? '' : 's'}`
                    : ''}
                  {location.state !== 'ok' ? (
                    <span className="badge badge-warn">{LOCATION_STATE[location.state]}</span>
                  ) : null}
                </span>
                {location.message ? (
                  <span className="small location-message">{location.message}</span>
                ) : null}
                <div className="row-actions">
                  {location.state !== 'missing' ? (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => {
                        reveal({ kind: 'location', path: location.path });
                      }}
                    >
                      Open folder
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="button button-small"
                    data-testid="remove-location"
                    onClick={() => void removeLocation(location.path)}
                  >
                    Remove from list
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button"
          data-testid="open-pack"
          title="Show one game from its folder, anywhere on this computer"
          onClick={() => void openPackFolder()}
        >
          Add a game’s folder…
        </button>
        <button
          type="button"
          className="button"
          data-testid="add-packs-folder"
          title="Show every game in a folder you choose"
          onClick={() => void addPacksFolder()}
        >
          Add a folder of games…
        </button>
        <button
          type="button"
          className="button"
          data-testid="refresh-maps"
          onClick={() => {
            void refreshLibrary()
              .then(() => {
                notify('Looked at every folder again.');
              })
              .catch((error: unknown) => {
                notify(String(error), 'error');
              });
          }}
        >
          Look again
        </button>
      </div>
      <p className="muted small">
        {following
          ? 'Atlas notices by itself when a pack file arrives, changes or goes in these folders. On a network drive or a removable drive, Atlas looks when you come back to its window and every half minute while you use it. Look again reads every folder again at once.'
          : 'Look again reads every folder again, for games another Atlas app added meanwhile.'}
      </p>
      <OpenedFiles files={library.openedFiles ?? []} />
      {library.packsFolder ? <PacksFolder folder={library.packsFolder} reader={reader} /> : null}
      {library.unreadable && library.unreadable.length > 0 ? (
        <div className="download-note" data-testid="unreadable-pack-files">
          <p>
            <strong>Pack files and folders that Atlas could not read:</strong>
          </p>
          <ul className="hidden-packs">
            {library.unreadable.map((file) => (
              <li key={`${file.path}\n${file.reason}`}>
                <span className="path-inline">{file.path}</span>: {file.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {library.hidden.length > 0 ? (
        <div className="download-note" data-testid="hidden-packs">
          <p>
            <strong>Not shown:</strong>
          </p>
          <ul className="hidden-packs">
            {library.hidden.map((pack) => (
              <li key={pack.path}>
                {pack.title} in <span className="path-inline">{pack.path}</span>. {pack.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The packs folder, under Games in other folders: what it is, Add a pack
 * file… (the app without downloads) and Open packs folder, and on a
 * desktop Change packs folder… and Use the default folder, each with the
 * question before anything changes (see `state/packsFolder.ts`).
 */
function PacksFolder({
  folder,
  reader,
}: {
  folder: { path: string; exists: boolean; isDefault?: boolean };
  reader: boolean;
}) {
  const changeable = useAtlas(packsFolderChangeable);
  const downloads = useAtlas(downloadsOffered);
  const [choice, setChoice] = useState<PacksFolderChoice | null>(null);
  const [working, setWorking] = useState<'move' | 'leave' | null>(null);
  const [left, setLeft] = useState<PacksFolderChanged['left']>([]);
  const apply = (moveFiles: boolean) => {
    setWorking(moveFiles ? 'move' : 'leave');
    void applyPacksFolder(moveFiles).then((changed) => {
      setWorking(null);
      if (changed) {
        setChoice(null);
        setLeft(changed.left);
      }
    });
  };
  const ask = (asked: Promise<PacksFolderChoice | null | undefined>) => {
    void asked.then((picked) => {
      if (picked) {
        setLeft([]);
        setChoice(picked);
      }
    });
  };
  return (
    <div data-testid="packs-folder">
      <p className="muted small">
        Pack files (.atlaspack) in the packs folder, and in the folders you added with Add a folder
        of games, are read where they are, without importing them. Atlas never changes or deletes a
        pack file, and moves one only when you change the packs folder and ask it to.
        {reader
          ? ' Add a pack file copies one into the packs folder; you can also put pack files there yourself, or open one from your file manager.'
          : ''}{' '}
        Packs folder: <span className="path-inline">{folder.path}</span>
        {changeable && folder.isDefault ? (
          <span className="badge" data-testid="packs-folder-default">
            Default
          </span>
        ) : null}
      </p>
      {!folder.exists && folder.isDefault === false ? (
        <p className="small location-message" data-testid="packs-folder-missing">
          <span className="badge badge-warn">Not found</span> The packs folder cannot be found. If
          it is on a drive that is not connected, connect it and press Look again, or choose another
          packs folder.
        </p>
      ) : null}
      {choice ? (
        <div
          className="download-confirm"
          role="group"
          aria-label="Use the new packs folder?"
          data-testid="packs-folder-confirm"
        >
          <p>{packsFolderQuestion(choice)}</p>
          {packsFolderFacts(choice).map((fact) => (
            <p key={fact} className="muted small">
              {fact}
            </p>
          ))}
          <div className="row-actions wrap">
            {choice.files > 0 ? (
              <button
                type="button"
                className="button button-primary"
                data-testid="packs-folder-move"
                disabled={working !== null}
                onClick={() => {
                  apply(true);
                }}
              >
                {working === 'move' ? 'Moving…' : 'Move the pack files there'}
              </button>
            ) : null}
            <button
              type="button"
              className={choice.files > 0 ? 'button' : 'button button-primary'}
              data-testid="packs-folder-leave"
              disabled={working !== null}
              onClick={() => {
                apply(false);
              }}
            >
              {choice.files > 0 ? 'Leave them where they are' : 'Use this folder'}
            </button>
            <button
              type="button"
              className="button"
              data-testid="packs-folder-cancel"
              disabled={working !== null}
              onClick={() => {
                setChoice(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row-actions wrap">
            {reader ? (
              <button
                type="button"
                className="button"
                data-testid="settings-add-pack-file"
                onClick={() => void pickPackFile()}
              >
                Add a pack file…
              </button>
            ) : null}
            <button
              type="button"
              className="button"
              onClick={() => {
                reveal({ kind: 'packs-folder' });
              }}
            >
              Open packs folder
            </button>
            {changeable ? (
              <button
                type="button"
                className="button"
                data-testid="change-packs-folder"
                onClick={() => {
                  ask(choosePacksFolder());
                }}
              >
                Change packs folder…
              </button>
            ) : null}
            {changeable && folder.isDefault === false ? (
              <button
                type="button"
                className="button"
                data-testid="default-packs-folder"
                onClick={() => {
                  ask(defaultPacksFolder());
                }}
              >
                Use the default folder
              </button>
            ) : null}
          </div>
          {changeable ? (
            <p className="muted small">
              Change packs folder chooses another folder and then asks whether to move the pack
              files there. Every Atlas app on this computer uses the same packs folder.
              {__ATLAS_DOWNLOADS__ && downloads
                ? ' Packs kept up to date are written into it too, unless you choose another folder for them below.'
                : ''}
            </p>
          ) : null}
        </>
      )}
      {left.length > 0 ? (
        <div className="download-note" data-testid="packs-folder-left">
          <p>
            <strong>Pack files that stayed in the old folder:</strong>
          </p>
          <ul className="hidden-packs">
            {left.map((file) => (
              <li key={file.path}>
                <span className="path-inline">{file.path}</span>: {file.reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The single pack files the person opened from the file manager, read
 * where they are: each with Remove from list, and Not found while it
 * cannot be found (as on a drive that is not connected).
 */
function OpenedFiles({ files }: { files: readonly OpenedFileInfo[] }) {
  if (files.length === 0) return null;
  return (
    <div data-testid="opened-pack-files">
      <h3 className="settings-subtitle">Pack files you opened</h3>
      <p className="muted small">
        Pack files you opened from the file manager are read where they are, without copying them.
        One leaves this list when you remove it here, or when it is deleted or moved. While its
        drive is not connected, it stays listed as not found. Remove from list deletes no files.
      </p>
      <ul className="profile-list" data-testid="opened-file-list">
        {files.map((file) => (
          <li
            key={file.path}
            className="profile-row pack-row"
            data-testid="opened-file-row"
            data-state={file.missing ? 'missing' : 'ok'}
          >
            <div className="pack-info">
              <span className="path">{file.path}</span>
              {file.missing ? (
                <span className="muted small">
                  <span className="badge badge-warn">Not found</span>
                </span>
              ) : null}
              <div className="row-actions">
                <button
                  type="button"
                  className="button button-small"
                  data-testid="forget-pack-file"
                  onClick={() => void forgetPackFile(file.path)}
                >
                  Remove from list
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** How fast downloads go, for every Atlas app on this computer (an app that downloads). */
export function DownloadSpeed() {
  const downloads = useAtlas(downloadsOffered);
  useEffect(() => {
    if (__ATLAS_DOWNLOADS__ && downloads) void loadDownloadSettings();
  }, [downloads]);
  if (!__ATLAS_DOWNLOADS__ || !downloads) return null;
  return (
    <section className="settings-group" aria-label="Download speed" data-testid="settings-speed">
      <h2 className="settings-group-title">Download speed</h2>
      <p className="muted small">
        How fast this computer fetches map images, photos and the pictures of pages, shared by every
        Atlas app on it. Pages are always read one at a time with a pause, whatever this says.
      </p>
      <DownloadSettingsSection running={false} open />
    </section>
  );
}

/** The activity log: what the Atlas apps on this computer did. */
export function ActivityLogSetting() {
  return (
    <section className="settings-group" aria-label="Activity log" data-testid="settings-log">
      <h2 className="settings-group-title">Activity log</h2>
      <p className="muted small">
        What the Atlas apps on this computer did with downloads, added maps and these folders. View
        activity log shows it; copy it from there to send it with a question about a problem.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="open-activity-log"
          onClick={() => {
            openActivityLog();
          }}
        >
          View activity log…
        </button>
      </div>
    </section>
  );
}
