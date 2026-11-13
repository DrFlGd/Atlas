import { useEffect, useId, useRef, useState } from 'react';
import type { ListedPack, PackDetails } from '../desktop';
import { copiesPickedFiles } from '../features';
import { switchGame } from '../state/actions';
import { setMapsDialogOpen } from '../state/library';
import { importPickedPackFile, loadPackDetails, pickPackFile } from '../state/packFile';
import { useAtlas } from '../state/store';
import { ActivityLogSection } from './ActivityLogSection';
import { DeletePackConfirm } from './DeletePackConfirm';
import { UiIcon } from './icons';
import { PackDetailsView } from './PackFacts';
import { PackSummary } from './PackSummary';

/**
 * "Maps", in the Android app's classic layout, which keeps its maps in its
 * own storage: the games on the device with their detail and size,
 * "Show", "Details" and "Delete…", and "Import map pack file…". The
 * desktop app has the Library instead (see `library/`).
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
          <PackList />
          <ActivityLogSection />
          <AppVersion />
        </div>
      ) : null}
    </dialog>
  );
}

/** Which app and version this is, at the foot of the dialog. */
function AppVersion() {
  const app = useAtlas((s) => s.app);
  if (!app?.version) return null;
  return (
    <p className="muted small app-version" data-testid="app-version">
      {app.name} {app.version}
    </p>
  );
}

function PackList() {
  const library = useAtlas((s) => s.library);
  const bundled = useAtlas((s) => s.bundledCatalog);
  const shown = useAtlas((s) => s.game?.entry.id);
  const copies = useAtlas(copiesPickedFiles);
  if (!library) return null;
  const listed = new Set(library.packs.map((p) => p.id));
  const fromApp = bundled.filter((p) => !listed.has(p.id));
  return (
    <section className="dialog-section" aria-label="Map packs">
      <h3 className="dialog-subhead">Games on this device</h3>
      <p className="muted small">
        Add a game with a map pack file (<code>.atlaspack</code>) exported by Atlas on your
        computer: copy it to this device, for example into Download, then import it here.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="import-pack-file"
          onClick={() => void (copies ? importPickedPackFile() : pickPackFile())}
        >
          Import map pack file…
        </button>
      </div>
      <ul className="profile-list pack-list" data-testid="pack-list">
        {fromApp.map((pack) => (
          <BundledRow key={pack.id} id={pack.id} title={pack.title} active={pack.id === shown} />
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

/**
 * A pack that comes with the app. It is part of the web build, which the
 * shell does not list, so it has no details to read; it can be shown.
 */
function BundledRow({ id, title, active }: { id: string; title: string; active: boolean }) {
  return (
    <li className="profile-row pack-row" data-testid="pack-row" data-pack={id}>
      <div className="pack-info">
        <PackTitle title={title} active={active} />
        <span className="muted small">Comes with the app</span>
        {!active ? (
          <div className="row-actions">
            <ShowButton id={id} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function ShowButton({ id }: { id: string }) {
  return (
    <button
      type="button"
      className="link-button"
      data-testid="show-pack"
      onClick={() => {
        setMapsDialogOpen(false);
        void switchGame(id);
      }}
    >
      Show
    </button>
  );
}

/** "Details" on a pack row, and what is known about the pack, read when opened. */
function usePackDetails(id: string) {
  const library = useAtlas((s) => s.library);
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<PackDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
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
  }, [open, id, library]);
  const toggle = (
    <button
      type="button"
      className="link-button"
      data-testid="pack-details-toggle"
      aria-expanded={open}
      onClick={() => {
        setOpen(!open);
      }}
    >
      Details
    </button>
  );
  const panel = !open ? null : details ? (
    <PackDetailsView details={details} />
  ) : error ? (
    <span className="small location-message">{error}</span>
  ) : (
    <span className="muted small">Reading…</span>
  );
  return { toggle, panel };
}

const ORIGIN: Record<ListedPack['origin'], string> = {
  bundled: 'Comes with the app',
  'maps-folder': 'Maps folder',
  location: 'Added folder',
};

function PackRow({ pack, active, busy }: { pack: ListedPack; active: boolean; busy: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const details = usePackDetails(pack.id);
  const deletable = pack.origin === 'maps-folder' && !pack.bundled;
  return (
    <li className="profile-row pack-row" data-testid="pack-row" data-pack={pack.id}>
      <div className="pack-info">
        <PackTitle title={pack.title} active={active} />
        <span className="muted small">
          {ORIGIN[pack.origin]}
          {pack.bundled ? ' · comes with the app' : ''}
          {busy ? ' · moving files from an older version…' : ''}
        </span>
        <PackSummary id={pack.id} />
        {confirming ? (
          <DeletePackConfirm
            id={pack.id}
            title={pack.title}
            onClose={() => {
              setConfirming(false);
            }}
          />
        ) : (
          <div className="row-actions">
            {!active ? <ShowButton id={pack.id} /> : null}
            {details.toggle}
            {deletable && !busy ? (
              <button
                type="button"
                className="link-button"
                data-testid="delete-pack"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Delete…
              </button>
            ) : null}
          </div>
        )}
        {details.panel}
      </div>
    </li>
  );
}
