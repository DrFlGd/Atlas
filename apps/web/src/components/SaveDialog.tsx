import type { Unmatched, WorldMatch } from '@atlas/saves';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { desktop } from '../desktop';
import { numberFormat } from '../state/derived';
import {
  linkSaveFile,
  linkSaveFolder,
  openSaveFile,
  readLinkedSave,
  removeSaveMarks,
  resetCalibration,
  saveMarkTargets,
  saveReaderOf,
  setFollowSaves,
  setSaveDialogOpen,
  setWorldMap,
  showPlayer,
  shownPlayer,
  startPlacing,
  unlinkSave,
  MIN_SPOT_DISTANCE,
} from '../state/saves';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/** "Game save": the save linked to the profile, what it says, and how it is shown on the maps. */
export function SaveDialog() {
  const open = useAtlas((s) => s.saveDialogOpen);
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
      className="dialog save-dialog"
      aria-labelledby={titleId}
      data-testid="save-dialog"
      onClose={() => {
        setSaveDialogOpen(false);
      }}
      onClick={(event) => {
        if (event.target === ref.current) setSaveDialogOpen(false);
      }}
    >
      {open ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Game save</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              onClick={() => {
                setSaveDialogOpen(false);
              }}
            >
              <UiIcon name="close" />
            </button>
          </header>
          <SaveDialogBody />
        </div>
      ) : null}
    </dialog>
  );
}

function SaveDialogBody() {
  const game = useAtlas((s) => s.game);
  const link = useAtlas((s) => s.save.link);
  const error = useAtlas((s) => s.save.error);
  const busy = useAtlas((s) => s.save.busy);
  const reader = saveReaderOf(game);
  if (!reader) {
    return <p className="muted small">Atlas cannot read saves of this game.</p>;
  }
  return (
    <>
      <p className="muted small">
        Atlas reads a copy of your {reader.title} save to mark the places it shows done and to show
        where you last saved. It never changes the save, and marks you set by hand always stay as
        they are.
      </p>
      {link ? <LinkedSave /> : <LinkChoices />}
      {busy ? (
        <p className="small" role="status" data-testid="save-busy">
          Reading the save…
        </p>
      ) : null}
      {error ? (
        <p className="save-error small" role="alert" data-testid="save-error">
          {error}
        </p>
      ) : null}
      <SaveResult />
      <SaveMarks />
    </>
  );
}

/** The ways to link a save: a folder or file in the desktop app, a file in a browser. */
function LinkChoices() {
  const game = useAtlas((s) => s.game);
  const reader = saveReaderOf(game);
  const [defaultFolder, setDefaultFolder] = useState<{ path: string; exists: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!desktop || !reader) return;
    let current = true;
    desktop.saves
      .defaultFolder(reader.id)
      .then((folder) => {
        if (current) setDefaultFolder(folder);
      })
      .catch(() => {
        // No Documents folder, or a game whose saves folder is not known.
      });
    return () => {
      current = false;
    };
  }, [reader]);

  return (
    <section className="dialog-section">
      <h3 className="dialog-subhead">Link a save to this profile</h3>
      {desktop ? (
        <>
          {defaultFolder?.exists ? (
            <div className="save-choice">
              <button
                type="button"
                className="button button-primary"
                data-testid="save-use-default"
                onClick={() => {
                  void linkSaveFolder('default');
                }}
              >
                <UiIcon name="folder" size={16} />
                Use the game’s saves folder
              </button>
              <p className="path">{defaultFolder.path}</p>
            </div>
          ) : null}
          <div className="save-buttons">
            <button
              type="button"
              className="button"
              onClick={() => {
                void linkSaveFolder('choose');
              }}
            >
              <UiIcon name="folder" size={16} />
              Choose a saves folder…
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                void linkSaveFile();
              }}
            >
              <UiIcon name="save" size={16} />
              Open a save file…
            </button>
          </div>
          <p className="muted small">
            With a folder, Atlas reads the newest save in it, and each new one as the game writes
            it.
          </p>
        </>
      ) : (
        <BrowserFilePicker label="Open a save file…" />
      )}
    </section>
  );
}

/** A file input for saves, in a browser. */
function BrowserFilePicker({ label }: { label: string }) {
  const game = useAtlas((s) => s.game);
  const reader = saveReaderOf(game);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="save-buttons">
      <button
        type="button"
        className="button"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <UiIcon name="save" size={16} />
        {label}
      </button>
      <input
        ref={inputRef}
        type="file"
        className="visually-hidden"
        tabIndex={-1}
        accept={reader?.extensions.join(',')}
        data-testid="save-file-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void openSaveFile(file);
        }}
      />
    </div>
  );
}

