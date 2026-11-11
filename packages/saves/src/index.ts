/**
 * Reading game saves, and matching what they say against a pack. Pure
 * TypeScript: no file, network, Node or DOM access, so the same code runs
 * in the browser, the desktop app and the Android app (in a Web Worker
 * when the save is large). The shells only hand over the bytes of a copy
 * of the save.
 */

import { SaveReadError, type ReadOptions, type SaveReader } from './reader';
import type { SaveSummary } from './summary';
import { witcher3Reader } from './witcher3/reader';

export * from './reader';
export * from './summary';
export * from './match/index';
export * from './games';
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
