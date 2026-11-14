import { z } from 'zod';
import { gameIdSchema } from './ids';

/**
 * Games shown under one title: a person's record of which games on their
 * device are the same game from several sources (a map from one site, a
 * map from another, a wiki), so the app lists them as one title and lets
 * them change source from it.
 *
 * Each source stays a whole game of its own: the game id is inside every
 * id of its content, and reading a source again replaces its whole pack, so
 * games are never merged. Nothing here changes a game. Found marks, lists,
 * own locations, notes and progress stay with the source they were made on.
 *
 * - `groups`: each with an `id` of its own, the `title` shown for it, and
 *   its `members`, the games in it by id, in order: the first is opened the
 *   first time the title is.
 *
 * A game is in one group at most. A member whose game is not on the device
 * is kept and simply not shown, so a game deleted by an older app, or not
 * copied to this device yet, joins its title again when it comes back.
 *
 * In the desktop app it is one file in the maps folder
 * (`game-groups.json`), so every Atlas app on the computer sees the same
 * titles; elsewhere it is kept where progress is kept. Written strictly,
 * read tolerantly: a group that cannot be read is left out, not the file.
 * An app older than the file's version shows the titles and does not change
 * them.
 *
 * A map pack file of a game in a group carries the group as
 * `mine/game-group.json` (see {@link writeGameGroupFile}).
 */

/** What the file of games shown under one title says it is. */
export const GAME_GROUPS_FORMAT = 'atlas-game-groups';
/** The version of that file this app writes. */
export const GAME_GROUPS_VERSION = 1;

/** What the group of one game in a map pack file says it is. */
export const GAME_GROUP_FORMAT = 'atlas-game-group';
/** The version of that file this app writes. */
export const GAME_GROUP_VERSION = 1;

/** The most groups one file may hold. */
export const MAX_GAME_GROUPS = 1000;
/** The most games one title may hold. */
export const MAX_GROUP_MEMBERS = 20;
/** The longest title. */
export const MAX_GROUP_TITLE_LENGTH = 200;

/** A group's own id: letters, digits and dashes. */
export const groupIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const isoTime = z.iso.datetime({ offset: true });

function gameGroupSchemas(mode: 'write' | 'read') {
  const reading = mode === 'read';
  const record = <T extends z.core.$ZodLooseShape>(shape: T) =>
    reading
      ? z.object(shape)
      : (z.strictObject(shape) as unknown as ReturnType<typeof z.object<T>>);

  /** One game of a group. */
  const memberSchema = record({ gameId: gameIdSchema });

  const title = z.string().trim().min(1).max(MAX_GROUP_TITLE_LENGTH);

  /** One title and its games. */
  const gameGroupSchema = record({
    id: groupIdSchema,
    title,
    members: reading
      ? z.array(z.unknown()).max(MAX_GROUP_MEMBERS * 4)
      : z.array(memberSchema).min(2).max(MAX_GROUP_MEMBERS),
  });

  const gameGroupsFileSchema = record({
    format: z.literal(GAME_GROUPS_FORMAT),
    version: reading ? z.int().positive() : z.literal(GAME_GROUPS_VERSION),
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    // Read one by one (see `readGameGroupsFile`), so one that cannot be read
    // does not lose the others.
    groups: reading
      ? z.array(z.unknown()).catch([])
      : z.array(gameGroupSchema).max(MAX_GAME_GROUPS),
  });

  /** The group of one game, as a map pack file carries it. */
  const gameGroupFileSchema = record({
    format: z.literal(GAME_GROUP_FORMAT),
    version: reading ? z.int().positive() : z.literal(GAME_GROUP_VERSION),
    /** The game the file was made from; one of the members. */
    gameId: gameIdSchema,
    updatedAt: reading ? isoTime.optional().catch(undefined) : isoTime,
    title,
    members: reading
      ? z.array(z.unknown()).max(MAX_GROUP_MEMBERS * 4)
      : z.array(memberSchema).min(2).max(MAX_GROUP_MEMBERS),
  });

  return { memberSchema, gameGroupSchema, gameGroupsFileSchema, gameGroupFileSchema };
}

/** The schemas these files are written with: strict. */
export const { gameGroupSchema, gameGroupsFileSchema, gameGroupFileSchema } =
  gameGroupSchemas('write');

/** The same schemas for reading: tolerant. */
export const gameGroupReadSchemas = gameGroupSchemas('read');

/** One title and the games shown under it. */
export interface GameGroup {
  id: string;
  /** The title shown for them. */
  title: string;
  /** The games, in order; the first is opened the first time. */
  members: { gameId: string }[];
}

/** No groups. */
export const NO_GAME_GROUPS: readonly GameGroup[] = [];

