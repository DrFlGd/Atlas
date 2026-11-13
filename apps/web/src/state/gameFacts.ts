import { create } from 'zustand';
import {
  desktop,
  type Detail,
  type DownloadPlan,
  type DownloadSnapshot,
  type ListedPack,
  type PackDetails,
  type PhotoPlan,
} from '../desktop';
import { downloadsOffered } from '../features';
import { useAtlas } from './store';

/**
 * What the Library says about each game, read from this computer only:
 * the pack's details (what it holds and how much of its map images is on
 * disk), and in an app that downloads, its photos and, for the game open,
 * the sizes of each detail of its map images. Nothing here asks a site for
 * anything: opening the Library reads files, never pages.
 */

export interface GameFacts {
  details: PackDetails | null;
  /** Why the details could not be read. */
  error: string | null;
  /** The photos the pack lists to be fetched later (an app that downloads). */
  photos: PhotoPlan | null;
  /** The map image download's choices (an app that downloads, the game open only). */
  images: DownloadPlan | null;
}

export const useGameFacts = create<{ byId: Record<string, GameFacts> }>()(() => ({ byId: {} }));

const EMPTY: GameFacts = { details: null, error: null, photos: null, images: null };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function patch(id: string, next: Partial<GameFacts>): void {
  const { byId } = useGameFacts.getState();
  useGameFacts.setState({ byId: { ...byId, [id]: { ...EMPTY, ...byId[id], ...next } } });
}

/** Reads the details of a game, and its photos in an app that downloads. */
export async function loadGameFacts(id: string, withImages = false): Promise<void> {
  const shell = desktop;
  if (!shell) return;
  const downloads = __ATLAS_DOWNLOADS__ && downloadsOffered(useAtlas.getState());
  const details = shell.packFiles.details(id).then(
    (loaded) => {
      patch(id, { details: loaded, error: null });
    },
    (error: unknown) => {
      patch(id, { error: errorText(error) });
    },
  );
  const photos = downloads
    ? shell.tiles.photosPlan(id).then(
        (plan) => {
          patch(id, { photos: plan });
        },
        () => {
          patch(id, { photos: null });
        },
      )
    : null;
  // Looks at every map image on disk: only for the game open.
  const images =
    downloads && withImages
      ? shell.tiles.plan(id).then(
          (plan) => {
            patch(id, { images: plan });
          },
          () => {
            patch(id, { images: null });
          },
        )
      : null;
  await Promise.all([details, photos, images]);
}

const following = new Set<string>();
const FOLLOW_MS = 1000;

/** A job that moves by itself: downloading or waiting its turn (not paused). */
const jobMoving = (job: DownloadSnapshot | null | undefined) =>
  job?.state === 'running' || job?.state === 'queued' || job?.state === 'waiting';

/**
 * Follows a game's map image and photo jobs once a second while one of
 * them moves, and reads the game's facts again when they stop. Reads the
 * shell's snapshots only, never a site.
 */
export function followJobs(id: string): void {
  const shell = desktop;
  if (!shell || !__ATLAS_DOWNLOADS__ || following.has(id)) return;
  following.add(id);
  let photoRevision = -1;
  const tick = async () => {
    const [images, photos] = await Promise.all([
      shell.tiles.snapshot(id).catch(() => null),
      shell.tiles.photosSnapshot(id).catch(() => null),
    ]);
    const facts = useGameFacts.getState().byId[id] ?? EMPTY;
    patch(id, {
      images: facts.images && images ? { ...facts.images, job: images } : facts.images,
      photos: facts.photos && photos ? { ...facts.photos, job: photos } : facts.photos,
    });
    // Photos just saved for the game shown: show them where they were missing.
    if (photos && photos.statusRevision !== photoRevision) {
      if (photoRevision !== -1 && useAtlas.getState().game?.entry.id === id) {
        useAtlas.setState({ tileRevision: useAtlas.getState().tileRevision + 1 });
      }
      photoRevision = photos.statusRevision;
    }
    if (jobMoving(images) || jobMoving(photos)) {
      window.setTimeout(() => void tick(), FOLLOW_MS);
    } else {
      following.delete(id);
      await loadGameFacts(id, true);
    }
  };
  window.setTimeout(() => void tick(), FOLLOW_MS);
}

/** Reads the facts of every game listed (not the sizes of their map images). */
export async function loadAllGameFacts(): Promise<void> {
  const ids = useAtlas.getState().catalog.map((entry) => entry.id);
  await Promise.all(ids.map((id) => loadGameFacts(id)));
}

// ---------------------------------------------------------------------------
// In words

/** What a game is, for the list: maps, a wiki read as guides, or a game made in this app. */
export type GameKind = 'maps' | 'wiki' | 'own';

export const KIND_LABEL: Record<GameKind, string> = {
  maps: 'Maps',
  wiki: 'Wiki',
  own: 'Made here',
};

export function gameKind(
  listed: Pick<ListedPack, 'madeInApp'> | undefined,
  details: Pick<PackDetails, 'contents'> | null,
): GameKind {
  if (listed?.madeInApp) return 'own';
  if (details?.contents.maps === 0 && details.contents.guides > 0) return 'wiki';
  return 'maps';
}

