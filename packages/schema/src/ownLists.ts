import { z } from 'zod';
import {
  ownEntryWriteSchemas,
  packReadSchemas,
  type Checklist,
  type ChecklistItem,
  type Picture,
  type SchemaMode,
} from './entities';
import { gameIdSchema, idOf, isOwnId, OWN_ID_PREFIX, parseId } from './ids';
import {
  MAX_OWN_PICTURES,
  ownPictureFile,
  pictureFileSchema,
  type PictureFile,
} from './ownPictures';

/**
 * A person's own lists and guides, kept apart from every pack.
 *
 * A pack's files are replaced whenever the pack is refreshed, rebuilt or
 * imported again, so nothing a person makes is ever written into them. The
 * lists of one game live in a file of their own (in the desktop app, beside
 * the game's folder in the maps folder; elsewhere, where progress is kept),
 * in the shape {@link ownListsFileSchema} gives. One list can also be
 * passed on in a list file ({@link listFileSchema}).
 *
 * Each list is made of the same records as a pack's lists, a checklist and
 * its items, so every view of the app shows it as it shows a pack's list.
 * Their ids are the game's, with a local id that starts with
 * {@link OWN_ID_PREFIX}, which packs may not use. Headings are kept as well
 * as the items' `section`, so that a heading with no step under it yet
 * survives; the items' `section` is the title of the heading above them.
 *
 * A list keeps the person's own photos of its steps (`pictures`, see
 * `ownPictures.ts`); a list file carries their bytes too (`pictureFiles`).
 *
 * Both files are written strictly and read tolerantly, as packs are (see
 * {@link SchemaMode}). A file of a later version is still read, without
 * what this app does not know.
 */

/** What the own lists file of a game says it is. */
export const OWN_LISTS_FORMAT = 'atlas-own-lists';
/** The version of the own lists file this app writes. */
export const OWN_LISTS_VERSION = 1;

/** What a file holding one list says it is. */
export const LIST_FILE_FORMAT = 'atlas-list';
/** The version of the list file this app writes. */
export const LIST_FILE_VERSION = 1;
/** The extension of a list file. The content is JSON. */
export const LIST_FILE_EXTENSION = 'atlaslist';

/** How long a heading may be: as long as an item's `section`. */
export const MAX_HEADING_LENGTH = 200;

const isoTime = z.iso.datetime({ offset: true });

/** An id of a person's own list, entry or heading, of one kind. */
export function ownIdOf(kind: 'checklist' | 'checkitem') {
  return idOf(kind).refine(isOwnId, `must be an own id (local id starting with ${OWN_ID_PREFIX})`);
}

