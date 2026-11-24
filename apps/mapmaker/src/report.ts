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
  /** The game, or for a map made from a 3D model, its pack id. */
  id:
    | 'dark-souls-remastered'
    | 'bloodborne'
    | 'dark-souls-ptde'
    | 'unknown'
    | (string & Record<never, never>);
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
  /** The cuts below and above it (null: no cut on that side). */
  between?: [number | null, number | null];
  areaSquareMetres: number;
  triangles: number;
  wallLines: number;
  markers: Partial<Record<MarkerCategory, number>>;
  tiles: { minZoom: number; maxZoom: number; tileSize: number; files: number; bytes: number };
  preview: string;
}

/** What 3D maps are made from ("3D look"): the game's own models with their textures, or the collision. */
export type Look3d = 'models' | 'collision';

export const LOOKS_3D: { id: Look3d; label: string }[] = [
  { id: 'models', label: 'Game models' },
  { id: 'collision', label: 'Collision' },
];

/** An area's 3D model, as Make map reports it (with "Also make 3D maps"). */
export interface MadeScene {
  made: boolean;
  /** Why it was not made. */
  reason?: string;
  /** What it was made from. */
  look?: Look3d;
  /** Why it was made from the collision when the game's models were asked for. */
  lookNote?: string;
  /** With the game's models: the textures kept (each at its own size at the finest level). */
  textures?: { kept?: number; leftOut?: number; bytes?: number; largestCellBytes?: number };
  /** Triangles read from the game, and of the model's finest level once cleaned. */
  trianglesBefore: number;
  trianglesAfter?: number;
  trianglesDropped?: number;
  /** Each level of detail over all cells, finest first. */
  levels?: { level: number; cells: number; triangles: number; bytes: number }[];
  cells?: number;
  cellSize?: number;
  files?: number;
  bytes?: number;
  seconds?: number;
  /** Each floor's [min, max] heights, when the area has storeys. */
  floors?: [number, number][] | null;
  /** Markers with no surface under them. */
  noSurfaceUnder?: number;
  warnings?: string[];
}

/** How much walkable floor there is at each height: bar i covers low + i × step to low + (i + 1) × step. */
export interface HeightProfile {
  low: number;
  high: number;
  step: number;
  /** Square metres, seen from above. */
  areas: number[];
}

/** Who set a cut: the Map Maker by itself, the player (Adjust floors), or the Map Maker's settings for the area. */
export type CutSource = 'automatic' | 'yours' | 'shipped';

/** How an area's floors are found: automatic passages (whole ground, split where one walkable surface lies over
 * another) or cut heights. */
export type FloorMethod = 'passages' | 'cuts';

export const FLOOR_METHODS: { id: FloorMethod; label: string }[] = [
  { id: 'passages', label: 'Automatic passages' },
  { id: 'cuts', label: 'Cuts' },
];

export function floorMethodLabel(id: string | undefined | null): string {
  return FLOOR_METHODS.find((method) => method.id === id)?.label ?? 'Cuts';
}

/** Which storey the main floor shows in an overlapping place. */
export type PassageShow = 'upper' | 'lower';

/** The player's choice for an overlapping place, found again by a point in it. */
export interface PassageChoice {
  x: number;
  z: number;
  show: PassageShow;
}

/** An overlapping place: where one walkable surface lies over another (passages.py). */
export interface PassagePlace {
  id: number;
  /** A point in it (world x east, z north). */
  x: number;
  z: number;
  /** Square metres seen from above. */
  area: number;
  /** How many storeys stack there. */
  levels: number;
  /** Its lowest and highest walkable height. */
  heights: [number, number];
  show: PassageShow;
  /** The player chose `show` (otherwise: upper, by default). */
  set: boolean;
  sheets: number;
  /** The floors its storeys are on. */
  floors: number[];
}

export interface PassagesReport {
  sheets: number;
  levels: number;
  mainLevel: number;
  joinsRefused?: number;
  levelClashes?: number;
  choicesUsed?: number;
  places: PassagePlace[];
}

export interface FloorPlanReport {
  /** Cuts when none is given (reports from before automatic passages). */
  method?: FloorMethod;
  cuts: number[];
  cutList?: { height: number; by: CutSource }[];
  /** Each automatic cut: with stacked floors, the floor area over and under it; by ground area (a 3D model), the
   * floor level it is under and the area of ground there. */
  automaticCuts?: {
    height: number;
    stackedArea?: number;
    slicedArea?: number;
    level?: number;
    groundArea?: number;
  }[];
  profile?: HeightProfile;
  /** The floor cuts used for the area, and where they came from. */
  overrides?: {
    from: 'yours' | 'shipped';
    cuts?: number[];
    names?: string[];
    splitAt?: number[];
    mergeAt?: number[];
    method?: FloorMethod;
    passages?: PassageChoice[];
  } | null;
  /** The area's floors without the player's own cuts ("Back to automatic"). */
  shipped?: { cuts: number[]; names: string[] | null; passages?: PassageChoice[] };
  /** Automatic passages: the overlapping places and the sheets of ground. */
  passages?: PassagesReport;
  /** Automatic passages: the navmesh triangles read, and those kept where collision ground lies under them. */
  navmesh?: { triangles: number; kept: number; used: boolean };
  /** Cuts given that left a floor with nothing on it, so were dropped. */
  cutsDropped?: number[];
  /** How the automatic cuts were found: `ground` (by ground area, for a 3D model), `stacked` or `none`. */
  automatic?: 'ground' | 'stacked' | 'none';
}

