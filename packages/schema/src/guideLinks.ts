import { z } from 'zod';
import { gameIdSchema, idOf, parseId } from './ids';

/**
 * A person's links between guide pages and the map of one game, kept apart
 * from every pack, as their own lists are (see `ownLists.ts`).
 *
 * The app suggests links by comparing the names of guide pages with the
 * game's locations, types and regions, but nothing is linked until the
 * person says so. What they said is kept here, per guide id: the targets
 * they confirmed, or that they skipped the page. A pack is never changed,
 * so reading a wiki again (a pack rebuilt by its importer, with the same
 * guide ids) keeps every choice; a choice for a guide that is not in the
 * pack for now is kept too, for when it comes back.
 *
 * The file can also name other games on the device whose guides are read
 * with this game's (`guidesFrom`): a wiki read as a game of its own, with
 * no map, whose pages are then linked to this game's map.
 *
 * In the desktop app it is a file beside the game's folder in the maps
 * folder (`<game id>.guide-links.json`); elsewhere it is kept where
 * progress is kept. It holds no personal data: ids, names of the game's own
 * locations, and a time. Written strictly, read tolerantly, as packs are.
 */

/** What the guide links file of a game says it is. */
export const GUIDE_LINKS_FORMAT = 'atlas-guide-links';
/**
 * The newest version of the guide links file this app reads and writes.
 * Version 2 adds a target of one location (`location`). A file is written
 * as version 2 only when it has such a target; without one it stays version
 * 1, which Atlas 0.6.3 and earlier read and write too. An app older than a
 * file's version uses its links and does not change the file.
 */
export const GUIDE_LINKS_VERSION = 2;
/** The version of a file without a target of one location. */
export const GUIDE_LINKS_VERSION_WITHOUT_LOCATIONS = 1;

/** The most targets one page may be linked to. */
export const MAX_LINK_TARGETS = 20;
/** The most other games whose guides one game may read with its own. */
export const MAX_GUIDES_FROM = 20;
/** How long a location name kept as a target may be. */
export const MAX_LINK_NAME_LENGTH = 200;

const isoTime = z.iso.datetime({ offset: true });

/**
 * What a page is linked to:
 *
 * - `type`: every location of a type (`id`, a category id);
 * - `name`: every location of a name (`name`, compared as the app compares
 *   names: case, punctuation, a leading article, simple plurals and a
 *   number at the end of a location's name do not count);
 * - `region`: a region (`id`), with the locations in it and in the regions
 *   inside it;
 * - `location`: one location (`id`), and no other of its name (version 2).
 */
export const linkTargetSchema = z.discriminatedUnion('to', [
  z.strictObject({ to: z.literal('type'), id: idOf('cat') }),
  z.strictObject({
    to: z.literal('name'),
    name: z.string().trim().min(1).max(MAX_LINK_NAME_LENGTH),
  }),
  z.strictObject({ to: z.literal('region'), id: idOf('region') }),
  z.strictObject({ to: z.literal('location'), id: idOf('loc') }),
]);

export type LinkTarget = z.infer<typeof linkTargetSchema>;

/** What the person said about one page: linked to these targets, or skipped. */
export const linkChoiceSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('linked'),
    targets: z.array(linkTargetSchema).min(1).max(MAX_LINK_TARGETS),
  }),
  z.strictObject({ state: z.literal('skipped') }),
]);

export type LinkChoice = z.infer<typeof linkChoiceSchema>;

/** Another game whose guides are read with this one's. */
export const guidesFromSchema = z.strictObject({ gameId: gameIdSchema });

/** The guide links file of one game, as it is written: strictly. */
export const guideLinksFileSchema = z
  .strictObject({
    format: z.literal(GUIDE_LINKS_FORMAT),
    version: z.union([
      z.literal(GUIDE_LINKS_VERSION_WITHOUT_LOCATIONS),
      z.literal(GUIDE_LINKS_VERSION),
    ]),
    gameId: gameIdSchema,
    updatedAt: isoTime,
    guidesFrom: z.array(guidesFromSchema).max(MAX_GUIDES_FROM),
    choices: z.record(idOf('guide'), linkChoiceSchema),
  })
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.guidesFrom.forEach((from, i) => {
      if (from.gameId === file.gameId || seen.has(from.gameId)) {
        context.addIssue({
          code: 'custom',
          path: ['guidesFrom', i, 'gameId'],
          message: 'must be another game, named once',
        });
      }
      seen.add(from.gameId);
    });
    const needed = hasLocationTarget(file.choices)
      ? GUIDE_LINKS_VERSION
      : GUIDE_LINKS_VERSION_WITHOUT_LOCATIONS;
    if (file.version !== needed) {
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: `must be ${needed}: version 2 only with a target of one location`,
      });
    }
    for (const [guideId, choice] of Object.entries(file.choices)) {
      if (choice.state !== 'linked') continue;
      choice.targets.forEach((target, i) => {
        if (target.to !== 'name' && parseId(target.id)?.gameId !== file.gameId) {
          context.addIssue({
            code: 'custom',
            path: ['choices', guideId, 'targets', i, 'id'],
            message: 'must be of this game',
          });
        }
      });
    }
  });

