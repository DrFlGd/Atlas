import { newOwnId } from '@atlas/core';
import {
  MAX_OWN_PICTURE_BYTES,
  OWN_PICTURE_TYPES,
  OWN_PICTURE_WIDTH,
  looksLikePicture,
  ownPicture,
  readOwnListsFile,
  readOwnLocationsFile,
  readOwnPagesFile,
  ownPictureFile,
  ownPictureType,
  type OwnPictureType,
  type Picture,
  type PictureFile,
  fromBase64,
  toBase64,
} from '@atlas/schema';
import { create } from 'zustand';
import { desktop } from '../desktop';
import { useOwnLists } from './ownLists';
import { useOwnLocations } from './ownLocations';
import { progressStore } from './services';
import { useAtlas } from './store';

/**
 * A person's own photos: the screenshots they add to steps of their own
 * lists, to their own locations and to guide pages. The records are kept with the list or
 * the own locations (see `ownPictures.ts` in the schema package); this
 * keeps their files:
 *
 * - in the desktop app, in a folder of the game's own beside its folder in
 *   the maps folder (`<game id>.my-pictures/`), through the shell;
 * - in the Android app and a browser, in the app's own storage, where
 *   progress is kept, one setting per photo (`ownPicture:<game id>:<file>`)
 *   and a setting that lists them (`ownPictures:<game id>`).
 *
 * A photo is never put in a pack's folder. Its file is written as it is
 * added, before the list or location naming it is saved; a file nothing
 * names any more (a photo removed, a list deleted, a change undone) is
 * deleted a while later, once Undo cannot bring it back, and when the game
 * is next opened.
 */

/** The largest picture file taken to be made into a photo, before shrinking. */
export const MAX_PICKED_PHOTO_BYTES = 40 << 20;

interface PictureBackend {
  read(gameId: string, file: string): Promise<Uint8Array | null>;
  write(gameId: string, file: string, bytes: Uint8Array): Promise<void>;
  list(gameId: string): Promise<string[]>;
  remove(gameId: string, files: readonly string[]): Promise<number>;
  removeAll(gameId: string): Promise<boolean>;
}

export const ownPicturesSetting = (gameId: string) => `ownPictures:${gameId}`;
const pictureSetting = (gameId: string, file: string) => `ownPicture:${gameId}:${file}`;

interface StoredPicture {
  type: string;
  data: Uint8Array;
}

/** One change at a time to the browser's list of photos, so none is lost. */
let indexTurn: Promise<unknown> = Promise.resolve();

function changeIndex(gameId: string, change: (files: string[]) => string[]): Promise<string[]> {
  const turn = indexTurn.then(async () => {
    const store = progressStore();
    const value = await store.getSetting(ownPicturesSetting(gameId));
    const before = Array.isArray(value)
      ? value.filter((file): file is string => typeof file === 'string')
      : [];
    const after = change(before);
    await store.putSetting(ownPicturesSetting(gameId), after.length > 0 ? after : null);
    return before;
  });
  indexTurn = turn.catch(() => undefined);
  return turn;
}

const browserBackend: PictureBackend = {
  async read(gameId, file) {
    const value: unknown = await progressStore().getSetting(pictureSetting(gameId, file));
    if (!value || typeof value !== 'object') return null;
    const { data } = value as Partial<StoredPicture>;
    if (data instanceof Uint8Array) return data;
    return null;
  },
  async write(gameId, file, bytes) {
    const type = ownPictureType(file) ?? 'image/jpeg';
    await progressStore().putSetting(pictureSetting(gameId, file), { type, data: bytes });
    await changeIndex(gameId, (files) => (files.includes(file) ? files : [...files, file]));
  },
  async list(gameId) {
    const value = await progressStore().getSetting(ownPicturesSetting(gameId));
    return Array.isArray(value) ? value.filter((f): f is string => typeof f === 'string') : [];
  },
  async remove(gameId, files) {
    const gone = new Set(files);
    const before = await changeIndex(gameId, (all) => all.filter((file) => !gone.has(file)));
    const store = progressStore();
    for (const file of files) await store.putSetting(pictureSetting(gameId, file), null);
    return before.filter((file) => gone.has(file)).length;
  },
  async removeAll(gameId) {
    const before = await changeIndex(gameId, () => []);
    const store = progressStore();
    for (const file of before) await store.putSetting(pictureSetting(gameId, file), null);
    return before.length > 0;
  },
};

function shellBackend(bridge: NonNullable<typeof desktop>): PictureBackend {
  return {
    read: (gameId, file) => bridge.ownPictures.read(gameId, file),
    write: (gameId, file, bytes) => bridge.ownPictures.write(gameId, file, toBase64(bytes)),
    list: (gameId) => bridge.ownPictures.list(gameId),
    remove: (gameId, files) => bridge.ownPictures.delete(gameId, [...files]),
    removeAll: (gameId) => bridge.ownPictures.deleteAll(gameId),
  };
}

