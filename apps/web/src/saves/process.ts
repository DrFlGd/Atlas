import {
  matchSave,
  pinTableBuilder,
  readerById,
  SaveReadError,
  type GameFileInput,
  type GamePinTable,
  type MapCalibration,
  type PackForMatching,
  type PinTableStats,
  type SaveErrorCode,
  type SaveMatch,
  type SaveSummary,
} from '@atlas/saves';

/**
 * Reading a save and matching it against the pack shown, and building the
 * table of the game's own map pins: the work the save worker does (see
 * `saveWorker.ts`), also run on the page when a worker cannot be started.
 */

/** What a job needs besides the save: the pack and the device's map settings. */
export interface SaveJobContext {
  /** The save reader's id, from the pack's game (see `readerForPack`). */
  readerId: string;
  pack: PackForMatching;
  worldMaps: Record<string, string | null>;
  calibrations: Record<string, MapCalibration>;
  /** The game's own map pins, read on this device; null when there is none. */
  table: GamePinTable | null;
  now: number;
}

/** Read a save's bytes and match it, or match a save read before again. */
export type SaveJob =
  | (SaveJobContext & { kind: 'read'; bytes: Uint8Array })
  | (SaveJobContext & { kind: 'match'; summary: SaveSummary });

export type SaveJobResult =
  | { ok: true; summary: SaveSummary; match: SaveMatch }
  | { ok: false; code: SaveErrorCode | 'failed'; message: string };

/** Build the table of the game's map pins from files the desktop app unpacked. */
export interface TableJob {
  kind: 'table';
  readerId: string;
  files: GameFileInput[];
  /** The game's executable's stamp, from the desktop app. */
  stamp: string;
  now: number;
}

export type TableJobResult =
  { ok: true; table: GamePinTable; stats: PinTableStats } | { ok: false; message: string };

export type WorkerJob = SaveJob | TableJob;
export type WorkerResult = SaveJobResult | TableJobResult;

export function processJob(job: SaveJob): SaveJobResult;
export function processJob(job: TableJob): TableJobResult;
export function processJob(job: WorkerJob): WorkerResult;
export function processJob(job: WorkerJob): WorkerResult {
  return job.kind === 'table' ? processTable(job) : processSave(job);
}

export function processTable(job: TableJob): TableJobResult {
  const build = pinTableBuilder(job.readerId);
  if (!build) return { ok: false, message: 'Atlas cannot read this game’s files.' };
  try {
    return { ok: true, ...build({ files: job.files, stamp: job.stamp, now: job.now }) };
  } catch (error) {
    console.error(error);
    return {
      ok: false,
      message: `The game’s map files could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

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
      table: job.table,
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
