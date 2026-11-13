import type { Detail, DownloadSnapshot } from '../desktop';

/** Whole percent of a job's tiles dealt with. */
export function downloadPercent(job: Pick<DownloadSnapshot, 'done' | 'total'>): number {
  return job.total === 0 ? 100 : Math.floor((job.done / job.total) * 100);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 60) return 'less than a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ${hours % 24} h`;
}

/** A duration estimate in words: "about 10 min", or "less than a minute". */
export function roughDuration(seconds: number): string {
  const text = formatDuration(seconds);
  return text === 'less than a minute' || text === 'unknown' ? text : `about ${text}`;
}

/** The levels of detail of a map image download, in words. */
export const DETAILS: Record<Detail, { label: string; description: string }> = {
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
