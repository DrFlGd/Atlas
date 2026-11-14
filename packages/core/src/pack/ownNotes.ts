import {
  isOwnId,
  type OwnNote,
  type OwnNotes,
  type Photo,
  type Picture,
  type PackData,
} from '@atlas/schema';
import { ownNoteId } from './ownLocations';

/**
 * A person's own notes on the locations of a game (see `ownNotes.ts` in the
 * schema package) as the app shows them, and the pure changes it makes to
 * them. Every change returns new notes and leaves what it was given as it
 * was, so a change can be undone by keeping what was there before.
 *
 * A note is kept under the location's id as it was when the note was
 * written. When it is shown, the pack's `idMigrations` are followed to the
 * id the location has now (as found marks are, see `resolveProgress`); a
 * note whose location the game no longer has is kept, and listed apart
 * with the name the location had.
 */

/** A note as shown: on its location now, under the id it is kept by. */
export interface ShownNote {
  /** The location's id now. */
  locationId: string;
  /** The id the note is kept under (an older id of the location, maybe). */
  keptAs: string;
  note: OwnNote;
}

/** The notes of a game as shown on its pack. */
export interface NotesOnPack {
  /** By the id each location has now. */
  byLocation: ReadonlyMap<string, ShownNote>;
  /**
   * Notes not shown on a location, by name: their location is gone, or
   * another note of the same location (kept under another of its ids) is
   * newer.
   */
  unplaced: readonly ShownNote[];
}

/**
 * Where each note is shown: on the location its id leads to now
 * (`currentId`, the pack's id migrations), when the game has it (`has`);
 * of two notes that lead to one location, the newer.
 */
export function notesOnPack(
  own: OwnNotes,
  has: (locationId: string) => boolean,
  currentId: (id: string) => string = (id) => id,
): NotesOnPack {
  const byLocation = new Map<string, ShownNote>();
  const unplaced: ShownNote[] = [];
  for (const [keptAs, note] of Object.entries(own.notes)) {
    const locationId = currentId(keptAs);
    const shown: ShownNote = { locationId, keptAs, note };
    if (!has(locationId)) {
      unplaced.push(shown);
      continue;
    }
    const other = byLocation.get(locationId);
    if (!other) {
      byLocation.set(locationId, shown);
    } else if (isNewer(shown, other)) {
      byLocation.set(locationId, shown);
      unplaced.push(other);
    } else {
      unplaced.push(shown);
    }
  }
  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  unplaced.sort((a, b) => collator.compare(a.note.name, b.note.name));
  return { byLocation, unplaced };
}

/** Newer by time; on a tie, the one kept under the location's id now. */
function isNewer(a: ShownNote, b: ShownNote): boolean {
  if (a.note.updatedAt !== b.note.updatedAt) return a.note.updatedAt > b.note.updatedAt;
  return a.keptAs === a.locationId;
}

/** What a note holds as it is written: its text and photos. */
export interface NoteFields {
  text: string;
  photos?: readonly Photo[];
}

/** Whether a note would hold anything: words or a photo. */
export function noteHasContent(fields: NoteFields): boolean {
  return fields.text.trim() !== '' || (fields.photos?.length ?? 0) > 0;
}

/**
 * The notes with one written on a location (its id now, and its name now):
 * kept under that id, and every older note that leads to the same location
 * goes, so one location has one note. Own pictures it shows are kept with
 * the notes (`pictures`, the records of photos just added); those no note
 * shows any more go. A note with nothing in it removes the note.
 */
export function putNote(
  own: OwnNotes,
  location: { id: string; name: string },
  fields: NoteFields,
  now: Date,
  currentId: (id: string) => string = (id) => id,
  pictures: readonly Picture[] = [],
): OwnNotes {
  const notes: Record<string, OwnNote> = {};
  for (const [keptAs, note] of Object.entries(own.notes)) {
    if (keptAs !== location.id && currentId(keptAs) !== location.id) notes[keptAs] = note;
  }
  if (noteHasContent(fields)) {
    const photos = fields.photos ?? [];
    notes[location.id] = {
      text: fields.text,
      name: location.name.trim() || 'A location',
      ...(photos.length > 0 ? { photos: photos.map((photo) => ({ ...photo })) } : {}),
      updatedAt: now.toISOString(),
    };
  }
  const known = new Map((own.pictures ?? []).map((picture) => [picture.id, picture]));
  for (const picture of pictures) known.set(picture.id, picture);
  return keepNotePicturesInUse({ notes, pictures: [...known.values()] });
}

/** The notes without the one kept under `keptAs`; the same notes when there is none. */
export function removeNote(own: OwnNotes, keptAs: string): OwnNotes {
  if (!(keptAs in own.notes)) return own;
  const notes = Object.fromEntries(Object.entries(own.notes).filter(([id]) => id !== keptAs));
  return keepNotePicturesInUse({ ...own, notes });
}

/** The notes keeping only the own pictures some note shows. */
export function keepNotePicturesInUse(own: OwnNotes): OwnNotes {
  const used = new Set(
    Object.values(own.notes).flatMap((note) => (note.photos ?? []).map((photo) => photo.picture)),
  );
  const pictures = (own.pictures ?? []).filter((picture) => used.has(picture.id));
  const { pictures: _pictures, ...rest } = own;
  return pictures.length > 0 ? { ...rest, pictures } : rest;
}

/** Adds the notes of one file to another's: a note kept under the same id is replaced. */
export function mergeOwnNotes(here: OwnNotes, incoming: OwnNotes): OwnNotes {
  const pictures = new Map((here.pictures ?? []).map((picture) => [picture.id, picture]));
  for (const picture of incoming.pictures ?? []) pictures.set(picture.id, picture);
  return keepNotePicturesInUse({
    notes: { ...here.notes, ...incoming.notes },
    pictures: [...pictures.values()],
  });
}

/** A note's text to search, on the location it is on now. */
export interface NoteText {
  locationId: string;
  text: string;
}

/**
 * Every note a game's locations have, to search: the person's own notes on
 * the game's locations (`shown`), and the notes of their own locations
 * (kept with them, see `ownLocations.ts`).
 */
export function noteTexts(data: Pick<PackData, 'locations' | 'guides'>, shown: NotesOnPack) {
  const texts: NoteText[] = [];
  for (const { locationId, note } of shown.byLocation.values()) {
    if (note.text.trim()) texts.push({ locationId, text: note.text });
  }
  const guides = new Map(data.guides.map((guide) => [guide.id, guide]));
  for (const location of data.locations) {
    if (!isOwnId(location.id) || location.guideId !== ownNoteId(location.id)) continue;
    const body = guides.get(location.guideId)?.body;
    if (body?.trim()) texts.push({ locationId: location.id, text: body });
  }
  return texts;
}
