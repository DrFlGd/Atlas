import type { Picture } from '@atlas/schema';
import { useRef, useState } from 'react';
import { notify } from '../../state/actions';
import { keepPhoto, PHOTO_ACCEPT, pickPhoto, shrinkPhoto } from '../../state/ownPictures';
import type { LoadedGame } from '../../state/store';

/**
 * "Add a photo": asks for a picture (the shell's dialog in the desktop app,
 * a file picker elsewhere), makes it at most about 1280 pixels wide, keeps
 * its file with the person's own data and gives its record. The file input
 * it uses where there is no shell is part of the page, so it is there to
 * use at once.
 */
export function useAddPhoto(game: LoadedGame, onAdded: (picture: Picture) => void) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    if (busy) return;
    let bytes: Uint8Array | null;
    try {
      bytes = await pickPhoto(input.current);
    } catch (error) {
      notify(`Could not open the picture: ${messageOf(error)}`, 'error');
      return;
    }
    if (bytes === null) return;
    if (bytes.length === 0) {
      notify('That picture could not be read, or it is too large.', 'error');
      return;
    }
    setBusy(true);
    try {
      const photo = await shrinkPhoto(bytes);
      const picture = await keepPhoto(game.pack.manifest.gameId, photo);
      onAdded(picture);
    } catch (error) {
      notify(`Could not add the photo: ${messageOf(error)}`, 'error');
    } finally {
      setBusy(false);
    }
  };
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept={PHOTO_ACCEPT}
      hidden
      tabIndex={-1}
      data-testid="photo-file-input"
    />
  );
  return { add, busy, fileInput };
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
