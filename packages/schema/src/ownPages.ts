import { z } from 'zod';
import { ownRecordWriteSchemas, packReadSchemas, type Picture, type SchemaMode } from './entities';
import { gameIdSchema, idOf, isOwnId, parseId } from './ids';
import { MAX_OWN_PICTURES, ownPictureFile } from './ownPictures';

/**
 * A person's own changes to the guide pages of one game, kept apart from
 * every pack, as their own lists, locations and guide links are (see
 * `ownLists.ts`).
 *
 * A pack's pages come from an importer that read a wiki, and a pack's files
 * are replaced whenever the importer reads the wiki again; so nothing a
 * person changes is ever written into them. What they changed is kept here
 * and laid over the pack's pages when they are shown (see `applyOwnPages`
 * in the core package):
 *
 * - `pages`: by guide id, the person's version of a pack's page (its title,
 *   its text, or both), a page they hid, and pages of their own, whose ids
 *   start with {@link OWN_ID_PREFIX}. A changed text keeps a copy of the
 *   pack's text it was changed from (`basedOn`), so the app can tell when
 *   the wiki's text changed since, and never replaces the person's text
 *   without asking: what happens then is the page's `whenWikiChanges`.
 * - `sections`: sections of their own, and new titles of the pack's.
 * - `contents`: the contents as the person arranged it (what is at the top,
 *   what each section holds, and the pages they put under a page, in
 *   order), once they moved anything. A page or section the pack adds
 *   later goes where the pack puts it. A page they left in a section whose
 *   pages are placed by their links (`placeByLinks`) is still placed by
 *   its links: only where they put a page by hand is kept as theirs.
 * - `pictures`: their own pictures the pages show (see `ownPictures.ts`).
 *
 * In the desktop app it is a file beside the game's folder in the maps
 * folder (`<game id>.my-pages.json`); elsewhere it is kept where progress
 * is kept. Written strictly, read tolerantly, as packs are: one page that
 * cannot be read is left out, not the file.
 */

/** What the own pages file of a game says it is. */
export const OWN_PAGES_FORMAT = 'atlas-own-pages';
/** The version of the own pages file this app writes. */
export const OWN_PAGES_VERSION = 1;

/** The longest title of a page or a section. */
export const MAX_PAGE_TITLE_LENGTH = 200;
/** The longest text of a page, in characters. */
export const MAX_PAGE_BODY_LENGTH = 2_000_000;
/** The most pages one file may hold. */
export const MAX_OWN_PAGES = 5_000;
/** The most sections one file may hold. */
export const MAX_OWN_SECTIONS = 2_000;

/**
 * What the app does when the wiki's text of a page the person changed has
 * changed since: `keep` shows their version and says so; `take` shows the
 * wiki's new text and keeps theirs, to go back to.
 */
export const WIKI_CHANGE_CHOICES = ['keep', 'take'] as const;
export type WikiChangeChoice = (typeof WIKI_CHANGE_CHOICES)[number];

const isoTime = z.iso.datetime({ offset: true });

const entryId = z.union([idOf('guide'), idOf('section')]);

