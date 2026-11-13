import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { formatBytes } from '../components/downloadFormat';
import type { CutJobProgress, PickedPicture } from '../desktop';
import { numberFormat } from '../state/derived';
import {
  addOwnLevel,
  addOwnMap,
  cancelCut,
  createOwnGame,
  cutProgress,
  deleteOwnMap,
  pickMapPicture,
  renameOwnGame,
} from '../state/ownGames';
import { useAtlas } from '../state/store';

/*
 * Games made in the app, on the Games screen of the desktop apps: "New
 * game…" (a name and the first map's picture, in one go), and for such a
 * game "Add map…", "Add level…", "Rename…" and "Delete map…". Making a map
 * from a picture shows how far it is, with Cancel, which leaves nothing.
 */

/** What the picture dialog makes. */
export type PictureDialogMode =
  | { kind: 'game' }
  | { kind: 'map'; gameId: string; title: string }
  | { kind: 'level'; gameId: string; title: string; maps: { id: string; name: string }[] };

/** The New game button, and its dialog. */
export function NewGameButton() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className="touch-button touch-button-block"
        data-testid="new-game"
        onClick={() => {
          setOpen(true);
        }}
      >
        <UiIcon name="mapPlus" size={20} />
        New game…
      </button>
      <p className="touch-note">
        Make a game of your own from a picture of its map: a large PNG, JPEG or WebP picture is cut
        into the map’s levels of detail. Add your own locations to it with Edit locations.
      </p>
      {open ? (
        <PictureDialog
          mode={{ kind: 'game' }}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

const TEXT = {
  game: {
    title: 'New game',
    nameLabel: 'Name of the game',
    namePlaceholder: 'My game',
    mapLabel: 'Name of its first map',
    mapPlaceholder: 'World',
    make: 'Make game',
    lead: 'A game needs a map, so give its first map a picture now. More maps, and levels such as floors, can be added later.',
  },
  map: {
    title: 'Add a map',
    nameLabel: '',
    namePlaceholder: '',
    mapLabel: 'Name of the map',
    mapPlaceholder: 'Caves',
    make: 'Add map',
    lead: 'The picture is the map at its most detailed; the app makes the less detailed levels from it.',
  },
  level: {
    title: 'Add a level',
    nameLabel: '',
    namePlaceholder: '',
    mapLabel: 'Name of the level',
    mapPlaceholder: 'Upper floor',
    make: 'Add level',
    lead: 'A level is another picture of the same map, such as a floor: it needs the same size in pixels as the map’s first picture.',
  },
} as const;

function PictureDialog({ mode, onClose }: { mode: PictureDialogMode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nameId = useId();
  const mapNameId = useId();
  const mapChoiceId = useId();
  const text = TEXT[mode.kind];
  const [title, setTitle] = useState('');
  const [mapName, setMapName] = useState('');
  const [mapId, setMapId] = useState(mode.kind === 'level' ? (mode.maps[0]?.id ?? '') : '');
  const [picture, setPicture] = useState<PickedPicture | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CutJobProgress | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    firstRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  // How far the cut is, while it runs.
  useEffect(() => {
    if (!running) return;
    let live = true;
    const poll = () => {
      void cutProgress().then(
        (next) => {
          if (live && next) setProgress(next);
        },
        () => undefined,
      );
    };
    poll();
    const timer = window.setInterval(poll, 250);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [running]);

  const close = () => {
    if (!running) onClose();
  };

  const choose = async () => {
    setPicking(true);
    setProblem(null);
    try {
      const chosen = await pickMapPicture();
      if (chosen) setPicture(chosen);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const make = async () => {
    if (mode.kind === 'game' && !title.trim()) {
      setProblem('Give the game a name.');
      return;
    }
    if (!mapName.trim()) {
      setProblem(mode.kind === 'level' ? 'Give the level a name.' : 'Give the map a name.');
      return;
    }
    if (!picture) {
      setProblem('Choose a picture for the map.');
      return;
    }
    if (picture.problem) {
      setProblem(picture.problem);
      return;
    }
    setProblem(null);
    setProgress(null);
    setRunning(true);
    try {
      if (mode.kind === 'game') await createOwnGame(title, mapName, picture.path);
      else if (mode.kind === 'map') await addOwnMap(mode.gameId, mapName, picture.path);
      else await addOwnLevel(mode.gameId, mapId, mapName, picture.path);
      setRunning(false);
      onClose();
    } catch (error) {
      setRunning(false);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small own-game-dialog"
      aria-labelledby={titleId}
      data-testid="picture-dialog"
      data-kind={mode.kind}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        className="own-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <header className="own-dialog-head">
          <h2 id={titleId} className="own-dialog-title">
            {text.title}
            {mode.kind === 'game' ? '' : ` to ${mode.title}`}
          </h2>
          <button
            type="button"
            className="touch-icon-button own-dialog-close"
            aria-label="Close"
            disabled={running}
            onClick={close}
          >
            <UiIcon name="close" size={20} strokeWidth={1.8} />
          </button>
        </header>
        <p className="own-dialog-line">{text.lead}</p>
        <fieldset className="own-game-fields" disabled={running}>
          {mode.kind === 'game' ? (
            <div className="own-field">
              <label htmlFor={nameId} className="own-label">
                {text.nameLabel}
              </label>
              <input
                ref={firstRef}
                id={nameId}
                className="own-input"
                maxLength={100}
                autoComplete="off"
                placeholder={text.namePlaceholder}
                data-testid="new-game-name"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setProblem(null);
                }}
              />
            </div>
          ) : null}
          {mode.kind === 'level' ? (
            <div className="own-field">
              <label htmlFor={mapChoiceId} className="own-label">
                Map
              </label>
              <select
                id={mapChoiceId}
                className="own-input"
                data-testid="level-map"
                value={mapId}
                onChange={(event) => {
                  setMapId(event.target.value);
                }}
              >
                {mode.maps.map((map) => (
                  <option key={map.id} value={map.id}>
                    {map.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="own-field">
            <label htmlFor={mapNameId} className="own-label">
              {text.mapLabel}
            </label>
            <input
              ref={mode.kind === 'game' ? undefined : firstRef}
              id={mapNameId}
              className="own-input"
              maxLength={100}
              autoComplete="off"
              placeholder={text.mapPlaceholder}
              data-testid="new-map-name"
              value={mapName}
              onChange={(event) => {
                setMapName(event.target.value);
                setProblem(null);
              }}
            />
          </div>
          <div className="own-field">
            <span className="own-label">Picture</span>
            <div className="own-game-picture" data-testid="picture-chosen">
              {picture ? (
                <span className="own-game-picture-text">
                  <span className="own-game-picture-name">{picture.fileName}</span>
                  <span className="own-game-picture-detail">
                    {numberFormat.format(picture.width)} × {numberFormat.format(picture.height)}{' '}
                    pixels · {picture.format.toUpperCase()} · {formatBytes(picture.bytes)}
                    {picture.problem
                      ? ''
                      : ` · ${picture.levels} levels of detail, ${numberFormat.format(picture.tiles)} map images`}
                  </span>
                </span>
              ) : (
                <span className="own-game-picture-text own-game-picture-none">
                  PNG, JPEG or WebP, up to 268 million pixels (16,384 × 16,384)
                </span>
              )}
              <button
                type="button"
                className="own-pill-button"
                data-testid="choose-picture"
                disabled={picking}
                onClick={() => void choose()}
              >
                <UiIcon name="image" size={18} strokeWidth={1.8} />
                {picture ? 'Another picture…' : 'Choose a picture…'}
              </button>
            </div>
            {picture?.problem ? (
              <p className="own-problem" role="alert" data-testid="picture-problem">
                {picture.problem}
              </p>
            ) : null}
          </div>
        </fieldset>
        {problem && problem !== picture?.problem ? (
          <p className="own-problem" role="alert" data-testid="picture-dialog-problem">
            {problem}
          </p>
        ) : null}
        {running ? (
          <CutProgressView
            progress={progress}
            onCancel={() => {
              void cancelCut();
            }}
          />
        ) : (
          <footer className="own-dialog-foot">
            <span className="own-space" />
            <button type="button" className="own-pill-button" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="own-pill-button own-pill-primary"
              data-testid="picture-make"
              disabled={picture?.problem != null}
            >
              {text.make}
            </button>
          </footer>
        )}
      </form>
    </dialog>
  );
}

function CutProgressView({
  progress,
  onCancel,
}: {
  progress: CutJobProgress | null;
  onCancel: () => void;
}) {
  const done = progress?.tilesDone ?? 0;
  const total = progress?.tilesTotal ?? 0;
  const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
  const line = progress?.cancelling
    ? 'Stopping. Nothing that was made is kept…'
    : !progress || progress.reading || total === 0
      ? 'Reading the picture…'
      : `Cutting the map: ${numberFormat.format(done)} of ${numberFormat.format(total)} map images (${percent}%)`;
  return (
    <div className="own-game-progress" data-testid="cut-progress">
      <p className="own-dialog-line" role="status" aria-live="polite">
        {line}
      </p>
      <div
        className="touch-meter"
        role="progressbar"
        aria-label="Making the map"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span className="touch-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <footer className="own-dialog-foot">
        <span className="own-space" />
        <button
          type="button"
          className="own-pill-button"
          data-testid="cut-cancel"
          disabled={progress?.cancelling === true}
          onClick={onCancel}
        >
          Cancel
        </button>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A game made in the app, on its row of the Games screen

/** The maps of a game, for its row: from the game shown, or none when another is. */
function useMapsOf(gameId: string): { id: string; name: string }[] {
  return useAtlas((s) => (s.game?.entry.id === gameId ? s.game.pack.data.maps : EMPTY_MAPS)).map(
    (map) => ({ id: map.id, name: map.name }),
  );
}

const EMPTY_MAPS: { id: string; name: string }[] = [];

export function OwnGameActions({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState<'map' | 'level' | 'rename' | 'delete-map' | null>(null);
  const maps = useMapsOf(id);
  const shown = useAtlas((s) => s.game?.entry.id === id);
  return (
    <>
      <div className="touch-game-actions own-game-actions" data-testid="own-game-actions">
        <button
          type="button"
          className="touch-text-button"
          data-testid="add-map"
          onClick={() => {
            setOpen('map');
          }}
        >
          Add map…
        </button>
        {shown && maps.length > 0 ? (
          <button
            type="button"
            className="touch-text-button"
            data-testid="add-level"
            onClick={() => {
              setOpen('level');
            }}
          >
            Add level…
          </button>
        ) : null}
        <button
          type="button"
          className="touch-text-button"
          aria-expanded={open === 'rename'}
          data-testid="rename-game"
          onClick={() => {
            setOpen(open === 'rename' ? null : 'rename');
          }}
        >
          Rename…
        </button>
        {shown && maps.length > 1 ? (
          <button
            type="button"
            className="touch-text-button touch-text-button-danger"
            aria-expanded={open === 'delete-map'}
            data-testid="delete-map"
            onClick={() => {
              setOpen(open === 'delete-map' ? null : 'delete-map');
            }}
          >
            Delete map…
          </button>
        ) : null}
      </div>
      {open === 'map' || open === 'level' ? (
        <PictureDialog
          mode={
            open === 'map'
              ? { kind: 'map', gameId: id, title }
              : { kind: 'level', gameId: id, title, maps }
          }
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open === 'rename' ? (
        <RenameForm
          id={id}
          title={title}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
      {open === 'delete-map' ? (
        <DeleteMapConfirm
          id={id}
          maps={maps}
          onClose={() => {
            setOpen(null);
          }}
        />
      ) : null}
    </>
  );
}

function RenameForm({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [name, setName] = useState(title);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.select();
  }, []);
  return (
    <form
      className="touch-game-confirm own-game-form"
      data-testid="rename-game-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) {
          setProblem('Give the game a name.');
          return;
        }
        setWorking(true);
        void renameOwnGame(id, name).then((error) => {
          setWorking(false);
          if (error) setProblem(error);
          else onClose();
        });
      }}
    >
      <label htmlFor={inputId} className="own-label">
        New name of {title}
      </label>
      <div className="own-game-form-row">
        <input
          ref={ref}
          id={inputId}
          className="own-input"
          maxLength={100}
          data-testid="rename-game-input"
          value={name}
          disabled={working}
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
        <button
          type="submit"
          className="own-pill-button own-pill-primary"
          data-testid="rename-game-save"
          disabled={working}
        >
          Rename
        </button>
        <button type="button" className="own-pill-button" disabled={working} onClick={onClose}>
          Cancel
        </button>
      </div>
      {problem ? (
        <p className="own-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

function DeleteMapConfirm({
  id,
  maps,
  onClose,
}: {
  id: string;
  maps: { id: string; name: string }[];
  onClose: () => void;
}) {
  const [mapId, setMapId] = useState(maps.at(-1)?.id ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const selectId = useId();
  const map = maps.find((m) => m.id === mapId);
  return (
    <div
      className="touch-game-confirm own-game-form"
      role="group"
      aria-label="Delete a map"
      data-testid="delete-map-confirm"
    >
      <label htmlFor={selectId} className="own-label">
        Map to delete
      </label>
      <select
        id={selectId}
        className="own-input"
        data-testid="delete-map-choice"
        value={mapId}
        disabled={working}
        onChange={(event) => {
          setMapId(event.target.value);
        }}
      >
        {maps.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <p className="removal-detail">
        {map ? map.name : 'The map'}, all its levels and their map images are deleted, with your own
        locations and areas on it. This cannot be undone.
      </p>
      <div className="own-game-form-row">
        <button
          type="button"
          className="own-pill-button own-pill-danger"
          data-testid="confirm-delete-map"
          disabled={working || !map}
          onClick={() => {
            if (!map) return;
            setWorking(true);
            void deleteOwnMap(id, map.id, map.name).then((error) => {
              setWorking(false);
              if (error) setProblem(error);
              else onClose();
            });
          }}
        >
          {working ? 'Deleting…' : 'Delete map'}
        </button>
        <button type="button" className="own-pill-button" disabled={working} onClick={onClose}>
          Keep it
        </button>
      </div>
      {problem ? (
        <p className="own-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
