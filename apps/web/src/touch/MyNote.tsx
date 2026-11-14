import { isOwnId, type Photo, type Picture } from '@atlas/schema';
import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { PhotoStrip } from '../components/Photos';
import { notify } from '../state/actions';
import {
  addOwnPhoto,
  canChangeOwnLocations,
  changeOwn,
  removeOwnPhoto,
  setOwnPhotoSpoiler,
  undoOwnChange,
  useOwnLocations,
} from '../state/ownLocations';
import {
  deleteNote,
  saveNote,
  setNoteDraftPictures,
  useNotesShown,
  useOwnNotes,
  whyNotesCannotChange,
} from '../state/ownNotes';
import { sweepOwnPicturesLater } from '../state/ownPictures';
import type { LoadedGame } from '../state/store';
import { PhotosField } from './editor/PhotosField';
import { useAddPhoto } from './editor/useAddPhoto';

/** The longest note, as the notes file allows. */
const MAX_NOTE_CHARS = 20_000;

/**
 * "My note" at the top of a location's card: the person's own note on the
 * location, in Markdown, with photos; "Add a note" when there is none. It
 * is written in place on the card. The note of a location of the game is
 * kept with their notes (see `ownNotes.ts`); the note of a location of
 * their own is the one kept with that location (see `ownLocations.ts`).
 */
export function MyNote({ game, locationId }: { game: LoadedGame; locationId: string }) {
  return isOwnId(locationId) ? (
    <OwnLocationNote game={game} locationId={locationId} />
  ) : (
    <GameLocationNote game={game} locationId={locationId} />
  );
}

/** The note of a location of the game, from the person's notes. */
function GameLocationNote({ game, locationId }: { game: LoadedGame; locationId: string }) {
  const shown = useNotesShown(game).byLocation.get(locationId);
  const status = useOwnNotes((s) => (s.gameId === game.pack.manifest.gameId ? s.status : 'idle'));
  const why = useOwnNotes((s) => whyNotesCannotChange(s));
  const location = game.pack.locations.get(locationId)!;
  if (status === 'idle' || status === 'loading') return null;
  const note = shown?.note;
  return (
    <NoteCard
      game={game}
      name={location.name}
      text={note?.text ?? ''}
      photos={note?.photos}
      has={note !== undefined}
      cannot={why}
      onSave={(text, photos) => saveNote(game, location, { text, photos })}
      onDelete={() => {
        if (shown) deleteNote(shown.keptAs, location.name);
      }}
      photoControls="draft"
    />
  );
}

/** The note of a location of the person's own, kept with the location. */
function OwnLocationNote({ game, locationId }: { game: LoadedGame; locationId: string }) {
  const own = useOwnLocations((s) => s.own.locations.find((l) => l.id === locationId));
  const ready = useOwnLocations((s) => canChangeOwnLocations(s));
  const readOnly = useOwnLocations((s) => s.readOnly);
  if (!own) return null;
  const text = own.note ?? '';
  return (
    <NoteCard
      game={game}
      name={own.name}
      text={text}
      // Its photos are the location's, shown at the top of the card.
      photos={undefined}
      has={text.trim() !== ''}
      cannot={
        ready ? null : (readOnly ?? 'Your locations cannot be changed now. Try again in a moment.')
      }
      onSave={(next) => {
        if (next === text) return false;
        changeOwn(own.id, { note: next.trim() ? next : '' }, 'Note changed');
        return true;
      }}
      onDelete={() => {
        changeOwn(own.id, { note: '' }, `Deleted your note on “${own.name}”`);
        notify(`Deleted your note on “${own.name}”`, 'info', {
          action: {
            label: 'Undo',
            run: () => {
              if (undoOwnChange()) notify('Undone: deleted your note');
            },
          },
        });
      }}
      photoControls={{
        photos: own.photos,
        add: (picture) => addOwnPhoto(own.id, picture),
        remove: (pictureId) => removeOwnPhoto(own.id, pictureId),
        spoiler: (pictureId, spoiler) => setOwnPhotoSpoiler(own.id, pictureId, spoiler),
      }}
    />
  );
}

/** Photos changed at once, as those of a location of the person's own are. */
interface DirectPhotos {
  photos: readonly Photo[] | undefined;
  add: (picture: Picture) => void;
  remove: (pictureId: string) => void;
  spoiler: (pictureId: string, spoiler: boolean) => void;
}

