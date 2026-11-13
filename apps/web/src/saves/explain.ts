import type { SaveMatch, SaveSummary } from '@atlas/saves';

/**
 * Plain words for what a read save holds and why it marks nothing, when it
 * marks nothing. A save that marks nothing is not a failure: a new game
 * has discovered nothing yet, and a Witcher 3 save names its places by the
 * game's own tags, without saying where they are.
 */

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One sentence for the notice after a read; null when there is nothing to explain. */
export function nothingNotice(match: SaveMatch): string | null {
  switch (match.nothingBecause) {
    case 'nothing-done':
      return 'The save has not discovered any locations yet.';
    case 'no-tag-table':
      return `The save names ${count(match.unplaced, 'discovered location', 'discovered locations')} by the game’s own tags only, and Atlas has no table yet of where those are.`;
    case 'not-in-table':
      return `The save names ${count(match.unplaced, 'discovered location', 'discovered locations')} by tags that are not among the map locations Atlas read from the game.`;
    case 'no-map':
      return 'The save’s map could not be read.';
    case null:
      return null;
  }
}

/** A short paragraph for the Game save dialog; null when there is nothing to explain. */
export function nothingExplained(match: SaveMatch): string | null {
  switch (match.nothingBecause) {
    case 'nothing-done':
      return 'This save has not discovered or cleared any locations yet, so there is nothing to mark. That is expected near the start of the game: locations are marked once a save has found them.';
    case 'no-tag-table':
      return `This save lists ${count(match.unplaced, 'location', 'locations')} as discovered or cleared, but names them only by the game’s own tags, without saying where they are. To tell which locations of this pack they are, Atlas needs a table of where each tag is, from the game’s own files, and it does not have one yet. The desktop app can read it from your copy of the game (“Map locations from the game”). Nothing is wrong with the save.`;
    case 'not-in-table':
      return `This save lists ${count(match.unplaced, 'location', 'locations')} as discovered or cleared by the game’s own tags, but none of them is among the map locations Atlas read from the game. If the game was updated or a DLC added since, read the map locations again. Nothing is wrong with the save.`;
    case 'no-map':
      return 'Atlas could not read this save’s map, so it cannot tell which locations the save has found.';
    case null:
      return null;
  }
}

/** What the save's own map holds, in counts; null when the save's map could not be read. */
export function mapStateText(summary: SaveSummary): string | null {
  const map = summary.map;
  if (!map) return null;
  const parts = [
    count(map.discovered, 'location discovered', 'locations discovered'),
    count(map.disabled, 'cleared', 'cleared'),
    count(map.known, 'known of', 'known of'),
  ];
  return `On the save’s own map: ${parts.join(', ')}.`;
}
