import { desktop, type DownloadSnapshot } from '../desktop';
import { useAtlas } from './store';

/**
 * The pictures of pages just added, fetched without being asked again: for
 * an importer whose pages come with their pictures
 * (`AtlasImporter.picturesWithPages`), in an app that downloads. It is the
 * same download as "Download location photos" in the Maps dialog (one at a time, at
 * the pace of the download settings, stopping on a refusal), started here
 * instead of there. Each picture shows on its page as soon as it is saved.
 *
 * Pages may be added while a pack's pictures are still coming in: the
 * pictures they list are fetched when the download under way is over.
 */

type Photos = Pick<NonNullable<typeof desktop>['tiles'], 'photosStart' | 'photosSnapshot'>;

/** Packs with pictures listed since their last download started. */
const wanted = new Set<string>();
/** Packs whose download is being followed. */
const followed = new Set<string>();

const POLL_MS = 1000;

const going = (job: DownloadSnapshot | null): boolean =>
  job?.state === 'running' || job?.state === 'queued' || job?.state === 'waiting';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shows pictures saved since they were last looked for. */
const showSaved = () => {
  useAtlas.setState({ tileRevision: useAtlas.getState().tileRevision + 1 });
};

/**
 * Fetches the pictures `packId` lists and does not have, and those listed
 * while it does. Ends when nothing is left to start: all fetched, none
 * listed, or the download paused or stopped (which the Maps dialog shows).
 */
export async function followPagePictures(
  packId: string,
  photos: Photos,
  sleep: (ms: number) => Promise<void> = wait,
  onSaved: () => void = showSaved,
): Promise<void> {
  while (wanted.delete(packId)) {
    let job: DownloadSnapshot | null;
    let started = true;
    try {
      job = await photos.photosStart(packId);
    } catch {
      // None to fetch, or this pack's pictures are coming in already.
      started = false;
      job = await photos.photosSnapshot(packId).catch(() => null);
    }
    const underWay = going(job);
    let revision = job?.statusRevision ?? -1;
    while (going(job)) {
      await sleep(POLL_MS);
      job = await photos.photosSnapshot(packId).catch(() => null);
      if (job && job.statusRevision !== revision) {
        revision = job.statusRevision;
        onSaved();
      }
    }
    onSaved();
    // A download someone else started knew nothing of the new pages: once more.
    if (!started && underWay) wanted.add(packId);
  }
}

/** Starts fetching the pictures of the pages just added to `packId`, in an app that downloads. */
export function fetchPagePictures(packId: string): void {
  if (!__ATLAS_DOWNLOADS__ || !desktop) return;
  wanted.add(packId);
  if (followed.has(packId)) return;
  followed.add(packId);
  void followPagePictures(packId, desktop.tiles)
    .catch(() => undefined)
    .finally(() => {
      followed.delete(packId);
    });
}

/** For tests: marks a pack as having new pictures listed, as {@link fetchPagePictures} does. */
export function wantPagePictures(packId: string): void {
  wanted.add(packId);
}