/** How the floors are drawn: the helper's render.MAP_STYLES. */
export type MapStyleId = 'shaded' | 'outlines' | 'textured' | 'textured-outlines';

export const TEXTURES_NOTE =
  'Drawn from the game’s own models and textures; an area whose models cannot be read is height shaded';

export const MAP_STYLES: { id: MapStyleId; label: string; available: boolean }[] = [
  { id: 'shaded', label: 'Height shaded', available: true },
  { id: 'outlines', label: 'Height shaded with outlines', available: true },
  { id: 'textured', label: 'Textured', available: true },
  { id: 'textured-outlines', label: 'Textured with outlines', available: true },
];

export function mapStyleLabel(id: string | undefined): string {
  return MAP_STYLES.find((style) => style.id === id)?.label ?? 'Height shaded';
}

export interface MadeArea {
  id: string;
  key: string;
  name: string;
  /** The map style it was drawn in (none: before map styles, "shaded"). */
  mapStyle?: MapStyleId;
  /** The map style asked for, when it was drawn in another (a textured style whose models could not be read). */
  mapStyleAsked?: MapStyleId;
  /** Why it was not drawn in the style asked for. */
  mapStyleNote?: string;
  /** The game's own models and textures, as read (the textured styles and the 3D look "Game models"). */
  models?: { status?: string; summary?: string; reason?: string } & Record<string, unknown>;
  /** Why the area was left out (a debug map, or one the config skips). */
  skipped?: string;
  /** What the floors were drawn from: `model` for a map made from a 3D model. */
  geometry?: { used: GeometrySourceName | 'model' | null } & Partial<
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
  floorPlan?: FloorPlanReport;
  floors?: MadeFloor[];
  markers?: {
    total: number;
    byCategory: Partial<Record<MarkerCategory, number>>;
    notOnFloor: number;
    notOnFloorList?: { key: string; category: MarkerCategory; height: number }[];
    withFlag: number;
    placeNames: number;
  };
  scene?: MadeScene;
  seconds?: number;
}

export interface MakeReport {
  tool: string;
  toolVersion: string;
  reportVersion: number;
  kind: 'make';
  /** `model` for a map made from a 3D model ("Make a map from a 3D model…"); none for game files. */
  source?: 'model';
  /** A map made from a 3D model: the model file and how it was set up. */
  model?: MadeModel;
  createdAt: string;
  /** When an area was made again last. */
  updatedAt?: string;
  folder: string;
  game: GameInfo;
  options?: {
    /** The player's own floor cuts file, and the areas that used it. */
    floorOverrides?: { file: string | null; error: string | null; usedFor: string[] };
    mapStyle?: MapStyleId;
    /** How floors were found where an area does not choose. */
    floorMethod?: FloorMethod;
  } & Record<string, unknown>;
  /** The area made again last ("Make this area again"). */
  remade?: { area: string; name: string; at: string };
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
    /** The 3D models over all areas; null or absent when 3D maps were off. */
    threeD?: {
      areasMade: number;
      areasNotMade: number;
      trianglesBefore: number;
      trianglesAfter: number;
      cells: number;
      files: number;
      bytes: number;
      seconds: number;
      noSurfaceUnder: number;
    } | null;
  } | null;
  warnings: string[];
  elapsedSeconds: number;
  diagnostics?: ReportDiagnostics;
}

/** The model a map was made from (the helper's model.py report `model`). */
export interface MadeModel {
  file: string;
  path: string;
  name: string;
  title: string;
  up: string;
  scale: number;
  units: string | null;
  textures: 'keep' | 'plain';
  format: string;
  triangles: number;
  materials: number;
  texturedMaterials: number;
  texturesFound: number;
  hasColours: boolean;
  bothSides: boolean;
  /** East to west, south to north, and height. */
  sizeMetres: [number, number, number];
  missingFiles: string[];
}

export type AnyReport = Report | MakeReport;

/** Whether a make's report is of a map made from a 3D model. */
export function isModelReport(report: AnyReport | null | undefined): report is MakeReport {
  return isMakeReport(report) && report.source === 'model';
}

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
  const threeD = summary.threeD;
  if (report.source === 'model') {
    const from = report.model ? ` from ${report.model.file}` : '';
    const model = threeD ? `, with its 3D model (${sizeText(threeD.bytes)})` : '';
    return `${plural(summary.floors, 'floor')}${from}${model}. No locations: add them in Atlas with Edit locations.`;
  }
  const parts = [
    `${plural(summary.areasMade, 'area')} drawn`,
    plural(summary.floors, 'floor'),
    plural(summary.markers, 'marker'),
    threeD ? `3D models of ${plural(threeD.areasMade, 'area')} (${sizeText(threeD.bytes)})` : null,
    summary.areasSkipped.length > 0
      ? `${plural(summary.areasSkipped.length, 'area')} left out`
      : null,
  ];
  return `${parts.filter(Boolean).join(', ')}.`;
}

