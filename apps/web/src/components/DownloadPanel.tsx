import { isDownloadable } from '@atlas/core';
import { useId, useState } from 'react';
import type { Detail, DetailOption, DownloadPlan, DownloadSnapshot, StopDetail } from '../desktop';
import { numberFormat } from '../state/derived';
import {
  cancelDownload,
  isActive,
  pauseDownload,
  resumeDownload,
  setDownloadPanelOpen,
  startDownload,
} from '../state/downloads';
import { useAtlas } from '../state/store';
import { downloadPercent, formatBytes, roughDuration } from './downloadFormat';
import { DownloadSettingsSection } from './DownloadSettings';
import { UiIcon } from './icons';
import { StopDetails, ViewLogButton } from './StopDetails';

const DETAILS: Record<Detail, { label: string; description: string }> = {
  overview: {
    label: 'Overview',
    description: 'Quickest. Good for finding your way; blurry when zoomed in close.',
  },
  standard: {
    label: 'Standard',
    description: 'Sharp at most zoom levels, at about a quarter of the full download.',
  },
  full: {
    label: 'Full detail',
    description: 'Every level, sharpest when zoomed in close. The largest download.',
  },
};

const active = isActive;

/** What a waiting download waits for, in words. */
function waitingText(job: DownloadSnapshot): string {
  if (job.state === 'waiting') {
    return 'Another Atlas app on this computer is downloading map images. This download starts when that one has finished; Atlas checks every few seconds.';
  }
  return `Waiting for ${job.waitingFor ?? 'another download'} to finish${
    job.queuePosition ? ` (number ${job.queuePosition} in line)` : ''
  }. It starts by itself; only one download runs at a time.`;
}

/** The host the pack's map images come from, shown so the user knows where Atlas connects. */
function useSourceHosts(): string[] {
  const game = useAtlas((s) => s.game);
  const hosts = new Set<string>();
  for (const layer of game?.pack.data.layers ?? []) {
    if (!isDownloadable(layer) || layer.tiles.type !== 'xyz' || !layer.tiles.remote) continue;
    try {
      hosts.add(new URL(layer.tiles.remote.urlTemplate.replace(/[{}]/g, '')).host);
    } catch {
      // The schema checked the URL; nothing to show if it still does not parse.
    }
  }
  return [...hosts];
}

/**
 * A small button over the map, in the desktop app, for packs whose map
 * images can be downloaded: opens the download panel, and shows how far a
 * running download has got.
 */
export function MapImagesButton() {
  const downloads = useAtlas((s) => s.downloads);
  const tileStatus = useAtlas((s) => s.tileStatus);
  if (!downloads.packFolder || downloads.panelOpen) return null;
  const job = downloads.job;
  // While the map image is missing, the notice offers the download instead.
  if (tileStatus?.status === 'missing' && !active(job)) return null;
  const label =
    job && active(job)
      ? job.state === 'queued' || job.state === 'waiting'
        ? 'Map images (waiting)'
        : `Map images ${downloadPercent(job)}%${job.state === 'paused' ? ' (paused)' : ''}`
      : 'Map images';
  return (
    <button
      type="button"
      className="map-images-button"
      data-testid="map-images-button"
      title="Download map images for offline use"
      onClick={() => {
        setDownloadPanelOpen(true);
      }}
    >
      <UiIcon name="download" size={16} />
      <span>{label}</span>
    </button>
  );
}

