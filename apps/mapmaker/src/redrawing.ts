/**
 * Draw all areas again: the report the helper writes (`atlas-gamefiles redraw`, tools/gamefiles/atlas_gamefiles/
 * redraw.py) when it draws a pack's 2D floors again from the pack's own 3D models, and the sentences the window
 * shows for it.
 */
import {
  mapStyleLabel,
  plural,
  removedLine,
  type MapStyleId,
  type RemovedPiecesReport,
} from './report';
import type { PackWithScenes } from './shell';

/** Where a map's floors came from: the player's floor cuts, the pack's own floors, or automatic passages again. */
export type FloorsFrom = 'yours' | 'pack' | 'passages';

/** One map of the pack: drawn again, or why not. */
export interface RedrawnMap {
  id: string;
  name: string;
  redrawn: boolean;
  reason?: string | null;
  floors?: number;
  floorsFrom?: FloorsFrom;
  /** Its floors came to another number, and its layers with them (a pack the Map Maker made). */
  layersChanged?: { before: number; after: number };
  /** Locations put on another floor. */
  locationsMoved?: number;
  tiles?: number;
  triangles?: number;
  /** Cells read at each level of detail ("0" the finest). */
  levels?: Record<string, number>;
  textures?: number;
  seconds?: number;
  /** The pieces removed in Adjust floors, found in its 3D model by their place and left out. */
  removedPieces?: RemovedPiecesReport;
}

export interface RedrawReport {
  kind: 'redraw';
  toolVersion: string;
  createdAt: string;
  pack: {
    id: string;
    folder: string;
    title?: string | null;
    gameId?: string | null;
    madeByMapMaker: boolean;
  };
  options?: { mapStyle?: MapStyleId };
  maps: RedrawnMap[];
  summary: { maps: number; redrawn: number; skipped: number; tiles: number } | null;
  check3d?: { problems?: string[] } | null;
  warnings: string[];
  elapsedSeconds?: number;
}

export function isRedrawReport(value: unknown): value is RedrawReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { kind?: unknown }).kind === 'redraw' &&
    Array.isArray((value as { maps?: unknown }).maps)
  );
}

/** One sentence on what was drawn again. */
export function redrawSummaryLine(report: RedrawReport): string {
  const withModel = report.maps.filter((map) => map.redrawn || map.reason !== 'it has no 3D model');
  const drawn = report.maps.filter((map) => map.redrawn).length;
  const style = mapStyleLabel(report.options?.mapStyle);
  const left = withModel.length - drawn;
  const without = report.maps.length - withModel.length;
  const parts = [
    `${drawn} of ${plural(withModel.length, 'map')} with a 3D model drawn again in ${style}`,
    left > 0 ? `${left} left as ${left === 1 ? 'it was' : 'they were'}` : null,
    without > 0 ? `${plural(without, 'map')} without a 3D model not touched` : null,
  ];
  return `${parts.filter(Boolean).join('; ')}.`;
}

const FROM: Record<FloorsFrom, string> = {
  yours: 'your floor cuts',
  pack: 'the pack’s floors',
  passages: 'automatic passages',
};

/** What became of one map, after its name. */
export function redrawnMapLine(map: RedrawnMap): string {
  if (!map.redrawn) return `left as it was: ${map.reason ?? 'it could not be drawn again'}`;
  const parts = [
    `drawn again, ${plural(map.floors ?? 0, 'floor')}${map.floorsFrom ? ` (${FROM[map.floorsFrom]})` : ''}`,
    map.layersChanged
      ? `its layers went from ${map.layersChanged.before} to ${map.layersChanged.after}`
      : null,
    map.locationsMoved ? `${plural(map.locationsMoved, 'location')} on another floor now` : null,
    map.levels && !map.levels['0'] ? 'from a coarser level of its 3D model' : null,
    map.removedPieces && map.removedPieces.found > 0
      ? `${removedLine(map.removedPieces)}, left out of its pictures and its 3D model`
      : null,
  ];
  return parts.filter(Boolean).join('; ');
}

/** The pack to offer first: the one just made, when it has 3D maps, else the first listed. */
export function defaultPack(packs: readonly PackWithScenes[], made: string | null): string | null {
  if (made && packs.some((pack) => pack.id === made)) return made;
  return packs[0]?.id ?? null;
}
