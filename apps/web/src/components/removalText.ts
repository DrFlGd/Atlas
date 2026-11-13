import type { ImagesDeleted, ImagesInfo, PackDeleted } from '../desktop';
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

/** What deleting a whole pack removes. `info` is null while it is counted. */
export function deletePackDetails(title: string, info: ImagesInfo | null): string[] {
  const images =
    info === null
      ? 'its downloaded map images'
      : info.files === 0
        ? 'everything else in its folder'
        : `its ${imagesAmount(info)}`;
  const lines = [
    `This removes ${title} from the maps folder, with its locations, checklists and ${images}. This cannot be undone.`,
  ];
  if (info?.downloading) {
    lines.push('Its map images are downloading right now. The download is stopped first.');
  }
  return lines;
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