/** What reading the file of groups found. */
export interface GameGroupsRead {
  /** The file's version; later than {@link GAME_GROUPS_VERSION} when a newer app wrote it. */
  version: number;
  groups: GameGroup[];
  /** Groups, and games of groups, that could not be read and were left out. */
  skipped: number;
}

/** The members of a group as read: valid game ids, each once, and not in a group read before. */
function readMembers(
  raw: readonly unknown[],
  taken: Set<string>,
): { members: { gameId: string }[]; skipped: number } {
  const members: { gameId: string }[] = [];
  let skipped = 0;
  for (const value of raw) {
    const member = gameGroupReadSchemas.memberSchema.safeParse(value);
    if (!member.success || taken.has(member.data.gameId) || members.length >= MAX_GROUP_MEMBERS) {
      skipped++;
      continue;
    }
    taken.add(member.data.gameId);
    members.push({ gameId: member.data.gameId });
  }
  return { members, skipped };
}

/**
 * Reads the file of groups tolerantly. A group that cannot be read, or has
 * fewer than two games left, is left out; so is a game already in a group
 * read before it, or named twice. Each is counted. A file that is not this
 * file at all is an error.
 */
export function readGameGroupsFile(
  value: unknown,
): { ok: true; file: GameGroupsRead } | { ok: false; error: string } {
  const read = gameGroupReadSchemas;
  const parsed = read.gameGroupsFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not a file of Atlas titles.' };
  const groups: GameGroup[] = [];
  const taken = new Set<string>();
  const ids = new Set<string>();
  let skipped = 0;
  for (const raw of parsed.data.groups) {
    const group = read.gameGroupSchema.safeParse(raw);
    if (!group.success || ids.has(group.data.id) || groups.length >= MAX_GAME_GROUPS) {
      skipped++;
      continue;
    }
    const kept = new Set(taken);
    const { members, skipped: left } = readMembers(group.data.members, kept);
    skipped += left;
    if (members.length < 2) {
      skipped++;
      continue;
    }
    for (const member of members) taken.add(member.gameId);
    ids.add(group.data.id);
    groups.push({ id: group.data.id, title: group.data.title, members });
  }
  return { ok: true, file: { version: parsed.data.version, groups, skipped } };
}

/** Checks the rules no schema can: each game in one group at most, each group id once. */
function checkGroups(groups: readonly GameGroup[]): void {
  const games = new Set<string>();
  const ids = new Set<string>();
  for (const group of groups) {
    if (ids.has(group.id)) throw new Error('Two titles have the same id.');
    ids.add(group.id);
    for (const { gameId } of group.members) {
      if (games.has(gameId)) throw new Error('A game is shown under two titles.');
      games.add(gameId);
    }
  }
}

/** The file of groups, checked strictly; throws when something is not valid. */
export function writeGameGroupsFile(groups: readonly GameGroup[], now: Date): string {
  checkGroups(groups);
  const file = gameGroupsFileSchema.parse({
    format: GAME_GROUPS_FORMAT,
    version: GAME_GROUPS_VERSION,
    updatedAt: now.toISOString(),
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title.trim(),
      members: group.members.map(({ gameId }) => ({ gameId })),
    })),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// In a map pack file

/** The group a map pack file carried: its title and games, and the game it was made from. */
export interface CarriedGameGroup {
  gameId: string;
  title: string;
  members: { gameId: string }[];
  /** Later than {@link GAME_GROUP_VERSION} when a newer app wrote it. */
  version: number;
}

/**
 * The group of one game as a map pack file carries it
 * (`mine/game-group.json`): its title and its games, the game the file was
 * made from among them. Throws when something is not valid.
 */
export function writeGameGroupFile(gameId: string, group: GameGroup, now: Date): string {
  if (!group.members.some((member) => member.gameId === gameId)) {
    throw new Error('The game is not in this title.');
  }
  checkGroups([group]);
  const file = gameGroupFileSchema.parse({
    format: GAME_GROUP_FORMAT,
    version: GAME_GROUP_VERSION,
    gameId,
    updatedAt: now.toISOString(),
    title: group.title.trim(),
    members: group.members.map((member) => ({ gameId: member.gameId })),
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/**
 * Reads the group a map pack file carried, tolerantly: games that cannot be
 * read are left out. It is an error when it is not such a file, or when
 * fewer than two games, or not the file's own game, are left.
 */
export function readGameGroupFile(
  value: unknown,
): { ok: true; group: CarriedGameGroup } | { ok: false; error: string } {
  const parsed = gameGroupReadSchemas.gameGroupFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'This is not the title of an Atlas game.' };
  const { members } = readMembers(parsed.data.members, new Set());
  if (members.length < 2 || !members.some((member) => member.gameId === parsed.data.gameId)) {
    return { ok: false, error: 'This title has no other game.' };
  }
  return {
    ok: true,
    group: {
      gameId: parsed.data.gameId,
      title: parsed.data.title,
      members,
      version: parsed.data.version,
    },
  };
}
