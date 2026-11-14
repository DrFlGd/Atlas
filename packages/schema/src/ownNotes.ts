import { z } from 'zod';
import {
  MAX_PHOTOS,
  ownRecordWriteSchemas,
  packReadSchemas,
  type Photo,
  type Picture,
} from './entities';
import { gameIdSchema, idOf, isOwnId, parseId } from './ids';
import { MAX_OWN_NOTE_LENGTH, MAX_OWN_NAME_LENGTH } from './ownLocations';
import { MAX_OWN_PICTURES, ownPictureFile } from './ownPictures';

/**
 * A person's own notes on the locations that came with a game ("My note"
 * on a location's card), kept apart from every pack, as their own lists,
 * locations and pages are (see `ownLists.ts`).
 *
 * A pack's files are replaced whenever the pack is updated, rebuilt or
 * downloaded again, so a note is never written into them. It is kept here,
 * by the id of its location, with the location's name as it was when the
 * note was written: when a newer pack no longer has the location, the note
 * is kept and still says what it was about. A pack's `idMigrations` are
 * followed when the notes are shown, as they are for found marks, so a
 * renamed location keeps its note.
 *
 * A location of the person's own keeps its note where it always has, in the
 * own locations file (`ownLocations.ts`); this file holds notes on the
 * game's locations only. It is a file of its own, not a field of that one,
 * so an app that does not know notes never writes over them.
 *
 * - `notes`: by location id, the note's Markdown `text`, the location's
 *   `name` when it was written, its `photos` (the person's own pictures,
 *   kept in `pictures`) and when it was last changed.
 * - `pictures`: their own pictures the notes show (see `ownPictures.ts`).
 *
 * In the desktop app it is a file beside the game's folder in the maps
 * folder (`<game id>.my-notes.json`); elsewhere it is kept where progress
 * is kept. Written strictly, read tolerantly: one note that cannot be read
 * is left out, not the file. An app older than the file's version shows the
 * notes and does not change them.
 */

/** What the own notes file of a game says it is. */
export const OWN_NOTES_FORMAT = 'atlas-own-notes';
/** The version of the own notes file this app writes. */
export const OWN_NOTES_VERSION = 1;

/** The most notes one file may hold. */
export const MAX_OWN_NOTES = 50_000;

const isoTime = z.iso.datetime({ offset: true });

function ownNoteSchemas(mode: 'write' | 'read') {
  const reading = mode === 'read';
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);

  /** One note: its text, the location's name then, its photos and when it changed. */
  const ownNoteSchema = record({
    /** The note, in Markdown. */
    text: z.string().max(MAX_OWN_NOTE_LENGTH),
    /** The location's name when the note was written. */
    name: reading
      ? z.string().trim().min(1).max(MAX_OWN_NAME_LENGTH).catch('A location')
      : z.string().trim().min(1).max(MAX_OWN_NAME_LENGTH),
    /** Photos: the person's own pictures (in `pictures`). */
    photos: reading
      ? z.array(packReadSchemas.photoSchema).max(MAX_PHOTOS).optional().catch(undefined)
      : z.array(ownRecordWriteSchemas.photoSchema).max(MAX_PHOTOS).optional(),
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
  }).refine(
    (note) => note.text.trim() !== '' || (note.photos?.length ?? 0) > 0,
    'a note has a text or a photo',
  );

  /** A person's own picture, named as `ownPictureFile` says. */
  const ownPictureSchema = (
    reading ? packReadSchemas.pictureSchema : ownRecordWriteSchemas.pictureSchema
  ).refine(
    (picture) => ownPictureFile(picture) !== null,
    'must be an own picture: an own id, with pictures/<its local id>.jpg, .png or .webp',
  );

  const ownNotesFileSchema = record({
    format: z.literal(OWN_NOTES_FORMAT),
    version: reading ? z.int().positive() : z.literal(OWN_NOTES_VERSION),
    gameId: gameIdSchema,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    // Read one by one (see `readOwnNotesFile`), so one that cannot be read
    // does not lose the others.
    notes: reading
      ? z.record(z.string(), z.unknown()).catch({})
      : z.record(idOf('loc'), ownNoteSchema),
    pictures: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(ownPictureSchema).max(MAX_OWN_PICTURES).optional(),
  });

  return { ownNoteSchema, ownPictureSchema, ownNotesFileSchema };
}

