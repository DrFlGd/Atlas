import type { ImagesDeleted, ImagesInfo, PackDeleted } from '../desktop';
import type { GameKind } from '../state/gameFacts';
import type { SiteNotesHeld } from '../state/wikiNotes';
import { formatBytes } from './downloadFormat';

/**
 * The words of "Delete…" and "Delete downloaded images…" in the Maps
 * dialog: what will be removed, roughly how much, and what happened.
 */

const count = new Intl.NumberFormat('en');

/** "1 map image", "1,234 map images". */
export function imageCount(files: number): string {
  return `${count.format(files)} map image${files === 1 ? '' : 's'}`;
}

/** "1,234 map images (about 45 MB)". */
export function imagesAmount(images: { files: number; bytes: number }): string {
  return images.bytes > 0
    ? `${imageCount(images.files)} (about ${formatBytes(images.bytes)})`
    : imageCount(images.files);
}

/** What the app remembers of a wiki's site, which goes when the wiki is deleted or started again. */
export const SITE_MEMORY =
  'its list of pages, the pages that could not be read, the pages you left out, the links and other names of its pages, the pages kept for later, how its pages are read, and the licence you confirmed for it';

/** What this app still remembers of a site, in words, each part a phrase (see `siteMemory` in `importing.ts`). */
export function memoryParts(
  memory: { held: SiteNotesHeld; queued: number },
  { way }: { way: boolean },
): string[] {
  const { held, queued } = memory;
  const pages = (n: number, what: string) =>
    `${count.format(n)} ${n === 1 ? 'page' : 'pages'} ${what}`;
  return [
    ...(held.contents ? ['its list of pages'] : []),
    ...(held.failed > 0 ? [pages(held.failed, 'that could not be read')] : []),
    ...(held.leftOut > 0 ? [pages(held.leftOut, 'you left out')] : []),
    ...(held.links > 0 ? ['the links and other names of pages read before'] : []),
    ...(queued > 0 ? [pages(queued, 'kept for later')] : []),
    ...(held.licence ? ['the licence you confirmed for it'] : []),
    ...(way && held.way ? ['how its pages are read'] : []),
  ];
}

/** "Delete…" in More, named for what the game is. */
export function deleteRow(kind: GameKind, grouped: boolean): { title: string; text: string } {
  const asked = 'You are asked first, and told what happens to the marks you made.';
  if (kind === 'wiki') {
    return {
      title: 'Delete this wiki',
      text: `Deletes only this wiki: the pages read from it, their pictures, and what this app remembers of its site.${
        grouped ? ' The other sources of its title stay.' : ''
      } ${asked}`,
    };
  }
  if (kind === 'maps') {
    return {
      title: 'Delete these maps',
      text: `Deletes only these maps: their folder with the maps, locations and images.${
        grouped ? ' The other sources of their title stay.' : ''
      } ${asked}`,
    };
  }
  return {
    title: 'Delete this game',
    text: `Deletes only this game made in this app: its folder with its maps and images.${
      grouped ? ' The other sources of its title stay.' : ''
    } ${asked}`,
  };
}

/** The question before deleting a pack, named for what it is. */
export function deletePackQuestion(title: string, kind: GameKind): string {
  if (kind === 'wiki') return `Delete the wiki ${title}?`;
  if (kind === 'maps') return `Delete the maps of ${title}?`;
  return `Delete ${title}?`;
}

/**
 * That only this pack is deleted: the other sources of the title it is
 * shown under stay, or the other games.
 */
export function onlyThisText(kind: GameKind, inTitle: string | undefined): string {
  const only =
    kind === 'wiki'
      ? 'Only this wiki is deleted.'
      : kind === 'maps'
        ? 'Only these maps are deleted.'
        : 'Only this game is deleted.';
  return inTitle
    ? `${only} It leaves the title ${inTitle}. The other sources stay under it.`
    : `${only} Your other games stay.`;
}

/**
 * What happens to what the app remembers of a wiki's site: forgotten, or
 * kept when another wiki in the Library is read from it. `site` is
 * undefined while it is looked up, null when the app keeps nothing of it
 * (its importer is not in this app).
 */
export function siteMemoryText(
  site: { key: string; shared: boolean } | null | undefined,
): string | null {
  if (site === null) return null;
  if (site === undefined) return 'This app also forgets what it remembers of the wiki’s site.';
  return site.shared
    ? `What this app remembers of the wiki’s site, ${site.key}, is kept, because another wiki in the Library is read from it.`
    : `This app also forgets what it remembers of the wiki’s site, ${site.key}: ${SITE_MEMORY}. Adding the wiki again then asks again how its pages are read.`;
}

/** What deleting a whole pack removes. `info` is null while it is counted. */
export function deletePackDetails(
  title: string,
  info: ImagesInfo | null,
  kind: GameKind = 'maps',
): string[] {
  const downloading = info?.downloading
    ? ['Its map images are downloading right now. The download is stopped first.']
    : [];
  if (kind === 'wiki') {
    return [
      `This removes the wiki ${title} from the maps folder, with the pages read from it and their downloaded pictures. This cannot be undone.`,
      ...downloading,
    ];
  }
  const images =
    info === null
      ? 'its downloaded map images'
      : info.files === 0
        ? 'everything else in its folder'
        : `its ${imagesAmount(info)}`;
  return [
    `This removes ${title} from the maps folder, with its locations, checklists and ${images}. This cannot be undone.`,
    ...downloading,
  ];
}

/** What to say once a pack is deleted. */
export function deletePackResult(
  title: string,
  outcome: PackDeleted,
  withProgress: boolean,
): string {
  const done = withProgress
    ? `Deleted ${title} and your progress for it.`
    : `Deleted ${title}. Your progress is kept in case you add it again.`;
  return outcome.complete
    ? done
    : `${done} A few of its files were in use by another program, so Atlas removes them the next time it starts.`;
}

/** What deleting a pack's downloaded images removes. `info` is null while it is counted. */
export function deleteImagesDetails(title: string, info: ImagesInfo | null): string[] {
  if (info === null) return ['Counting the downloaded map images…'];
  if (info.files === 0 && !info.downloading) {
    return [`There are no downloaded map images of ${title} to delete.`];
  }
  const lines = [
    info.files === 0
      ? `A download of ${title} has started, but no map images are saved yet.`
      : `This removes ${imagesAmount(info)} of ${title} from this computer.`,
    `${title} itself stays, with its locations, checklists and your found marks. You can download the images again later.`,
  ];
  if (info.downloading) lines.push('The download that is running is stopped first.');
  return lines;
}

/** What to say once a pack's downloaded images are deleted. */
export function deleteImagesResult(title: string, outcome: ImagesDeleted): string {
  const done =
    outcome.files === 0
      ? `No map images of ${title} needed deleting.`
      : `Deleted ${imagesAmount(outcome)} of ${title}.`;
  return outcome.left === 0
    ? done
    : `${done} ${imageCount(outcome.left)} ${outcome.left === 1 ? 'was' : 'were'} in use by another program and ${outcome.left === 1 ? 'is' : 'are'} still there. Close other programs that may use them and try again.`;
}

/**
 * A command's error in plain words. The shell's own messages are plain
 * already; a raw system error is replaced by a general explanation.
 */
export function plainError(error: unknown, what: string): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/os error|\berrno\b|\b0x[0-9a-f]+\b/i.test(text) || text.trim() === '') {
    return `Atlas could not ${what}. Some of its files may be in use by another program or on a drive that is not connected. Close other programs that may use them and try again.`;
  }
  return text;
}