function ownListSchemas(mode: SchemaMode) {
  const reading = mode === 'read';
  const pack = reading ? packReadSchemas : ownEntryWriteSchemas;
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);

  /** A heading of an own list, placed among its items by `order`. */
  const headingSchema = record({
    id: ownIdOf('checkitem'),
    title: z.string().trim().min(1).max(MAX_HEADING_LENGTH),
    order: z.int(),
  });

  /** A person's own picture, named as `ownPictureFile` says. */
  const ownPictureSchema = pack.pictureSchema.refine(
    (picture) => ownPictureFile(picture) !== null,
    'must be an own picture: an own id, with pictures/<its local id>.jpg, .png or .webp',
  );

  /** One list a person made, or copied from a pack's list. */
  const ownListSchema = record({
    checklist: pack.checklistSchema,
    items: z.array(pack.checklistItemSchema),
    headings: reading ? z.array(headingSchema).catch([]) : z.array(headingSchema),
    /**
     * The person's own photos its steps show (see `ownPictures.ts`). When
     * reading, one that cannot be read is left out, not the list.
     */
    pictures: reading
      ? z
          .array(z.unknown())
          .transform((list) =>
            list.flatMap((value) => {
              const picture = ownPictureSchema.safeParse(value);
              return picture.success ? [picture.data] : [];
            }),
          )
          .optional()
          .catch(undefined)
      : z.array(ownPictureSchema).max(MAX_OWN_PICTURES).optional(),
    /** The pack's list it was copied from, if it was. The pack's list is never changed. */
    copiedFrom: reading
      ? idOf('checklist').optional().catch(undefined)
      : idOf('checklist').optional(),
    createdAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
  }).superRefine((list, context) => {
    const listId = list.checklist.id;
    if (!isOwnId(listId)) {
      context.addIssue({ code: 'custom', path: ['checklist', 'id'], message: 'must be an own id' });
    }
    const seen = new Set<string>();
    const check = (id: string, path: (string | number)[]) => {
      if (!isOwnId(id)) context.addIssue({ code: 'custom', path, message: 'must be an own id' });
      if (seen.has(id)) context.addIssue({ code: 'custom', path, message: 'is used twice' });
      seen.add(id);
    };
    list.items.forEach((item, i) => {
      check(item.id, ['items', i, 'id']);
      if (item.checklistId !== listId) {
        context.addIssue({
          code: 'custom',
          path: ['items', i, 'checklistId'],
          message: 'must be the list it is in',
        });
      }
    });
    list.headings.forEach((heading, i) => {
      check(heading.id, ['headings', i, 'id']);
    });
    list.pictures?.forEach((picture, i) => {
      check(picture.id, ['pictures', i, 'id']);
    });
  });

  /** Every own list of one game. */
  const ownListsFileSchema = record({
    format: z.literal(OWN_LISTS_FORMAT),
    version: reading ? z.int().positive() : z.literal(OWN_LISTS_VERSION),
    gameId: gameIdSchema,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    // Read one by one (see `readOwnListsFile`), so one list that cannot be
    // read does not lose the others.
    lists: reading ? z.array(z.unknown()) : z.array(ownListSchema),
  });

  /** One list, passed on as a file. Never holds found or done marks. */
  const listFileSchema = record({
    format: z.literal(LIST_FILE_FORMAT),
    version: reading ? z.int().positive() : z.literal(LIST_FILE_VERSION),
    gameId: gameIdSchema,
    /** The game's title when the list was exported, for the message when it does not fit. */
    gameTitle: reading ? z.string().optional().catch(undefined) : z.string().min(1).optional(),
    exportedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    list: ownListSchema,
    /**
     * The bytes of the list's own photos, so they travel with it. Optional,
     * so a file without photos is as before; an app that does not know it
     * imports the list without its photos.
     */
    pictureFiles: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(pictureFileSchema).max(MAX_OWN_PICTURES).optional(),
  });

  return { headingSchema, ownListSchema, ownListsFileSchema, listFileSchema };
}

/** The schemas these files are written with: strict. */
export const { headingSchema, ownListSchema, ownListsFileSchema, listFileSchema } =
  ownListSchemas('write');

/** The same schemas for reading: tolerant (see {@link SchemaMode}). */
export const ownListReadSchemas = ownListSchemas('read');

export type OwnHeading = z.infer<typeof headingSchema>;
export interface OwnList {
  checklist: Checklist;
  items: ChecklistItem[];
  headings: OwnHeading[];
  /** The person's own photos its steps show. */
  pictures?: Picture[];
  copiedFrom?: string;
  createdAt: string;
  updatedAt: string;
}
export type OwnListsFile = z.infer<typeof ownListsFileSchema>;
export type ListFile = z.infer<typeof listFileSchema>;

/** What reading an own lists file found. */
export interface OwnListsRead {
  gameId: string;
  /** The file's version; later than {@link OWN_LISTS_VERSION} when a newer app wrote it. */
  version: number;
  lists: OwnList[];
  /** Lists that could not be read and were left out. */
  skipped: number;
}

/** Fills in what a tolerant read may leave out, so a list read is whole. */
function completeList(list: z.infer<typeof ownListReadSchemas.ownListSchema>): OwnList {
  const now = new Date(0).toISOString();
  return {
    checklist: list.checklist,
    items: list.items,
    headings: list.headings,
    ...(list.pictures && list.pictures.length > 0 ? { pictures: list.pictures } : {}),
    ...(list.copiedFrom ? { copiedFrom: list.copiedFrom } : {}),
    createdAt: list.createdAt ?? list.updatedAt ?? now,
    updatedAt: list.updatedAt ?? list.createdAt ?? now,
  };
}