function LinkedSave() {
  const link = useAtlas((s) => s.save.link)!;
  const folder = useAtlas((s) => s.save.folder);
  const busy = useAtlas((s) => s.save.busy);
  const last = link.last;
  const followId = useId();
  return (
    <section className="dialog-section" data-testid="save-link">
      <h3 className="dialog-subhead">
        {link.kind === 'folder' ? 'Linked saves folder' : 'Linked save'}
      </h3>
      <p className="save-linked">
        <strong>{link.name}</strong>
        {link.kind === 'folder' && folder ? (
          <span className="muted small"> ({numberFormat.format(folder.saves.length)} saves)</span>
        ) : null}
      </p>
      {link.path ? <p className="path">{link.path}</p> : null}
      {last ? (
        <dl className="facts save-facts" data-testid="save-last">
          <dt>Read</dt>
          <dd>
            {link.kind === 'folder' ? `${last.file}, ` : ''}
            {new Date(last.readAt).toLocaleString()}
          </dd>
          <dt>Version</dt>
          <dd>{last.version}</dd>
          <dt>World</dt>
          <dd data-testid="save-world">{last.world?.name ?? 'not in the save'}</dd>
          <dt>Found</dt>
          <dd data-testid="save-found">
            {numberFormat.format(last.found)} places, {numberFormat.format(last.marked)} newly
            marked
          </dd>
        </dl>
      ) : null}
      {desktop && last?.path ? <Screenshot path={last.path} /> : null}
      {link.kind !== 'browser' && desktop ? (
        <label className="switch save-follow" htmlFor={followId}>
          <input
            id={followId}
            type="checkbox"
            role="switch"
            checked={link.follow}
            data-testid="save-follow"
            onChange={(event) => {
              setFollowSaves(event.target.checked);
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          Follow new saves
        </label>
      ) : null}
      <div className="save-buttons">
        {link.kind !== 'browser' && desktop ? (
          <button
            type="button"
            className="button"
            disabled={busy}
            data-testid="save-read-again"
            onClick={() => {
              void readLinkedSave();
            }}
          >
            {link.kind === 'folder' ? 'Read the newest save' : 'Read again'}
          </button>
        ) : (
          <BrowserFilePicker label="Open another save file…" />
        )}
        <button
          type="button"
          className="button"
          data-testid="save-unlink"
          onClick={() => {
            unlinkSave();
          }}
        >
          Unlink
        </button>
      </div>
    </section>
  );
}

/** The game's screenshot of the save, in the desktop app. */
function Screenshot({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let current = true;
    let made: string | null = null;
    desktop.saves
      .screenshot(path)
      .then((bytes) => {
        if (!current) return;
        made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' }));
        setUrl(made);
      })
      .catch(() => {
        setUrl(null);
      });
    return () => {
      current = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return url ? (
    <img className="save-screenshot" src={url} alt="The game’s picture of the save" />
  ) : null;
}

const REASONS: Record<Unmatched['reason'], string> = {
  'no-category': 'this pack has no category for them',
  'no-place-nearby': 'no place of their kind in the pack is close enough',
  'no-position': 'the save does not say where they are',
  'no-map': 'no map is chosen for their world',
  'not-lined-up': 'their map is not lined up with the game world yet',
};

/** What the save read in this session says, matched against the pack. */
function SaveResult() {
  const game = useAtlas((s) => s.game);
  const save = useAtlas((s) => s.save);
  const { match, summary } = save;
  const player = shownPlayer(save);
  if (!game) return null;
  if (!match || !summary) {
    return player ? (
      <section className="dialog-section">
        <button
          type="button"
          className="button"
          onClick={() => {
            setSaveDialogOpen(false);
            showPlayer();
          }}
        >
          <UiIcon name="target" size={16} />
          Show me on the map
        </button>
      </section>
    ) : null;
  }
  const maps = game.pack.data.maps;
  return (
    <>
      <section className="dialog-section" data-testid="save-worlds">
        <h3 className="dialog-subhead">Maps</h3>
        {match.current && !match.current.mapId ? (
          <p className="small" data-testid="save-no-map">
            You saved in {match.current.name}, which no map of this pack shows. Choose its map below
            if it has one under another name.
          </p>
        ) : null}
        {player && !player.onMap ? (
          <p className="small muted">
            Where you saved lies outside the map image; the map may not be lined up well.
          </p>
        ) : null}
        <ul className="save-worlds">
          {match.worlds.map((world) => (
            <WorldRow
              key={world.worldId}
              world={world}
              current={world.worldId === match.current?.worldId}
              maps={maps}
            />
          ))}
        </ul>
        {player ? (
          <button
            type="button"
            className="button"
            data-testid="save-show-me"
            onClick={() => {
              setSaveDialogOpen(false);
              showPlayer();
            }}
          >
            <UiIcon name="target" size={16} />
            Show me on the map
          </button>
        ) : null}
      </section>

      <section className="dialog-section" data-testid="save-categories">
        <h3 className="dialog-subhead">What the save shows done</h3>
        {match.categories.length === 0 ? (
          <p className="muted small">No places of this pack match the save yet.</p>
        ) : (
          <ul className="save-counts">
            {match.categories.map((count) => (
              <li key={count.categoryId}>
                <span>{game.pack.categories.get(count.categoryId)?.name ?? count.categoryId}</span>
                <span className="chip-count">{numberFormat.format(count.matched)}</span>
              </li>
            ))}
          </ul>
        )}
        {match.unmatched.length > 0 ? (
          <>
            <p className="muted small">Not matched to a place:</p>
            <ul className="save-unmatched small" data-testid="save-unmatched">
              {match.unmatched.map((miss) => (
                <li key={`${miss.kind}-${miss.reason}`}>
                  {numberFormat.format(miss.count)} {miss.label.toLowerCase()}:{' '}
                  {REASONS[miss.reason]}
                </li>
              ))}
            </ul>
          </>
        ) : null}
        {summary.notes.length > 0 ? (
          <ul className="save-notes muted small">
            {summary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </section>
    </>
  );
}

function WorldRow({
  world,
  current,
  maps,
}: {
  world: WorldMatch;
  current: boolean;
  maps: readonly { id: string; name: string }[];
}) {
  const selectId = useId();
  const calibration = useAtlas((s) => (world.mapId ? s.save.calibrations[world.mapId] : undefined));
  const spots = useAtlas((s) => (world.mapId ? (s.save.points[world.mapId]?.length ?? 0) : 0));
  const canPlace = useAtlas((s) => Boolean(current && s.save.summary?.player));
  return (
    <li className="save-world" data-testid="save-world-row">
      <label htmlFor={selectId}>
        {world.name}
        {current ? <span className="muted small"> (you are here)</span> : null}
      </label>
      <select
        id={selectId}
        className="select"
        value={world.mapId ?? ''}
        onChange={(event) => {
          setWorldMap(world.worldId, event.target.value || null);
        }}
      >
        <option value="">No map</option>
        {maps.map((map) => (
          <option key={map.id} value={map.id}>
            {map.name}
          </option>
        ))}
      </select>
      {world.mapId ? (
        <p className="small muted save-lined-up" data-testid="save-lined-up">
          {world.calibration === 'pack'
            ? 'Lined up with the game world by the pack.'
            : world.calibration === 'manual'
              ? 'Lined up from the spots you marked.'
              : world.calibration === 'auto'
                ? `Lined up from the save’s map pins${calibration?.fit ? ` (${calibration.fit.inliers} of ${calibration.fit.candidates} fit)` : ''}.`
                : spots > 0
                  ? `Not lined up yet: ${spots === 1 ? 'one spot' : `${spots} spots`} marked. Mark one more from a save at least ${MIN_SPOT_DISTANCE} m away.`
                  : 'Not lined up with the game world yet.'}
        </p>
      ) : null}
      {world.mapId && world.calibration !== 'pack' ? (
        <div className="save-buttons">
          {canPlace ? (
            <button
              type="button"
              className="button button-small"
              data-testid="save-place-me"
              onClick={() => {
                startPlacing();
              }}
            >
              Place me on the map
            </button>
          ) : null}
          {world.calibration || spots > 0 ? (
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                resetCalibration(world.mapId!);
              }}
            >
              Reset lining up
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** Taking back the marks made from saves. */
function SaveMarks() {
  const rows = useAtlas((s) => s.rows);
  const game = useAtlas((s) => s.game);
  const [confirming, setConfirming] = useState(false);
  const count = useMemo(() => saveMarkTargets(game, rows).length, [game, rows]);
  if (count === 0) return null;
  return (
    <section className="dialog-section">
      <h3 className="dialog-subhead">Marks made from saves</h3>
      <p className="muted small">
        {numberFormat.format(count)} {count === 1 ? 'place is' : 'places are'} marked found because
        a save said so.
      </p>
      {confirming ? (
        <div className="save-buttons">
          <button
            type="button"
            className="button button-danger"
            data-testid="save-remove-marks-confirm"
            onClick={() => {
              removeSaveMarks();
              setConfirming(false);
            }}
          >
            Remove {count === 1 ? 'the mark' : `${numberFormat.format(count)} marks`}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="button"
          data-testid="save-remove-marks"
          onClick={() => {
            setConfirming(true);
          }}
        >
          Remove marks made from saves
        </button>
      )}
    </section>
  );
}