/** Where own photos are kept on this device: with the own lists (see the top of this file). */
export function ownPicturesBackend(): PictureBackend {
  const { app } = useAtlas.getState();
  return desktop && app?.ownListFiles === true ? shellBackend(desktop) : browserBackend;
}

// ---------------------------------------------------------------------------
// Showing them

/** What the app knows of an own photo's file: a URL to show it, or that it is not there. */
type Loaded = { url: string } | { missing: true };

interface OwnPicturesState {
  /** By `<game id>/<file>`. */
  files: Readonly<Record<string, Loaded>>;
}

export const useOwnPictures = create<OwnPicturesState>()(() => ({ files: {} }));

const keyOf = (gameId: string, file: string) => `${gameId}/${file}`;
const asking = new Set<string>();

function remember(gameId: string, file: string, bytes: Uint8Array | null): void {
  const key = keyOf(gameId, file);
  const before = useOwnPictures.getState().files[key];
  if (before && 'url' in before) URL.revokeObjectURL(before.url);
  const type = ownPictureType(file) ?? 'image/jpeg';
  const loaded: Loaded = bytes
    ? { url: URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type })) }
    : { missing: true };
  useOwnPictures.setState((s) => ({ files: { ...s.files, [key]: loaded } }));
}

function forget(gameId: string, files: readonly string[]): void {
  const gone = new Set(files.map((file) => keyOf(gameId, file)));
  const now: Record<string, Loaded> = {};
  for (const [key, loaded] of Object.entries(useOwnPictures.getState().files)) {
    if (!gone.has(key)) now[key] = loaded;
    else if ('url' in loaded) URL.revokeObjectURL(loaded.url);
  }
  useOwnPictures.setState({ files: now });
}

/** Reads an own picture's file once, to show it (see `useOwnPictures`). */
function ask(gameId: string, file: string): void {
  const key = keyOf(gameId, file);
  if (asking.has(key)) return;
  asking.add(key);
  void ownPicturesBackend()
    .read(gameId, file)
    .then(
      (bytes) => {
        remember(gameId, file, bytes && bytes.length > 0 ? bytes : null);
      },
      () => {
        remember(gameId, file, null);
      },
    )
    .finally(() => {
      asking.delete(key);
    });
}

/**
 * Where an own picture is shown from now, outside React: a URL once its
 * file is read, null while it is read (it is asked for), `missing` when it
 * is not there. Follow `useOwnPictures` to see it arrive.
 */
export function ownPictureUrl(gameId: string, picture: Picture): string | null {
  const file = ownPictureFile(picture);
  if (!file) return 'missing';
  const loaded = useOwnPictures.getState().files[keyOf(gameId, file)];
  if (!loaded) {
    ask(gameId, file);
    return null;
  }
  return 'url' in loaded ? loaded.url : 'missing';
}

/**
 * Where an own picture is shown from: a URL once its file is read, null
 * while it is read, `missing` when it is not there. Asks for it once.
 */
export function useOwnPictureUrl(gameId: string, picture: Picture | undefined): string | null {
  const file = picture ? ownPictureFile(picture) : null;
  const loaded = useOwnPictures((s) => (file ? s.files[keyOf(gameId, file)] : undefined));
  if (!file) return 'missing';
  if (!loaded) {
    ask(gameId, file);
    return null;
  }
  return 'url' in loaded ? loaded.url : 'missing';
}

/**
 * Other own records of a game that show own photos (own pages): what they
 * name, so a photo is never taken for one nothing names.
 */
export interface OwnPictureSource {
  /** Whether the records of this game are read, can be changed, and so name every photo they show. */
  ready(gameId: string): boolean;
  /** The pictures they name now, Undo and what is being edited included. */
  pictures(): readonly Picture[];
}

const sources: OwnPictureSource[] = [];

/** Adds a kind of own record that shows own photos (see `OwnPictureSource`). */
export function addOwnPictureSource(source: OwnPictureSource): void {
  if (!sources.includes(source)) sources.push(source);
}

/** The own pictures of the game shown: those of its own lists, locations and pages. */
export function ownPicturesOfGame(): Map<string, Picture> {
  const pictures = new Map<string, Picture>();
  for (const list of useOwnLists.getState().lists) {
    for (const picture of list.pictures ?? []) pictures.set(picture.id, picture);
  }
  for (const picture of useOwnLocations.getState().own.pictures ?? []) {
    pictures.set(picture.id, picture);
  }
  for (const source of sources) {
    for (const picture of source.pictures()) pictures.set(picture.id, picture);
  }
  return pictures;
}

// ---------------------------------------------------------------------------
// Adding them