/** Whether every id of a list is of one game. */
function listOfGame(list: OwnList, gameId: string): boolean {
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  return (
    ofGame(list.checklist.id) &&
    list.items.every(
      (item) =>
        ofGame(item.id) &&
        item.locationIds.every(ofGame) &&
        (item.photos ?? []).every((photo) => ofGame(photo.picture)),
    ) &&
    list.headings.every((heading) => ofGame(heading.id)) &&
    (list.pictures ?? []).every((picture) => ofGame(picture.id))
  );
}

/**
 * Reads an own lists file tolerantly. A list that cannot be read is left
 * out and counted; a file that is not an own lists file at all is an error.
 */
export function readOwnListsFile(
  value: unknown,
): { ok: true; file: OwnListsRead } | { ok: false; error: string } {
  const parsed = ownListReadSchemas.ownListsFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not a file of Atlas lists.' };
  const lists: OwnList[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  for (const raw of parsed.data.lists) {
    const list = ownListReadSchemas.ownListSchema.safeParse(raw);
    const whole = list.success ? completeList(list.data) : null;
    if (!whole || !listOfGame(whole, parsed.data.gameId) || ids.has(whole.checklist.id)) {
      skipped++;
      continue;
    }
    ids.add(whole.checklist.id);
    lists.push(whole);
  }
  return {
    ok: true,
    file: { gameId: parsed.data.gameId, version: parsed.data.version, lists, skipped },
  };
}

/** The own lists file of a game, checked strictly; throws when a list is not valid. */
export function writeOwnListsFile(gameId: string, lists: readonly OwnList[], now: Date): string {
  const file: OwnListsFile = ownListsFileSchema.parse({
    format: OWN_LISTS_FORMAT,
    version: OWN_LISTS_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    lists,
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * A list file for one list, checked strictly, with the bytes of its own
 * photos when given (see `pictureFiles`).
 */
export function writeListFile(
  gameId: string,
  gameTitle: string,
  list: OwnList,
  now: Date,
  pictureFiles: readonly PictureFile[] = [],
): string {
  const file: ListFile = listFileSchema.parse({
    format: LIST_FILE_FORMAT,
    version: LIST_FILE_VERSION,
    gameId,
    gameTitle,
    exportedAt: now.toISOString(),
    list,
    ...(pictureFiles.length > 0 ? { pictureFiles } : {}),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** What reading a list file found: its list and game, or why it cannot be used. */
export type ListFileRead =
  | {
      ok: true;
      gameId: string;
      gameTitle: string | null;
      list: OwnList;
      /** The bytes of the list's own photos that the file carries and the list names. */
      pictureFiles: PictureFile[];
    }
  | { ok: false; error: string };

/** Reads a list file tolerantly (see {@link listFileSchema}). */
export function readListFile(text: string): ListFileRead {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not an Atlas list: it is not JSON.' };
  }
  const head = z.object({ format: z.string(), gameId: gameIdSchema }).safeParse(value);
  if (!head.success || head.data.format !== LIST_FILE_FORMAT) {
    return { ok: false, error: 'This file is not an Atlas list.' };
  }
  const parsed = ownListReadSchemas.listFileSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: 'This Atlas list is damaged, so it cannot be imported.' };
  }
  const list = completeList(parsed.data.list);
  if (!listOfGame(list, parsed.data.gameId)) {
    return { ok: false, error: 'This Atlas list is damaged, so it cannot be imported.' };
  }
  const named = new Set((list.pictures ?? []).map((picture) => picture.file));
  const pictureFiles = (parsed.data.pictureFiles ?? []).flatMap((value) => {
    const file = pictureFileSchema.safeParse(value);
    return file.success && named.has(file.data.file) ? [file.data] : [];
  });
  return {
    ok: true,
    gameId: parsed.data.gameId,
    gameTitle: parsed.data.gameTitle ?? null,
    list,
    pictureFiles,
  };
}
