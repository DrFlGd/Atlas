import type { PackData } from '@atlas/schema';
import { create } from 'zustand';
import { desktop, type DownloadSnapshot } from '../desktop';
import { downloadsOffered } from '../features';
import { useAtlas } from './store';

/**
 * The location photos of a map just added, downloaded without being asked
 * again ("Download location photos with a map" in the download settings,
 * on unless turned off), in an app that downloads. It is the same download
 * as "Download location photos" in the Library (one photo at a time, at the
 * pace of the download settings, stopping at the first refusal), started
 * here instead of there:
 *
 * - only once the map's own image download is over, or when there is none,
 *   never beside it; and while it runs, a download of the same game's map
 *   images that waits its turn goes first: the photos pause and go on when
 *   it is over, unless the person resumed them meanwhile;
 * - never a second one while one of the game's photo downloads is under
 *   way or paused, and never by itself after one of this session stopped at
 *   a refusal or a problem, or that the person cancelled (the Library then
 *   offers it again, as before).
 *
 * A location's card offers the same download for a game added before
 * ({@link downloadGamePhotos}): the person's press, so it starts even
 * after a download that stopped. Each photo shows as soon as it is saved.
 */

type Tiles = Pick<
  NonNullable<typeof desktop>['tiles'],
  | 'settings'
  | 'snapshot'
  | 'photosPlan'
  | 'photosStart'
  | 'photosSnapshot'
  | 'photosPause'
  | 'photosResume'
>;

/** What the download of a game's photos started here is doing. */
export type MapPhotosStep = 'waiting' | 'downloading';

/** The games whose photos are being looked after here, by pack id. */
export const useMapPhotos = create<{ following: Readonly<Record<string, MapPhotosStep>> }>(() => ({
  following: {},
}));

const POLL_MS = 1000;

const setStep = (packId: string, step: MapPhotosStep | null) => {
  const following = Object.fromEntries(
    Object.entries(useMapPhotos.getState().following).filter(([id]) => id !== packId),
  );
  useMapPhotos.setState({ following: step ? { ...following, [packId]: step } : following });
};

/** A job that downloads now or waits its turn. */
const going = (job: DownloadSnapshot | null | undefined): boolean =>
  job?.state === 'running' || job?.state === 'queued' || job?.state === 'waiting';

/** A job that is not over: going, or paused. */
const notOver = (job: DownloadSnapshot | null | undefined): boolean =>
  going(job) || job?.state === 'paused';

/**
 * A photo download of this session that the app does not start again by
 * itself: stopped at a refusal or a problem, or cancelled by the person.
 */
const leftAlone = (job: DownloadSnapshot | null | undefined): boolean =>
  job?.state === 'stopped' || job?.state === 'cancelled';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Shows photos saved since they were last looked for. */
const showSaved = () => {
  useAtlas.setState({ tileRevision: useAtlas.getState().tileRevision + 1 });
};

/** How {@link followMapPhotos} ended. */
export type MapPhotosEnd =
  'off' | 'none' | 'busy' | 'left-alone' | 'failed' | 'done' | 'stopped' | 'paused';

/**
 * Downloads the location photos of `packId` that are not here yet, after
 * its map images, and follows the download until it is over. `asked`: the
 * person pressed for it, so the setting and an earlier stop do not count.
 */
export async function followMapPhotos(
  packId: string,
  tiles: Tiles,
  { asked = false, sleep = wait, onSaved = showSaved } = {},
): Promise<MapPhotosEnd> {
  if (!asked) {
    const settings = await tiles.settings().catch(() => null);
    if (!settings || settings.settings.photosWithMap === false) return 'off';
  }
  const images = () => tiles.snapshot(packId).catch(() => null);
  setStep(packId, 'waiting');
  try {
    // After the map's own images, never beside them.
    while (notOver(await images())) await sleep(POLL_MS);
    const plan = await tiles.photosPlan(packId).catch(() => null);
    if (!plan || plan.remaining === 0) return 'none';
    if (notOver(plan.job)) return 'busy';
    if (!asked && leftAlone(plan.job)) return 'left-alone';
    let job: DownloadSnapshot | null;
    try {
      job = await tiles.photosStart(packId);
    } catch {
      return 'failed';
    }
    setStep(packId, 'downloading');
    let revision = job.statusRevision;
    // Paused here for the game's map images: the photos go on after them.
    let yielded = false;
    // The person resumed them meanwhile: not paused here again.
    let leftAsChosen = false;
    for (;;) {
      if (going(job)) {
        if (!yielded && !leftAsChosen && job?.state === 'running' && going(await images())) {
          const paused = await tiles.photosPause(packId).catch(() => null);
          if (paused) job = paused;
          yielded = paused?.state === 'paused';
        }
      } else if (yielded && job?.state === 'paused') {
        if (!going(await images())) {
          const resumed = await tiles.photosResume(packId).catch(() => null);
          if (resumed) job = resumed;
          yielded = false;
        }
      } else {
        break;
      }
      await sleep(POLL_MS);
      const next = await tiles.photosSnapshot(packId).catch(() => null);
      if (yielded && going(next)) {
        yielded = false;
        leftAsChosen = true;
      }
      job = next;
      if (job && job.statusRevision !== revision) {
        revision = job.statusRevision;
        onSaved();
      }
    }
    onSaved();
    return job?.state === 'done' ? 'done' : job?.state === 'paused' ? 'paused' : 'stopped';
  } finally {
    setStep(packId, null);
  }
}

/** Whether this app downloads location photos: a build and a shell with downloads. */
export function mapPhotosOffered(
  state: Parameters<typeof downloadsOffered>[0] = useAtlas.getState(),
): boolean {
  return __ATLAS_DOWNLOADS__ && desktop !== null && downloadsOffered(state);
}

/** Whether the download settings say to download a map's photos with it (on unless turned off). */
export async function photosWithMapOn(): Promise<boolean> {
  if (!mapPhotosOffered() || !desktop) return false;
  const info = await desktop.tiles.settings().catch(() => null);
  return info !== null && info.settings.photosWithMap !== false;
}

/** Whether a pack's locations or entries have photos to be fetched later. */
export function listsLocationPhotos(
  pack: Pick<PackData, 'locations' | 'checklistItems' | 'pictures'>,
): boolean {
  const remote = new Set(
    (pack.pictures ?? []).flatMap((picture) => (picture.remote ? [picture.id] : [])),
  );
  if (remote.size === 0) return false;
  const named = (entries: readonly { photos?: readonly { picture: string }[] }[] | undefined) =>
    (entries ?? []).some((entry) => entry.photos?.some((photo) => remote.has(photo.picture)));
  return named(pack.locations) || named(pack.checklistItems);
}

function follow(packId: string, asked: boolean): void {
  if (!mapPhotosOffered() || !desktop) return;
  // One at a time for a game.
  if (useMapPhotos.getState().following[packId]) return;
  void followMapPhotos(packId, desktop.tiles, { asked }).catch(() => {
    setStep(packId, null);
  });
}

/** Starts downloading the location photos of the map just added to `packId`, in an app that downloads. */
export function fetchMapPhotos(packId: string): void {
  follow(packId, false);
}

/** The person asked from a location's card: the photos of the game, after its map images. */
export function downloadGamePhotos(packId: string): void {
  follow(packId, true);
}
