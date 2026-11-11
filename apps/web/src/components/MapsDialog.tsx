import { useEffect, useId, useRef, useState } from 'react';
import type { FolderChoice, ListedPack, LocationInfo } from '../desktop';
import { downloadsOffered } from '../features';
import { notify, switchGame } from '../state/actions';
import { rebuildPack } from '../state/importing';
import {
  addPacksFolder,
  applyMapsFolder,
  chooseMapsFolder,
  openPackFolder,
  refreshLibrary,
  removeLocation,
  reveal,
  setMapsDialogOpen,
} from '../state/library';
import { useAtlas } from '../state/store';
import { ActivityLogSection } from './ActivityLogSection';
import { DeleteImagesConfirm } from './DeleteImagesConfirm';
import { DeletePackConfirm } from './DeletePackConfirm';
import { UiIcon } from './icons';
import { MapPageActions } from './MapPageActions';

/**
 * "Maps", in the desktop app: where maps are kept, the packs it shows and
 * where each comes from, and the pack folders and folders of packs the
 * person added. Nothing here deletes files except "Delete" on a pack in the
 * maps folder and "Delete downloaded images" on a pack with a folder, each
 * after a confirmation.
 */
export function MapsDialog() {
  const open = useAtlas((s) => s.mapsDialogOpen);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog maps-dialog"
      aria-labelledby={titleId}
      data-testid="maps-dialog"
      onClose={() => {
        setMapsDialogOpen(false);
      }}
      onClick={(event) => {
        if (event.target === ref.current) setMapsDialogOpen(false);
      }}
    >
      {open ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Maps</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              onClick={() => {
                setMapsDialogOpen(false);
              }}
            >
              <UiIcon name="close" />
            </button>
          </header>
          <MapsFolder />
          <PackList />
          <Locations />
          <ActivityLogSection />
        </div>
      ) : null}
    </dialog>
  );
}

function MapsFolder() {
  const library = useAtlas((s) => s.library);
  const importers = useAtlas((s) => s.config?.importers.length ?? 0);
  const downloads = useAtlas(downloadsOffered);
  const [choice, setChoice] = useState<FolderChoice | null>(null);
  const [working, setWorking] = useState(false);
  if (!library) return null;
  const folder = library.mapsFolder;
  return (
    <section className="dialog-section" aria-label="Maps folder">
      <h3 className="dialog-subhead">Where maps are saved</h3>
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
      )}
    </section>
  );
}

const ORIGIN: Record<ListedPack['origin'], string> = {
  bundled: 'Comes with the app',
  'maps-folder': 'Maps folder',
  location: 'Added folder',
};

function PackList() {
  const library = useAtlas((s) => s.library);
  const bundled = useAtlas((s) => s.bundledCatalog);
  const shown = useAtlas((s) => s.game?.entry.id);
  if (!library) return null;
  const listed = new Set(library.packs.map((p) => p.id));
  const fromApp = bundled.filter((p) => !listed.has(p.id));
  return (
    <section className="dialog-section" aria-label="Map packs">
      <div className="dialog-subhead-row">
        <h3 className="dialog-subhead">Map packs</h3>
        <button
          type="button"
          className="link-button"
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
          Refresh
        </button>
      </div>
      <ul className="profile-list pack-list" data-testid="pack-list">
        {fromApp.map((pack) => (
          <li key={pack.id} className="profile-row pack-row" data-testid="pack-row">
            <PackTitle title={pack.title} active={pack.id === shown} />
            <span className="muted small">{ORIGIN.bundled}</span>
          </li>
        ))}
        {library.packs.map((pack) => (
          <PackRow
            key={pack.id}
            pack={pack}
            active={pack.id === shown}
            busy={library.busy.includes(pack.id)}
          />
        ))}
      </ul>
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

function PackTitle({ title, active }: { title: string; active: boolean }) {
  return (
    <span className="pack-title">
      {title}
      {active ? <span className="badge badge-done">Shown</span> : null}
    </span>
  );
}

function PackRow({ pack, active, busy }: { pack: ListedPack; active: boolean; busy: boolean }) {
  const [confirming, setConfirming] = useState<'pack' | 'images' | null>(null);
  const canRebuild = useAtlas((s) =>
    s.config?.importers.some((i) => i.id === pack.imported?.importerId),
  );
  const mapPages = useAtlas(downloadsOffered);
  const deletable = pack.origin === 'maps-folder' && !pack.bundled;
  const close = () => {
    setConfirming(null);
  };
  return (
    <li className="profile-row pack-row" data-testid="pack-row" data-pack={pack.id}>
      <div className="pack-info">
        <PackTitle title={pack.title} active={active} />
        <span className="muted small">
          {ORIGIN[pack.origin]}
          {pack.imported ? ` · added with ${pack.imported.importerTitle}` : ''}
          {pack.bundled ? ' · comes with the app' : ''}
          {busy ? ' · moving files from an older version…' : ''}
        </span>
        {pack.path ? <span className="path small">{pack.path}</span> : null}
        {confirming === 'pack' ? (
          <DeletePackConfirm id={pack.id} title={pack.title} onClose={close} />
        ) : confirming === 'images' ? (
          <DeleteImagesConfirm id={pack.id} title={pack.title} onClose={close} />
        ) : (
          <div className="row-actions">
            {!active ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMapsDialogOpen(false);
                  void switchGame(pack.id);
                }}
              >
                Show
              </button>
            ) : null}
            {pack.path ? (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  reveal({ kind: 'pack', id: pack.id });
                }}
              >
                Open folder
              </button>
            ) : null}
            {pack.imported && canRebuild ? (
              <button
                type="button"
                className="link-button"
                title="Build the pack again from the page data kept with it, without visiting the page"
                onClick={() => void rebuildPack(pack.id)}
              >
                Rebuild
              </button>
            ) : null}
            {pack.path && !busy ? (
              <button
                type="button"
                className="link-button"
                data-testid="delete-images"
                title="Delete the map images downloaded for this game and keep the game"
                onClick={() => {
                  setConfirming('images');
                }}
              >
                Delete downloaded images…
              </button>
            ) : null}
            {deletable && !busy ? (
              <button
                type="button"
                className="link-button"
                data-testid="delete-pack"
                onClick={() => {
                  setConfirming('pack');
                }}
              >
                Delete…
              </button>
            ) : null}
          </div>
        )}
        {__ATLAS_DOWNLOADS__ && mapPages && pack.imported ? <MapPageActions pack={pack} /> : null}
      </div>
    </li>
  );
}

const LOCATION_STATE: Record<LocationInfo['state'], string> = {
  ok: '',
  missing: 'Not found',
  'not-a-pack': 'Not a map pack',
  'no-packs': 'No map packs',
};

function Locations() {
  const library = useAtlas((s) => s.library);
  if (!library) return null;
  return (
    <section className="dialog-section" aria-label="Added folders">
      <h3 className="dialog-subhead">Map packs elsewhere</h3>
      <p className="muted small">
        Show map packs kept in other folders, for example on another drive. They are remembered
        between runs. Removing one from this list does not delete any files.
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
                      className="link-button"
                      onClick={() => {
                        reveal({ kind: 'location', path: location.path });
                      }}
                    >
                      Open folder
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="link-button"
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
      </div>
    </section>
  );
}
