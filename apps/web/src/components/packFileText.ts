import type { ContentCounts, Detail, PackDetails, PackFileHeader, SourceFacts } from '../desktop';
import { formatBytes } from './downloadFormat';

/**
 * Words for pack files: what a file holds (a game with a map, or a wiki of
 * pages and pictures), which of a file and the installed game is newer,
 * where a pack's data came from, and dates in local time. Kept apart from
 * the dialogs so they can be tested without a page.
 */

const numberFormat = new Intl.NumberFormat('en');

const count = (n: number, one: string, many: string) =>
  `${numberFormat.format(n)} ${n === 1 ? one : many}`;

/**
 * What a game or a file holds, for the words of the pack file dialog: a
 * game with a map, or a game of pages and pictures with no map (a wiki).
 * The file is the same either way; only what is said about it differs.
 */
export type PackKind = 'map' | 'pages';

export function packKind(contents: Pick<ContentCounts, 'maps'>): PackKind {
  return contents.maps === 0 ? 'pages' : 'map';
}

/**
 * What a pack file of a game holds, after "A pack file holds <title> in one
 * file: ". For a game of pages: whether the pictures of its pages go in
 * always (`shared`, pictures that may be passed on), only when ticked
 * (`ownUse`, downloaded for the person's own use), or not at all.
 */
export function exportHolds(kind: PackKind, pictures: { shared: number; ownUse: number }): string {
  if (kind === 'map') {
    return 'its maps, locations and checklists, and the map images at the detail you choose. Copy it to another computer or to Atlas for Android and import it there to use the maps offline.';
  }
  const holds =
    pictures.ownUse > 0
      ? 'its pages, and the pictures of its pages as you choose below'
      : pictures.shared > 0
        ? 'its pages and their pictures'
        : 'its pages';
  return `${holds}. Copy it to another computer or to Atlas for Android and import it there to read the pages offline.`;
}

/** The name of the box that adds one's own things of the game to the file. */
export function mineLabel(kind: PackKind, contents: Pick<ContentCounts, 'checklists'>): string {
  if (kind === 'map') return 'Include my lists, locations, types and photos';
  return contents.checklists > 0 ? 'Include my pages and lists' : 'Include my pages';
}

/** The hint under that box: what of one's own goes with the game. */
export function mineHint(kind: PackKind, contents: Pick<ContentCounts, 'checklists'>): string {
  if (kind === 'map') {
    return 'Your own lists and guides of this game, the locations, types and areas you added, your photos of them, your links between guide pages and the map, the pages you changed or added, your notes on its locations, and the title it shares with other games, so they come with it on the other device. Found marks are never included.';
  }
  const lists = contents.checklists > 0 ? ', your own lists of it,' : '';
  return `The pages you added or changed in this game${lists} and the title it shares with other games, so they come with it on the other device. Your progress is never included.`;
}

/** The name of the box that adds the pictures downloaded for one's own use. */
export function photosLabel(kind: PackKind): string {
  return kind === 'map' ? 'Include downloaded photos' : 'Include downloaded pictures';
}

export const DETAIL_LABELS: Record<Detail, string> = {
  overview: 'Overview',
  standard: 'Standard',
  full: 'Full detail',
};

/**
 * The hint under "Include downloaded photos" in the Export dialog: how many
 * there are, their size as the caller words it, and that such a file is one
 * to keep.
 */
export function photosHint(count: number, size: string, kind: PackKind = 'map'): string {
  if (kind === 'pages') {
    const pictures = `${numberFormat.format(count)} picture${count === 1 ? '' : 's'}`;
    return `The ${pictures} of its pages downloaded for your own use (${size}). Tick this so the pages show their pictures on the other device: without it, the file holds the pages without these pictures. Keep a file with them to yourself: they are not yours to pass on.`;
  }
  const photos = `${numberFormat.format(count)} photo${count === 1 ? '' : 's'}`;
  return `The ${photos} downloaded for your own use (location photos and the pictures of guide pages, ${size}), so the other device shows them without downloading them again. Keep a file with them to yourself: they are not yours to pass on.`;
}

/** "Pictures in the file": the pictures as this computer keeps them, or made smaller. */
export type PicturesInFile = 'full' | 'smaller';

export const PICTURES_IN_FILE_LABELS: Record<PicturesInFile, string> = {
  full: 'Full size',
  smaller: 'Smaller',
};

