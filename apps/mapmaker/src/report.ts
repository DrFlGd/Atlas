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