export type GuideLinksFile = z.infer<typeof guideLinksFileSchema>;

/** A game's guide links, as the app keeps them. */
export interface GuideLinks {
  /** Other games whose guides are read with this one's, in the order added. */
  guidesFrom: string[];
  /** By guide id. */
  choices: Record<string, LinkChoice>;
}

/** What reading a guide links file found. */
export interface GuideLinksRead extends GuideLinks {
  gameId: string;
  /** The file's version; later than {@link GUIDE_LINKS_VERSION} when a newer app wrote it. */
  version: number;
  /** Choices that could not be read and were left out. */
  skipped: number;
}

const readHead = z.object({
  format: z.literal(GUIDE_LINKS_FORMAT),
  version: z.int().positive(),
  gameId: gameIdSchema,
  guidesFrom: z.array(z.unknown()).catch([]),
  choices: z.record(z.string(), z.unknown()).catch({}),
});

const readTarget = z.discriminatedUnion('to', [
  z.object({ to: z.literal('type'), id: idOf('cat') }),
  z.object({ to: z.literal('name'), name: z.string().trim().min(1).max(MAX_LINK_NAME_LENGTH) }),
  z.object({ to: z.literal('region'), id: idOf('region') }),
  z.object({ to: z.literal('location'), id: idOf('loc') }),
]);

const readChoice = z.object({ state: z.string(), targets: z.array(z.unknown()).optional() });

/** One target read tolerantly: only what this app knows, of this game. */
function readOneTarget(value: unknown, gameId: string): LinkTarget | null {
  const parsed = readTarget.safeParse(value);
  if (!parsed.success) return null;
  const target = parsed.data;
  if (target.to === 'name') return { to: 'name', name: target.name };
  if (parseId(target.id)?.gameId !== gameId) return null;
  return { to: target.to, id: target.id };
}

/**
 * Reads a guide links file tolerantly. A choice that cannot be read is left
 * out and counted; a target this app does not know is left out of its
 * choice. A file that is not a guide links file at all is an error.
 */
export function readGuideLinksFile(
  value: unknown,
): { ok: true; file: GuideLinksRead } | { ok: false; error: string } {
  const head = readHead.safeParse(value);
  if (!head.success) return { ok: false, error: 'This is not a file of Atlas guide links.' };
  const { gameId } = head.data;
  const guidesFrom: string[] = [];
  for (const raw of head.data.guidesFrom) {
    const from = z.object({ gameId: gameIdSchema }).safeParse(raw);
    if (!from.success || from.data.gameId === gameId || guidesFrom.includes(from.data.gameId)) {
      continue;
    }
    if (guidesFrom.length < MAX_GUIDES_FROM) guidesFrom.push(from.data.gameId);
  }
  const choices: Record<string, LinkChoice> = {};
  let skipped = 0;
  for (const [guideId, raw] of Object.entries(head.data.choices)) {
    const choice = readChoice.safeParse(raw);
    if (!idOf('guide').safeParse(guideId).success || !choice.success) {
      skipped++;
      continue;
    }
    if (choice.data.state === 'skipped') {
      choices[guideId] = { state: 'skipped' };
      continue;
    }
    if (choice.data.state !== 'linked') {
      skipped++;
      continue;
    }
    const targets = (choice.data.targets ?? [])
      .map((target) => readOneTarget(target, gameId))
      .filter((target): target is LinkTarget => target !== null)
      .slice(0, MAX_LINK_TARGETS);
    if (targets.length === 0) {
      skipped++;
      continue;
    }
    choices[guideId] = { state: 'linked', targets };
  }
  return {
    ok: true,
    file: { gameId, version: head.data.version, guidesFrom, choices, skipped },
  };
}

/** The guide links file of a game, checked strictly; throws when something is not valid. */
export function writeGuideLinksFile(gameId: string, links: GuideLinks, now: Date): string {
  const choices: Record<string, LinkChoice> = {};
  for (const id of Object.keys(links.choices).sort()) choices[id] = links.choices[id]!;
  const file: GuideLinksFile = guideLinksFileSchema.parse({
    format: GUIDE_LINKS_FORMAT,
    // The newer version only when an older app could not keep what is in it.
    version: hasLocationTarget(choices)
      ? GUIDE_LINKS_VERSION
      : GUIDE_LINKS_VERSION_WITHOUT_LOCATIONS,
    gameId,
    updatedAt: now.toISOString(),
    guidesFrom: links.guidesFrom.map((from) => ({ gameId: from })),
    choices,
  });
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Whether any page is linked to one location alone (which needs version 2). */
export function hasLocationTarget(choices: Readonly<Record<string, LinkChoice>>): boolean {
  return Object.values(choices).some(
    (choice) =>
      choice.state === 'linked' && choice.targets.some((target) => target.to === 'location'),
  );
}

/** Whether two targets are the same (a name compared as written). */
export function sameLinkTarget(a: LinkTarget, b: LinkTarget): boolean {
  if (a.to !== b.to) return false;
  return a.to === 'name' ? a.name === (b as typeof a).name : a.id === (b as typeof a).id;
}