/** What each choice means, given how many pictures go in and their size at full size. */
export function picturesInFileText(choice: PicturesInFile, count: number, size: string): string {
  if (choice === 'full') {
    const pictures = `${numberFormat.format(count)} picture${count === 1 ? '' : 's'}`;
    return `The pictures go in as this computer keeps them (${pictures}, ${size}).`;
  }
  return 'Each picture is made at most 1,280 pixels wide and a photo is saved as a JPEG, so the file is much smaller and a picture opened large shows less detail. The pictures on this computer and your own photos stay as they are.';
}

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
  if (details.archive) return 'In one archive file, which a pack file cannot hold.';
  if (!details.layers.some((layer) => layer.downloadable)) return 'They come with the game’s pack.';
  if (details.detail) return `Downloaded at ${DETAIL_PHRASES[details.detail]}.`;
  return details.layers.some((layer) => layer.levels.length > 0)
    ? 'Partly downloaded.'
    : 'Not downloaded.';
}

/**
 * The size of a game's contents: "3 maps, 120 locations, 2 checklists", or
 * for a game with no map "24 pages, 1 checklist".
 */
export function contentsText(contents: PackFileHeader['contents']): string {
  if (packKind(contents) === 'pages') {
    const parts = [count(contents.guides, 'page', 'pages')];
    if (contents.checklists > 0) parts.push(count(contents.checklists, 'checklist', 'checklists'));
    return parts.join(', ');
  }
  const parts = [
    count(contents.maps, 'map', 'maps'),
    count(contents.locations, 'location', 'locations'),
  ];
  if (contents.checklists > 0) parts.push(count(contents.checklists, 'checklist', 'checklists'));
  if (contents.guides > 0) parts.push(count(contents.guides, 'guide', 'guides'));
  return parts.join(', ');
}

/** What a file just saved holds, after "Saved <file> (<size>): ". */
export function savedText(header: PackFileHeader, pictures: number): string {
  if (packKind(header.contents) === 'map') return imagesText(header);
  const pages = count(header.contents.guides, 'page', 'pages');
  return pictures > 0 ? `${pages} and ${count(pictures, 'picture', 'pictures')}.` : `${pages}.`;
}

/**
 * The note on what importing a file does to the game with the same id shown
 * now: replaced in the maps folder, or shown in place of one that comes with
 * the app or sits in another folder. What is replaced is said by what the
 * file holds.
 */
export function replaceText(
  kind: PackKind,
  installed: { title: string; origin: string; folder: string | null },
  replaces: boolean,
): string {
  const kept = kind === 'map' ? 'Your found marks are kept.' : 'Your progress is kept.';
  if (replaces) {
    return kind === 'map'
      ? `Importing replaces ${installed.title} in the maps folder. Your found marks are kept; its locations, checklists and map images are replaced by the ones in this file.`
      : `Importing replaces ${installed.title} in the maps folder. Your progress is kept; its pages and pictures are replaced by the ones in this file.`;
  }
  if (installed.origin === 'bundled') {
    return `${installed.title} comes with the app. The imported game goes into the maps folder and is shown in its place. ${kept}`;
  }
  return `The imported game goes into the maps folder and is shown in place of the one in ${installed.folder ?? 'its folder'}, which is left as it is. ${kept}`;
}

/**
 * The sentence for a game with a map whose title also shows a wiki: the
 * wiki is a game of its own and is not in this game's file. Null when
 * there is none.
 */
export function wikisApartText(wikis: readonly string[]): string | null {
  if (wikis.length === 0) return null;
  const names =
    wikis.length === 1 ? wikis[0]! : `${wikis.slice(0, -1).join(', ')} and ${wikis.at(-1)!}`;
  return wikis.length === 1
    ? `The wiki ${names}, shown with this game under one title, is not in this file: export it by itself from the Library, under More, Export to a file.`
    : `The wikis ${names}, shown with this game under one title, are not in this file: export each by itself from the Library, under More, Export to a file.`;
}

/**
 * The style sheets kept from a wiki's pages, in words: "4, 1.2 MB in all."
 * (pages are laid out with them); null when there are none.
 */
export function stylesText(styles: PackDetails['styles']): string | null {
  if (!styles || styles.sheets === 0) return null;
  const text = `${numberFormat.format(styles.sheets)}, ${formatBytes(styles.bytes)} in all.`;
  if (styles.leftOut === 0) return text;
  const more =
    styles.leftOut === 1 ? '1 more was' : `${numberFormat.format(styles.leftOut)} more were`;
  return `${text} ${more} not kept; the activity log says why.`;
}
