import { useCallback, useEffect, useId, useState } from 'react';
import type { FolderSize, OldFolder, OldFolders as OldFoldersListing } from '../desktop';
import { readsPackFilesOnly } from '../features';
import { notify } from '../state/actions';
import {
  afterText,
  confirmText,
  loadOldFolders,
  measureOldFolder,
  removeOldFolders,
  removedText,
  sizeText,
} from '../state/oldFolders';
import { useAtlas } from '../state/store';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Said instead of a list where another app that reads sites keeps its folders. */
export const SITE_READER_HERE =
  'The maps folder on this computer is also used by another app that reads sites and keeps its maps and wikis there as folders, so Atlas offers none of them for removal.';

/**
 * Old folders, in the settings of the desktop app without downloads: the
 * folder maps, wikis and guides in the maps folder that the app no longer
 * uses, each with its folder, its size and whether a pack file of the same
 * game is there. Each is removed only after a question that says which,
 * how many and how much room, and "Remove all listed" never takes a game
 * made in Atlas on this computer, which is listed only when asked for.
 * The app with downloads has no such section.
 */
export function OldFolders() {
  const reader = useAtlas(readsPackFilesOnly);
  if (__ATLAS_DOWNLOADS__ || !reader) return null;
  return <OldFoldersSection />;
}

