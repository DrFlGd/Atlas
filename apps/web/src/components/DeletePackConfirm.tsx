import { useEffect, useId, useState } from 'react';
import type { ImagesInfo } from '../desktop';
import type { GameKind } from '../state/gameFacts';
import { useTitleOf } from '../state/gameGroups';
import { deletePack, loadImagesInfo } from '../state/removal';
import { usePackKind, useWikiSite } from './packKind';
import { deletePackDetails, deletePackQuestion, onlyThisText, siteMemoryText } from './removalText';

/**
 * Asks before deleting a pack from the maps folder, named for what it is
 * (a wiki, maps, a game made here), saying that only it goes, what goes
 * with it and roughly how much, and whether a running download is stopped
 * first; for a wiki, what this app forgets of its site. It stays open with
 * a plain explanation when the delete fails.
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
  const [withLists, setWithLists] = useState(false);
  const [withLocations, setWithLocations] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useTitleOf(id);
  const kind = usePackKind(id);
  const site = useWikiSite(id, kind);
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
      kind={kind}
      site={site}
      inTitle={group?.title}
      withProgress={withProgress}
      working={working}
      error={error}
      onWithProgress={setWithProgress}
      withLists={withLists}
      onWithLists={setWithLists}
      withLocations={withLocations}
      onWithLocations={setWithLocations}
      onConfirm={() => {
        setWorking(true);
        setError(null);
        void deletePack(id, withProgress, withLists, withLocations).then((outcome) => {
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
  kind = 'maps',
  site,
  withProgress,
  working,
  error,
  onWithProgress,
  withLists = false,
  onWithLists,
  withLocations = false,
  onWithLocations,
  onConfirm,
  onCancel,
  inTitle,
}: {
  title: string;
  info: ImagesInfo | null;
  /** What it is: the question and what goes are named for it. */
  kind?: GameKind;
  /** For a wiki, the site this app forgets (see {@link siteMemoryText}). */
  site?: { key: string; shared: boolean } | null | undefined;
  /** The title the game is shown under with other games, if any. */
  inTitle?: string | undefined;
  withProgress: boolean;
  working: boolean;
  error: string | null;
  onWithProgress: (checked: boolean) => void;
  /** The person's own lists of the game, kept beside the pack; offered when this is given. */
  withLists?: boolean;
  onWithLists?: (checked: boolean) => void;
  /**
   * The person's own locations, types and areas of the game, and their
   * notes on its locations; offered when this is given.
   */
  withLocations?: boolean;
  onWithLocations?: (checked: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const checkboxId = useId();
  const listsId = useId();
  const locationsId = useId();
  const question = deletePackQuestion(title, kind);
  const memory = kind === 'wiki' ? siteMemoryText(site) : null;
  const what = kind === 'wiki' ? 'this wiki' : 'this game';
  return (
    <div
      className="download-confirm removal-confirm"
      role="group"
      aria-label={question}
      data-testid="delete-pack-confirm"
      data-kind={kind}
    >
      <p>
        <strong>{question}</strong>
      </p>
      {deletePackDetails(title, info, kind).map((line) => (
        <p key={line} className="removal-detail">
          {line}
        </p>
      ))}
      <p
        className="removal-detail"
        data-testid={inTitle ? 'delete-pack-title' : 'delete-pack-only'}
      >
        {onlyThisText(kind, inTitle)}
      </p>
      {memory ? (
        <p className="removal-detail" data-testid="delete-pack-site">
          {memory}
        </p>
      ) : null}
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
        Also delete my progress for {what} in this app
      </label>
      {onWithLists ? (
        <label htmlFor={listsId} className="checkbox-row">
          <input
            id={listsId}
            type="checkbox"
            checked={withLists}
            disabled={working}
            data-testid="delete-pack-lists"
            onChange={(event) => {
              onWithLists(event.target.checked);
            }}
          />{' '}
          Also delete my lists, guides, guide links and pages for {what}
        </label>
      ) : null}
      {onWithLocations ? (
        <label htmlFor={locationsId} className="checkbox-row">
          <input
            id={locationsId}
            type="checkbox"
            checked={withLocations}
            disabled={working}
            data-testid="delete-pack-locations"
            onChange={(event) => {
              onWithLocations(event.target.checked);
            }}
          />{' '}
          Also delete my locations, types and notes for {what}
        </label>
      ) : null}
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
          Cancel
        </button>
      </div>
    </div>
  );
}
