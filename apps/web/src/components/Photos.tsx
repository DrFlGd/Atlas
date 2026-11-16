import type { LoadedPack } from '@atlas/core';
import { isOwnId, type Photo, type Picture } from '@atlas/schema';
import { useState } from 'react';
import { useOwnLists } from '../state/ownLists';
import { useOwnLocations } from '../state/ownLocations';
import { useOwnNotes } from '../state/ownNotes';
import { useOwnPictureUrl } from '../state/ownPictures';
import { useAtlas, type LoadedGame } from '../state/store';
import { UiIcon } from './icons';
import { openPicture } from '../state/pictureViewer';
import { cardCopyFile } from '../state/photoCopy';

/**
 * Photos of locations and of list entries: pictures of the pack, or a
 * person's own. A pack's picture is shown from the pack's own files only,
 * never from the address it may be fetched from later, so one not
 * downloaded shows a quiet mark instead. A photo with a smaller copy (see
 * `photoCopy.ts`) shows the copy, or its file when the copy is not there,
 * and opens its file large. A spoiler photo stays blurred until it is
 * tapped or clicked; then a tap opens it large (see `PictureViewer.tsx`).
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

/** An own picture of the game shown, from its own lists, own locations or notes. */
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
  // Those of the notes, and of the note being written.
  const inNotes = useOwnNotes((s) =>
    own
      ? (s.own.pictures?.find((picture) => picture.id === id) ??
        s.draftPictures.find((picture) => picture.id === id))
      : undefined,
  );
  return inLists ?? inLocations ?? inNotes;
}

/**
 * Where a photo is shown from: a URL, null while it is read, or `missing`;
 * and for a pack's photo with a smaller copy, the copy's URL.
 */
function usePhotoSource(
  game: LoadedGame,
  id: string,
): { picture: Picture | undefined; url: string | null; copyUrl?: string } {
  const own = isOwnId(id);
  const ownPicture = useOwnPicture(id, own);
  const ownUrl = useOwnPictureUrl(game.pack.manifest.gameId, own ? ownPicture : undefined);
  if (own) return { picture: ownPicture, url: ownUrl };
  const picture = packPicture(game.pack, id);
  if (!picture) return { picture, url: 'missing' };
  const copy = cardCopyFile(picture);
  return {
    picture,
    url: game.pack.resolveUrl(picture.file),
    ...(copy ? { copyUrl: game.pack.resolveUrl(copy) } : {}),
  };
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
  const { picture, url, copyUrl } = usePhotoSource(game, photo.picture);
  const [revealed, setRevealed] = useState(false);
  // A photo downloaded later is tried again when new images are saved.
  const revision = useAtlas((s) => s.tileRevision);
  const [failedAt, setFailedAt] = useState<number | null>(null);
  // Its copy could not be loaded: the file is shown instead.
  const [copyFailedAt, setCopyFailedAt] = useState<number | null>(null);
  const failed = failedAt === revision;
  const shownUrl = copyUrl !== undefined && copyFailedAt !== revision ? copyUrl : url;
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
          else {
            openPicture({
              url,
              ...(shownUrl && shownUrl !== url ? { fallbackUrl: shownUrl } : {}),
              description,
              ...(picture?.credit ? { credit: picture.credit } : {}),
              opener: event.currentTarget,
            });
          }
        }}
      >
        <img
          key={`${shownUrl === url ? 'file' : 'copy'}-${failedAt === null && copyFailedAt === null ? 'shown' : revision}`}
          src={shownUrl ?? url}
          alt={hidden ? '' : description}
          loading="lazy"
          decoding="async"
          draggable={false}
          width={picture?.width}
          height={picture?.height}
          onError={() => {
            if (shownUrl !== url) setCopyFailedAt(revision);
            else setFailedAt(revision);
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
