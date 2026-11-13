import { useEffect, useRef, useState } from 'react';
import { desktop, type DownloadSnapshot, type ListedPack, type PhotoPlan } from '../desktop';
import { numberFormat } from '../state/derived';
import { useAtlas } from '../state/store';
import { formatBytes } from './downloadFormat';
import { StopDetails, ViewLogButton } from './StopDetails';
import '../styles/pageView.css';

/**
 * In the Maps dialog of a downloads build: "Download location photos" for
 * a pack whose pictures are listed to be fetched later. Nothing is fetched
 * until the person asks. The photos come one at a time, with the pause of
 * the download settings, in the same line as map images.
 */
export function PhotoDownload({ pack }: { pack: ListedPack }) {
  const [plan, setPlan] = useState<PhotoPlan | null>(null);
  const [job, setJob] = useState<DownloadSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const revision = useRef(-1);

  const take = (snapshot: DownloadSnapshot | null) => {
    setJob(snapshot);
    if (snapshot && snapshot.statusRevision !== revision.current) {
      revision.current = snapshot.statusRevision;
      // Photos just saved: show them where they were missing.
      useAtlas.setState({ tileRevision: useAtlas.getState().tileRevision + 1 });
    }
  };

  const loadPlan = async () => {
    if (!desktop) return;
    try {
      const next = await desktop.tiles.photosPlan(pack.id);
      setPlan(next);
      take(next.job);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const active = isActive(job);
  // Polls while the job is not over; reads the plan again once it is.
  useEffect(() => {
    if (!open || !active || !desktop) return;
    const bridge = desktop;
    const timer = window.setInterval(() => {
      void bridge.tiles.photosSnapshot(pack.id).then((snapshot) => {
        take(snapshot);
        if (!isActive(snapshot)) void loadPlan();
      });
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- take and loadPlan only set state
  }, [open, active, pack.id]);

  const act = async (step: () => Promise<DownloadSnapshot | undefined>) => {
    setPending(true);
    try {
      const snapshot = await step();
      if (snapshot) take(snapshot);
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
    await loadPlan();
  };

  const bridge = desktop;
  return (
    <details
      className="map-page-details photo-download"
      data-testid="photo-download"
      onToggle={(event) => {
        const details = event.currentTarget;
        setOpen(details.open);
        if (!details.open) return;
        void loadPlan().then(() => {
          details.scrollIntoView({ block: 'nearest' });
        });
      }}
    >
      <summary className="link-button">Location photos…</summary>
      {error ? (
        <p className="download-error" role="alert">
          {error}
        </p>
      ) : null}
      {!plan && !error ? <p className="muted small">Looking…</p> : null}
      {plan?.total === 0 ? (
        <p className="muted small" data-testid="photo-download-none">
          This map pack lists no photos to download.
        </p>
      ) : null}
      {plan && plan.total > 0 && bridge ? (
        <div className="download-body">
          <p className="small" data-testid="photo-download-plan">
            {numberFormat.format(plan.total)} {plan.total === 1 ? 'photo' : 'photos'} listed,{' '}
            {plan.remaining === 0
              ? 'all on this device.'
              : `${numberFormat.format(plan.remaining)} not on this device yet.`}
          </p>
          {plan.hosts.length > 0 ? (
            <p className="muted small">
              From {plan.hosts.join(', ')}. One at a time, with the pause set for downloads. Each is
              made at most 1280 pixels wide.
            </p>
          ) : null}
          {job ? <PhotoJob job={job} /> : null}
          {plan.busyWith && !active ? (
            <p className="muted small">
              {plan.busyWith} is downloading now. Photos wait for it to finish.
            </p>
          ) : null}
          <div className="row-actions wrap">
            {!active && plan.remaining > 0 ? (
              <button
                type="button"
                className="button button-small button-primary"
                data-testid="download-photos"
                disabled={pending}
                onClick={() => void act(() => bridge.tiles.photosStart(pack.id))}
              >
                Download location photos
              </button>
            ) : null}
            {job?.state === 'running' || job?.state === 'queued' || job?.state === 'waiting' ? (
              <button
                type="button"
                className="button button-small"
                data-testid="photos-pause"
                disabled={pending}
                onClick={() => void act(() => bridge.tiles.photosPause(pack.id))}
              >
                Pause
              </button>
            ) : null}
            {job?.state === 'paused' ? (
              <button
                type="button"
                className="button button-small button-primary"
                data-testid="photos-resume"
                disabled={pending}
                onClick={() => void act(() => bridge.tiles.photosResume(pack.id))}
              >
                Resume
              </button>
            ) : null}
            {active ? (
              <button
                type="button"
                className="button button-small"
                data-testid="photos-cancel"
                disabled={pending}
                onClick={() =>
                  void act(async () => {
                    await bridge.tiles.photosCancel(pack.id);
                    return undefined;
                  })
                }
              >
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function isActive(job: DownloadSnapshot | null): boolean {
  return (
    job?.state === 'running' ||
    job?.state === 'paused' ||
    job?.state === 'queued' ||
    job?.state === 'waiting'
  );
}

function PhotoJob({ job }: { job: DownloadSnapshot }) {
  const total = Math.max(1, job.total);
  return (
    <div className="download-overall" data-testid="photo-job" data-state={job.state}>
      {job.state === 'stopped' ? (
        <>
          {job.reason ? (
            <p className="download-error" role="alert" data-testid="photo-download-reason">
              {job.reason}
            </p>
          ) : null}
          {job.stopDetail ? (
            <StopDetails detail={job.stopDetail} />
          ) : (
            <p className="muted small">
              The activity log says more: <ViewLogButton />
            </p>
          )}
        </>
      ) : null}
      {job.state === 'queued' || job.state === 'waiting' ? (
        <p className="download-note" role="status">
          {job.waitingFor ? `Waiting for ${job.waitingFor}.` : 'Waiting its turn.'}
        </p>
      ) : null}
      <div className="download-figures">
        <span data-testid="photo-download-count">
          {numberFormat.format(job.done)} of {numberFormat.format(job.total)} photos
        </span>
        <span className="download-percent">{Math.floor((job.done / total) * 100)}%</span>
      </div>
      <span
        className="meter"
        role="progressbar"
        aria-label="Location photos"
        aria-valuemin={0}
        aria-valuemax={job.total}
        aria-valuenow={job.done}
        aria-valuetext={`${job.done} of ${job.total} photos`}
      >
        <span className="meter-fill" style={{ width: `${(job.done / total) * 100}%` }} />
      </span>
      {job.state === 'paused' ? (
        <p className="muted small">Paused. Nothing is downloaded until you resume.</p>
      ) : null}
      {job.state === 'cancelled' ? (
        <p className="muted small">Cancelled. The photos downloaded so far are kept.</p>
      ) : null}
      {job.state === 'done' ? (
        <p className="download-note" data-testid="photo-download-summary">
          {numberFormat.format(job.saved)} {job.saved === 1 ? 'photo' : 'photos'} downloaded
          {job.missing ? `, ${numberFormat.format(job.missing)} not on the server` : ''}
          {job.bytes ? `, ${formatBytes(job.bytes)}` : ''}.{job.reason ? ` ${job.reason}` : ''}
        </p>
      ) : null}
    </div>
  );
}