function OldFoldersSection() {
  const [listing, setListing] = useState<OldFoldersListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<Record<string, FolderSize>>({});
  const [showMadeHere, setShowMadeHere] = useState(false);
  // The folders a question is asked about now, and whether they are made here.
  const [asking, setAsking] = useState<{ folders: OldFolder[]; madeHere: boolean } | null>(null);
  const [removing, setRemoving] = useState(false);
  const madeHereId = useId();

  // The packs folder: the old folders are looked at again when it changes,
  // as the pack files Atlas reads may be others then.
  const packsFolder = useAtlas((s) => s.library?.packsFolder?.path);
  // Raised to look at the maps folder again.
  const [looks, setLooks] = useState(0);
  const look = useCallback(() => {
    setError(null);
    setSizes({});
    setLooks((n) => n + 1);
  }, []);

  useEffect(() => {
    const run = { live: true };
    loadOldFolders().then(
      (found) => {
        if (run.live) setListing(found);
      },
      (reason: unknown) => {
        if (run.live) setError(errorText(reason));
      },
    );
    return () => {
      run.live = false;
    };
  }, [looks, packsFolder]);

  // Each folder measured in turn, off the page: "measuring…" until known.
  useEffect(() => {
    if (!listing) return;
    const run = { live: true };
    const all = [...listing.folders, ...listing.madeHere];
    void (async () => {
      for (const folder of all) {
        let size: FolderSize;
        try {
          size = await measureOldFolder(folder.folder);
        } catch {
          // Gone meanwhile: the next look leaves it out.
          continue;
        }
        // Looked again or left meanwhile: the next look measures again.
        if (!run.live) return;
        setSizes((before) => ({ ...before, [folder.folder]: size }));
      }
    })();
    return () => {
      run.live = false;
    };
  }, [listing]);

  const remove = (folders: OldFolder[]) => {
    setRemoving(true);
    removeOldFolders(folders)
      .then(
        (result) => {
          const failed = result.removed.some((one) => !one.removed);
          notify(removedText(result), failed ? 'error' : 'info');
        },
        (reason: unknown) => {
          notify(errorText(reason), 'error');
        },
      )
      .finally(() => {
        setRemoving(false);
        setAsking(null);
        look();
      });
  };

  const rows = (folders: OldFolder[], madeHere: boolean) => (
    <ul className="profile-list" data-testid={madeHere ? 'made-here-list' : 'old-folder-list'}>
      {folders.map((folder) => (
        <li
          key={folder.folder}
          className="profile-row pack-row"
          data-testid="old-folder-row"
          data-folder={folder.folder}
        >
          <div className="pack-info">
            <span className="pack-title">
              {folder.title}
              {madeHere ? (
                <span className="badge badge-warn" data-testid="made-here-badge">
                  {folder.packFile ? 'Made here' : 'Made here, exists only here'}
                </span>
              ) : null}
            </span>
            <span className="path">{folder.path}</span>
            <span className="muted small" data-testid="old-folder-size">
              Size: {sizeText(sizes[folder.folder])}
            </span>
            <span className="muted small" data-testid="old-folder-pack-file">
              {folder.packFile ? (
                <>
                  A pack file of this game is there:{' '}
                  <span className="path-inline">{folder.packFile}</span>. Once the folder is gone,
                  the game is shown from it.
                </>
              ) : madeHere ? (
                'There is no pack file of this game. Once the folder is gone, the game is gone for good.'
              ) : (
                'There is no pack file of this game. Once the folder is gone, it is no longer in the Library.'
              )}
            </span>
            <div className="row-actions">
              <button
                type="button"
                className="button button-small"
                data-testid="remove-old-folder"
                disabled={removing || asking !== null}
                onClick={() => {
                  setAsking({ folders: [folder], madeHere });
                }}
              >
                Remove…
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="settings-group" aria-label="Old folders" data-testid="settings-old-folders">
      <h2 className="settings-group-title">Old folders</h2>
      <p className="muted small">
        Atlas now keeps each map, wiki and guide for a game as a pack file and makes no new folders
        in the maps folder. The folders from earlier versions are still shown, and a folder is shown
        before a pack file of the same game. Nothing in them is converted. They can be removed to
        free space; each is removed only when you confirm. Your own lists, locations, notes, photos
        and guide links for a game are kept beside its folder and stay, and so do your found marks.
      </p>
      {error ? (
        <p className="download-error" role="alert">
          {error}
        </p>
      ) : !listing ? (
        <p className="muted small">Looking at the maps folder…</p>
      ) : listing.siteReader ? (
        <p className="download-note" data-testid="old-folders-site-reader">
          {SITE_READER_HERE}
        </p>
      ) : (
        <>
          {listing.folders.length === 0 ? (
            <p className="muted small" data-testid="old-folders-none">
              There are no old folders of maps, wikis or guides in the maps folder.
            </p>
          ) : (
            rows(listing.folders, false)
          )}
          {asking ? (
            <div
              className="removal-confirm"
              role="group"
              aria-label="Remove the folders?"
              data-testid="old-folders-confirm"
            >
              <p>{confirmText(asking.folders, sizes)}</p>
              <p className="muted small">
                {asking.madeHere && asking.folders.every((folder) => !folder.packFile)
                  ? 'It was made in Atlas on this computer and exists only here: removing its folder deletes the game for good. '
                  : ''}
                {afterText(asking.folders)} Your own lists, locations, notes, photos and guide links
                for {asking.folders.length === 1 ? 'the game' : 'these games'} stay, and so do your
                found marks.
              </p>
              <div className="row-actions wrap">
                <button
                  type="button"
                  className="button button-danger"
                  data-testid="old-folders-remove"
                  disabled={removing}
                  onClick={() => {
                    remove(asking.folders);
                  }}
                >
                  {removing
                    ? 'Removing…'
                    : asking.folders.length === 1
                      ? 'Remove the folder'
                      : `Remove ${asking.folders.length} folders`}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={removing}
                  onClick={() => {
                    setAsking(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
          <div className="row-actions wrap">
            {listing.folders.length > 1 ? (
              <button
                type="button"
                className="button"
                data-testid="remove-all-old-folders"
                disabled={removing || asking !== null}
                onClick={() => {
                  setAsking({ folders: listing.folders, madeHere: false });
                }}
              >
                Remove all listed…
              </button>
            ) : null}
            <button type="button" className="button" disabled={removing} onClick={look}>
              Look again
            </button>
          </div>
          {listing.madeHere.length > 0 ? (
            <>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  data-testid="show-made-here"
                  aria-describedby={madeHereId}
                  checked={showMadeHere}
                  onChange={(event) => {
                    setShowMadeHere(event.target.checked);
                  }}
                />
                <span>
                  Also list the maps made in Atlas on this computer
                  <span id={madeHereId} className="muted small pack-file-hint">
                    {listing.madeHere.length === 1
                      ? '1 map was'
                      : `${listing.madeHere.length} maps were`}{' '}
                    made here from pictures. Each folder is the map itself, so it is never removed
                    with Remove all listed. Write the pack file, in the Library, makes it one pack
                    file and then removes its folder.
                  </span>
                </span>
              </label>
              {showMadeHere ? rows(listing.madeHere, true) : null}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
