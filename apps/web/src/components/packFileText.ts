import type { Detail, PackDetails, PackFileHeader, SourceFacts } from '../desktop';

/**
 * Words for map pack files: which of a file and the installed game is
 * newer, where a pack's data came from, and dates in local time. Kept apart
 * from the dialogs so they can be tested without a page.
 */

const numberFormat = new Intl.NumberFormat('en');

export const DETAIL_LABELS: Record<Detail, string> = {
  overview: 'Overview',
  standard: 'Standard',
  full: 'Full detail',
};

/** A date and time in the person's own format and time zone. */
export function localDate(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    time,
  );
}

/** Orders `1.2.0` before `1.10.0`; as the shell does, only the first three numbers count. */
export function compareVersions(a: string, b: string): number {
  const key = (version: string) =>
    (version.split(/[-+]/)[0] ?? '')
      .split('.')
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [key(a), key(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** Which is newer, the file or the game installed now, and what that rests on. */
export type Freshness =
  | { verdict: 'file-newer' | 'installed-newer'; basis: 'pages'; file: string; installed: string }
  | { verdict: 'file-newer' | 'installed-newer'; basis: 'version'; file: string; installed: string }
  | { verdict: 'file-newer' | 'installed-newer'; basis: 'dates'; file: string; installed: string }
  | { verdict: 'same'; basis: 'same-file' | 'same-data' }
  | { verdict: 'unknown' };

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** The latest of some ISO dates, or null. */
function latest(dates: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const date of dates) {
    if (!date || Number.isNaN(time(date))) continue;
    if (best === null || time(date) > time(best)) best = date;
  }
  return best;
}

/**
 * Compares a file with the game installed under the same id: first by when
 * their data was read from the game's pages, then by pack version, then by
 * when the file was made against the last change recorded for the
 * installed game. Dates that are not recorded are never guessed.
 */
export function compareWithInstalled(header: PackFileHeader, installed: PackDetails): Freshness {
  if (installed.packFile?.header.exportedAt === header.exportedAt) {
    return { verdict: 'same', basis: 'same-file' };
  }
  const filePages = header.source.newestPageAt;
  const installedPages = installed.source.newestPageAt;
  if (filePages && installedPages && time(filePages) !== time(installedPages)) {
    return {
      verdict: time(filePages) > time(installedPages) ? 'file-newer' : 'installed-newer',
      basis: 'pages',
      file: filePages,
      installed: installedPages,
    };
  }
  const versions = compareVersions(header.packVersion, installed.pack.packVersion);
  if (versions !== 0) {
    return {
      verdict: versions > 0 ? 'file-newer' : 'installed-newer',
      basis: 'version',
      file: header.packVersion,
      installed: installed.pack.packVersion,
    };
  }
  if (filePages && installedPages) return { verdict: 'same', basis: 'same-data' };
  const changed = latest([
    installed.pack.updated,
    installed.pack.created,
    installed.imagesAt,
    installed.packFile?.header.exportedAt,
  ]);
  if (changed && !Number.isNaN(time(header.exportedAt))) {
    return {
      verdict: time(header.exportedAt) > time(changed) ? 'file-newer' : 'installed-newer',
      basis: 'dates',
      file: header.exportedAt,
      installed: changed,
    };
  }
  return { verdict: 'unknown' };
}

/** One sentence on which is newer; `date` writes a date (local time in the dialog). */
export function freshnessText(
  freshness: Freshness,
  date: (iso: string) => string = localDate,
): string {
  switch (freshness.verdict) {
    case 'unknown':
      return 'Atlas cannot tell which is newer: neither records when its data was read.';
    case 'same':
      return freshness.basis === 'same-file'
        ? 'The installed game was imported from this same file.'
        : 'Both hold data read from the game’s pages at the same time, in the same version.';
    default:
      break;
  }
  const newer = freshness.verdict === 'file-newer';
  const [subject, other] = newer
    ? ['This file', 'the installed game']
    : ['The installed game', 'this file'];
  const [mine, theirs] = newer
    ? [freshness.file, freshness.installed]
    : [freshness.installed, freshness.file];
  switch (freshness.basis) {
    case 'pages':
      return `${subject} is newer: its data was read from the game’s pages on ${date(mine)}, ${other}’s on ${date(theirs)}.`;
    case 'version':
      return `${subject} is newer: it is version ${mine} of the game’s pack, ${other} has version ${theirs}.`;
    case 'dates':
      return newer
        ? `This file is probably newer: it was made on ${date(mine)}, after the installed game last changed (${date(theirs)}).`
        : `The installed game is probably newer: it last changed on ${date(mine)}, after this file was made (${date(theirs)}).`;
  }
}

/** Where a pack's data came from, in words. */
export function sourceText(source: SourceFacts): string {
  if (source.kind === 'app') return 'Comes with the Atlas app.';
  if (source.kind === 'web-pages') {
    const pages = source.pages?.length ?? 0;
    const from = source.importer ? ` with ${source.importer.title}` : '';
    return pages > 0
      ? `Read from ${pages} web page${pages === 1 ? '' : 's'}${from}.`
      : `Read from web pages${from}.`;
  }
  return 'Where its data came from is not recorded.';
}

/** The map images a file holds, in words. */
export function imagesText(header: PackFileHeader): string {
  const count = header.images.files;
  if (count === 0) return 'No map images.';
  return `${numberFormat.format(count)} map image${count === 1 ? '' : 's'} at ${DETAIL_PHRASES[header.detail]}.`;
}

/** A level of detail inside a sentence. */
export const DETAIL_PHRASES: Record<Detail, string> = {
  overview: 'overview detail',
  standard: 'standard detail',
  full: 'full detail',
};

/** When the map images in a file were downloaded: the newest date of any layer. */
export function imagesDownloadedAt(header: PackFileHeader): string | null {
  return latest(header.images.layers.map((layer) => layer.downloadedAt));
}

/** The map images of an installed game, in words, without their date. */
export function installedImagesText(details: PackDetails): string {
  if (details.archive) return 'In one archive file, which a map pack file cannot hold.';
  if (!details.layers.some((layer) => layer.downloadable)) return 'They come with the game’s pack.';
  if (details.detail) return `Downloaded at ${DETAIL_PHRASES[details.detail]}.`;
  return details.layers.some((layer) => layer.levels.length > 0)
    ? 'Partly downloaded.'
    : 'Not downloaded.';
}

/** The size of a game's contents: "3 maps, 120 locations, 2 checklists". */
export function contentsText(contents: PackFileHeader['contents']): string {
  const part = (count: number, one: string, many: string) =>
    `${numberFormat.format(count)} ${count === 1 ? one : many}`;
  const parts = [
    part(contents.maps, 'map', 'maps'),
    part(contents.locations, 'location', 'locations'),
  ];
  if (contents.checklists > 0) parts.push(part(contents.checklists, 'checklist', 'checklists'));
  if (contents.guides > 0) parts.push(part(contents.guides, 'guide', 'guides'));
  return parts.join(', ');
}
