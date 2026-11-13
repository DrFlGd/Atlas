import { z } from 'zod';

/**
 * Content ids are stable, prefixed strings: `<gameId>:<kind>:<localId>`,
 * for example `demo:loc:0412`. The kind segment is fixed per entity type so an
 * id alone says what it refers to.
 */
export const ID_KINDS = {
  map: 'map',
  layer: 'layer',
  region: 'region',
  categoryGroup: 'catgroup',
  category: 'cat',
  location: 'loc',
  entity: 'entity',
  checklist: 'checklist',
  checklistItem: 'checkitem',
  guide: 'guide',
  link: 'link',
  preset: 'preset',
  // Guides read as pages: the sections of their contents, and their pictures.
  section: 'section',
  picture: 'picture',
} as const;

export type IdKind = (typeof ID_KINDS)[keyof typeof ID_KINDS];

const GAME_ID_SOURCE = '[a-z0-9][a-z0-9-]*';
const LOCAL_ID_SOURCE = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const KIND_SOURCE = Object.values(ID_KINDS).join('|');

export const GAME_ID_PATTERN = new RegExp(`^${GAME_ID_SOURCE}$`);
export const ANY_ID_PATTERN = new RegExp(
  `^(${GAME_ID_SOURCE}):(${KIND_SOURCE}):(${LOCAL_ID_SOURCE})$`,
);

export const gameIdSchema = z
  .string()
  .regex(GAME_ID_PATTERN, 'must be lowercase letters, digits and dashes');

/** Any content id, whatever its kind. */
export const anyIdSchema = z
  .string()
  .regex(ANY_ID_PATTERN, 'must look like <gameId>:<kind>:<localId>');

/** A content id that must be of one specific kind, e.g. `idOf('loc')`. */
export function idOf(kind: IdKind) {
  const pattern = new RegExp(`^${GAME_ID_SOURCE}:${kind}:${LOCAL_ID_SOURCE}$`);
  return z.string().regex(pattern, `must look like <gameId>:${kind}:<localId>`);
}

export interface ParsedId {
  gameId: string;
  kind: IdKind;
  localId: string;
}

/** Splits a content id into its parts, or returns null when it is malformed. */
export function parseId(id: string): ParsedId | null {
  const match = ANY_ID_PATTERN.exec(id);
  if (!match) return null;
  const [, gameId, kind, localId] = match;
  if (gameId === undefined || kind === undefined || localId === undefined) return null;
  return { gameId, kind: kind as IdKind, localId };
}

/** Builds a content id from its parts. */
export function makeId(gameId: string, kind: IdKind, localId: string): string {
  return `${gameId}:${kind}:${localId}`;
}
