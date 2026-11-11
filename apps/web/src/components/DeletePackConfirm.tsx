import { useEffect, useId, useState } from 'react';
import type { ImagesInfo } from '../desktop';
import { deletePack, loadImagesInfo } from '../state/removal';
import { deletePackDetails } from './removalText';

/**
 * Asks before deleting a pack from the maps folder, saying what goes and
 * roughly how much, and whether a running download is stopped first. It
 * stays open with a plain explanation when the delete fails.
 */
export function DeletePackConfirm({
  id,
  title,
  onClose,
}: {
  id: string;
  title: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<ImagesInfo | null>(null);
  const [withProgress, setWithProgress] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void loadImagesInfo(id).then((loaded) => {
      if (current) setInfo(loaded);
    });
    return () => {
      current = false;
    };
  }, [id]);
  return (
    <DeletePackConfirmView
      title={title}
      info={info}
      withProgress={withProgress}
      working={working}
      error={error}
      onWithProgress={setWithProgress}
      onConfirm={() => {
        setWorking(true);
        setError(null);
        void deletePack(id, withProgress).then((outcome) => {
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
export function DeletePackConfirmView({
  title,
  info,
  withProgress,
  working,
  error,
  onWithProgress,
  onConfirm,
  onCancel,
}: {
  title: string;
  info: ImagesInfo | null;
  withProgress: boolean;
  working: boolean;
  error: string | null;
  onWithProgress: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const checkboxId = useId();
  return (
    <div
      className="download-confirm removal-confirm"
      role="group"
      aria-label={`Delete ${title}?`}
      data-testid="delete-pack-confirm"
    >
      <p>
        <strong>Delete {title}?</strong>
      </p>
      {deletePackDetails(title, info).map((line) => (
        <p key={line} className="removal-detail">
          {line}
        </p>
      ))}
      <label htmlFor={checkboxId} className="checkbox-row">
        <input
          id={checkboxId}
          type="checkbox"
          checked={withProgress}
          disabled={working}
          onChange={(event) => {
            onWithProgress(event.target.checked);
          }}
        />{' '}
        Also delete my progress for this game in this app
      </label>
      {error ? (
        <p className="download-error" role="alert" data-testid="delete-error">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-danger"
          data-testid="confirm-delete-pack"
          disabled={working}
          onClick={onConfirm}
        >
          {working ? (info?.downloading ? 'Stopping the download…' : 'Deleting…') : 'Delete'}
        </button>
        <button type="button" className="button" disabled={working} onClick={onCancel}>
          Keep it
        </button>
      </div>
    </div>
  );
}
