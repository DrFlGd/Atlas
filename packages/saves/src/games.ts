import type { SaveGame } from './reader';
import { WITCHER3_GAME } from './witcher3/tuning';

/**
 * The games whose saves Atlas reads, without their readers: light enough
 * for the page, which offers saves for a pack and leaves the reading to a
 * worker (`@atlas/saves/games`).
 */

export const SAVE_GAMES: readonly SaveGame[] = [WITCHER3_GAME];

/** The game of a pack, or null when Atlas cannot read that game's saves. */
export function saveGameForPack(pack: { gameId: string; title: string }): SaveGame | null {
  return SAVE_GAMES.find((game) => game.matchesPack(pack)) ?? null;
}
