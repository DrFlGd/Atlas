import { z } from 'zod';
import type { Photo, Picture } from './entities';
import { isOwnId, makeId, OWN_ID_PREFIX, parseId } from './ids';

/**
 * A person's own photos: screenshots they add to a step of their own list
 * or to a location of their own. Each is a picture in the pack format (see
 * `pictureSchema`), with an own id (`<gameId>:picture:own.<random>`), kept
 * in the record of what it belongs to: the list (`OwnList.pictures`) or the
 * own locations file (`pictures`). The steps and locations name them as
 * photos, as a pack's do.
 *
 * Their files are never in a pack's folder. The `file` of an own picture is
 * `pictures/<local id>.<jpg|png|webp>`, a name in the game's own pictures:
 * in the desktop app the folder `<game id>.my-pictures/` beside the game's
 * folder in the maps folder; elsewhere the app's own storage. They are
 * shrunk to at most {@link OWN_PICTURE_WIDTH} pixels wide when added.
 */

/** The widest an own photo is stored, in pixels; a narrower one is kept as it is. */
export const OWN_PICTURE_WIDTH = 1280;
/** The largest own photo file kept, after shrinking. */
export const MAX_OWN_PICTURE_BYTES = 8 << 20;
/** The most own photos a list or a game's own locations may have. */
export const MAX_OWN_PICTURES = 2000;

/** The name of an own photo's file: its local id and an extension. */
export const OWN_PICTURE_FILE_PATTERN = /^own\.[a-z0-9]{1,40}\.(?:jpg|png|webp)$/;

/** The extensions an own photo is stored with, by the type of its bytes. */
export const OWN_PICTURE_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

export type OwnPictureType = keyof typeof OWN_PICTURE_TYPES;

/** The type of an own photo's bytes, from its file name. */
export function ownPictureType(file: string): OwnPictureType | null {
  const extension = file.slice(file.lastIndexOf('.') + 1);
  const found = Object.entries(OWN_PICTURE_TYPES).find(([, ext]) => ext === extension);
  return found ? (found[0] as OwnPictureType) : null;
}

/** The file name (without `pictures/`) of an own picture, or null when it is not one. */
export function ownPictureFile(picture: Pick<Picture, 'id' | 'file'>): string | null {
  if (!isOwnId(picture.id) || !picture.file.startsWith('pictures/')) return null;
  const name = picture.file.slice('pictures/'.length);
  if (!OWN_PICTURE_FILE_PATTERN.test(name)) return null;
  // The file is named after the picture's id, so two pictures never share one.
  return name.slice(0, name.lastIndexOf('.')) === parseId(picture.id)?.localId ? name : null;
}

/** A new own picture's record, for a file of a type, at a size. */
export function ownPicture(
  id: string,
  type: OwnPictureType,
  width: number,
  height: number,
): Picture {
  const local = parseId(id)?.localId ?? `${OWN_ID_PREFIX}photo`;
  return {
    id,
    file: `pictures/${local}.${OWN_PICTURE_TYPES[type]}`,
    shareable: true,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/** The same picture under another own id (when an import finds its id taken). */
export function renamedPicture(picture: Picture, id: string): Picture {
  const extension = picture.file.slice(picture.file.lastIndexOf('.'));
  const local = parseId(id)?.localId ?? '';
  return { ...picture, id, file: `pictures/${local}${extension}` };
}

/** Whether a picture id is of a game and one of a person's own. */
export function isOwnPictureId(id: string, gameId?: string): boolean {
  const parsed = parseId(id);
  return (
    parsed?.kind === 'picture' &&
    parsed.localId.startsWith(OWN_ID_PREFIX) &&
    (gameId === undefined || parsed.gameId === gameId)
  );
}

/** An own picture id of a game from a local id. */
export const ownPictureId = (gameId: string, localId: string) => makeId(gameId, 'picture', localId);

/**
 * The pictures a record keeps that its photos name: what is kept when a
 * photo is removed, so a list never holds pictures nothing shows.
 */
export function picturesInUse(
  pictures: readonly Picture[],
  photos: Iterable<readonly Photo[] | undefined>,
): Picture[] {
  const used = new Set<string>();
  for (const list of photos) for (const photo of list ?? []) used.add(photo.picture);
  return pictures.filter((picture) => used.has(picture.id));
}

/**
 * The bytes of an own photo in a list file: its file name (as the
 * picture's `file` gives it) and its bytes in base64.
 */
export const pictureFileSchema = z.object({
  file: z
    .string()
    .refine(
      (file) =>
        file.startsWith('pictures/') &&
        OWN_PICTURE_FILE_PATTERN.test(file.slice('pictures/'.length)),
      'must be pictures/own.<name>.jpg, .png or .webp',
    ),
  data: z
    .string()
    .max(Math.ceil(MAX_OWN_PICTURE_BYTES / 3) * 4 + 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'must be base64'),
});

export type PictureFile = z.infer<typeof pictureFileSchema>;

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map(
  Array.from({ length: BASE64.length }, (_, i) => [BASE64.charCodeAt(i), i]),
);

/** Bytes as base64. */
export function toBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out.push(BASE64[n >> 18]! + BASE64[(n >> 12) & 63]! + BASE64[(n >> 6) & 63]! + BASE64[n & 63]!);
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = bytes[i]! << 16;
    out.push(`${BASE64[n >> 18]!}${BASE64[(n >> 12) & 63]!}==`);
  } else if (left === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out.push(`${BASE64[n >> 18]!}${BASE64[(n >> 12) & 63]!}${BASE64[(n >> 6) & 63]!}=`);
  }
  return out.join('');
}

/** The bytes of base64 text; null when it is not base64. */
export function fromBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let at = 0;
  for (let i = 0; i < text.length; i += 4) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const code = text.charCodeAt(i + k);
      const value = code === 61 && i + k >= text.length - padding ? 0 : BASE64_VALUES.get(code);
      if (value === undefined) return null;
      n = (n << 6) | value;
    }
    if (at < bytes.length) bytes[at++] = (n >> 16) & 255;
    if (at < bytes.length) bytes[at++] = (n >> 8) & 255;
    if (at < bytes.length) bytes[at++] = n & 255;
  }
  return bytes;
}

/** Whether bytes start as a PNG, JPEG or WebP file does. */
export function looksLikePicture(bytes: Uint8Array): boolean {
  const starts = (...values: number[]) => values.every((value, i) => bytes[i] === value);
  return (
    starts(0xff, 0xd8, 0xff) ||
    starts(0x89, 0x50, 0x4e, 0x47) ||
    (bytes.length >= 12 &&
      starts(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50)
  );
}