/** The schemas this file is written with: strict. */
export const { ownNoteSchema, ownNotesFileSchema } = ownNoteSchemas('write');

/** The same schemas for reading: tolerant. */
export const ownNoteReadSchemas = ownNoteSchemas('read');

/** A person's note on one location. */
export interface OwnNote {
  /** Markdown. */
  text: string;
  /** The location's name when the note was written. */
  name: string;
  photos?: Photo[];
  updatedAt: string;
}

/** A person's notes on the locations of one game. */
export interface OwnNotes {
  /** By location id, as it was when the note was written. */
  notes: Record<string, OwnNote>;
  /** Their own pictures the notes show; absent when there are none. */
  pictures?: Picture[];
}

/** No notes. */
export const NO_OWN_NOTES: OwnNotes = { notes: {} };

/** What reading an own notes file found. */
export interface OwnNotesRead {
  gameId: string;
  /** The file's version; later than {@link OWN_NOTES_VERSION} when a newer app wrote it. */
  version: number;
  own: OwnNotes;
  /** Notes and pictures that could not be read and were left out. */
  skipped: number;
}

/**
 * Reads an own notes file tolerantly. A note or picture that cannot be
 * read, is not of the file's game, or is on a location of the person's own
 * (whose note is kept with it), is left out and counted; a file that is not
 * an own notes file at all is an error.
 */
export function readOwnNotesFile(
  value: unknown,
): { ok: true; file: OwnNotesRead } | { ok: false; error: string } {
  const read = ownNoteReadSchemas;
  const parsed = read.ownNotesFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not a file of Atlas notes.' };
  const { gameId } = parsed.data;
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  let skipped = 0;

  const notes: Record<string, OwnNote> = {};
  for (const [id, raw] of Object.entries(parsed.data.notes)) {
    const note = read.ownNoteSchema.safeParse(raw);
    if (!idOf('loc').safeParse(id).success || !ofGame(id) || isOwnId(id) || !note.success) {
      skipped++;
      continue;
    }
    const { text, name, photos, updatedAt } = note.data;
    notes[id] = {
      text,
      name,
      ...(photos && photos.length > 0 ? { photos } : {}),
      updatedAt: updatedAt ?? new Date(0).toISOString(),
    };
  }

  const own: OwnNotes = { notes };
  const pictures: Picture[] = [];
  const pictureIds = new Set<string>();
  for (const raw of parsed.data.pictures ?? []) {
    const picture = read.ownPictureSchema.safeParse(raw);
    if (!picture.success || !ofGame(picture.data.id) || pictureIds.has(picture.data.id)) {
      skipped++;
      continue;
    }
    pictureIds.add(picture.data.id);
    pictures.push(picture.data);
  }
  if (pictures.length > 0) own.pictures = pictures;
  return { ok: true, file: { gameId, version: parsed.data.version, own, skipped } };
}

/** The own notes file of a game, checked strictly; throws when something is not valid. */
export function writeOwnNotesFile(gameId: string, own: OwnNotes, now: Date): string {
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  const ids = Object.keys(own.notes);
  if (ids.length > MAX_OWN_NOTES) throw new Error('There are too many notes to save.');
  if (![...ids, ...(own.pictures ?? []).map((picture) => picture.id)].every(ofGame)) {
    throw new Error('A note or picture is not of this game.');
  }
  if (ids.some(isOwnId)) throw new Error('A location of your own keeps its note with it.');
  const pictures = own.pictures ?? [];
  if (new Set(pictures.map((picture) => picture.id)).size !== pictures.length) {
    throw new Error('A picture is named twice.');
  }
  const notes: Record<string, OwnNote> = {};
  for (const id of ids.sort()) notes[id] = own.notes[id]!;
  const file = ownNotesFileSchema.parse({
    format: OWN_NOTES_FORMAT,
    version: OWN_NOTES_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    notes,
    ...(pictures.length > 0 ? { pictures } : {}),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** How many notes there are. */
export function countOwnNotes(own: OwnNotes): number {
  return Object.keys(own.notes).length;
}
