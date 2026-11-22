import { useId } from 'react';
import {
  downloadText,
  installText,
  installUpdate,
  notesParts,
  skipUpdate,
  updateLater,
  useUpdates,
  type FoundUpdate,
  type UpdatesView,
} from '../state/updates';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/**
 * The notice of a new version of Atlas (see `state/updates.ts`): in a
 * corner, covering nothing, with the new version, what is new in it, and
 * "Install now", "Later" and "Skip this version". While it installs, it
 * shows the download's progress; when that does not work, why.
 */
export function UpdateNotice() {
  const view = useUpdates();
  const platform = useAtlas((s) => s.app?.platform);
  const found = view.found;
  if (!view.notice || found?.state !== 'available') return null;
  return (
    <UpdateNoticeView
      found={found}
      view={view}
      platform={platform}
      onInstall={() => {
        void installUpdate();
      }}
      onLater={updateLater}
      onSkip={skipUpdate}
    />
  );
}

/** The notice as it looks, for the given state; exported for tests. */
export function UpdateNoticeView({
  found,
  view,
  platform,
  onInstall,
  onLater,
  onSkip,
}: {
  found: FoundUpdate;
  view: Pick<UpdatesView, 'phase' | 'received' | 'total' | 'installProblem'>;
  platform: string | undefined;
  onInstall: () => void;
  onLater: () => void;
  onSkip: () => void;
}) {
  const titleId = useId();
  const notes = notesParts(found.notes);
  const busy = view.phase === 'downloading' || view.phase === 'installing';
  const percent =
    view.total && view.total > 0 ? Math.min(100, (view.received / view.total) * 100) : null;
  return (
    <section
      className="update-notice"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      data-testid="update-notice"
    >
      <h2 id={titleId} className="update-notice-title">
        Atlas {found.version} is available
      </h2>
      <p className="muted small">You have Atlas {found.current}.</p>
      {notes.length > 0 ? (
        <div className="update-notes" data-testid="update-notes">
          <h3>What’s new</h3>
          <Notes notes={notes} />
        </div>
      ) : null}
      {view.phase === 'downloading' ? (
        <div className="update-progress" data-testid="update-progress">
          <div
            className="update-progress-bar"
            role="progressbar"
            aria-label="Downloading the update"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent === null ? {} : { 'aria-valuenow': Math.floor(percent) })}
          >
            <span style={{ width: `${percent ?? 5}%` }} />
          </div>
          <p className="small" aria-live="polite">
            {downloadText(view.received, view.total)}
          </p>
        </div>
      ) : view.phase === 'installing' ? (
        <p className="small" aria-live="polite" data-testid="update-installing">
          Installing… Atlas starts again in a moment.
        </p>
      ) : (
        <p className="muted small">{installText(platform)}</p>
      )}
      {view.installProblem ? (
        <p className="small" role="alert" data-testid="update-problem">
          {view.installProblem}
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary button-small"
          data-testid="update-install"
          disabled={busy}
          onClick={onInstall}
        >
          <UiIcon name="download" size={16} />
          {view.phase === 'failed' ? 'Try again' : 'Install now'}
        </button>
        <button
          type="button"
          className="button button-small"
          data-testid="update-later"
          disabled={busy}
          onClick={onLater}
        >
          Later
        </button>
        <button
          type="button"
          className="button button-small"
          data-testid="update-skip"
          disabled={busy}
          onClick={onSkip}
        >
          Skip this version
        </button>
      </div>
    </section>
  );
}

function Notes({ notes }: { notes: ReturnType<typeof notesParts> }) {
  // Items next to each other make one list.
  const groups: { kind: 'text' | 'item'; texts: string[] }[] = [];
  for (const part of notes) {
    const last = groups.at(-1);
    if (part.kind === 'item' && last?.kind === 'item') last.texts.push(part.text);
    else groups.push({ kind: part.kind, texts: [part.text] });
  }
  return (
    <>
      {groups.map((group, index) =>
        group.kind === 'item' ? (
          <ul key={index}>
            {group.texts.map((text, item) => (
              <li key={item}>{text}</li>
            ))}
          </ul>
        ) : (
          <p key={index}>{group.texts[0]}</p>
        ),
      )}
    </>
  );
}