function NoteCard({
  game,
  name,
  text,
  photos,
  has,
  cannot,
  onSave,
  onDelete,
  photoControls,
}: {
  game: LoadedGame;
  name: string;
  text: string;
  photos: readonly Photo[] | undefined;
  has: boolean;
  /** Why the note cannot be written now, or null. */
  cannot: string | null;
  /** Saves the note as written; whether anything changed. */
  onSave: (text: string, photos: readonly Photo[]) => boolean;
  onDelete: () => void;
  /** "draft": photos are kept with the note when it is saved; otherwise changed at once. */
  photoControls: 'draft' | DirectPhotos;
}) {
  const [editing, setEditing] = useState(false);
  const headingId = useId();
  const startRef = useRef<HTMLButtonElement>(null);
  // After writing or deleting, the focus goes back to the button that started it.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!editing && returnFocus.current) {
      returnFocus.current = false;
      startRef.current?.focus();
    }
  });
  const close = () => {
    returnFocus.current = true;
    setEditing(false);
  };

  if (editing) {
    return (
      <section
        className="place-note place-note-editing"
        aria-labelledby={headingId}
        data-testid="my-note"
        data-editing=""
      >
        <h3 className="place-note-heading" id={headingId}>
          My note
        </h3>
        <NoteEditor
          game={game}
          name={name}
          text={text}
          photos={photos}
          photoControls={photoControls}
          onSave={(next, nextPhotos) => {
            onSave(next, nextPhotos);
            close();
          }}
          onCancel={close}
        />
      </section>
    );
  }

  if (!has) {
    return (
      <section
        className="place-note place-note-empty"
        aria-labelledby={headingId}
        data-testid="my-note"
      >
        <h3 className="visually-hidden" id={headingId}>
          My note
        </h3>
        {cannot ? (
          <p className="muted small-text place-note-why">{cannot}</p>
        ) : (
          <button
            ref={startRef}
            type="button"
            className="touch-text-button place-note-add"
            data-testid="add-note"
            onClick={() => {
              setEditing(true);
            }}
          >
            <UiIcon name="pencil" size={18} />
            Add a note
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="place-note" aria-labelledby={headingId} data-testid="my-note">
      <div className="place-note-head">
        <h3 className="place-note-heading" id={headingId}>
          My note
        </h3>
        {cannot ? null : (
          <span className="place-note-actions">
            <button
              ref={startRef}
              type="button"
              className="touch-text-button"
              data-testid="edit-note"
              aria-label="Edit my note"
              onClick={() => {
                setEditing(true);
              }}
            >
              <UiIcon name="pencil" size={16} />
              Edit
            </button>
            <button
              type="button"
              className="touch-text-button place-note-delete"
              data-testid="delete-note"
              aria-label="Delete my note"
              onClick={() => {
                returnFocus.current = true;
                onDelete();
              }}
            >
              <UiIcon name="trash" size={16} />
              Delete
            </button>
          </span>
        )}
      </div>
      {text.trim() ? <MarkdownBody source={text} className="guide-body place-note-body" /> : null}
      {photos && photos.length > 0 ? (
        <PhotoStrip
          game={game}
          photos={photos}
          name={`${name}, my note`}
          className="place-photos"
        />
      ) : null}
      {cannot ? <p className="muted small-text place-note-why">{cannot}</p> : null}
    </section>
  );
}

function NoteEditor({
  game,
  name,
  text,
  photos,
  photoControls,
  onSave,
  onCancel,
}: {
  game: LoadedGame;
  name: string;
  text: string;
  photos: readonly Photo[] | undefined;
  photoControls: 'draft' | DirectPhotos;
  onSave: (text: string, photos: readonly Photo[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const [draftPhotos, setDraftPhotos] = useState<readonly Photo[]>(photos ?? []);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const direct = photoControls === 'draft' ? null : photoControls;
  const photo = useAddPhoto(game, (picture) => {
    if (direct) {
      direct.add(picture);
      return;
    }
    setDraftPhotos((list) => [...list, { picture: picture.id }]);
    setNoteDraftPictures([...useOwnNotes.getState().draftPictures, picture]);
  });
  useEffect(() => {
    textRef.current?.focus();
  }, []);
  // Photos added and not saved are let go when the note is left unsaved.
  useEffect(
    () => () => {
      if (!direct && useOwnNotes.getState().draftPictures.length > 0) {
        setNoteDraftPictures([]);
        sweepOwnPicturesLater();
      }
    },
    [direct],
  );
  const save = () => {
    onSave(draft, draftPhotos);
  };
  return (
    <form
      className="place-note-form"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          save();
        }
      }}
    >
      <label htmlFor={fieldId} className="visually-hidden">
        My note on {name}
      </label>
      <textarea
        ref={textRef}
        id={fieldId}
        className="own-input locations-note place-note-text"
        data-testid="note-text"
        rows={5}
        maxLength={MAX_NOTE_CHARS}
        placeholder="What you want to remember about this location"
        aria-describedby={hintId}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <p className="muted small-text place-note-hint" id={hintId}>
        Markdown works: **bold**, - lists, and ||a spoiler|| hidden until tapped. Ctrl+Enter saves,
        Esc cancels.
      </p>
      {photo.fileInput}
      <PhotosField
        game={game}
        photos={direct ? direct.photos : draftPhotos}
        name={name}
        busy={photo.busy}
        add={() => {
          void photo.add();
        }}
        onRemove={(pictureId) => {
          if (direct) direct.remove(pictureId);
          else setDraftPhotos((list) => list.filter((p) => p.picture !== pictureId));
        }}
        onSpoiler={(pictureId, spoiler) => {
          if (direct) direct.spoiler(pictureId, spoiler);
          else
            setDraftPhotos((list) =>
              list.map((p) =>
                p.picture === pictureId
                  ? spoiler
                    ? { ...p, spoiler: true }
                    : { picture: p.picture }
                  : p,
              ),
            );
        }}
      />
      <div className="place-note-buttons">
        <button type="submit" className="touch-button touch-button-primary" data-testid="save-note">
          Save
        </button>
        <button type="button" className="touch-button" data-testid="cancel-note" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