/** The type of a picture's bytes, when it is one Atlas keeps. */
export function pictureTypeOf(bytes: Uint8Array): OwnPictureType | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  return looksLikePicture(bytes) ? 'image/webp' : null;
}

/** A picture made ready to keep as a photo. */
export interface ShrunkPhoto {
  bytes: Uint8Array;
  type: OwnPictureType;
  width: number;
  height: number;
}

function encode(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, type, 0.85);
  });
}

/**
 * A picture's bytes made into a photo: at most `OWN_PICTURE_WIDTH` pixels
 * wide, its shape kept, never made larger. One narrow enough is kept as it
 * is; a wider one is drawn smaller and stored as WebP where the browser
 * can write it, else JPEG.
 */
export async function shrinkPhoto(bytes: Uint8Array): Promise<ShrunkPhoto> {
  const type = pictureTypeOf(bytes);
  if (!type) throw new Error('That is not a PNG, JPEG or WebP picture.');
  if (bytes.length > MAX_PICKED_PHOTO_BYTES) throw new Error('That picture is too large.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  } catch {
    throw new Error('That picture could not be read.');
  }
  const { width, height } = bitmap;
  if (width <= OWN_PICTURE_WIDTH && bytes.length <= MAX_OWN_PICTURE_BYTES) {
    bitmap.close();
    return { bytes, type, width, height };
  }
  const scale = Math.min(1, OWN_PICTURE_WIDTH / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('That picture could not be made smaller here.');
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  let blob = await encode(canvas, 'image/webp');
  if (blob?.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg');
  if (!blob) throw new Error('That picture could not be made smaller here.');
  const out = new Uint8Array(await blob.arrayBuffer());
  if (out.length > MAX_OWN_PICTURE_BYTES) throw new Error('That picture is too large.');
  return {
    bytes: out,
    type: blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg',
    width: w,
    height: h,
  };
}

/** Every own picture id in use in the game shown, so a new one is none of them. */
function takenPictureIds(): Set<string> {
  return new Set(ownPicturesOfGame().keys());
}

/**
 * Keeps a photo's file and gives its record, to add to a step or a
 * location. The file is written first, so a record never names a file
 * that is not there.
 */
export async function keepPhoto(gameId: string, photo: ShrunkPhoto): Promise<Picture> {
  const id = newOwnId(gameId, 'picture', takenPictureIds());
  const picture = ownPicture(id, photo.type, photo.width, photo.height);
  const file = ownPictureFile(picture);
  if (!file) throw new Error('The photo could not be named.');
  await ownPicturesBackend().write(gameId, file, photo.bytes);
  remember(gameId, file, photo.bytes);
  return picture;
}

/**
 * Asks for a picture to add as a photo: the shell's open dialog in the
 * desktop app, a file picker elsewhere. Null when nothing was chosen.
 */
export async function pickPhoto(input: HTMLInputElement | null): Promise<Uint8Array | null> {
  const { app } = useAtlas.getState();
  if (desktop && app?.ownListFiles === true) {
    const bytes = await desktop.ownPictures.pick();
    return bytes.length > 0 ? bytes : null;
  }
  if (!input) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: Uint8Array | null) => {
      if (settled) return;
      settled = true;
      input.removeEventListener('change', changed);
      input.removeEventListener('cancel', cancelled);
      input.value = '';
      resolve(value);
    };
    const changed = () => {
      const file = input.files?.[0];
      if (!file) {
        done(null);
        return;
      }
      if (file.size > MAX_PICKED_PHOTO_BYTES) {
        done(new Uint8Array());
        return;
      }
      void file.arrayBuffer().then(
        (buffer) => {
          done(new Uint8Array(buffer));
        },
        () => {
          done(new Uint8Array());
        },
      );
    };
    const cancelled = () => {
      done(null);
    };
    input.addEventListener('change', changed);
    input.addEventListener('cancel', cancelled);
    input.click();
  });
}

/** The types a file picker offers for photos. */
export const PHOTO_ACCEPT = Object.keys(OWN_PICTURE_TYPES).join(',');

// ---------------------------------------------------------------------------
// Carrying them in files

/** The files of own pictures, as a list file or a map pack file carries them. */
export async function pictureFilesOf(
  gameId: string,
  pictures: readonly Picture[],
): Promise<PictureFile[]> {
  const backend = ownPicturesBackend();
  const files: PictureFile[] = [];
  for (const picture of pictures) {
    const file = ownPictureFile(picture);
    if (!file) continue;
    const bytes = await backend.read(gameId, file).catch(() => null);
    if (bytes && bytes.length > 0) files.push({ file: picture.file, data: toBase64(bytes) });
  }
  return files;
}

/**
 * Keeps the files a list file or a map pack file carried, under the names
 * given (`renamed`, from a name in the file to the name kept). Returns how
 * many were kept; what is not a picture is left out.
 */