function ownPageSchemas(mode: SchemaMode) {
  const reading = mode === 'read';
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);
  const title = z.string().trim().min(1).max(MAX_PAGE_TITLE_LENGTH);
  const body = z.string().max(MAX_PAGE_BODY_LENGTH);

  /**
   * One page: the person's own (an own id; it has a title and a text), or
   * a pack's page they changed or hid.
   */
  const ownPageSchema = record({
    id: idOf('guide'),
    /** The page's title: an own page's, or a pack's page renamed. */
    title: title.optional(),
    /** The page's Markdown text: an own page's, or a pack's page as the person changed it. */
    body: body.optional(),
    /** A pack's page whose text was changed: the pack's text it was changed from. */
    basedOn: body.optional(),
    /** What to do when the wiki's text changes; `keep` when absent. */
    whenWikiChanges: reading
      ? z.enum(WIKI_CHANGE_CHOICES).optional().catch(undefined)
      : z.enum(WIKI_CHANGE_CHOICES).optional(),
    /** A pack's page the person hid from the contents. */
    hidden: reading ? z.boolean().optional().catch(undefined) : z.literal(true).optional(),
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
  }).superRefine((page, context) => {
    if (isOwnId(page.id)) {
      if (page.title === undefined || page.body === undefined) {
        context.addIssue({ code: 'custom', message: 'an own page has a title and a text' });
      }
      if (page.basedOn !== undefined || page.hidden) {
        context.addIssue({
          code: 'custom',
          message: 'an own page is not based on a wiki page, and is never hidden',
        });
      }
    } else if (page.body !== undefined && page.basedOn === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['basedOn'],
        message: 'a changed text keeps the text it was changed from',
      });
    }
  });

  /** A section of one's own, or a new title of a pack's section. */
  const ownSectionSchema = record({
    id: idOf('section'),
    title,
  });

  /** The contents as the person arranged it. */
  const contentsSchema = record({
    /** What is at the top of the contents, in order: sections, and pages. */
    top: z.array(entryId),
    /**
     * What each section holds, in order, by section id; and by page id, the
     * pages the person put under that page. Apps before pages could hold
     * pages leave out the lists by page id when reading.
     */
    sections: z.record(entryId, z.array(entryId)),
  });

  /** A person's own picture, named as `ownPictureFile` says. */
  const ownPictureSchema = (
    reading ? packReadSchemas.pictureSchema : ownRecordWriteSchemas.pictureSchema
  ).refine(
    (picture) => ownPictureFile(picture) !== null,
    'must be an own picture: an own id, with pictures/<its local id>.jpg, .png or .webp',
  );

  const ownPagesFileSchema = record({
    format: z.literal(OWN_PAGES_FORMAT),
    version: reading ? z.int().positive() : z.literal(OWN_PAGES_VERSION),
    gameId: gameIdSchema,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    // Read one by one (see `readOwnPagesFile`), so one that cannot be read
    // does not lose the others.
    pages: reading ? z.array(z.unknown()).catch([]) : z.array(ownPageSchema).max(MAX_OWN_PAGES),
    sections: reading
      ? z.array(z.unknown()).catch([])
      : z.array(ownSectionSchema).max(MAX_OWN_SECTIONS),
    contents: reading ? z.unknown().optional() : contentsSchema.optional(),
    pictures: reading
      ? z.array(z.unknown()).optional().catch(undefined)
      : z.array(ownPictureSchema).max(MAX_OWN_PICTURES).optional(),
  });

  return { ownPageSchema, ownSectionSchema, contentsSchema, ownPictureSchema, ownPagesFileSchema };
}

/** The schemas this file is written with: strict. */
export const { ownPageSchema, ownSectionSchema, ownPagesFileSchema } = ownPageSchemas('write');

/** The same schemas for reading: tolerant (see {@link SchemaMode}). */
export const ownPageReadSchemas = ownPageSchemas('read');

/** A page of one's own, or one's change to a pack's page. */
export interface OwnPage {
  id: string;
  title?: string;
  body?: string;
  basedOn?: string;
  whenWikiChanges?: WikiChangeChoice;
  hidden?: true;
  updatedAt: string;
}

/** A section of one's own, or a new title of a pack's section. */
export interface OwnSection {
  id: string;
  title: string;
}

/**
 * The contents as arranged: what is at the top, and what each section
 * holds; and by a page's id, the pages under that page.
 */
export interface PagesLayout {
  top: string[];
  sections: Record<string, string[]>;
}

/** A person's own changes to the pages of one game. */
export interface OwnPages {
  pages: OwnPage[];
  sections: OwnSection[];
  /** Absent until the person moved, added or removed anything in the contents. */
  contents?: PagesLayout;
  /** Their own pictures the pages show; absent when there are none. */
  pictures?: Picture[];
}

/** No changes. */
export const NO_OWN_PAGES: OwnPages = { pages: [], sections: [] };

/** What reading an own pages file found. */
export interface OwnPagesRead {
  gameId: string;
  /** The file's version; later than {@link OWN_PAGES_VERSION} when a newer app wrote it. */
  version: number;
  own: OwnPages;
  /** Records that could not be read and were left out. */
  skipped: number;
}

