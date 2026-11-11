/**
 * A table of a game's own map pins, read from the game's files on the
 * person's computer (see `witcher3/gameFiles.ts`): every pin's name, type
 * and position, by world. It lets the matcher place pins that a save names
 * by tag alone, and line maps up from every pin of a kind.
 *
 * The table holds data from the game's files, so it stays on the device
 * that read them: it is never exported, never put in a pack and never
 * sent anywhere. It is keyed to the game's executable (`stamp`), so a
 * patch makes it stale and it is read again.
 */

/** One map pin of the game. Positions are world coordinates (metres). */
export interface GameTablePin {
  /** The pin's name: the entity name the game's scripts and saves use. */
  name: string;
  /** The game's pin type, such as `RoadSign`; empty when the file does not say. */
  type: string;
  x: number;
  y: number;
  z: number;
  /** The pin's radius in metres; 0 when the file does not say. */
  radius: number;
  /** The entity's tags, when they are not just its name. */
  tags?: string[];
}

export interface GamePinTable {
  format: 1;
  /** The save reader's id of the game, such as `witcher3`. */
  game: string;
  /** The game's executable's size and time, as the desktop app gives them. */
  stamp: string;
  /** When it was built, in milliseconds since the epoch. */
  builtAt: number;
  /** Pins by world id. */
  worlds: Record<string, GameTablePin[]>;
}

/** A pin found in the table, with its world. */
export interface TablePinAt {
  world: string;
  pin: GameTablePin;
}

/** Whether a value read from storage is a table this version of Atlas can use. */
export function isPinTable(value: unknown): value is GamePinTable {
  if (typeof value !== 'object' || value === null) return false;
  const table = value as Record<string, unknown>;
  const worlds = table.worlds;
  return (
    table.format === 1 &&
    typeof table.game === 'string' &&
    typeof table.stamp === 'string' &&
    typeof table.builtAt === 'number' &&
    typeof worlds === 'object' &&
    worlds !== null &&
    Object.values(worlds).every(Array.isArray)
  );
}

/** How many pins the table has in each world. */
export function tableCounts(table: GamePinTable): Record<string, number> {
  return Object.fromEntries(Object.entries(table.worlds).map(([id, pins]) => [id, pins.length]));
}

/**
 * Looking pins up by the name a save uses: an entity name, or else one of
 * its tags; compared exactly first, then without case.
 */
export class PinTableIndex {
  private readonly byName = new Map<string, TablePinAt[]>();
  private readonly byTag = new Map<string, TablePinAt[]>();
  private readonly byLowerName = new Map<string, TablePinAt[]>();
  private readonly byLowerTag = new Map<string, TablePinAt[]>();

  constructor(readonly table: GamePinTable) {
    const add = (map: Map<string, TablePinAt[]>, key: string, entry: TablePinAt) => {
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    };
    for (const [world, pins] of Object.entries(table.worlds)) {
      for (const pin of pins) {
        const entry = { world, pin };
        if (pin.name) {
          add(this.byName, pin.name, entry);
          add(this.byLowerName, pin.name.toLowerCase(), entry);
        }
        for (const tag of pin.tags ?? []) {
          if (tag === pin.name) continue;
          add(this.byTag, tag, entry);
          add(this.byLowerTag, tag.toLowerCase(), entry);
        }
      }
    }
  }

  /**
   * The pin a save's tag names. When several worlds have a pin of that
   * name, the one in `preferWorld` wins, else the first.
   */
  find(name: string, preferWorld: string | null): TablePinAt | null {
    const lower = name.toLowerCase();
    const found =
      this.byName.get(name) ??
      this.byTag.get(name) ??
      this.byLowerName.get(lower) ??
      this.byLowerTag.get(lower);
    if (!found || found.length === 0) return null;
    return found.find((entry) => entry.world === preferWorld) ?? found[0]!;
  }

  /** The pins of a world. */
  pinsOf(world: string): readonly GameTablePin[] {
    return this.table.worlds[world] ?? [];
  }
}