/** "640 KB", "12.5 MB": a file size in plain words. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${count(Math.max(1, Math.round(bytes / 1024)))} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : count(Math.round(mb))} MB`;
}

/**
 * An area's 3D model in a few lines: triangles before and after (and per level of detail),
 * cells, size and time. Empty when 3D maps were off.
 */
export function sceneLines(scene: MadeScene | undefined): string[] {
  if (!scene) return [];
  if (!scene.made) return [`Not made: ${scene.reason ?? 'unknown reason'}`];
  const levels = scene.levels ?? [];
  const textures = scene.textures?.kept ?? 0;
  return [
    scene.look === 'models'
      ? `From the game’s models${textures > 0 ? `, ${plural(textures, 'texture')} at their own size` : ''}`
      : scene.look === 'collision'
        ? 'From the collision'
        : null,
    `${count(scene.trianglesBefore)} triangles read, ${count(scene.trianglesAfter ?? 0)} in the model`,
    levels.length > 1
      ? `Levels of detail: ${levels.map((level) => count(level.triangles)).join(', ')} triangles`
      : null,
    `${plural(scene.cells ?? 0, 'cell')}, ${plural(scene.files ?? 0, 'file')}, ${sizeText(scene.bytes ?? 0)}`,
    `${secondsText(scene.seconds ?? 0)} s`,
  ].filter((line): line is string => line !== null);
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
  if (area.scene && !area.scene.made && area.geometry?.used)
    notes.push(`No 3D model: ${area.scene.reason ?? 'unknown reason'}`);
  if (area.scene?.lookNote) notes.push(`3D map from the collision: ${area.scene.lookNote}`);
  if (area.mapStyleNote) notes.push(`Map ${area.mapStyleNote}`);
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

/** "6.3 m", "−2 m": a height, to the centimetre. */
export function heightText(height: number): string {
  const rounded = Math.round(height * 100) / 100;
  return `${rounded < 0 ? '−' : ''}${String(Math.abs(rounded))} m`;
}

const CUT_SOURCES: Record<CutSource, string> = {
  automatic: 'automatic',
  yours: 'set by you',
  shipped: 'set in the Map Maker',
};

export function cutSourceText(by: CutSource): string {
  return CUT_SOURCES[by];
}

/** "Cut at 6.3 m (automatic)", "Cuts at 4.5 m (set by you) and 12 m (automatic)", "No cut: one floor". */
export function cutsLine(area: MadeArea): string | null {
  const plan = area.floorPlan;
  if (!plan || !area.geometry?.used) return null;
  if (plan.method === 'passages') {
    const places = plan.passages?.places ?? [];
    const chosen = places.filter((place) => place.set).length;
    const where =
      places.length === 0
        ? 'nothing overlaps'
        : `${plural(places.length, 'overlapping spot')}${chosen ? `, ${count(chosen)} set by you` : ''}`;
    return `Automatic passages: ${where}`;
  }
  const list = plan.cutList ?? plan.cuts.map((height) => ({ height, by: 'automatic' as const }));
  if (list.length === 0) return 'No cut: one floor';
  const parts = list.map((cut) => `${heightText(cut.height)} (${cutSourceText(cut.by)})`);
  const joined =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list.length === 1 ? 'Cut' : 'Cuts'} at ${joined}`;
}

/** Where a floor lies between the cuts: "up to 6.3 m", "6.3 to 12 m", "from 12 m". Empty for a lone floor. */
export function floorRangeText(floor: MadeFloor): string {
  const [below, above] = floor.between ?? [null, null];
  if (below === null && above === null) return '';
  if (below === null) return `up to ${heightText(above!)}`;
  if (above === null) return `from ${heightText(below)}`;
  return `${heightText(below).replace(/ m$/, '')} to ${heightText(above)}`;
}

/** Whether the player's floor cuts as saved now (`saved`) differ from those the area was made with: saved,
 * changed or cleared since. */
export function waitingCuts(
  area: MadeArea,
  saved:
    | { cuts?: number[]; names?: string[]; method?: FloorMethod; passages?: PassageChoice[] }
    | undefined,
  usedOwn: boolean,
): boolean {
  if (!canAdjustFloors(area)) return false;
  if (!saved) return usedOwn;
  if (!usedOwn) return true;
  const used = area.floorPlan?.overrides;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    !same(saved.cuts, used?.cuts) ||
    !same(saved.names, used?.names) ||
    !same(saved.method, used?.method) ||
    !same(saved.passages, used?.passages)
  );
}

/** Whether Adjust floors can be offered for an area: it was drawn from geometry. */
export function canAdjustFloors(area: MadeArea): boolean {
  return !area.skipped && Boolean(area.geometry?.used) && Boolean(area.floorPlan);
}
