/**
 * Reading the desktop apps' activity log (see `apps/desktop`, `activity.rs`):
 * one event per line,
 *
 *     2026-11-11T09:12:03.123Z [Atlas 0.3.1] download error: Stopped: …
 *
 * Lines are untrusted text: they are parsed here and only ever shown as text.
 */

export const LOG_AREAS = ['download', 'import', 'library', 'migration', 'app'] as const;
export type LogArea = (typeof LOG_AREAS)[number];
export type LogLevel = 'info' | 'warn' | 'error';

/** Which entries to show: an area or all, and the lowest level. */
export interface LogFilter {
  area: LogArea | 'all';
  level: LogLevel;
}

export const ALL_ENTRIES: LogFilter = { area: 'all', level: 'info' };

export interface LogEntry {
  /** The line as written, which is what is copied. */
  line: string;
  /** ISO 8601 UTC, or null for a line that is not in the log's format. */
  time: string | null;
  /** The app's name and version. */
  app: string | null;
  area: LogArea | null;
  level: LogLevel | null;
  message: string;
}

const LINE =
  /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) \[([^\]]*)\] (app|download|import|library|migration) (info|warn|error): (.*)$/;

export function parseLogLine(line: string): LogEntry {
  const match = LINE.exec(line);
  if (!match) return { line, time: null, app: null, area: null, level: null, message: line };
  const [, time = '', app = '', area, level, message = ''] = match;
  return {
    line,
    time,
    app,
    area: area as LogArea,
    level: level as LogLevel,
    message,
  };
}

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };

/**
 * The entries a filter shows. Lines in no known format are shown only when
 * nothing is filtered, so that nothing is hidden by surprise.
 */
export function filterEntries(entries: readonly LogEntry[], filter: LogFilter): LogEntry[] {
  return entries.filter((entry) => {
    if (!entry.area || !entry.level) return filter.area === 'all' && filter.level === 'info';
    return (
      (filter.area === 'all' || entry.area === filter.area) &&
      RANK[entry.level] >= RANK[filter.level]
    );
  });
}

/** The text that "Copy" puts on the clipboard: the lines as written. */
export function logText(entries: readonly LogEntry[]): string {
  return entries.length ? `${entries.map((entry) => entry.line).join('\n')}\n` : '';
}

/** A log time for display: "2026-11-11 09:12:03 UTC". */
export function displayTime(time: string): string {
  return `${time.slice(0, 10)} ${time.slice(11, 19)} UTC`;
}