export async function keepPictureFiles(
  gameId: string,
  files: readonly PictureFile[],
  renamed: ReadonlyMap<string, string> = new Map(),
): Promise<number> {
  const backend = ownPicturesBackend();
  let kept = 0;
  for (const { file, data } of files) {
    const target = (renamed.get(file) ?? file).slice('pictures/'.length);
    const bytes = fromBase64(data);
    if (!bytes || !looksLikePicture(bytes) || bytes.length > MAX_OWN_PICTURE_BYTES) continue;
    if (ownPictureType(target) === null) continue;
    await backend.write(gameId, target, bytes);
    forget(gameId, [target]);
    kept++;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Deleting them

/** How long after a photo stops being named its file is deleted: after Undo has gone. */
const SWEEP_DELAY_MS = 120_000;
let sweepTimer: number | undefined;

/** Whether the lists and locations of a game are read and can be trusted to name every photo. */
function allRead(gameId: string): boolean {
  const lists = useOwnLists.getState();
  const locations = useOwnLocations.getState();
  return (
    lists.gameId === gameId &&
    lists.status === 'ready' &&
    lists.readOnly === null &&
    locations.gameId === gameId &&
    locations.status === 'ready' &&
    locations.readOnly === null &&
    sources.every((source) => source.ready(gameId))
  );
}

/** The photo files the game's own lists and locations name, Undo included. */
function namedFiles(): Set<string> {
  const named = new Set<string>();
  const add = (pictures: readonly Picture[] | undefined) => {
    for (const picture of pictures ?? []) {
      const file = ownPictureFile(picture);
      if (file) named.add(file);
    }
  };
  for (const list of useOwnLists.getState().lists) add(list.pictures);
  const locations = useOwnLocations.getState();
  add(locations.own.pictures);
  for (const step of locations.undo) add(step.before.pictures);
  for (const source of sources) add(source.pictures());
  return named;
}

/**
 * Deletes the photo files of a game that nothing names any more. Only when
 * its own lists and locations were all read, so a file never goes because
 * the record naming it could not be read.
 */
export async function sweepOwnPictures(gameId: string): Promise<number> {
  if (!allRead(gameId)) return 0;
  const backend = ownPicturesBackend();
  const stored = await backend.list(gameId).catch(() => [] as string[]);
  if (!allRead(gameId)) return 0;
  const named = namedFiles();
  const unused = stored.filter((file) => !named.has(file));
  if (unused.length === 0) return 0;
  forget(gameId, unused);
  return backend.remove(gameId, unused).catch(() => 0);
}

const sweptOnOpen = new Set<string>();

/** Once a game is open and its own records are read: deletes photos nothing names, once a session. */
export function sweepOwnPicturesOnOpen(gameId: string): void {
  if (sweptOnOpen.has(gameId)) return;
  sweptOnOpen.add(gameId);
  window.setTimeout(() => {
    void sweepOwnPictures(gameId);
  }, 5_000);
}

/** Deletes the photos nothing names a while from now, once Undo cannot bring them back. */
export function sweepOwnPicturesLater(): void {
  window.clearTimeout(sweepTimer);
  sweepTimer = window.setTimeout(() => {
    const gameId = useOwnLists.getState().gameId;
    if (gameId) void sweepOwnPictures(gameId);
  }, SWEEP_DELAY_MS);
}

/** Deletes the files of some own pictures of a game: those of own records being deleted. */
export async function deleteOwnPictures(
  gameId: string,
  pictures: readonly Picture[],
): Promise<number> {
  const files = pictures.flatMap((picture) => ownPictureFile(picture) ?? []);
  if (files.length === 0) return 0;
  forget(gameId, files);
  return ownPicturesBackend().remove(gameId, files);
}

/** The own pictures an own lists, locations or pages file names, from its text. */
export function picturesInFile(
  text: string | null,
  kind: 'lists' | 'locations' | 'pages',
): Picture[] {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return [];
  }
  if (kind === 'lists') {
    const read = readOwnListsFile(value);
    return read.ok ? read.file.lists.flatMap((list) => list.pictures ?? []) : [];
  }
  if (kind === 'pages') {
    const read = readOwnPagesFile(value);
    return read.ok ? (read.file.own.pictures ?? []) : [];
  }
  const read = readOwnLocationsFile(value);
  return read.ok ? (read.file.own.pictures ?? []) : [];
}

/** Deletes every own photo of a game, as its own lists and locations are deleted. */
export async function deleteOwnPicturesOf(gameId: string): Promise<boolean> {
  const files = Object.keys(useOwnPictures.getState().files)
    .filter((key) => key.startsWith(`${gameId}/`))
    .map((key) => key.slice(gameId.length + 1));
  forget(gameId, files);
  return ownPicturesBackend().removeAll(gameId);
}
