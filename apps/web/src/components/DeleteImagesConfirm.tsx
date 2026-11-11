import { useEffect, useState } from 'react';
import type { ImagesInfo } from '../desktop';
import { deleteImages, loadImagesInfo } from '../state/removal';
import { deleteImagesDetails } from './removalText';

/**
 * Asks before deleting the map images downloaded for a pack, saying how
 * many there are and that the pack, its places and progress stay. It stays
 * open with a plain explanation when the delete fails.
 */
export function DeleteImagesConfirm({
  id,
  title,
  onClose,
}: {
  id: string;
  title: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<ImagesInfo | null>(null);
  const [failedToCount, setFailedToCount] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadImagesInfo(id).then((loaded) => {
      if (!current) return;
      setInfo(loaded);
      setFailedToCount(loaded === null);
    });
    return () => {
      current = false;
    };
  }, [id]);
  return (
    <DeleteImagesConfirmView
      title={title}
      info={info}
      working={working}
      error={
        error ??
        (failedToCount
          ? 'Atlas could not look at the map images of this game. Close this and try again.'
          : null)
      }
      onConfirm={() => {
        setWorking(true);
        setError(null);
        void deleteImages(id).then((outcome) => {
          setWorking(false);
          if (outcome.ok) onClose();
          else setError(outcome.error);
        });
      }}
      onCancel={onClose}
    />
  );
}

/** The confirmation itself, without the commands; exported for tests. */
export function DeleteImagesConfirmView({
  title,
  info,
  working,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  info: ImagesInfo | null;
  working: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Nothing to delete, or it could not be counted (`error` says why).
  const counting = info === null && !error;
  const nothing = (info !== null && info.files === 0 && !info.downloading) || (!info && !counting);
  return (
    <div
      className="download-confirm removal-confirm"
      role="group"
      aria-label={`Delete the downloaded map images of ${title}?`}
      data-testid="delete-images-confirm"
    >
      <p>
        <strong>Delete the downloaded map images of {title}?</strong>
      </p>
      {info || counting
        ? deleteImagesDetails(title, info).map((line) => (
            <p key={line} className="removal-detail" aria-busy={counting}>
              {line}
            </p>
          ))
        : null}
      {error ? (
        <p className="download-error" role="alert" data-testid="delete-error">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        {nothing ? null : (
          <button
            type="button"
            className="button button-danger"
            data-testid="confirm-delete-images"
            disabled={working || info === null}
            onClick={onConfirm}
          >
            {working
              ? info?.downloading
                ? 'Stopping the download…'
                : 'Deleting…'
              : 'Delete map images'}
          </button>
        )}
        <button type="button" className="button" disabled={working} onClick={onCancel}>
          {nothing ? 'Close' : 'Keep them'}
        </button>
      </div>
    </div>
  );
}
