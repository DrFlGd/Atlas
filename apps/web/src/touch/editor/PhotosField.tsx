import { MAX_PHOTOS, type Photo } from '@atlas/schema';
import { useId } from 'react';
import { UiIcon } from '../../components/icons';
import { PhotoTile } from '../../components/Photos';
import type { LoadedGame } from '../../state/store';

/** The photos of a step or a location, each with a spoiler switch and Remove. */
export function PhotosField({
  game,
  photos,
  name,
  onRemove,
  onSpoiler,
  busy,
  add,
}: {
  game: LoadedGame;
  photos: readonly Photo[] | undefined;
  name: string;
  onRemove: (pictureId: string) => void;
  onSpoiler: (pictureId: string, spoiler: boolean) => void;
  busy: boolean;
  /** An "Add a photo" button of its own, where there is none in a toolbar. */
  add?: () => void;
}) {
  const labelId = useId();
  const list = photos ?? [];
  if (list.length === 0 && !busy && !add) return null;
  const full = list.length >= MAX_PHOTOS;
  return (
    <div className="own-field editor-photos" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="own-label">
        Photos
      </span>
      {list.length > 0 ? (
        <ul className="editor-photo-list" data-testid="editor-photos">
          {list.map((photo, index) => (
            <li key={photo.picture} className="editor-photo" data-testid="editor-photo">
              <PhotoTile
                game={game}
                photo={{ picture: photo.picture }}
                size="card"
                name={`${name}, photo ${index + 1}`}
              />
              <div className="editor-photo-actions">
                <label className="editor-photo-spoiler">
                  <input
                    type="checkbox"
                    checked={photo.spoiler === true}
                    data-testid="photo-spoiler"
                    onChange={(event) => {
                      onSpoiler(photo.picture, event.target.checked);
                    }}
                  />
                  Spoiler: blurred until tapped
                </label>
                <button
                  type="button"
                  className="own-text-button editor-danger"
                  data-testid="photo-remove"
                  aria-label={`Remove photo ${index + 1}`}
                  onClick={() => {
                    onRemove(photo.picture);
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {busy ? (
        <p className="muted small-text" role="status">
          Adding the photo…
        </p>
      ) : null}
      {add ? (
        <button
          type="button"
          className="own-text-button editor-add-photo"
          data-testid="add-photo"
          disabled={busy || full}
          onClick={add}
        >
          <UiIcon name="image" size={18} strokeWidth={1.8} />
          Add a photo
        </button>
      ) : null}
      {full ? (
        <p className="muted small-text">{MAX_PHOTOS} photos is the most there can be.</p>
      ) : null}
    </div>
  );
}
