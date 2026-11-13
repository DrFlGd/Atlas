import { useEffect, useState } from 'react';
import { downloadPercent, formatBytes, roughDuration } from '../components/downloadFormat';
import { UiIcon } from '../components/icons';
import type { JobEntry } from '../desktop';
import { numberFormat } from '../state/derived';
import { loadDownloadSettings } from '../state/downloads';
import {
  cancelJob,
  endedToday,
  moveJob,
  pauseEverything,
  pauseJob,
  resumeJob,
  retryJob,
  useDownloadsView,
} from '../state/downloadsView';
import { stopRun, useImport, type ImportPhase } from '../state/importing';
import { foundText, stopReasonText, waitingForPerson, type RunState } from '../state/importRun';
import { openSettings, setDownloadsOpen, showLibraryAdd, useLibrary } from '../state/libraryView';
import { useAtlas } from '../state/store';

/**
 * The Downloads panel and the strip under the Library, in an app that
 * downloads: one view over the map image and photo jobs of the shell's
 * single queue and the run of pages being read. Every button says what it
 * does, with a sentence under each group.
 */

const noun = (entry: JobEntry) => (entry.kind === 'photos' ? 'photos' : 'map images');

/** The game's title, without the "Location photos of" the shell puts before a photo job's. */
function gameTitle(entry: JobEntry): string {
  return entry.job.title.replace(/^Location photos of /, '');
}

/** The run of pages being read, when it reads now. */
function runningRun(phase: ImportPhase): RunState | null {
  return (phase.kind === 'run' || phase.kind === 'listing') && phase.run.status === 'running'
    ? phase.run
    : null;
}

/** Of a run, the pages dealt with. */
function runDone(run: RunState): number {
  return run.pages.filter(
    (page) =>
      page.state.kind !== 'waiting' &&
      page.state.kind !== 'open' &&
      page.state.kind !== 'converting',
  ).length;
}

const moves = (entry: JobEntry) =>
  entry.job.state === 'running' || entry.job.state === 'queued' || entry.job.state === 'waiting';

/** The strip at the bottom of the Library: now and next, Pause everything, and All downloads. */
export function DownloadsStrip() {
  const jobs = useDownloadsView((s) => s.jobs);
  const pending = useDownloadsView((s) => s.pending);
  const phase = useImport((s) => s.phase);
  const licence = useImport((s) => s.licenceAsk !== null);
  const open = useLibrary((s) => s.downloads);
  const pane = useLibrary((s) => s.pane);
  const run = runningRun(phase);
  const now = jobs.find((entry) => entry.job.state === 'running');
  const next = jobs.find((entry) => entry.job.state === 'queued' || entry.job.state === 'waiting');
  const stopped = jobs.filter((entry) => entry.job.state === 'stopped').length;
  let text: string;
  let share: number | null = null;
  if (run) {
    const done = runDone(run);
    const found = foundText(run);
    text = `Reading page ${Math.min(done + 1, run.pages.length)} of ${run.pages.length}${found ? `, ${found}` : ''}${run.stopRequested ? ', stopping after this page' : ''}${waitingForPerson(run) ? '. The page window is waiting for you' : ''}${licence ? '. A page waits for you to confirm the wiki’s licence' : ''}`;
    share = done / Math.max(1, run.pages.length);
  } else if (licence) {
    text = 'A page waits for you to confirm the wiki’s licence.';
  } else if (now) {
    text = `Downloading ${noun(now)} of ${gameTitle(now)}, ${downloadPercent(now.job)}%`;
    share = now.job.done / Math.max(1, now.job.total);
  } else {
    text = 'Nothing is downloading or being read.';
  }
  return (
    <footer className="library-strip" data-testid="library-strip" aria-label="Downloads now">
      <span className="library-strip-now" data-testid="library-strip-now">
        <strong>Now:</strong> {text}
      </span>
      {share !== null ? (
        <span className="meter meter-small library-strip-meter" aria-hidden="true">
          <span className="meter-fill" style={{ width: `${share * 100}%` }} />
        </span>
      ) : null}
      {next ? (
        <span className="library-strip-next muted">
          Next: {noun(next)} of {gameTitle(next)}
        </span>
      ) : null}
      {stopped > 0 ? (
        <span className="library-status-problem">
          {stopped === 1 ? 'A download needs you' : `${stopped} downloads need you`}
        </span>
      ) : null}
      <span className="library-strip-space" />
      {run && pane !== 'add' ? (
        <button
          type="button"
          className="button button-small"
          title="Shows the pages being read, each with its state"
          onClick={showLibraryAdd}
        >
          See the pages
        </button>
      ) : null}
      {run || jobs.some(moves) ? (
        <button
          type="button"
          className="button button-small"
          data-testid="pause-everything"
          disabled={pending}
          title="Pauses every download and stops reading pages after the page open now"
          onClick={() => void pauseEverything()}
        >
          <UiIcon name="pause" size={14} />
          Pause everything
        </button>
      ) : null}
      <button
        type="button"
        className="button button-small"
        aria-expanded={open}
        data-testid="all-downloads"
        title="Every download: now, next, those that need you and those done today"
        onClick={() => {
          setDownloadsOpen(!open);
        }}
      >
        All downloads
      </button>
    </footer>
  );
}

