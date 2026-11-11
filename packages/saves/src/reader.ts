import type { SaveSummary } from './summary';

/** Why a save could not be read. */
export type SaveErrorCode =
  /** No reader recognises the file. */
  | 'not-a-save'
  /** A reader recognises the file, but not the version that wrote it. */
  | 'unsupported-version'
  /** The file is larger than a save can be. */
  | 'too-large'
  /** The file looks like a save but its contents do not hold together (damaged, or still being written). */
  | 'damaged';

/** A save that cannot be read, with a message for people. */
export class SaveReadError extends Error {
  override name = 'SaveReadError';

  constructor(
    readonly code: SaveErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** A world of the game, as the matcher needs to know it. */
export interface GameWorld {
  /** The world id a reader puts in {@link SaveSummary}. */
  id: string;
  name: string;
  /**
   * Lowercase words or phrases that appear in the names of maps of this
   * world (in packs made by anyone), used to suggest which map shows it.
   */
  mapKeywords: string[];
}

/**
 * A kind of map pin and the pack categories it matches. The matcher marks
 * a pack location found when a pin of this kind is in the state
 * `foundWhen`, within the matching radius of the location, and the
 * location's category name holds one of `categoryKeywords`.
 */
export interface PinKindRule {
  kind: string;
  /** Plural name for people: "Signposts". */
  label: string;
  /** The game's pin types of this kind, compared without case. */
  types: string[];
  /** Lowercase words or phrases found in matching category names. */
  categoryKeywords: string[];
  /** `discovered`: found once seen on the map; `cleared`: once done. */
  foundWhen: 'discovered' | 'cleared';
  /** Pins of this kind are places that never move, good for lining up a map automatically. */
  anchor: boolean;
}

/** What the matcher needs to know about a game, kept in one place per game so it is easy to tune. */
export interface SaveTuning {
  worlds: GameWorld[];
  pinKinds: PinKindRule[];
  /** How far a pin may be from a pack location and still match it, in world units (metres). */
  matchRadius: number;
  /** The smallest radius in map pixels, so a tiny map scale still finds neighbours. */
  minRadiusPx: number;
}

export interface ReadOptions {
  /** Refuse saves that unpack to more than this many bytes. */
  maxUnpackedBytes?: number;
}

/**
 * A reader for one game's saves. Readers are pure: they take the bytes of
 * a copy of the save and never touch a file.
 */
export interface SaveReader {
  /** Stable id, such as `witcher3`. */
  id: string;
  /** The game's title. */
  title: string;
  /** File name endings of saves, lowercase with the dot, for file pickers. */
  extensions: string[];
  /** Whether the bytes look like this game's save (a quick check of the first bytes). */
  detect(bytes: Uint8Array): boolean;
  /** Reads a save. Throws {@link SaveReadError} when it cannot. */
  read(bytes: Uint8Array, options?: ReadOptions): SaveSummary;
  /** Whether a pack is for this game, from its id and title. */
  matchesPack(pack: { gameId: string; title: string }): boolean;
  tuning: SaveTuning;
}