/** How many levels below the top each detail stops (see the shell's `Detail`). */
const DETAIL_DROP: Record<Detail, number> = { overview: 2, standard: 1, full: 0 };

export const DETAIL_NAME: Record<Detail, string> = {
  overview: 'Overview',
  standard: 'Standard',
  full: 'Full',
};

/**
 * The maps whose map images can be downloaded, and how many of them have
 * every level of `detail` on disk, from the pack's status files.
 */
export function mapsAtDetail(
  details: Pick<PackDetails, 'layers'>,
  detail: Detail,
): { done: number; total: number } {
  const byMap = new Map<string, boolean>();
  for (const layer of details.layers) {
    if (!layer.downloadable) continue;
    const top = Math.max(layer.minZoom, layer.maxZoom - DETAIL_DROP[detail]);
    let complete = true;
    for (let z = layer.minZoom; z <= top; z++) {
      if (!layer.levels.includes(z)) complete = false;
    }
    byMap.set(layer.mapName, (byMap.get(layer.mapName) ?? true) && complete);
  }
  return { done: [...byMap.values()].filter(Boolean).length, total: byMap.size };
}

/** A job that is not over: downloading, paused, or waiting its turn. */
export const jobGoing = (job: DownloadSnapshot | null | undefined): job is DownloadSnapshot =>
  job?.state === 'running' ||
  job?.state === 'paused' ||
  job?.state === 'queued' ||
  job?.state === 'waiting';

/** The jobs of a game that the Library knows of. */
export interface GameJobs {
  images: DownloadSnapshot | null;
  photos: DownloadSnapshot | null;
}

/** One line on a game, for the list. */
export interface StatusLine {
  text: string;
  tone: 'todo' | 'done' | 'busy' | 'plain' | 'problem';
  /** A share done, from 0 to 1, for a bar under the line. */
  progress?: number;
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/**
 * The game's one status line: what is going on now, else what is left to
 * do, else that everything is there. `reading` is the page run's progress
 * when it reads pages of this game.
 */
export function statusLine(options: {
  kind: GameKind;
  facts: GameFacts | undefined;
  jobs: GameJobs;
  downloads: boolean;
  reading?: { done: number; total: number } | null;
  /** Pages of a wiki: read, and listed by the wiki when its list is kept. */
  wikiPages?: { read: number; listed: number | null } | null;
}): StatusLine {
  const { kind, facts, jobs, downloads, reading, wikiPages } = options;
  if (reading) {
    return {
      text: `Reading page ${Math.min(reading.done + 1, reading.total)} of ${reading.total}`,
      tone: 'busy',
      progress: reading.total > 0 ? reading.done / reading.total : 0,
    };
  }
  for (const [job, noun] of [
    [jobs.images, 'map images'],
    [jobs.photos, kind === 'wiki' ? 'pictures' : 'photos'],
  ] as const) {
    if (!jobGoing(job)) continue;
    const share = job.total > 0 ? job.done / job.total : 0;
    if (job.state === 'paused')
      return { text: `Download of ${noun} paused`, tone: 'todo', progress: share };
    if (job.state !== 'running') return { text: `Waiting to download ${noun}`, tone: 'busy' };
    return {
      text: `Downloading ${noun}, ${Math.floor(share * 100)}%`,
      tone: 'busy',
      progress: share,
    };
  }
  if (jobs.images?.state === 'stopped' || jobs.photos?.state === 'stopped') {
    return { text: 'A download stopped: it needs you', tone: 'problem' };
  }
  if (facts?.images?.unfinished) return { text: 'A download was not finished', tone: 'todo' };
  if (kind === 'wiki' && wikiPages) {
    return wikiPages.listed !== null && wikiPages.listed > 0
      ? {
          text: `${wikiPages.read.toLocaleString('en')} of ${plural(wikiPages.listed, 'page', 'pages')} read`,
          tone: wikiPages.read >= wikiPages.listed ? 'done' : 'todo',
        }
      : { text: `${plural(wikiPages.read, 'page', 'pages')} read`, tone: 'plain' };
  }
  const details = facts?.details;
  if (!downloads || kind === 'own') {
    if (kind === 'own') return { text: 'Nothing to download', tone: 'done' };
    if (!details) return { text: '', tone: 'plain' };
    const { maps, locations, guides } = details.contents;
    return {
      text:
        maps === 0
          ? plural(guides, 'page', 'pages')
          : `${plural(maps, 'map', 'maps')}, ${plural(locations, 'location', 'locations')}`,
      tone: 'plain',
    };
  }
  if (!details) return { text: '', tone: 'plain' };
  let todo = 0;
  const downloadable = details.layers.some((layer) => layer.downloadable);
  if (downloadable && details.detail === null) todo++;
  const photos = facts.photos;
  if (photos && photos.remaining > 0) todo++;
  if (todo > 0) return { text: plural(todo, 'thing to do', 'things to do'), tone: 'todo' };
  if (downloadable || (photos && photos.total > 0)) {
    return { text: 'Everything downloaded', tone: 'done' };
  }
  return { text: 'Nothing to download', tone: 'done' };
}