/** The panel that chooses, starts and follows a map image download. It does not block the map. */
export function DownloadPanel() {
  const downloads = useAtlas((s) => s.downloads);
  const title = useAtlas((s) => s.game?.pack.manifest.title ?? '');
  const headingId = useId();
  // Shows the detail choice again after a finished download, to add detail.
  const [choosing, setChoosing] = useState(false);
  if (!downloads.packFolder || !downloads.panelOpen) return null;
  const { plan, job, pending, error } = downloads;

  const showJob = job && (active(job) || (!choosing && job.state !== 'cancelled'));
  const heading = !showJob
    ? 'Download map images'
    : {
        queued: 'Download waiting its turn',
        waiting: 'Download waiting its turn',
        running: 'Downloading map images',
        paused: 'Download paused',
        stopped: 'Download stopped',
        cancelled: 'Download cancelled',
        done: 'Map images downloaded',
      }[job.state];

  return (
    <section
      className="download-panel"
      aria-labelledby={headingId}
      data-testid="download-panel"
      data-state={showJob ? job.state : 'choose'}
    >
      <div className="download-head">
        <h2 id={headingId}>{heading}</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close"
          title={active(job) ? 'Hide; the download continues' : 'Close'}
          onClick={() => {
            setChoosing(false);
            setDownloadPanelOpen(false);
          }}
        >
          <UiIcon name="close" size={16} />
        </button>
      </div>
      {error ? (
        <p className="download-error" role="alert">
          {error}
        </p>
      ) : null}
      {plan ? <QueueList plan={plan} current={downloads.packFolder} /> : null}
      {showJob ? (
        <JobView
          job={job}
          pending={pending}
          canAddDetail={!!plan && plan.options.some((o) => !o.installed)}
          onAddDetail={() => {
            setChoosing(true);
          }}
        />
      ) : plan ? (
        <ChooseView
          title={title}
          options={plan.options}
          recommended={plan.recommended}
          unfinished={plan.unfinished}
          busyWith={plan.busyWith}
          pending={pending}
          onStart={(detail) => {
            setChoosing(false);
            void startDownload(detail);
          }}
          onForget={() => void cancelDownload()}
        />
      ) : (
        <p className="muted" aria-busy="true">
          Working out the download size…
        </p>
      )}
    </section>
  );
}

