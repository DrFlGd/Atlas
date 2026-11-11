/**
 * Reading game saves, and matching what they say against a pack. Pure
 * TypeScript: no file, network, Node or DOM access, so the same code runs
 * in the browser, the desktop app and the Android app (in a Web Worker
 * when the save is large). The shells only hand over the bytes of a copy
 * of the save.
 */

import type { GamePinTable } from './gamefiles/table';
import { SaveReadError, type ReadOptions, type SaveReader } from './reader';
import type { SaveSummary } from './summary';
import { buildPinTable, type BuildPinTableInput, type PinTableStats } from './witcher3/gameFiles';
import { witcher3Reader } from './witcher3/reader';

export * from './reader';
export * from './summary';
export * from './match/index';
export * from './games';
export * from './gamefiles/table';
export {
  exportProperties,
  exportsOf,
  isCr2w,
  readCr2w,
  type Cr2wExport,
  type Cr2wFile,
  type Cr2wImport,
  type Cr2wRecord,
  type Cr2wValue,
} from './gamefiles/cr2w';
export {
  areaWorldsOf,
  buildPinTable,
  entityMapPinsOf,
  mappinsMountersOf,
  type BuildPinTableInput,
  type EntityMapPin,
  type GameFileInput,
  type MappinsMounter,
  type PinTableStats,
} from './witcher3/gameFiles';
export { witcher3Reader, WITCHER3_VERSIONS, readWitcher3Tree } from './witcher3/reader';
export {
  WITCHER3_GAME,
  WITCHER3_TITLE,
  WITCHER3_TUNING,
  WITCHER3_WORLDS,
  WITCHER3_PIN_KINDS,
} from './witcher3/tuning';

/** Every save reader Atlas has. */
export const SAVE_READERS: readonly SaveReader[] = [witcher3Reader];

/** The reader for a pack's game, or null when Atlas cannot read that game's saves. */
export function readerForPack(pack: { gameId: string; title: string }): SaveReader | null {
  return SAVE_READERS.find((reader) => reader.matchesPack(pack)) ?? null;
}

export function readerById(id: string): SaveReader | null {
  return SAVE_READERS.find((reader) => reader.id === id) ?? null;
}

/** Reads a save with whichever reader recognises it. Throws {@link SaveReadError}. */
export function readSave(bytes: Uint8Array, options?: ReadOptions): SaveSummary {
  const reader = SAVE_READERS.find((candidate) => candidate.detect(bytes));
  if (!reader) {
    throw new SaveReadError('not-a-save', 'This file is not a game save that Atlas can read.');
  }
  return reader.read(bytes, options);
}

/**
 * Builds the table of a game's own map pins from files of the game, for
 * the games Atlas can read them for; null for the others.
 */
export function pinTableBuilder(
  readerId: string,
): ((input: BuildPinTableInput) => { table: GamePinTable; stats: PinTableStats }) | null {
  return readerId === witcher3Reader.id ? buildPinTable : null;
}
