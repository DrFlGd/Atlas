import { describe, expect, it } from 'vitest';
import type { DownloadSettingsInfo, DownloadSnapshot, PhotoPlan } from '../desktop';
import { followMapPhotos, listsLocationPhotos, useMapPhotos } from './mapPhotos';

type State = DownloadSnapshot['state'];

const snapshot = (state: State, statusRevision = 0): DownloadSnapshot =>
  ({ packId: 'isle', state, statusRevision }) as DownloadSnapshot;

/**
 * A stand-in for the shell: the map images job goes through `images`, one
 * state a look; the photo job through `photos` once started, one a look.
 */
function shell({
  images = [] as (State | null)[],
  photos = [] as State[],
  remaining = 2,
  last = null as State | null,
  withMap = true as boolean | undefined,
}) {
  const calls: string[] = [];
  let imageStep = 0;
  let photoStep = -1;
  const photo = () => (photoStep < 0 ? null : photos[Math.min(photoStep, photos.length - 1)]!);
  return {
    calls,
    settings(): Promise<DownloadSettingsInfo> {
      return Promise.resolve({
        settings: {
          parallel: 2,
          pauseMs: 250,
          requestsPerMinute: null,
          kilobytesPerSecond: null,
          ...(withMap === undefined ? {} : { photosWithMap: withMap }),
        },
      } as DownloadSettingsInfo);
    },
    snapshot(): Promise<DownloadSnapshot | null> {
      calls.push('images');
      const state = images[Math.min(imageStep++, images.length - 1)] ?? null;
      return Promise.resolve(state ? snapshot(state) : null);
    },
    photosPlan(): Promise<PhotoPlan> {
      calls.push('plan');
      return Promise.resolve({
        packId: 'isle',
        total: 2,
        remaining,
        hosts: [],
        job: last ? snapshot(last) : null,
        busyWith: null,
      });
    },
    photosStart(): Promise<DownloadSnapshot> {
      calls.push('start');
      photoStep = 0;
      return Promise.resolve(snapshot(photo()!, photoStep));
    },
    photosSnapshot(): Promise<DownloadSnapshot | null> {
      calls.push('look');
      photoStep += 1;
      const state = photo();
      return Promise.resolve(state ? snapshot(state, photoStep) : null);
    },
    photosPause(): Promise<DownloadSnapshot> {
      calls.push('pause');
      return Promise.resolve(snapshot('paused'));
    },
    photosResume(): Promise<DownloadSnapshot> {
      calls.push('resume');
      return Promise.resolve(snapshot('running'));
    },
  };
}

const noWait = () => Promise.resolve();
const quiet = { sleep: noWait, onSaved: () => undefined };

describe('the location photos of a map just added', () => {
  it('starts after the map images are over, and follows the download to its end', async () => {
    const tiles = shell({
      images: ['running', 'running', 'done', 'done'],
      photos: ['running', 'running', 'done'],
    });
    let saved = 0;
    const end = await followMapPhotos('isle', tiles, { sleep: noWait, onSaved: () => saved++ });
    expect(end).toBe('done');
    // Nothing of the photos while the map images download.
    expect(tiles.calls.slice(0, 4)).toEqual(['images', 'images', 'images', 'plan']);
    expect(tiles.calls.filter((call) => call === 'start')).toHaveLength(1);
    expect(saved).toBeGreaterThan(0);
    expect(useMapPhotos.getState().following).toEqual({});
  });

  it('starts at once for a map with no map image download', async () => {
    const tiles = shell({ images: [null], photos: ['running', 'done'] });
    expect(await followMapPhotos('isle', tiles, quiet)).toBe('done');
    expect(tiles.calls.slice(0, 3)).toEqual(['images', 'plan', 'start']);
  });

  it('waits for map images the person paused too', async () => {
    const tiles = shell({ images: ['paused', 'paused', 'cancelled'], photos: ['done'] });
    expect(await followMapPhotos('isle', tiles, quiet)).toBe('done');
    expect(tiles.calls.slice(0, 4)).toEqual(['images', 'images', 'images', 'plan']);
  });

  it('does nothing when the download settings say not to, unless the person asks', async () => {
    const off = shell({ withMap: false, photos: ['done'] });
    expect(await followMapPhotos('isle', off, quiet)).toBe('off');
    expect(off.calls).toEqual([]);
    expect(await followMapPhotos('isle', off, { ...quiet, asked: true })).toBe('done');
    // A shell before the setting: on.
    const older = shell({ withMap: undefined, photos: ['done'] });
    expect(await followMapPhotos('isle', older, quiet)).toBe('done');
  });

  it('never starts a second download, nor one with nothing to fetch', async () => {
    for (const last of ['running', 'queued', 'waiting', 'paused'] as const) {
      const tiles = shell({ last, photos: ['done'] });
      expect(await followMapPhotos('isle', tiles, quiet)).toBe('busy');
      expect(tiles.calls).not.toContain('start');
    }
    const none = shell({ remaining: 0, photos: ['done'] });
    expect(await followMapPhotos('isle', none, quiet)).toBe('none');
    expect(none.calls).not.toContain('start');
  });

  it('does not start by itself after a refusal or after the person stopped it', async () => {
    for (const last of ['stopped', 'cancelled'] as const) {
      const tiles = shell({ last, photos: ['done'] });
      expect(await followMapPhotos('isle', tiles, quiet)).toBe('left-alone');
      expect(tiles.calls).not.toContain('start');
      // Pressed on a location's card: the person asks for it.
      const asked = shell({ last, photos: ['done'] });
      expect(await followMapPhotos('isle', asked, { ...quiet, asked: true })).toBe('done');
    }
  });

  it('lets a download of the map images that waits its turn go first', async () => {
    // Photos run; the person starts the map images, which wait for them.
    const tiles = shell({
      images: [null, 'queued', 'running', 'done'],
      photos: ['running', 'paused', 'paused', 'running', 'done'],
    });
    expect(await followMapPhotos('isle', tiles, quiet)).toBe('done');
    const pause = tiles.calls.indexOf('pause');
    const resume = tiles.calls.indexOf('resume');
    expect(pause).toBeGreaterThan(tiles.calls.indexOf('start'));
    expect(resume).toBeGreaterThan(pause);
    expect(tiles.calls.filter((call) => call === 'pause')).toHaveLength(1);
  });

  it('ends with a refusal and is not started again', async () => {
    const tiles = shell({ photos: ['running', 'stopped'] });
    expect(await followMapPhotos('isle', tiles, quiet)).toBe('stopped');
    expect(tiles.calls.filter((call) => call === 'start')).toHaveLength(1);
  });
});

describe('listsLocationPhotos', () => {
  const picture = (id: string, remote?: string) => ({
    id: `isle:picture:${id}`,
    file: `pictures/${id}.jpg`,
    shareable: false,
    ...(remote ? { remote } : {}),
  });
  it('is true only for photos of locations or entries to be fetched later', () => {
    const pictures = [picture('a', 'https://pictures.example.com/a.jpg'), picture('b')];
    const at = (id: string) => [{ photos: [{ picture: `isle:picture:${id}` }] }];
    expect(listsLocationPhotos({ locations: at('a'), pictures } as never)).toBe(true);
    expect(listsLocationPhotos({ locations: [], checklistItems: at('a'), pictures } as never)).toBe(
      true,
    );
    expect(listsLocationPhotos({ locations: at('b'), pictures } as never)).toBe(false);
    expect(listsLocationPhotos({ locations: [], pictures } as never)).toBe(false);
  });
});
