import type { LoadedPack } from '@atlas/core';
import { isOwnId, type Photo, type Picture } from '@atlas/schema';
import { useEffect, useId, useRef, useState } from 'react';
import { create } from 'zustand';
import { useOwnLists } from '../state/ownLists';
import { useOwnLocations } from '../state/ownLocations';
import { useOwnPictureUrl } from '../state/ownPictures';
import { useAtlas, type LoadedGame } from '../state/store';
import { UiIcon } from './icons';

/**
 * Photos of locations and of list entries: pictures of the pack, or a
 * person's own. A pack's picture is shown from the pack's own files only,
 * never from the address it may be fetched from later, so one not
 * downloaded shows a quiet mark instead. A spoiler photo stays blurred
 * until it is tapped or clicked; then a tap opens it large.
 */

const packPictures = new WeakMap<LoadedPack, Map<string, Picture>>();

/** A picture of the pack, by id. */
function packPicture(pack: LoadedPack, id: string): Picture | undefined {
  let pictures = packPictures.get(pack);
  if (!pictures) {
    pictures = new Map((pack.data.pictures ?? []).map((picture) => [picture.id, picture]));
    packPictures.set(pack, pictures);
  }
  return pictures.get(id) ?? pictures.get(pack.currentId(id));
}

/** An own picture of the game shown, from its own lists or own locations. */
function useOwnPicture(id: string, own: boolean): Picture | undefined {
  const inLists = useOwnLists((s) => {
    if (!own) return undefined;
    for (const list of s.lists) {
      const found = list.pictures?.find((picture) => picture.id === id);
      if (found) return found;
    }
    return undefined;
  });
  const inLocations = useOwnLocations((s) =>
    own ? s.own.pictures?.find((picture) => picture.id === id) : undefined,
  );
  return inLists ?? inLocations;
}

/** Where a photo is shown from: a URL, null while it is read, or `missing`. */
function usePhotoSource(
  game: LoadedGame,
  id: string,
): { picture: Picture | undefined; url: string | null } {
  const own = isOwnId(id);
  const ownPicture = useOwnPicture(id, own);
  const ownUrl = useOwnPictureUrl(game.pack.manifest.gameId, own ? ownPicture : undefined);
  if (own) return { picture: ownPicture, url: ownUrl };
  const picture = packPicture(game.pack, id);
  return { picture, url: picture ? game.pack.resolveUrl(picture.file) : 'missing' };
}

// ---------------------------------------------------------------------------
// One photo

export type PhotoSize = 'card' | 'strip' | 'cover';

export function PhotoTile({
  game,
  photo,
  size,
  name,
}: {
  game: LoadedGame;
  photo: Photo;
  size: PhotoSize;
  /** What it is a photo of, for its description. */
  name?: string;
}) {
  const { picture, url } = usePhotoSource(game, photo.picture);
  const [revealed, setRevealed] = useState(false);
  // A photo downloaded later is tried again when new images are saved.
  const revision = useAtlas((s) => s.tileRevision);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  const failed = failedAt === revision;
  const hidden = photo.spoiler === true && !revealed;
  const description = picture?.caption ?? (name ? `Photo of ${name}` : 'Photo');
  const ratio =
    picture?.width && picture.height ? `${picture.width} / ${picture.height}` : undefined;

  if (url === null) {
    return (
      <div className={`photo photo-size-${size} photo-loading`} style={{ aspectRatio: ratio }} />
    );
  }
  if (url === 'missing' || failed) {
    return (
      <div
        className={`photo photo-size-${size} photo-missing`}
        style={{ aspectRatio: ratio }}
        data-testid="photo-missing"
      >
        <UiIcon name="image" size={18} />
        <span>{picture?.remote ? 'Photo not downloaded' : 'Photo not found'}</span>
      </div>
    );
  }
  return (
    <figure
      className={`photo photo-size-${size}`}
      data-testid="photo"
      data-spoiler={photo.spoiler ? (hidden ? 'hidden' : 'shown') : undefined}
    >
      <button
        type="button"
        className="photo-button"
        aria-label={hidden ? 'Spoiler photo: show it' : `Open ${description}`}
        onClick={(event) => {
          event.stopPropagation();
          if (hidden) setRevealed(true);
          else openPhoto({ url, description, picture });
        }}
      >
        <img
          key={failedAt === null ? 'shown' : revision}
          src={url}
          alt={hidden ? '' : description}
          loading="lazy"
          decoding="async"
          draggable={false}
          width={picture?.width}
          height={picture?.height}
          onError={() => {
            setFailedAt(revision);
          }}
          onLoad={() => {
            if (failedAt !== null) setFailedAt(null);
          }}
        />
        {hidden ? (
          <span className="photo-spoiler-label">
            <UiIcon name="eyeOff" size={18} />
            Spoiler · show photo
          </span>
        ) : null}
      </button>
    </figure>
  );
}

/** The photos of a location or an entry, one after another. */
export function PhotoStrip({
  game,
  photos,
  name,
  size = 'strip',
  className,
}: {
  game: LoadedGame;
  photos: readonly Photo[] | undefined;
  name?: string;
  size?: PhotoSize;
  className?: string;
}) {
  if (!photos || photos.length === 0) return null;
  return (
    <div
      className={className ? `photo-strip ${className}` : 'photo-strip'}
      data-testid="photo-strip"
      data-count={photos.length}
    >
      {photos.map((photo) => (
        <PhotoTile key={photo.picture} game={game} photo={photo} size={size} name={name} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A photo shown large

interface Shown {
  url: string;
  description: string;
  picture: Picture | undefined;
}

const usePhotoViewer = create<{ shown: Shown | null }>()(() => ({ shown: null }));

function openPhoto(shown: Shown): void {
  usePhotoViewer.setState({ shown });
}

function closePhoto(): void {
  usePhotoViewer.setState({ shown: null });
}

/** The photo opened, large, over everything; Escape, Close or a click beside it closes it. */
export function PhotoViewer() {
  const shown = usePhotoViewer((s) => s.shown);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shown && !dialog.open) dialog.showModal();
    if (!shown && dialog.open) dialog.close();
  }, [shown]);

  const credit = shown?.picture?.credit;
  return (
    <dialog
      ref={ref}
      className="photo-viewer"
      aria-labelledby={titleId}
      data-testid="photo-viewer"
      onClose={closePhoto}
      onClick={(event) => {
        if (event.target === event.currentTarget) closePhoto();
      }}
    >
      {shown ? (
        <figure className="photo-viewer-figure">
          <img src={shown.url} alt={shown.description} />
          <figcaption>
            <span id={titleId}>{shown.description}</span>
            {credit ? <span className="photo-viewer-credit"> · {credit}</span> : null}
          </figcaption>
          <button
            type="button"
            className="photo-viewer-close"
            aria-label="Close photo"
            autoFocus
            onClick={closePhoto}
          >
            <UiIcon name="close" size={20} />
          </button>
        </figure>
      ) : null}
    </dialog>
  );
}
