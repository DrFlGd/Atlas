import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  LOG_AREAS,
  displayTime,
  filterEntries,
  logText,
  parseLogLine,
  type LogArea,
  type LogEntry,
  type LogLevel,
} from '../activityLog';
import { copyText } from '../clipboard';
import { desktop, type RecentLog } from '../desktop';
import { foldersOffered } from '../features';
import { numberFormat } from '../state/derived';
import { closeActivityLog } from '../state/activityLog';
import { reveal } from '../state/library';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

const AREA_LABELS: Record<LogArea | 'all', string> = {
  all: 'All areas',
  download: 'Downloads',
  import: 'Adding maps',
  library: 'Maps library',
  saves: 'Game saves',
  migration: 'Moving from 0.2.0',
  app: 'App',
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  info: 'Everything',
  warn: 'Warnings and errors',
  error: 'Errors only',
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * "Activity log", in the desktop app: what the Atlas apps on this computer
 * did (downloads, adding maps, the maps library), read from the log file in
 * the shared folder. The lines are shown as plain text; they can be
 * filtered, copied to send along with a question, or found in their folder.
 */
export function ActivityLogDialog() {
  const viewer = useAtlas((s) => s.logViewer);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (viewer && !dialog.open) dialog.showModal();
    if (!viewer && dialog.open) dialog.close();
  }, [viewer]);

  if (!desktop) return null;
  return (
    <dialog
      ref={ref}
      className="dialog log-dialog"
      aria-labelledby={titleId}
      data-testid="log-dialog"
      onClose={closeActivityLog}
    >
      {viewer ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Activity log</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              onClick={closeActivityLog}
            >
              <UiIcon name="close" />
            </button>
          </header>
          <LogView initialArea={viewer.area} dialog={ref} />
        </div>
      ) : null}
    </dialog>
  );
}

function LogView({
  initialArea,
  dialog,
}: {
  initialArea: LogArea | 'all';
  dialog: React.RefObject<HTMLDialogElement | null>;
}) {
  const [log, setLog] = useState<RecentLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [area, setArea] = useState<LogArea | 'all'>(initialArea);
  const [level, setLevel] = useState<LogLevel>('info');
  const [note, setNote] = useState('');
  const folders = useAtlas(foldersOffered);
  const listRef = useRef<HTMLOListElement>(null);
  const ids = { area: useId(), level: useId(), status: useId() };

  const load = useCallback(() => {
    if (!desktop) return;
    desktop.activityLog.read().then(
      (recent) => {
        setLog(recent);
        setError(null);
      },
      (failure: unknown) => {
        setError(errorText(failure));
      },
    );
  }, []);
  useEffect(load, [load]);

  const entries = useMemo<LogEntry[]>(() => (log ? log.lines.map(parseLogLine) : []), [log]);
  const shown = useMemo(() => filterEntries(entries, { area, level }), [entries, area, level]);

  // The newest entries are at the end: keep them in view.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [shown]);

  const copy = async () => {
    const host = dialog.current;
    if (!host) return;
    const copied = await copyText(logText(shown), host);
    setNote(
      copied
        ? `Copied ${numberFormat.format(shown.length)} ${shown.length === 1 ? 'entry' : 'entries'} to the clipboard.`
        : 'The clipboard could not be used. Open the log folder and send the file atlas.log instead.',
    );
  };

  return (
    <>
      <p className="muted small">
        What the Atlas apps on this computer did: map image downloads, adding maps and the maps
        library. Copy it to send it with a question about a problem. It holds no progress and
        nothing from the web pages that maps were added from.
      </p>
      {log ? (
        <p className="path small" data-testid="log-file">
          {log.file}
        </p>
      ) : null}
      <div className="log-toolbar">
        <label htmlFor={ids.area} className="visually-hidden">
          Area
        </label>
        <select
          id={ids.area}
          className="select"
          data-testid="log-area"
          value={area}
          onChange={(event) => {
            setArea(event.target.value as LogArea | 'all');
            setNote('');
          }}
        >
          {(['all', ...LOG_AREAS] as const).map((value) => (
            <option key={value} value={value}>
              {AREA_LABELS[value]}
            </option>
          ))}
        </select>
        <label htmlFor={ids.level} className="visually-hidden">
          Level
        </label>
        <select
          id={ids.level}
          className="select"
          data-testid="log-level"
          value={level}
          onChange={(event) => {
            setLevel(event.target.value as LogLevel);
            setNote('');
          }}
        >
          {(Object.keys(LEVEL_LABELS) as LogLevel[]).map((value) => (
            <option key={value} value={value}>
              {LEVEL_LABELS[value]}
            </option>
          ))}
        </select>
        <div className="row-actions wrap log-actions">
          <button
            type="button"
            className="button"
            data-testid="log-refresh"
            onClick={() => {
              setNote('');
              load();
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="button"
            data-testid="log-copy"
            disabled={shown.length === 0}
            onClick={() => void copy()}
          >
            <UiIcon name="copy" size={16} /> Copy all shown
          </button>
          {folders ? (
            <button
              type="button"
              className="button"
              data-testid="log-open-folder"
              onClick={() => {
                reveal({ kind: 'log-folder' });
              }}
            >
              <UiIcon name="folder" size={16} /> Open log folder
            </button>
          ) : null}
        </div>
      </div>
      <p className="muted small" id={ids.status} role="status" data-testid="log-status">
        {error
          ? null
          : log
            ? `${numberFormat.format(shown.length)} of ${numberFormat.format(entries.length)} recent entries shown, newest last${log.truncated ? '; older entries are in the file' : ''}.`
            : 'Reading the log…'}
        {note ? ` ${note}` : null}
      </p>
      {error ? (
        <p className="download-error" role="alert">
          {error}
        </p>
      ) : null}
      <ol
        ref={listRef}
        className="log-list"
        data-testid="log-list"
        tabIndex={0}
        aria-label="Log entries"
        aria-describedby={ids.status}
      >
        {shown.map((entry, index) => (
          <li
            // Lines can repeat; their position in the file tells them apart.
            key={index}
            className="log-row"
            data-level={entry.level ?? 'other'}
            data-testid="log-row"
          >
            {entry.time ? <span className="log-time">{displayTime(entry.time)}</span> : null}
            {entry.area ? (
              <span className="log-tags">
                {entry.app} · {entry.area} · <span className="log-level">{entry.level}</span>
              </span>
            ) : null}
            <span className="log-message">{entry.message}</span>
          </li>
        ))}
        {log && shown.length === 0 ? (
          <li className="log-row muted">
            No entries{entries.length ? ' match this filter' : ' yet'}.
          </li>
        ) : null}
      </ol>
    </>
  );
}
