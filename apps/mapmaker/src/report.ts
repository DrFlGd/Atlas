/**
 * The report the helper (tools/gamefiles) writes, and the plain-language words the window uses for it.
 */

export type SourceStatus = 'ok' | 'partial' | 'failed' | 'missing' | 'not-decoded' | 'timed-out';
export type GeometrySourceName = 'collision' | 'navmesh' | 'mapPieces';

export interface SourceResult {
  status: SourceStatus;
  format: string;
  files: string[];
  entries: number;
  read: number;
  failed: number;
  triangles: number;
  vertices: number;
  seconds: number;
  unplaced?: number;
  /** Only some of the files were read: an evenly spaced sample, or as many as the time budget allowed. */
  sampled?: boolean;
  havokClasses?: string[];
  errors?: string[];
  note?: string;
  /** Seconds to open the binder. */
  openSeconds?: number;
  /** Seconds per file read. */
  fileSeconds?: { files: number; min: number; median: number; max: number };
  slowestFile?: string;
  /** A source stopped at the time limit (status `timed-out`): the file it was on and the files done before it. */
  stoppedOn?: string;
  filesDone?: number;
  timeLimitSeconds?: number;
}

export interface Bounds {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

export interface AreaPreview {
  file: string;
  geometry: string;
  width: number;
  height: number;
  pixelsPerMetre: number;
  dots: Record<string, number>;
}

export interface AreaReport {
  id: string;
  name: string;
  msbFile: string;
  mapFolder: string | null;
  msb: { ok: boolean; error?: string };
  parts?: Record<string, number>;
  partsTotal?: number;
  treasures?: number;
  itemLotsReferenced?: number;
  itemLotsFound?: number | null;
  bonfireCandidates?: { count: number; method: string; examples: string[] } & Record<
    string,
    unknown
  >;
  bounds?: Bounds | null;
  pointBounds?: Bounds | null;
  geometry: Record<GeometrySourceName, SourceResult>;
  preview: AreaPreview | null;
}

export interface GameInfo {
  id: 'dark-souls-remastered' | 'bloodborne' | 'dark-souls-ptde' | 'unknown';
  title: string;
  supported: boolean;
  version: string | null;
  dataFolder: string | null;
  evidence: string[];
  details?: Record<string, unknown>;
  reason?: string;
}

export interface GeometryCounts {
  ok: number;
  partial: number;
  failed: number;
  missing: number;
  'not-decoded': number;
  /** Missing from reports made before version 0.1.1. */
  'timed-out'?: number;
  triangles: number;
}

export interface ReportSummary {
  areas: number;
  areasRead: number;
  parts: number;
  treasures: number;
  itemLotsReferenced: number;
  itemLotsFound: number | null;
  bonfireCandidates: number;
  geometry: Record<GeometrySourceName, GeometryCounts>;
  previews: number;
  recommendedGeometry: GeometrySourceName | null;
  recommendation: string;
  mainAreas?: { expected: number; found: number; missing: string[] };
}

/** How the helper ran (from version 0.1.2): for a report from a PC where the check stalled. */
export interface ReportDiagnostics {
  frozen: boolean;
  python: string;
  helperVersion: string;
  system: string;
  tempDir: string | null;
  soulstructImportSeconds: number | null;
  reader: {
    startedWith: string;
    startSeconds?: number | null;
    lastStage?: string | null;
    broken?: string;
    havokBroken?: string;
    logTail?: string[];
    [key: string]: unknown;
  };
}

export interface Report {
  tool: string;
  toolVersion: string;
  reportVersion: number;
  createdAt: string;
  folder: string;
  game: GameInfo;
  gameData: {
    itemLots: { ok: boolean; file: string | null; rows: number; error?: string };
    itemText: { ok: boolean; file: string | null; tables: number; entries: number; error?: string };
  } | null;
  areas: AreaReport[];
  summary: ReportSummary | null;
  warnings: string[];
  elapsedSeconds: number;
  /** Missing from reports made before version 0.1.2. */
  diagnostics?: ReportDiagnostics;
}

export const SOURCE_LABELS: Record<GeometrySourceName, string> = {
  collision: 'Collision',
  navmesh: 'Navmesh',
  mapPieces: 'Map pieces',
};

const numberFormat = new Intl.NumberFormat('en-US');

export function count(value: number): string {
  return numberFormat.format(value);
}

export function plural(value: number, one: string, many = `${one}s`): string {
  return `${count(value)} ${value === 1 ? one : many}`;
}

/** "0.25", "3.4", "42": seconds with as many decimals as matter. */
export function secondsText(seconds: number): string {
  if (seconds < 1) return seconds.toFixed(2);
  if (seconds < 10) return seconds.toFixed(1);
  return count(Math.round(seconds));
}

/** One cell of the areas table: whether a geometry source worked, in words. */
export function sourceText(result: SourceResult): string {
  switch (result.status) {
    case 'ok':
      if (result.sampled) {
        const files = `${count(result.read)} of ${plural(result.entries, 'file')}`;
        return result.triangles > 0
          ? `Read a sample (${files}, ${plural(result.triangles, 'triangle')})`
          : `Read a sample (${files})`;
      }
      return result.triangles > 0
        ? `Read (${plural(result.triangles, 'triangle')})`
        : `Read (${plural(result.read, 'file')})`;
    case 'partial':
      return result.sampled
        ? `Partly read (${count(result.read)} of ${plural(result.read + result.failed, 'sampled file')})`
        : `Partly read (${count(result.read)} of ${plural(result.entries, 'file')})`;
    case 'failed':
      return `Could not read (${plural(result.entries, 'file')})`;
    case 'missing':
      return 'No files';
    case 'not-decoded':
      return `Opens, not decoded yet (${plural(result.read, 'file')})`;
    case 'timed-out':
      return `Took too long: stopped after ${secondsText(result.timeLimitSeconds ?? result.seconds)} seconds`;
  }
}

export type Tone = 'good' | 'warn' | 'bad' | 'muted';

export function sourceTone(status: SourceStatus): Tone {
  switch (status) {
    case 'ok':
      return 'good';
    case 'partial':
    case 'not-decoded':
    case 'timed-out':
      return 'warn';
    case 'failed':
      return 'bad';
    case 'missing':
      return 'muted';
  }
}

/** The details shown under a table cell: notes, errors and the files read. */
export function sourceDetails(result: SourceResult): string[] {
  const lines: string[] = [];
  if (result.note) lines.push(result.note);
  if (result.unplaced)
    lines.push(`${plural(result.unplaced, 'file')} placed by no part of the map layout`);
  if (result.havokClasses?.length) lines.push(`Havok contents: ${result.havokClasses.join(', ')}`);
  const times = result.fileSeconds;
  if (times) {
    const range =
      times.files === 1
        ? `${secondsText(times.max)} seconds for 1 file`
        : `${secondsText(times.min)} to ${secondsText(times.max)} seconds per file (middle ${secondsText(times.median)})`;
    lines.push(
      `Reading time: ${range}${result.slowestFile ? `, slowest ${result.slowestFile}` : ''}`,
    );
  }
  if (result.openSeconds !== undefined && result.openSeconds >= 1)
    lines.push(`Opening the files took ${secondsText(result.openSeconds)} seconds`);
  for (const error of result.errors ?? []) lines.push(`Error: ${error}`);
  return lines;
}

/** The headline: which game, which version. */
export function gameHeadline(game: GameInfo): string {
  if (game.id === 'unknown') return 'No supported game found in this folder';
  const version = game.version ? `, version ${game.version}` : '';
  return `${game.title}${version}`;
}

/** One sentence on what was found, for the top of the results. */
export function summaryLine(report: Report): string {
  const summary = report.summary;
  if (!summary) return report.game.reason ?? 'This folder could not be checked.';
  const parts = [
    `${plural(summary.areas, 'area')} found`,
    summary.areasRead < summary.areas ? `${count(summary.areasRead)} read` : null,
    plural(summary.treasures, 'treasure event'),
    `${plural(summary.itemLotsReferenced, 'item lot')} referenced` +
      (summary.itemLotsFound === null
        ? ''
        : ` (${count(summary.itemLotsFound)} in the item table)`),
    plural(
      summary.bonfireCandidates,
      report.game.id === 'bloodborne' ? 'lamp candidate' : 'bonfire candidate',
    ),
  ];
  return `${parts.filter(Boolean).join(', ')}.`;
}

/** "x −120 to 340, z −80 to 410 (height 0 to 95)". */
export function boundsText(bounds: Bounds | null | undefined): string {
  if (!bounds) return '';
  const range = ([low, high]: [number, number]) => `${Math.round(low)} to ${Math.round(high)}`;
  return `x ${range(bounds.x)}, z ${range(bounds.z)} (height ${range(bounds.y)})`;
}

/** A file name to suggest when saving the report: atlas-check-dark-souls-remastered-2026-11-11.zip. */
export function suggestedFileName(report: Report | null, now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `atlas-check-${report?.game.id ?? 'unknown'}-${date}.zip`;
}

/** Preview file name of an area, as the shell accepts it. */
export function previewFile(area: AreaReport): string | null {
  const file = area.preview?.file;
  return file && /^previews\/[A-Za-z0-9_]+\.png$/.test(file) ? file : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Make map: the report `atlas-gamefiles make` writes (kind "make").

export type MarkerCategory =
  | 'bonfire'
  | 'boss'
  | 'npc'
  | 'drop'
  | 'weapon'
  | 'armour'
  | 'ring'
  | 'spell'
  | 'key'
  | 'upgrade'
  | 'other'
  | 'consumable'
  | 'souls';

/** In the order the report lists them, with the words the window uses. */
export const CATEGORY_LABELS: Record<MarkerCategory, string> = {
  bonfire: 'Bonfires',
  boss: 'Bosses',
  npc: 'NPCs',
  drop: 'Guaranteed drops',
  weapon: 'Weapons',
  armour: 'Armour',
  ring: 'Rings',
  spell: 'Spells',
  key: 'Key items',
  upgrade: 'Upgrade materials',
  other: 'Other items',
  consumable: 'Consumables',
  souls: 'Souls',
};

export interface MadeFloor {
  index: number;
  name: string;
  heights: [number, number];
  areaSquareMetres: number;
  triangles: number;
  wallLines: number;
  markers: Partial<Record<MarkerCategory, number>>;
  tiles: { minZoom: number; maxZoom: number; tileSize: number; files: number; bytes: number };
  preview: string;
}

export interface MadeArea {
  id: string;
  key: string;
  name: string;
  /** Why the area was left out (a debug map, or one the config skips). */
  skipped?: string;
  geometry?: { used: GeometrySourceName | null } & Partial<
    Record<GeometrySourceName, SourceResult>
  >;
  bonfires?: { method: string; registered?: number; placed?: number; objectsNotFound?: unknown[] };
  treasure?: {
    events: number;
    lotsReferenced: number;
    lotsFound: number;
    lotsEmpty?: number;
    lotsMissing?: { count: number; examples?: number[]; tableEmpty?: boolean };
  };
  characters?: {
    total: number;
    bosses: number;
    bossesExpected?: number;
    bossesNotFound?: string[];
    npc?: number;
    guaranteedDrop?: number;
  };
  placement?: { verdict: string; markersChecked: number } & Record<string, unknown>;
  frame?: { width: number; height: number; pixelsPerMetre: number; cropped: boolean };
  mainFloor?: number;
  floors?: MadeFloor[];
  markers?: {
    total: number;
    byCategory: Partial<Record<MarkerCategory, number>>;
    notOnFloor: number;
    notOnFloorList?: { key: string; category: MarkerCategory; height: number }[];
    withFlag: number;
    placeNames: number;
  };
  seconds?: number;
}

export interface MakeReport {
  tool: string;
  toolVersion: string;
  reportVersion: number;
  kind: 'make';
  createdAt: string;
  folder: string;
  game: GameInfo;
  areas: MadeArea[];
  pack: {
    id: string;
    folder: string;
    installed: boolean;
    mapsFolder: string;
    counts: Record<string, number>;
    tiles: number;
    tileBytes: number;
  } | null;
  summary: {
    areas: number;
    areasMade: number;
    areasSkipped: string[];
    floors: number;
    markers: number;
    markersByCategory: Partial<Record<MarkerCategory, number>>;
    notOnFloor: number;
  } | null;
  warnings: string[];
  elapsedSeconds: number;
  diagnostics?: ReportDiagnostics;
}

export type AnyReport = Report | MakeReport;

export function isMakeReport(report: AnyReport | null | undefined): report is MakeReport {
  return (report as MakeReport | null | undefined)?.kind === 'make';
}

/** "Bonfires 4, Bosses 1, Rings 1": a count per category, in the usual order, leaving out the empty ones. */
export function categoryCounts(counts: Partial<Record<MarkerCategory, number>>): string {
  return (Object.keys(CATEGORY_LABELS) as MarkerCategory[])
    .filter((category) => (counts[category] ?? 0) > 0)
    .map((category) => `${CATEGORY_LABELS[category]} ${count(counts[category] ?? 0)}`)
    .join(', ');
}

/** One sentence on what was made, for the top of the results. */
export function makeSummaryLine(report: MakeReport): string {
  const summary = report.summary;
  if (!summary) return report.game.reason ?? 'No map could be made from this folder.';
  const parts = [
    `${plural(summary.areasMade, 'area')} drawn`,
    plural(summary.floors, 'floor'),
    plural(summary.markers, 'marker'),
    summary.areasSkipped.length > 0
      ? `${plural(summary.areasSkipped.length, 'area')} left out`
      : null,
  ];
  return `${parts.filter(Boolean).join(', ')}.`;
}

/** What to look at in an area of a made map, in plain words; empty when all went as expected. */
export function areaNotes(area: MadeArea): string[] {
  if (area.skipped) return [`Left out: ${area.skipped}`];
  const notes: string[] = [];
  if (area.geometry && !area.geometry.used)
    notes.push('No collision or navmesh could be read: markers only, on an empty picture');
  else if (area.geometry?.used === 'navmesh')
    notes.push('Drawn from the navmesh (collision could not be read)');
  const notOnFloor = area.markers?.notOnFloor ?? 0;
  if (notOnFloor > 0 && area.geometry?.used)
    notes.push(`${plural(notOnFloor, 'marker')} not over any floor (put on the main floor)`);
  const missingBosses = area.characters?.bossesNotFound ?? [];
  if (missingBosses.length > 0) notes.push(`Bosses not found: ${missingBosses.join(', ')}`);
  const missingLots = area.treasure?.lotsMissing?.count ?? 0;
  if (missingLots > 0)
    notes.push(`${plural(missingLots, 'item lot')} not in the item table (left off the map)`);
  const lostBonfires = area.bonfires?.objectsNotFound?.length ?? 0;
  if (lostBonfires > 0)
    notes.push(`${plural(lostBonfires, 'bonfire')} registered by the event script but not placed`);
  if (area.frame?.cropped)
    notes.push(
      `Too large for one picture: drawn at ${area.frame.pixelsPerMetre} pixels per metre and cropped`,
    );
  if (area.placement && !area.placement.verdict.startsWith('placed by part'))
    notes.push(`Collision placement: ${area.placement.verdict}`);
  return notes;
}

/** A file name to suggest when saving a make's report: atlas-make-dark-souls-remastered-2026-11-12.zip. */
export function makeSuggestedFileName(report: MakeReport | null, now: Date): string {
  return suggestedFileName(report as Report | null, now).replace(/^atlas-check-/, 'atlas-make-');
}

/** Preview file name of one floor, as the shell accepts it. */
export function floorPreviewFile(floor: MadeFloor): string | null {
  return /^previews\/[A-Za-z0-9_]+\.png$/.test(floor.preview) ? floor.preview : null;
}
