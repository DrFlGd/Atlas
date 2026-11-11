/**
 * What a save reader makes of a save: a plain, structured-cloneable object
 * (it crosses from a Web Worker to the page), with nothing that names the
 * player or the computer.
 */

/** A point in the game's own world coordinates. */
export interface WorldPoint {
  x: number;
  y: number;
  z?: number;
}

/** A game world (level) the save knows of. */
export interface SaveWorld {
  /** Stable id: the world's folder name in the game files, such as `novigrad`. */
  id: string;
  /** The game's own path of the world, such as `levels\novigrad\novigrad.w2w`. */
  path: string;
  /** A name for people, such as "Velen and Novigrad". */
  name: string;
}

/** Where the player stood when the game saved. */
export interface SavePlayer {
  /** World id, as in {@link SaveWorld}; null when the save does not say. */
  world: string | null;
  position: WorldPoint;
  /**
   * Facing, in degrees as the game stores it (its yaw), or null when the
   * save has none. Turned into a direction on the map by the matcher.
   */
  yaw: number | null;
}

/**
 * A map pin the save knows of, with whatever state it has. A Witcher 3 save
 * names its pins by the game's own tag alone: no world, type or position.
 * Those live in the game's files, not in the save.
 */
export interface SavePin {
  /** The pin's name in the game (an entity name or tag), or a made-up id when it has none. */
  id: string;
  /** World id, when known. */
  world: string | null;
  /** The game's pin type, such as `MonsterNestDisabled`; null when unknown. */
  type: string | null;
  /** The pin kind the reader recognised in the type (see the reader's tuning), or null. */
  kind: string | null;
  /** Where the pin is in its world; null when the save does not say. */
  position: WorldPoint | null;
  /** Shown on the map (not a question mark any more). Undefined: the save does not say. */
  discovered?: boolean;
  /** Known to the player, for example from a notice board. */
  known?: boolean;
  /** Cleared or used: a destroyed nest, a looted treasure, a disabled pin type. */
  cleared?: boolean;
  tags?: string[];
}

/** A quest objective's map pin that the save switches on or off. */
export interface SaveQuestPin {
  /** The journal objective's GUID, as hex. */
  objective: string;
  /** The map pin's GUID, as hex. */
  pin: string;
  shown: boolean;
}

/** A pin a quest puts on a person (an agent), such as one with a quest to give. */
export interface SaveAgentPin {
  /** The person's tag in the game. */
  tag: string;
  /** The pin type, such as `QuestAvailable`; null when the save does not say. */
  type: string | null;
  /** Shown even when the person is far away; null when the save does not say. */
  showAlways: boolean | null;
}

/**
 * What the save's own world map holds, in counts, before any matching.
 * Each count is how many map pins the save lists in that state, by tag.
 */
export interface SaveMapState {
  /** Pins the player knows of without having been there, for example from a notice board. */
  known: number;
  /** Pins the player has discovered: shown on the map, not a question mark any more. */
  discovered: number;
  /** Pins switched off: a cleared nest or a looted treasure, by what is known so far. */
  disabled: number;
  /** World ids the map marks as visited. */
  visited: string[];
  /** Quest objectives' map pins, as the save switches them. */
  questPins: SaveQuestPin[];
  /** Pins quests put on people. */
  agentPins: SaveAgentPin[];
  /**
   * The length every list of the map declares, by the list's name in the
   * save, added up over worlds. For diagnostics: it says which lists hold
   * anything, without naming what.
   */
  lists: Record<string, number>;
}

/** The save's format version, as read from its header. */
export interface SaveVersion {
  /** The numbers in the file, in order. */
  numbers: number[];
  /** A short description for people, such as "save version 67, game version 29". */
  label: string;
}

/** A save, read into the parts Atlas uses. */
export interface SaveSummary {
  /** The reader's id, such as `witcher3`. */
  game: string;
  /** The game's title. */
  gameTitle: string;
  version: SaveVersion;
  /** The world the player was in. */
  world: SaveWorld | null;
  /** Every world the save has data of, the current one included. */
  worlds: SaveWorld[];
  player: SavePlayer | null;
  /**
   * Quest and world facts by name, with their current value (the sum of
   * their lasting records). Empty when the reader could not read them.
   */
  facts: Record<string, number>;
  pins: SavePin[];
  /** The save's own map: what it lists, in counts. Null when it could not be read. */
  map: SaveMapState | null;
  /** Size of the save data once unpacked, in bytes. */
  unpackedBytes: number;
  /** Things the reader could not read completely, in plain words. Never fatal. */
  notes: string[];
}
