/**
 * One change to a game's pack at a time. Every step that writes a pack an
 * importer made (a page of a go, a single address, a page kept while
 * browsing, "Build again from saved pages", "Check the site for changes")
 * takes its turn for the pack's id: it reads the pack, has the importer
 * turn the page into the pack with it, and saves it, before the next step
 * for the same pack starts. Otherwise two steps could each read the pack
 * as it was, and the one saved last would leave out what the other added.
 *
 * Packs of other games do not wait for each other.
 */

const lasts = new Map<string, Promise<void>>();

/** A step's turn for a pack: `ready` once the steps before it are done; `done` lets the next go. */
export interface PackTurn {
  /** Another step for the same pack was under way when this one asked. */
  waits: boolean;
  ready: Promise<void>;
  done: () => void;
}

/** Asks for a turn to change the pack `packId`, after the steps that asked before. */
export function packTurn(packId: string): PackTurn {
  const before = lasts.get(packId);
  let done!: () => void;
  const mine = new Promise<void>((resolve) => {
    done = resolve;
  });
  const last = (before ?? Promise.resolve()).then(() => mine);
  lasts.set(packId, last);
  void last.then(() => {
    if (lasts.get(packId) === last) lasts.delete(packId);
  });
  return { waits: before !== undefined, ready: before ?? Promise.resolve(), done };
}

/** Whether a step is changing the pack `packId` now, or waiting to. */
export const packBusy = (packId: string): boolean => lasts.has(packId);

const saves = new Map<string, number>();

/** How many times the pack `packId` was saved by a step, since the app started. */
export const packSaves = (packId: string): number => saves.get(packId) ?? 0;

/** A step saved the pack `packId`. */
export function notePackSaved(packId: string): void {
  saves.set(packId, packSaves(packId) + 1);
}
