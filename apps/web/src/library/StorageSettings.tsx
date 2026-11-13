import { useEffect, useState } from 'react';
import type { FolderChoice, LocationInfo } from '../desktop';
import { downloadsOffered } from '../features';
import { notify } from '../state/actions';
import { loadDownloadSettings } from '../state/downloads';
import {
  addPacksFolder,
  applyMapsFolder,
  chooseMapsFolder,
  openPackFolder,
  refreshLibrary,
  removeLocation,
  reveal,
} from '../state/library';
import { useAtlas } from '../state/store';
import { DownloadSettingsSection } from '../components/DownloadSettings';
import { openActivityLog } from '../state/activityLog';

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
  if (!library) return null;
  return (
    <section className="settings-group" aria-label="Added folders" data-testid="settings-locations">
      <h2 className="settings-group-title">Map packs elsewhere</h2>
      <p className="muted small">
        Show map packs kept in other folders, for example on another drive. They are remembered
        between runs. Open folder shows a folder in your file manager; Remove from list forgets it
        and does not delete any files.
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
                  {location.kind === 'pack' ? 'Map pack' : 'Folder of map packs'}
                  {location.state === 'ok' && location.kind === 'folder'
                    ? ` · ${location.packs.length} pack${location.packs.length === 1 ? '' : 's'}`
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
          title="Show one map pack folder from anywhere on this computer"
          onClick={() => void openPackFolder()}
        >
          Open a map pack…
        </button>
        <button
          type="button"
          className="button"
          data-testid="add-packs-folder"
          title="Show every map pack in a folder you choose"
          onClick={() => void addPacksFolder()}
        >
          Choose maps folder…
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
        Open a map pack shows one pack folder from anywhere on this computer. Choose maps folder
        shows every map pack in a folder you choose. Look again reads every folder again, for maps
        another Atlas app added meanwhile.
      </p>
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