/** The Downloads panel: now, next in order, needs you, done today. */
export function DownloadsPanel() {
  const jobs = useDownloadsView((s) => s.jobs);
  const pending = useDownloadsView((s) => s.pending);
  const phase = useImport((s) => s.phase);
  const settings = useAtlas((s) => s.downloads.settings?.settings ?? null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  useEffect(() => {
    void loadDownloadSettings();
  }, []);
  const run = runningRun(phase);
  const now = jobs.filter((entry) => entry.job.state === 'running');
  const next = jobs.filter(
    (entry) =>
      entry.job.state === 'queued' || entry.job.state === 'waiting' || entry.job.state === 'paused',
  );
  const queued = next.filter((entry) => entry.job.state === 'queued');
  const stopped = jobs.filter((entry) => entry.job.state === 'stopped');
  const runStopped =
    phase.kind === 'run' &&
    phase.run.status === 'stopped' &&
    (phase.run.stopReason === 'refused' || phase.run.stopReason === 'no-data')
      ? phase.run.stopReason
      : null;
  const today = jobs.filter(
    (entry) => (entry.job.state === 'done' || entry.job.state === 'cancelled') && endedToday(entry),
  );
  const anything =
    run !== null || now.length + next.length + stopped.length + today.length > 0 || runStopped;

  const stop = (entry: JobEntry) =>
    cancelling === entry.key ? (
      <span className="library-confirm-inline" role="group" aria-label="Stop the download?">
        <span>Stop it? What came so far is kept.</span>
        <button
          type="button"
          className="button button-small button-danger"
          data-testid="downloads-stop-confirm"
          disabled={pending}
          onClick={() => {
            setCancelling(null);
            void cancelJob(entry);
          }}
        >
          Stop
        </button>
        <button
          type="button"
          className="button button-small"
          onClick={() => {
            setCancelling(null);
          }}
        >
          Keep it
        </button>
      </span>
    ) : null;

  return (
    <section className="library-downloads" aria-label="Downloads" data-testid="downloads-panel">
      <header className="library-downloads-head">
        <h2>Downloads</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close Downloads"
          title="Close Downloads; nothing stops"
          onClick={() => {
            setDownloadsOpen(false);
          }}
        >
          <UiIcon name="close" size={16} />
        </button>
      </header>
      <div className="library-downloads-body">
        {!anything ? (
          <p className="muted" data-testid="downloads-empty">
            Nothing is downloading, nothing waits its turn, and nothing was done today.
          </p>
        ) : null}

        {run || now.length > 0 ? (
          <section className="library-downloads-group" data-testid="downloads-now">
            <h3>Now</h3>
            {run ? (
              <div className="library-job" data-kind="pages">
                <span className="library-job-title">
                  Reading pages: {Math.min(runDone(run) + 1, run.pages.length)} of{' '}
                  {run.pages.length}
                </span>
                <span className="meter meter-small" aria-hidden="true">
                  <span
                    className="meter-fill"
                    style={{ width: `${(runDone(run) / Math.max(1, run.pages.length)) * 100}%` }}
                  />
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="button button-small"
                    disabled={run.stopRequested}
                    onClick={stopRun}
                  >
                    Stop
                  </button>
                </span>
              </div>
            ) : null}
            {now.map((entry) => (
              <div
                key={entry.key}
                className="library-job"
                data-testid="downloads-job"
                data-key={entry.key}
              >
                <span className="library-job-title">
                  {noun(entry) === 'photos' ? 'Location photos' : 'Map images'} of{' '}
                  {gameTitle(entry)}
                </span>
                <span className="muted small">
                  {numberFormat.format(entry.job.done)} of {numberFormat.format(entry.job.total)},{' '}
                  {downloadPercent(entry.job)}%
                  {entry.job.secondsLeft !== null
                    ? `, ${roughDuration(entry.job.secondsLeft)} left`
                    : ''}
                </span>
                <span className="meter meter-small" aria-hidden="true">
                  <span
                    className="meter-fill"
                    style={{ width: `${(entry.job.done / Math.max(1, entry.job.total)) * 100}%` }}
                  />
                </span>
                {stop(entry) ?? (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="downloads-pause"
                      disabled={pending}
                      onClick={() => void pauseJob(entry)}
                    >
                      Pause
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      data-testid="downloads-stop"
                      onClick={() => {
                        setCancelling(entry.key);
                      }}
                    >
                      Stop
                    </button>
                  </span>
                )}
              </div>
            ))}
            <p className="library-card-note">
              Pause holds a download where it is, to resume later. Stop ends it and keeps what came;
              reading pages stops after the page open now.
            </p>
          </section>
        ) : null}

        {next.length > 0 ? (
          <section className="library-downloads-group" data-testid="downloads-next">
            <h3>Next, in this order</h3>
            <ol className="library-job-list">
              {next.map((entry) => {
                const at = queued.indexOf(entry);
                return (
                  <li
                    key={entry.key}
                    className="library-job"
                    data-testid="downloads-job"
                    data-key={entry.key}
                    data-state={entry.job.state}
                  >
                    <span className="library-job-title">
                      {noun(entry) === 'photos' ? 'Location photos' : 'Map images'} of{' '}
                      {gameTitle(entry)}
                    </span>
                    <span className="muted small">
                      {entry.job.state === 'paused'
                        ? `Paused at ${downloadPercent(entry.job)}%`
                        : entry.job.state === 'waiting'
                          ? 'Waiting for another Atlas app on this computer'
                          : 'Waiting its turn'}
                    </span>
                    {stop(entry) ?? (
                      <span className="row-actions">
                        {entry.job.state === 'queued' ? (
                          <>
                            <button
                              type="button"
                              className="button button-small"
                              aria-label={`Move ${gameTitle(entry)} earlier`}
                              data-testid="downloads-earlier"
                              disabled={pending || at <= 0}
                              onClick={() => void moveJob(entry, true)}
                            >
                              Earlier
                            </button>
                            <button
                              type="button"
                              className="button button-small"
                              aria-label={`Move ${gameTitle(entry)} later`}
                              data-testid="downloads-later"
                              disabled={pending || at < 0 || at >= queued.length - 1}
                              onClick={() => void moveJob(entry, false)}
                            >
                              Later
                            </button>
                          </>
                        ) : null}
                        {entry.job.state === 'paused' ? (
                          <button
                            type="button"
                            className="button button-small button-primary"
                            data-testid="downloads-resume"
                            disabled={pending}
                            onClick={() => void resumeJob(entry)}
                          >
                            Resume
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="button button-small"
                          data-testid="downloads-remove"
                          onClick={() => {
                            setCancelling(entry.key);
                          }}
                        >
                          Remove
                        </button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="library-card-note">
              One download runs at a time, in this order. Earlier and Later change the order; Resume
              puts a paused one back in line, at the end; Remove takes it out of the line and keeps
              what it downloaded.
            </p>
          </section>
        ) : null}

        {stopped.length > 0 || runStopped ? (
          <section className="library-downloads-group" data-testid="downloads-needs-you">
            <h3>Needs you</h3>
            {runStopped ? (
              <div className="library-job" data-kind="pages">
                <span className="library-job-title">Reading pages stopped</span>
                <span className="small">{stopReasonText(runStopped)}</span>
                <span className="row-actions">
                  <button type="button" className="button button-small" onClick={showLibraryAdd}>
                    See the pages
                  </button>
                </span>
              </div>
            ) : null}
            {stopped.map((entry) => (
              <div
                key={entry.key}
                className="library-job"
                data-testid="downloads-job"
                data-key={entry.key}
                data-state="stopped"
              >
                <span className="library-job-title">
                  {noun(entry) === 'photos' ? 'Location photos' : 'Map images'} of{' '}
                  {gameTitle(entry)}
                </span>
                <span className="small library-status-problem" data-testid="downloads-reason">
                  {entry.job.reason ?? 'It stopped.'}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="button button-small button-primary"
                    data-testid="downloads-retry"
                    disabled={pending}
                    onClick={() => void retryJob(entry)}
                  >
                    Try again
                  </button>
                </span>
              </div>
            ))}
            <p className="library-card-note">
              Try again starts the same download; only what is missing is fetched. A site that
              refused is not asked again until you press it. The activity log says more.
            </p>
          </section>
        ) : null}

        {today.length > 0 ? (
          <section className="library-downloads-group" data-testid="downloads-today">
            <h3>Done today</h3>
            <ul className="library-job-list">
              {today.map((entry) => (
                <li
                  key={entry.key}
                  className="library-job"
                  data-testid="downloads-job"
                  data-key={entry.key}
                  data-state={entry.job.state}
                >
                  <span className="library-job-title">
                    {noun(entry) === 'photos' ? 'Location photos' : 'Map images'} of{' '}
                    {gameTitle(entry)}
                  </span>
                  <span className="muted small">
                    {entry.job.state === 'cancelled'
                      ? `Stopped, ${numberFormat.format(entry.job.saved)} kept`
                      : `${numberFormat.format(entry.job.saved)} downloaded${entry.job.bytes ? `, ${formatBytes(entry.job.bytes)}` : ''}`}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
      <footer className="library-downloads-foot">
        <span className="muted small" data-testid="downloads-pace">
          {settings
            ? `${settings.parallel === 1 ? 'One request at a time' : `${settings.parallel} requests at a time`}, with a pause of ${(settings.pauseMs / 1000).toLocaleString('en')} s after each. Pages are always read one at a time.`
            : 'Pages are always read one at a time.'}
        </span>
        <span className="row-actions wrap">
          <button
            type="button"
            className="button button-small"
            title="Settings: download speed, the activity log and where maps are saved"
            onClick={() => {
              setDownloadsOpen(false);
              openSettings();
            }}
          >
            Speed and activity log
          </button>
          {run || jobs.some(moves) ? (
            <button
              type="button"
              className="button button-small"
              disabled={pending}
              onClick={() => void pauseEverything()}
            >
              <UiIcon name="pause" size={14} />
              Pause everything
            </button>
          ) : null}
        </span>
      </footer>
    </section>
  );
}
