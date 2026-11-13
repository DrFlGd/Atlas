import { useId, useState } from 'react';
import type { DownloadSettings, DownloadSettingsInfo } from '../desktop';
import { saveDownloadSettings } from '../state/downloads';
import { useAtlas } from '../state/store';

/**
 * How map images are downloaded: parallel downloads, the pause after each
 * request, and optional caps on requests per minute and on speed. Kept
 * within bounds that stay considerate to the image servers.
 */
export function DownloadSettingsSection({
  running,
  open = false,
}: {
  running: boolean;
  /** Shown open, as on the settings page. */
  open?: boolean;
}) {
  const info = useAtlas((s) => s.downloads.settings);
  const pending = useAtlas((s) => s.downloads.pending);
  const [saved, setSaved] = useState(false);
  if (!info) return null;
  return (
    <details className="download-settings" data-testid="download-settings" open={open}>
      <summary>Download settings</summary>
      <SettingsForm
        // Starts again from the saved settings whenever they change.
        key={JSON.stringify(info.settings)}
        info={info}
        pending={pending}
        running={running}
        saved={saved}
        onSaved={setSaved}
      />
    </details>
  );
}

const PAUSES = [100, 250, 500, 1000, 2000, 5000];

function SettingsForm({
  info,
  pending,
  running,
  saved,
  onSaved,
}: {
  info: DownloadSettingsInfo;
  pending: boolean;
  running: boolean;
  saved: boolean;
  onSaved: (saved: boolean) => void;
}) {
  const [draft, setDraft] = useState<DownloadSettings>(info.settings);
  const ids = { parallel: useId(), pause: useId(), rpm: useId(), speed: useId() };
  const { bounds } = info;
  const changed = JSON.stringify(draft) !== JSON.stringify(info.settings);
  const inRange = (value: number | null, [low, high]: [number, number]) =>
    value === null || (Number.isInteger(value) && value >= low && value <= high);
  const valid =
    inRange(draft.requestsPerMinute, bounds.requestsPerMinute) &&
    inRange(draft.kilobytesPerSecond, bounds.kilobytesPerSecond);
  const change = (patch: Partial<DownloadSettings>) => {
    onSaved(false);
    setDraft({ ...draft, ...patch });
  };
  const parallelOptions = Array.from(
    { length: bounds.parallel[1] - bounds.parallel[0] + 1 },
    (_, i) => bounds.parallel[0] + i,
  );
  const pauses = PAUSES.filter((ms) => ms >= bounds.pauseMs[0] && ms <= bounds.pauseMs[1]);
  if (!pauses.includes(draft.pauseMs)) pauses.push(draft.pauseMs);
  pauses.sort((a, b) => a - b);

  return (
    <form
      className="settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) void saveDownloadSettings(draft).then(onSaved);
      }}
    >
      <p className="muted small">
        These settings are shared by every Atlas app on this computer and cover everything it
        downloads: only one download runs at a time, in any Atlas app, and the others wait their
        turn. Faster settings put more load on the image server; there is no unlimited setting.
      </p>
      <div className="settings-grid">
        <label htmlFor={ids.parallel}>Parallel downloads</label>
        <select
          id={ids.parallel}
          className="select"
          data-testid="setting-parallel"
          value={draft.parallel}
          onChange={(event) => {
            change({ parallel: Number(event.target.value) });
          }}
        >
          {parallelOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <label htmlFor={ids.pause}>Pause after each image</label>
        <select
          id={ids.pause}
          className="select"
          data-testid="setting-pause"
          value={draft.pauseMs}
          onChange={(event) => {
            change({ pauseMs: Number(event.target.value) });
          }}
        >
          {pauses.map((ms) => (
            <option key={ms} value={ms}>
              {ms < 1000 ? `${ms} ms` : `${ms / 1000} s`}
            </option>
          ))}
        </select>
        <Cap
          id={ids.rpm}
          label="At most"
          unit="images a minute"
          testId="setting-rpm"
          value={draft.requestsPerMinute}
          bounds={bounds.requestsPerMinute}
          fallback={120}
          onChange={(requestsPerMinute) => {
            change({ requestsPerMinute });
          }}
        />
        <Cap
          id={ids.speed}
          label="At most"
          unit="KB a second"
          testId="setting-speed"
          value={draft.kilobytesPerSecond}
          bounds={bounds.kilobytesPerSecond}
          fallback={1000}
          onChange={(kilobytesPerSecond) => {
            change({ kilobytesPerSecond });
          }}
        />
      </div>
      <p className="muted small">
        Parallel downloads is how many images are fetched at the same time. Pause after each image
        is how long each one waits before the next request. A ticked At most limits the images a
        minute, or the kilobytes a second. Save settings keeps them for every Atlas app on this
        computer.
      </p>
      <div className="row-actions">
        <button
          type="submit"
          className="button"
          data-testid="save-download-settings"
          disabled={!changed || !valid || pending}
        >
          Save settings
        </button>
        {saved && !changed ? (
          <span className="muted small" role="status">
            Saved. The time estimates above use them.
          </span>
        ) : null}
      </div>
      {running ? (
        <p className="muted small">
          A running download follows new settings at once, except that more parallel downloads start
          with its next detail level.
        </p>
      ) : null}
    </form>
  );
}

function Cap({
  id,
  label,
  unit,
  testId,
  value,
  bounds,
  fallback,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  testId: string;
  value: number | null;
  bounds: [number, number];
  fallback: number;
  onChange: (value: number | null) => void;
}) {
  const on = value !== null;
  return (
    <>
      <label className="checkbox-row" htmlFor={`${id}-on`}>
        <input
          id={`${id}-on`}
          type="checkbox"
          checked={on}
          data-testid={`${testId}-on`}
          onChange={(event) => {
            onChange(
              event.target.checked ? Math.min(bounds[1], Math.max(bounds[0], fallback)) : null,
            );
          }}
        />{' '}
        {label}
      </label>
      <span className="cap-input">
        <input
          id={id}
          className="text-input"
          type="number"
          inputMode="numeric"
          aria-label={`${label} ${unit}`}
          data-testid={testId}
          min={bounds[0]}
          max={bounds[1]}
          step={1}
          disabled={!on}
          value={value ?? ''}
          onChange={(event) => {
            onChange(
              event.target.value === '' ? bounds[0] : Math.round(Number(event.target.value)),
            );
          }}
        />{' '}
        <span className="muted small">
          {unit} ({bounds[0]}–{bounds[1]})
        </span>
      </span>
    </>
  );
}
