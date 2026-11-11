import {
  matchSave,
  readerById,
  SaveReadError,
  type MapCalibration,
  type PackForMatching,
  type SaveErrorCode,
  type SaveMatch,
  type SaveSummary,
} from '@atlas/saves';

/**
 * Reading a save and matching it against the pack shown: the work the save
 * worker does (see `saveWorker.ts`), also run on the page when a worker
 * cannot be started.
 */

/** What a job needs besides the save: the pack and the device's map settings. */
export interface SaveJobContext {
  /** The save reader's id, from the pack's game (see `readerForPack`). */
  readerId: string;
  pack: PackForMatching;
  worldMaps: Record<string, string | null>;
  calibrations: Record<string, MapCalibration>;
  now: number;
}

/** Read a save's bytes and match it, or match a save read before again. */
export type SaveJob =
  | (SaveJobContext & { kind: 'read'; bytes: Uint8Array })
  | (SaveJobContext & { kind: 'match'; summary: SaveSummary });

export type SaveJobResult =
  | { ok: true; summary: SaveSummary; match: SaveMatch }
  | { ok: false; code: SaveErrorCode | 'failed'; message: string };

export function processSave(job: SaveJob): SaveJobResult {
  const reader = readerById(job.readerId);
  if (!reader) {
    return { ok: false, code: 'not-a-save', message: 'Atlas cannot read saves of this game.' };
  }
  try {
    const summary = job.kind === 'read' ? reader.read(job.bytes) : job.summary;
    const match = matchSave({
      summary,
      pack: job.pack,
      tuning: reader.tuning,
      worldMaps: job.worldMaps,
      calibrations: job.calibrations,
      now: job.now,
    });
    return { ok: true, summary, match };
  } catch (error) {
    if (error instanceof SaveReadError)
      return { ok: false, code: error.code, message: error.message };
    console.error(error);
    return {
      ok: false,
      code: 'failed',
      message: `The save could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