/**
 * Reads an own pages file tolerantly. A page, section or picture that
 * cannot be read, is not of the file's game, or has an id used before, is
 * left out and counted; contents that cannot be read are left out (the
 * pack's then show, with every own page at the top); a file that is not an
 * own pages file at all is an error.
 */
export function readOwnPagesFile(
  value: unknown,
): { ok: true; file: OwnPagesRead } | { ok: false; error: string } {
  const read = ownPageReadSchemas;
  const parsed = read.ownPagesFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not a file of Atlas pages.' };
  const { gameId } = parsed.data;
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  let skipped = 0;

  const pages: OwnPage[] = [];
  const pageIds = new Set<string>();
  for (const raw of parsed.data.pages) {
    const page = read.ownPageSchema.safeParse(raw);
    if (!page.success || !ofGame(page.data.id) || pageIds.has(page.data.id)) {
      skipped++;
      continue;
    }
    pageIds.add(page.data.id);
    const { id, title, body, basedOn, whenWikiChanges, hidden, updatedAt } = page.data;
    pages.push({
      id,
      ...(title !== undefined ? { title } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(basedOn !== undefined ? { basedOn } : {}),
      ...(whenWikiChanges ? { whenWikiChanges } : {}),
      ...(hidden === true ? { hidden: true as const } : {}),
      updatedAt: updatedAt ?? new Date(0).toISOString(),
    });
  }

  const sections: OwnSection[] = [];
  const sectionIds = new Set<string>();
  for (const raw of parsed.data.sections) {
    const section = read.ownSectionSchema.safeParse(raw);
    if (!section.success || !ofGame(section.data.id) || sectionIds.has(section.data.id)) {
      skipped++;
      continue;
    }
    sectionIds.add(section.data.id);
    sections.push({ id: section.data.id, title: section.data.title });
  }

  const own: OwnPages = { pages, sections };
  if (parsed.data.contents !== undefined) {
    const contents = readContents(parsed.data.contents, ofGame);
    if (contents) own.contents = contents;
    else skipped++;
  }

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

/** Contents read tolerantly: ids that are not of the game, or not ids, are left out. */
function readContents(value: unknown, ofGame: (id: string) => boolean): PagesLayout | null {
  const shape = z
    .object({ top: z.array(z.unknown()), sections: z.record(z.string(), z.unknown()) })
    .safeParse(value);
  if (!shape.success) return null;
  const ids = (list: unknown): string[] =>
    Array.isArray(list)
      ? list.filter(
          (id): id is string =>
            typeof id === 'string' && entryId.safeParse(id).success && ofGame(id),
        )
      : [];
  const sections: Record<string, string[]> = {};
  for (const [id, items] of Object.entries(shape.data.sections)) {
    if (entryId.safeParse(id).success && ofGame(id)) sections[id] = ids(items);
  }
  return { top: ids(shape.data.top), sections };
}

/** The own pages file of a game, checked strictly; throws when something is not valid. */
export function writeOwnPagesFile(gameId: string, own: OwnPages, now: Date): string {
  const ofGame = (id: string) => parseId(id)?.gameId === gameId;
  const ids = [
    ...own.pages.map((page) => page.id),
    ...own.sections.map((section) => section.id),
    ...(own.pictures ?? []).map((picture) => picture.id),
  ];
  if (!ids.every(ofGame)) throw new Error('A page, section or picture is not of this game.');
  const unique = (list: readonly { id: string }[]) =>
    new Set(list.map((item) => item.id)).size === list.length;
  if (!unique(own.pages) || !unique(own.sections) || !unique(own.pictures ?? [])) {
    throw new Error('A page, section or picture is named twice.');
  }
  const file = ownPagesFileSchema.parse({
    format: OWN_PAGES_FORMAT,
    version: OWN_PAGES_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    pages: own.pages,
    sections: own.sections,
    ...(own.contents ? { contents: own.contents } : {}),
    ...(own.pictures && own.pictures.length > 0 ? { pictures: own.pictures } : {}),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Whether there is nothing in them: no page, section, contents or picture. */
export function noOwnPages(own: OwnPages): boolean {
  return (
    own.pages.length === 0 &&
    own.sections.length === 0 &&
    own.contents === undefined &&
    (own.pictures ?? []).length === 0
  );
}