function ChooseView({
  title,
  options,
  recommended,
  unfinished,
  busyWith,
  pending,
  onStart,
  onForget,
}: {
  title: string;
  options: DetailOption[];
  recommended: Detail;
  unfinished: DownloadPlan['unfinished'];
  busyWith: string | null;
  pending: boolean;
  onStart: (detail: Detail) => void;
  onForget: () => void;
}) {
  const hosts = useSourceHosts();
  const firstMissing = options.find((o) => !o.installed && o.detail === recommended)
    ? recommended
    : (options.find((o) => !o.installed)?.detail ?? recommended);
  const [chosen, setChosen] = useState<Detail>(unfinished?.detail ?? firstMissing);
  const name = useId();
  const option = options.find((o) => o.detail === chosen);
  const everything = options.every((o) => o.installed);

  return (
    <div className="download-body">
      {unfinished ? (
        <div className="download-unfinished" data-testid="download-unfinished">
          <p>
            <strong>A download was not finished.</strong>{' '}
            {unfinished.reason ?? 'It stopped when Atlas was closed.'}
          </p>
          {unfinished.stopDetail ? <StopDetails detail={unfinished.stopDetail} /> : null}
          <div className="row-actions wrap">
            <button
              type="button"
              className="button button-primary"
              disabled={pending}
              onClick={() => {
                onStart(unfinished.detail);
              }}
            >
              <UiIcon name="download" size={16} />
              {unfinished.reason ? 'Try again' : 'Resume download'}
            </button>
            <button type="button" className="button" disabled={pending} onClick={onForget}>
              Forget it
            </button>
          </div>
        </div>
      ) : null}
      <p className="download-intro">
        Atlas copies the map images of <strong>{title}</strong>
        {hosts.length ? <> from {hosts.join(', ')}</> : null} so the map works offline. It downloads
        slowly on purpose, to go easy on the server. You can keep using the map, and more detail
        appears as each level finishes.
      </p>
      {everything ? <p className="download-note">Every map image is already downloaded.</p> : null}
      <fieldset className="detail-options">
        <legend className="visually-hidden">How much detail</legend>
        {options.map((o) => (
          <label key={o.detail} className="detail-option" data-detail={o.detail}>
            <input
              type="radio"
              name={name}
              value={o.detail}
              checked={chosen === o.detail}
              onChange={() => {
                setChosen(o.detail);
              }}
            />
            <span className="detail-text">
              <span className="detail-label">
                {DETAILS[o.detail].label}
                {o.detail === recommended ? <span className="badge">Recommended</span> : null}
                {o.installed ? <span className="badge badge-done">Downloaded</span> : null}
              </span>
              <span className="detail-description">{DETAILS[o.detail].description}</span>
              <span className="detail-numbers" data-testid={`detail-${o.detail}`}>
                {o.installed
                  ? `${numberFormat.format(o.tiles)} images`
                  : o.remaining < o.tiles
                    ? `${numberFormat.format(o.remaining)} of ${numberFormat.format(o.tiles)} images left`
                    : `${numberFormat.format(o.tiles)} images`}
                {o.remaining > 0
                  ? ` · about ${formatBytes(o.estimatedBytes)} · ${roughDuration(o.estimatedSeconds)}`
                  : ''}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {busyWith ? (
        <p className="download-note" role="status">
          Map images for {busyWith} are downloading. A download started here waits its turn and
          starts by itself when that one is done.
        </p>
      ) : null}
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="start-download"
          disabled={pending || !option || option.remaining === 0}
          onClick={() => {
            onStart(chosen);
          }}
        >
          <UiIcon name="download" size={16} /> {busyWith ? 'Download after it' : 'Start download'}
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            setDownloadPanelOpen(false);
          }}
        >
          Not now
        </button>
      </div>
      <DownloadSettingsSection running={false} />
    </div>
  );
}

function JobView({
  job,
  pending,
  canAddDetail,
  onAddDetail,
}: {
  job: DownloadSnapshot;
  pending: boolean;
  canAddDetail: boolean;
  onAddDetail: () => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const percent = downloadPercent(job);
  const running = job.state === 'running';
  return (
    <div className="download-body">
      {job.state === 'stopped' && job.reason ? (
        <p className="download-error" role="alert" data-testid="download-reason">
          {job.reason}
        </p>
      ) : null}
      {job.state === 'stopped' ? <StoppedDetail detail={job.stopDetail} /> : null}
      {job.state === 'queued' || job.state === 'waiting' ? (
        <p className="download-note" role="status" data-testid="download-waiting">
          {waitingText(job)}
        </p>
      ) : null}
      <div className="download-overall">
        <div className="download-figures">
          <span data-testid="download-count">
            {numberFormat.format(job.done)} of {numberFormat.format(job.total)} images
          </span>
          <span className="download-percent">{percent}%</span>
        </div>
        <Meter done={job.done} total={job.total} label="All maps" />
        {running ? (
          <p className="download-rate muted small" data-testid="download-rate">
            {job.tilesPerSecond > 0
              ? `${job.tilesPerSecond.toFixed(1)} images/s · ${formatBytes(job.bytesPerSecond)}/s`
              : 'Starting…'}
            {job.secondsLeft !== null ? ` · ${roughDuration(job.secondsLeft)} left` : ''}
          </p>
        ) : null}
        {job.state === 'paused' ? (
          <p className="muted small">Paused. Nothing is downloaded until you resume.</p>
        ) : null}
      </div>
      {job.maps.length > 1 ? (
        <ul className="download-maps">
          {job.maps.map((map) => (
            <li key={map.mapId}>
              <span className="download-map-name">{map.name}</span>
              <span className="muted small">
                {numberFormat.format(map.done)} / {numberFormat.format(map.total)}
              </span>
              <Meter done={map.done} total={map.total} label={map.name} small />
            </li>
          ))}
        </ul>
      ) : null}
      {job.state === 'done' ? (
        <p className="download-note" data-testid="download-summary">
          {numberFormat.format(job.saved)} images downloaded
          {job.missing
            ? `, ${numberFormat.format(job.missing)} not on the server (empty areas)`
            : ''}
          {job.notAsked
            ? `, ${numberFormat.format(job.notAsked)} not asked for, because the area around them is not on the server`
            : ''}
          {job.bytes ? `, ${formatBytes(job.bytes)}` : ''}.{job.reason ? ` ${job.reason}` : ''}
        </p>
      ) : null}
      {confirmCancel ? (
        <div className="download-confirm" role="group" aria-label="Cancel the download?">
          <p>Cancel the download? The images downloaded so far are kept.</p>
          <div className="row-actions">
            <button
              type="button"
              className="button button-danger"
              disabled={pending}
              onClick={() => {
                setConfirmCancel(false);
                void cancelDownload();
              }}
            >
              Cancel download
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setConfirmCancel(false);
              }}
            >
              Keep downloading
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          {running ? (
            <button
              type="button"
              className="button"
              data-testid="pause-download"
              disabled={pending}
              onClick={() => void pauseDownload()}
            >
              Pause
            </button>
          ) : null}
          {job.state === 'paused' ? (
            <button
              type="button"
              className="button button-primary"
              data-testid="resume-download"
              disabled={pending}
              onClick={() => void resumeDownload()}
            >
              Resume
            </button>
          ) : null}
          {job.state === 'stopped' ? (
            <button
              type="button"
              className="button button-primary"
              disabled={pending}
              onClick={() => void startDownload(job.detail)}
            >
              Try again
            </button>
          ) : null}
          {active(job) ? (
            <button
              type="button"
              className="button"
              data-testid="cancel-download"
              onClick={() => {
                setConfirmCancel(true);
              }}
            >
              Cancel
            </button>
          ) : null}
          {(job.state === 'done' || job.state === 'stopped') && canAddDetail ? (
            <button type="button" className="button" onClick={onAddDetail}>
              {job.state === 'done' ? 'Download more detail…' : 'Choose detail…'}
            </button>
          ) : null}
          {job.state === 'done' || job.state === 'stopped' ? (
            <button
              type="button"
              className="button"
              onClick={() => {
                setDownloadPanelOpen(false);
              }}
            >
              Close
            </button>
          ) : null}
        </div>
      )}
      {active(job) ? <DownloadSettingsSection running /> : null}
    </div>
  );
}

