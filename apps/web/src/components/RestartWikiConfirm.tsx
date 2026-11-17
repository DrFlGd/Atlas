import { useState } from 'react';
import { useTitleOf } from '../state/gameGroups';
import { startWikiAgain } from '../state/importing';
import { deletePack } from '../state/removal';
import { useWikiSite } from './packKind';
import { siteMemoryText } from './removalText';

/**
 * Asks before starting a wiki again from the beginning: what is deleted
 * (the pages read and their pictures, what this app remembers of its
 * site), what is kept (the person's own pages, notes, lists and found
 * marks, and its place under a title), and what happens next. Then the
 * wiki is deleted as "Delete this wiki" does, keeping its place under its
 * title, and the steps of adding open at its start address, asking how its
 * pages are read. Nothing is read until the person chooses.
 */
export function RestartWikiConfirm({
  id,
  title,
  start,
  onClose,
}: {
  id: string;
  title: string;
  /** Where reading it starts: its contents, else the last page read. */
  start: string;
  onClose: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useTitleOf(id);
  const site = useWikiSite(id, 'wiki');
  return (
    <RestartWikiConfirmView
      title={title}
      start={start}
      site={site}
      inTitle={group?.title}
      working={working}
      error={error}
      onConfirm={() => {
        setWorking(true);
        setError(null);
        void deletePack(id, false, false, false, { keepTitle: true }).then(async (outcome) => {
          setWorking(false);
          if (!outcome.ok) {
            setError(outcome.error);
            return;
          }
          onClose();
          await startWikiAgain(start);
        });
      }}
      onCancel={onClose}
    />
  );
}

/** The confirmation itself, without the commands; exported for tests. */
export function RestartWikiConfirmView({
  title,
  start,
  site,
  inTitle,
  working,
  error,
  onConfirm,
  onCancel,
}: {
  title: string;
  start: string;
  site: { key: string; shared: boolean } | null | undefined;
  /** The title the wiki is shown under with other games, if any. */
  inTitle?: string | undefined;
  working: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const question = `Start the wiki ${title} again from the beginning?`;
  const memory = siteMemoryText(site);
  return (
    <div
      className="download-confirm removal-confirm"
      role="group"
      aria-label={question}
      data-testid="restart-wiki-confirm"
    >
      <p>
        <strong>{question}</strong>
      </p>
      <p className="removal-detail">
        This deletes the wiki {title} from the maps folder, with the pages read from it and their
        downloaded pictures. This cannot be undone.
      </p>
      {memory ? (
        <p className="removal-detail" data-testid="restart-wiki-site">
          {memory}
        </p>
      ) : null}
      <p className="removal-detail" data-testid="restart-wiki-kept">
        Your own pages, notes, lists and found marks for this wiki are kept.
        {inTitle
          ? ` It stays under the title ${inTitle} while it is away, so it shows there again once its pages are read again. The other sources of the title stay.`
          : ''}
      </p>
      <p className="removal-detail" data-testid="restart-wiki-next">
        Then the address box holds its start address, {start}, and this app asks how its pages are
        read. Nothing is read until you choose.
      </p>
      {error ? (
        <p className="download-error" role="alert" data-testid="delete-error">
          {error}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-danger"
          data-testid="confirm-restart-wiki"
          disabled={working}
          onClick={onConfirm}
        >
          {working ? 'Deleting…' : 'Start again'}
        </button>
        <button type="button" className="button" disabled={working} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