function StoppedDetail({ detail }: { detail: StopDetail | null }) {
  if (detail) return <StopDetails detail={detail} />;
  return (
    <p className="muted small">
      The activity log says more: <ViewLogButton />
    </p>
  );
}

const QUEUE_STATE: Record<DownloadSnapshot['state'], string> = {
  running: 'downloading',
  waiting: 'waiting for another Atlas app',
  queued: 'waiting its turn',
  paused: 'paused',
  stopped: 'stopped',
  cancelled: 'cancelled',
  done: 'done',
};

/** The downloads of this app that are not over, in the order they run. */
function QueueList({ plan, current }: { plan: DownloadPlan; current: string | null }) {
  const others = plan.queue.filter((entry) => entry.packId !== current);
  if (others.length === 0) return null;
  return (
    <div className="download-queue" data-testid="download-queue">
      <p className="muted small">One download runs at a time. In line:</p>
      <ol>
        {plan.queue.map((entry) => (
          <li
            key={entry.packId}
            data-pack={entry.packId}
            aria-current={entry.packId === current ? 'true' : undefined}
          >
            <span className="download-map-name">{entry.title}</span>{' '}
            <span className="muted small">{QUEUE_STATE[entry.state]}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Meter({
  done,
  total,
  label,
  small = false,
}: {
  done: number;
  total: number;
  label: string;
  small?: boolean;
}) {
  return (
    <span
      className={small ? 'meter meter-small' : 'meter'}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total} images`}
    >
      <span className="meter-fill" style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
    </span>
  );
}
