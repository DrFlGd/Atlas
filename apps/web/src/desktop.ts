import type { PictureSummary, PictureTilesRequest } from '@atlas/importer-api';
import type { PinTableStats, TableFit } from '@atlas/saves';

/**
 * The bridge to the desktop shell (`apps/desktop`). The web app has no
 * dependency on Tauri: inside the shell, Tauri injects an `invoke` function,
 * and this module calls the shell's commands through it. In a browser
 * `desktop` is null and the app works as a plain web page.
 */

/** How much of a pack's map images to download; see the shell's `Detail`. */
export type Detail = 'overview' | 'standard' | 'full';

export interface DetailOption {
  detail: Detail;
  /** Remote tiles up to this detail. */
  tiles: number;
  /** Of those, not on disk yet. */
  remaining: number;
  estimatedSeconds: number;
  estimatedBytes: number;
  /** Every level up to this detail is ready. */
  installed: boolean;
}

/**
 * `queued`: waiting for another download of this app; `waiting`: for
 * another Atlas app on this computer to finish downloading.
 */
export type JobState =
  'queued' | 'waiting' | 'running' | 'paused' | 'stopped' | 'cancelled' | 'done';

/** Where a map image sits in its level. Columns and rows count from 0. */
export interface TilePlace {
  z: number;
  sourceZ: number;
  x: number;
  y: number;
  columns: number;
  rows: number;
}

/** The answer that stopped a download (a refusal or a web page), in full. */
export interface StopDetail {
  kind: 'refused' | 'web-page';
  url: string;
  status: number;
  /** The layer and map: "Surface (Island)". */
  layer: string | null;
  place: TilePlace | null;
  attempt: number;
  /** Images this download had saved before it. */
  savedBefore: number;
  savedFromHost: number;
  host: string;
  headers: [string, string][];
  /** The start of a text body. */
  body: string | null;
  at: string;
  /** Set when the job stopped after this many "access denied" answers in a row. */
  deniedInARow?: number;
}

export interface MapProgress {
  mapId: string;
  name: string;
  done: number;
  total: number;
}

/** The state of a download job. */
export interface DownloadSnapshot {
  packId: string;
  /** The pack's title. */
  title: string;
  detail: Detail;
  state: JobState;
  /** Why the job stopped, or a note on a finished one. */
  reason: string | null;
  stopDetail: StopDetail | null;
  /** Queued: its place in line, from 1. */
  queuePosition: number | null;
  /** Queued or waiting: what it waits for, in words. */
  waitingFor: string | null;
  maps: MapProgress[];
  done: number;
  total: number;
  saved: number;
  /** Not on the server (404, or an object store's "access denied" for images that do not exist). */
  missing: number;
  /** Not asked for, because the area above them is not on the server. */
  notAsked: number;
  failed: number;
  bytes: number;
  tilesPerSecond: number;
  bytesPerSecond: number;
  secondsLeft: number | null;
  /** Increases whenever a layer's status file changes. */
  statusRevision: number;
}

/** What "Download location photos" offers for a pack. */
export interface PhotoPlan {
  packId: string;
  /** Pictures the pack lists to be fetched later. */
  total: number;
  /** Of those, not on this device yet. */
  remaining: number;
  /** The servers they come from. */
  hosts: string[];
  /** The current or last photo job of this pack in this session. */
  job: DownloadSnapshot | null;
  /** The title of another download that runs now; a new one waits for it. */
  busyWith: string | null;
}

export interface DownloadPlan {
  packId: string;
  options: DetailOption[];
  recommended: Detail;
  /** A job left unfinished, for example when the app was closed. */
  unfinished: { detail: Detail; reason: string | null; stopDetail: StopDetail | null } | null;
  job: DownloadSnapshot | null;
  /** The title of another pack that is downloading now; a new download waits for it. */
  busyWith: string | null;
  /** Downloads of this app that are not over, in queue order. */
  queue: { packId: string; title: string; state: JobState }[];
}

/** The most recent lines of the activity log, newest last. */
export interface RecentLog {
  folder: string;
  file: string;
  lines: string[];
  /** Older lines exist that were not loaded. */
  truncated: boolean;
}

/** A game save on disk, as the shell lists it. */
export interface SaveFileEntry {
  path: string;
  name: string;
  /** Last change, in milliseconds since the epoch. */
  modified: number;
  size: number;
  /** The game keeps a screenshot of the save next to it. */
  screenshot: boolean;
}

export interface SaveFolderInfo {
  path: string;
  name: string;
  exists: boolean;
  /** Newest first. */
  saves: SaveFileEntry[];
}

/** What "Follow new saves" sees: the newest save, and the last one that stopped changing. */
export interface SaveWatchStatus {
  path: string | null;
  newest: SaveFileEntry | null;
  settled: SaveFileEntry | null;
  /** Increases each time a new save has settled. */
  revision: number;
}

/** The game's folder (desktop app), as the shell checks it. */
export interface GameFolderInfo {
  path: string | null;
  name: string | null;
  /** It is the game's folder, and it is there. */
  valid: boolean;
  /** The game's executable's size and time; changes when the game is patched. */
  stamp: string | null;
  /** Why it cannot be used, in plain words. */
  problem: string | null;
}

/** A map file in the game's bundles that the shell can unpack. */
export interface GameFileEntry {
  index: number;
  /** The game's own path, such as `game\hub_pins\novigrad.w2em`. */
  path: string;
  size: number;
  compression: string;
}

/** What a scan of the game's bundles found, in counts and game paths. */
export interface GameFilesScan {
  stamp: string;
  bundles: number;
  entries: number;
  /** Lowest precedence first. */
  files: GameFileEntry[];
  extensions: Record<string, number>;
  compressions: Record<string, number>;
  /** Bundles by table of contents layout (`1`, `2` or `unknown`). */
  layouts: Record<string, number>;
  duplicates: number;
  outside: number;
  unreadable: number;
}

/**
 * How reading the game's map places went, or how a save used them, for the
 * activity log: counts, game world ids and pin types only.
 */
export type GameFilesReport =
  | ({ kind: 'table'; readFailed: number } & Omit<PinTableStats, 'worlds'> & {
        worlds: Record<string, { pins: number; types: Record<string, number> }>;
      })
  | {
      kind: 'match';
      saveTags: number;
      saveTagsFound: number;
      fits: Record<string, Omit<TableFit, 'kinds'> & { kinds: string }>;
    };

/** How reading a save went, for the activity log. Never anything from inside the save but these. */
export interface SaveReport {
  /** The file name only. */
  file: string;
  ok: boolean;
  version?: string;
  world?: string;
  matched?: number;
  marked?: number;
  message?: string;
}

/** How an import ended, for the activity log. Never page data. */
export interface ImportReport {
  importerId: string | null;
  outcome:
    | 'added'
    | 'updated'
    | 'rebuilt'
    | 'failed'
    | 'cancelled'
    | 'timed-out'
    /** Several addresses: the run started, stopped early, or ended (its summary). */
    | 'run-started'
    | 'run-stopped'
    | 'run-finished'
    /** A game page was read: its pages by kind. */
    | 'game-listed'
    /** A list of games was read. */
    | 'catalogue-listed'
    /** A game page or a list of games gave no usable list. */
    | 'listing-failed'
    /** Reading game pages to update games started. */
    | 'update-started';
  packId?: string;
  mapId?: string;
  message?: string;
  counts?: { mapLocations: number; maps: number; locations: number; categories: number };
  /** The pages of a run, when it starts, or the page a list was read from. The log keeps only their hosts. */
  pages?: string[];
  /** A run that updates games, rather than adding maps. */
  update?: boolean;
  /** A game page's pages by kind. */
  kinds?: Record<string, number>;
  /** Of a game page's map pages, or a list's games: how many are added already. */
  alreadyAdded?: number;
  /** Games in a list of games, or to update. */
  games?: number;
  /** How the map's picture was sized, when the importer could measure it. */
  picture?: PictureSummary;
  /** A run's figures. */
  run?: {
    added?: number;
    refreshed?: number;
    notAdded?: number;
    notStarted?: number;
    /** Addresses left out because no importer recognises them. */
    leftOut?: number;
  };
}

export interface DesktopInfo {
  /** The app's name: "Atlas", or the name a build gave it. */
  name: string;
  version: string;
  platform: string;
  /**
   * The shell downloads map images and saves them from map pages (a build
   * with `ATLAS_ENABLE_DOWNLOADS=1`). Without it, those commands do not exist.
   */
  downloads: boolean;
  /**
   * Folders can be chosen and shown in the file manager, so the Maps dialog
   * is offered. False in the Android app, which keeps its maps in its own
   * storage. Absent counts as true.
   */
  folders?: boolean;
  /**
   * The Maps dialog is offered: the games shown, opening, deleting and
   * importing them. True in the Android app too, where without `folders`
   * it has no folder choices. Absent counts as true.
   */
  maps?: boolean;
  /**
   * Progress can be exported to and imported from files through the
   * system's dialogs (in the Android app, its save and open screens).
   * Absent counts as true.
   */
  progressFiles?: boolean;
  /** Web pages can be opened for importers. False in the Android app. Absent counts as true. */
  imports?: boolean;
  /**
   * Map pack files are picked with the system's picker and copied into
   * the app before they are imported, since the picker gives no path: the
   * Android app. Absent counts as false.
   */
  copyPickedFiles?: boolean;
  /**
   * A person's own lists are kept in a file beside the game's folder in
   * the maps folder (`ownLists`). False in the Android app, whose maps
   * folder is never backed up; absent (an older shell) counts as false.
   * Without it the web app keeps them in its own storage, with progress.
   */
  ownListFiles?: boolean;
  /**
   * A person's own locations, types and areas are kept in a file beside the
   * game's folder (`ownLocations`), as own lists are. Absent counts as false.
   */
  ownLocationFiles?: boolean;
  /**
   * Games can be made in the app from a picture, and maps and levels added
   * to them (`ownGames`): the desktop apps. Absent counts as false.
   */
  ownGames?: boolean;
}

/** Where a listed pack comes from. */
export type PackOrigin = 'bundled' | 'maps-folder' | 'location';

export interface ListedPack {
  id: string;
  title: string;
  url: string;
  origin: PackOrigin;
  /** The pack folder; null for packs that come with the app. */
  path: string | null;
  packVersion: string;
  /** A pack with this id comes with the app. */
  bundled: boolean;
  /** The importer that made the pack, if it was added from a web page. */
  imported: { importerId: string; importerTitle: string } | null;
  /** The web pages the pack was made from, as its manifest records them. */
  pages?: { url: string; mapId: string | null }[];
  /** The game was made in the app (its manifest's `madeInApp`); absent counts as false. */
  madeInApp?: boolean;
}

/** A pack that is not shown because another with the same id is. */
export interface HiddenPack {
  id: string;
  title: string;
  path: string;
  reason: string;
}

export type LocationState = 'ok' | 'missing' | 'not-a-pack' | 'no-packs';

/** A pack folder or folder of packs the person added. */
export interface LocationInfo {
  path: string;
  kind: 'pack' | 'folder';
  state: LocationState;
  packs: string[];
  message: string | null;
}

/** Every pack the app can show, and where they come from. */
export interface Listing {
  mapsFolder: { path: string; isDefault: boolean; exists: boolean };
  packs: ListedPack[];
  hidden: HiddenPack[];
  locations: LocationInfo[];
  /** Packs whose files are being moved, for example from an older version. */
  busy: string[];
}

/** A maps folder the person picked, before it is used. */
export interface FolderChoice {
  path: string;
  /** Packs in the current maps folder. */
  packs: number;
  /** They can be moved quickly and safely (same drive). */
  canMove: boolean;
}

/** Page data kept with an imported pack. */
export interface StoredSource {
  key: string;
  url: string;
  importedAt: string;
  mapId: string | null;
  /** The page data as JSON text. */
  data: string;
}

export interface SaveImportRequest {
  packId: string;
  importer: { id: string; title: string };
  sourceKey: string;
  pageUrl: string;
  importedAt: string;
  /** The map the page became; absent for a page that became something else, such as a checklist. */
  mapId?: string;
  /** The page data as JSON text. */
  pageData: string;
  /** Pack files by name, as JSON text. */
  files: Record<string, string>;
  /** The pack refreshes one that comes with the app (its importer allows that). */
  refreshBundled?: boolean;
}

/** What the shell found when it looked at the import window. */
export type PollResult =
  | { state: 'waiting'; loading: boolean; note: string | null }
  /**
   * The page data has been read and the map picture is being measured from
   * the page: the importer's step has run `steps` times, `presses` of which
   * pressed the page's zoom control.
   */
  | { state: 'measuring'; steps: number; presses: number }
  /** The page data, and when the page was measured, what it loaded (`PageObservations`, unchecked). */
  | { state: 'ready'; data: string; page?: unknown }
  | { state: 'closed' }
  | { state: 'failed'; message: string };

export interface DownloadSettings {
  /** Requests in flight at once. */
  parallel: number;
  /** Pause after each request, per parallel download, in milliseconds. */
  pauseMs: number;
  requestsPerMinute: number | null;
  /** In kilobytes (1000 bytes) per second. */
  kilobytesPerSecond: number | null;
}

export interface DownloadSettingsInfo {
  settings: DownloadSettings;
  /** Lowest and highest allowed value of each setting. */
  bounds: Record<keyof DownloadSettings, [number, number]>;
}

/** Map images downloaded for a pack, to say what a delete would remove. */
export interface ImagesInfo {
  /** Image files and their size in bytes. */
  files: number;
  bytes: number;
  /** A download of the pack is running or paused; deleting stops it. */
  downloading: boolean;
}

/** The outcome of deleting a pack. */
export interface PackDeleted {
  /**
   * Every file is gone. Otherwise some were in use by another program; the
   * pack is not listed any more, and the rest is removed at the next start.
   */
  complete: boolean;
}

/** The outcome of deleting a pack's downloaded map images. */
export interface ImagesDeleted {
  files: number;
  bytes: number;
  /** Images that were in use by another program and are still there. */
  left: number;
}

export type RevealTarget =
  | { kind: 'maps-folder' }
  | { kind: 'pack'; id: string }
  | { kind: 'location'; path: string }
  | { kind: 'log-folder' };

/** The app that wrote a map pack file. */
export interface AppFacts {
  name: string;
  version: string;
  platform: string;
}

/** A pack, as its manifest describes it. Dates are ISO 8601 in UTC. */
export interface PackFacts {
  id: string;
  title: string;
  packVersion: string;
  gamePatch?: string;
  schemaVersion: number;
  attribution: { name?: string; url?: string; license?: string }[];
  created?: string;
  updated?: string;
  writtenBy?: { name?: string; version?: string };
}

/** Where a pack's data came from: web pages read by an importer, the app, or not recorded. */
export interface SourceFacts {
  kind: 'web-pages' | 'app' | 'unknown';
  importer?: { id: string; title: string };
  pages?: { url: string; mapId?: string; importedAt?: string }[];
  newestPageAt?: string;
  oldestPageAt?: string;
}

export interface ContentCounts {
  maps: number;
  layers: number;
  locations: number;
  categories: number;
  regions: number;
  checklists: number;
  guides: number;
}

/** The map images of one layer in a map pack file. */
export interface LayerFacts {
  id: string;
  name: string;
  mapName: string;
  minZoom: number;
  maxZoom: number;
  levels: number[];
  files: number;
  bytes: number;
  complete: boolean;
  /** Every level of the layer is there. */
  full: boolean;
  /** Its images can be downloaded, so the detail limits it. */
  downloadable: boolean;
  downloadedAt?: string;
}

/** `atlaspack.json`, the description at the start of a map pack file. */
export interface PackFileHeader {
  format: 'atlas-pack-file';
  version: number;
  packId: string;
  title: string;
  packVersion: string;
  detail: Detail;
  exportedAt: string;
  exportedBy: AppFacts;
  pack: PackFacts;
  source: SourceFacts;
  contents: ContentCounts;
  images: { detail: Detail; files: number; bytes: number; layers: LayerFacts[] };
  /** Entries after the header, and their size unpacked. */
  files: number;
  bytes: number;
  /** The person's own lists, locations, types and areas the file carries (version 2). */
  mine?: {
    lists: number;
    locations: number;
    types: number;
    areas: number;
    photos?: number;
    guideLinks?: boolean;
    /** Own guide pages and the pack's pages changed or hidden (version 4). */
    pages?: number;
    sections?: number;
  };
}

/** What is known about an installed pack, as a map pack file would say. */
export interface PackDetails {
  pack: PackFacts;
  source: SourceFacts;
  contents: ContentCounts;
  layers: {
    id: string;
    name: string;
    mapName: string;
    minZoom: number;
    maxZoom: number;
    downloadable: boolean;
    levels: number[];
    downloadedAt: string | null;
  }[];
  /** The highest detail whose map images are all downloaded. */
  detail: Detail | null;
  /** When map images were last downloaded. */
  imagesAt: string | null;
  /** Its map images are one archive file, which cannot be exported. */
  archive: boolean;
  /** The map pack file it was imported from. */
  packFile: { importedAt: string; fileName: string; header: PackFileHeader } | null;
}

/** One level of detail in the Export dialog. */
export interface PackFileDetailOption {
  detail: Detail;
  available: boolean;
  /** Why not, in plain words. */
  reason: string | null;
  images: number;
  imageBytes: number;
  /** The whole file, unpacked. */
  bytes: number;
}

/** What the Export dialog offers for a pack. */
export interface PackFileOptions {
  packId: string;
  title: string;
  exportable: boolean;
  /** Why it cannot be exported, in plain words. */
  reason: string | null;
  details: PackFileDetailOption[];
  /** Layers whose images all come with the pack: exported whole at every detail. */
  wholeLayers: string[];
  defaultNames: Record<Detail, string>;
  /**
   * The pictures downloaded for the person's own use (location photos,
   * pictures of guide pages) that "Include downloaded photos" would add,
   * and their bytes. None from a shell that does not offer it.
   */
  ownUsePictures?: number;
  ownUsePictureBytes?: number;
  /** A download of the pack is not over. */
  downloading: boolean;
}

export interface PackFileExported {
  path: string;
  fileName: string;
  /** The file's size on disk. */
  size: number;
  header: PackFileHeader;
  /** The progress export saved beside it, when asked for. */
  progressFile: string | null;
  /** Why the progress export could not be saved; the map pack file is fine. */
  progressError: string | null;
}

/** A map pack file picked for import, before anything is written. */
export interface PackFileInfo {
  path: string;
  fileName: string;
  size: number;
  header: PackFileHeader;
  /** The game with the same id shown now. */
  installed: {
    title: string;
    origin: PackOrigin;
    folder: string | null;
    details: PackDetails | null;
  } | null;
  /** Importing replaces the game in the maps folder (in its own folder). */
  replaces: boolean;
  /** Why it cannot be imported here. */
  blocked: string | null;
}

export interface PackFileImported {
  packId: string;
  title: string;
  replaced: boolean;
  header: PackFileHeader;
  listing: Listing;
  /** The text of the own lists file the file carried, to add to the person's. */
  ownLists?: string | null;
  /** The text of the own locations file the file carried, to add to the person's. */
  ownLocations?: string | null;
  /** The text of the guide links file the file carried, to add to the person's. */
  guideLinks?: string | null;
  /** The text of the own pages file the file carried, to add to the person's. */
  ownPages?: string | null;
  /** The person's own photos the file carried: their file names and bytes in base64. */
  ownPictures?: { file: string; data: string }[] | null;
}

/** A picture chosen for a map, and whether it can be one. */
export interface PickedPicture {
  path: string;
  fileName: string;
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp';
  /** The file's size. */
  bytes: number;
  /** How many levels of detail and tiles it makes. */
  levels: number;
  tiles: number;
  /** Why it cannot be made into a map, in plain words; null when it can. */
  problem: string | null;
}

/** How far a picture being made into a map is. */
export interface CutJobProgress {
  kind: 'game' | 'map' | 'level';
  /** The name of what is being made. */
  name: string;
  /** The picture is being read, before any tile is cut. */
  reading: boolean;
  tilesDone: number;
  tilesTotal: number;
  cancelling: boolean;
}

/** What a change to a game made in the app gives back. */
export interface OwnGameChanged {
  /** What was added: the game's id, and the map and level made. */
  added: { gameId: string; mapId: string; layerId: string } | null;
  listing: Listing;
}

/** A map pack file picked with Android's picker, before it is copied into the app. */
export interface PickedPackFile {
  /** Its name where it is. */
  fileName: string;
  /** Its size, when the system says. */
  size: number | null;
  packId: string;
  title: string;
  /** The room importing it takes: the copy and the game unpacked. */
  roomNeeded: number;
}

/** How far the map pack file being saved, imported or copied into the app is. */
export interface PackFileProgress {
  /** `copy`: a picked file copied into the app, counted in bytes only. */
  kind: 'export' | 'import' | 'copy';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  cancelling: boolean;
}

/** One answer to {@link DesktopBridge.tiles.fetchPage}. */
export interface ShellFetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  retryAfter: string | null;
}

export interface DesktopBridge {
  info(): Promise<DesktopInfo>;
  /** Opens an http or https link in the system browser. */
  openExternal(url: string): Promise<void>;
  /** Asks where to save, then saves. Null when the dialog was closed. */
  saveTextFile(suggestedName: string, contents: string): Promise<{ name: string } | null>;
  /** Asks for a file and reads it. Null when the dialog was closed. */
  openTextFile(): Promise<{ name: string; contents: string } | null>;
  /** Only in a build with downloads; see `downloadsOffered` in `features.ts`. */
  tiles: {
    plan(packId: string): Promise<DownloadPlan>;
    start(packId: string, detail: Detail): Promise<DownloadSnapshot>;
    pause(packId: string): Promise<DownloadSnapshot>;
    resume(packId: string): Promise<DownloadSnapshot>;
    cancel(packId: string): Promise<void>;
    snapshot(packId: string): Promise<DownloadSnapshot | null>;
    settings(): Promise<DownloadSettingsInfo>;
    setSettings(settings: DownloadSettings): Promise<DownloadSettingsInfo>;
    /**
     * Which map images of one zoom exist around a start tile, for an
     * importer (`ImportContext.pictureTiles`). Null when the picture cannot
     * be measured; the activity log says why.
     */
    pictureTiles(request: PictureTilesRequest): Promise<unknown>;
    /** Stops a measurement that is running, when an import is cancelled. */
    cancelPicture(): Promise<void>;
    /**
     * Reads one address for an importer that reads pages by fetching them,
     * as the app (see `fetching.ts` in the importer contract): the answer,
     * whatever its status. Rejects when the site could not be reached.
     */
    fetchPage(url: string): Promise<ShellFetchedPage>;
    /** "Download location photos": the pictures a pack lists to be fetched later. */
    photosPlan(packId: string): Promise<PhotoPlan>;
    photosStart(packId: string): Promise<DownloadSnapshot>;
    photosPause(packId: string): Promise<DownloadSnapshot>;
    photosResume(packId: string): Promise<DownloadSnapshot>;
    photosCancel(packId: string): Promise<void>;
    photosSnapshot(packId: string): Promise<DownloadSnapshot | null>;
  };
  library: {
    list(): Promise<Listing>;
    /** Asks for a pack folder and remembers it; its pack id, or null when the dialog was closed. */
    openPack(): Promise<string | null>;
    /** Asks for a folder of packs and remembers it; how many packs it has, or null. */
    addFolder(): Promise<number | null>;
    removeLocation(path: string): Promise<void>;
    /** Asks for a new maps folder; it is used only after {@link applyMapsFolder}. */
    chooseMapsFolder(): Promise<FolderChoice | null>;
    /** Uses the chosen maps folder; returns the ids of the packs moved there. */
    applyMapsFolder(movePacks: boolean): Promise<string[]>;
    reveal(target: RevealTarget): Promise<void>;
    /** Deletes a pack from the maps folder, stopping its download first. */
    deletePack(id: string): Promise<PackDeleted>;
    /** How many map images were downloaded for a pack. */
    imagesInfo(id: string): Promise<ImagesInfo>;
    /** Deletes a pack's downloaded map images only, stopping its download first. */
    deleteImages(id: string): Promise<ImagesDeleted>;
    importSources(packId: string, importerId: string): Promise<StoredSource[]>;
    saveImport(request: SaveImportRequest): Promise<Listing>;
  };
  importWindow: {
    open(
      url: string,
      reader: string,
      importer?: { id: string; waitSeconds: number },
      /** What is read, for the activity log: a map page (default), a game page, or a list of games. */
      purpose?: 'map' | 'game' | 'catalogue',
      /**
       * The importer's page measuring step (`PageMeasure.step`), when the
       * person asked for the map picture to be measured from the page. Only
       * a shell with downloads takes it.
       */
      measure?: string,
    ): Promise<void>;
    poll(): Promise<PollResult>;
    close(): Promise<void>;
    /** Records how an import ended in the activity log. */
    report(report: ImportReport): Promise<void>;
  };
  activityLog: {
    read(): Promise<RecentLog>;
  };
  /** Game saves, read-only: the shell reads only where the person chose. */
  saves: {
    /** Where a game keeps its saves (under Documents), with the saves there. */
    defaultFolder(game: string): Promise<SaveFolderInfo>;
    chooseFolder(game: string): Promise<SaveFolderInfo | null>;
    chooseFile(game: string): Promise<SaveFileEntry | null>;
    list(folder: string): Promise<SaveFolderInfo>;
    read(path: string): Promise<Uint8Array>;
    screenshot(path: string): Promise<Uint8Array>;
    watch(path: string): Promise<SaveWatchStatus>;
    watchStatus(): Promise<SaveWatchStatus>;
    unwatch(): Promise<void>;
    report(report: SaveReport): Promise<void>;
  };
  /** The game's own files, read-only: only in the folder the person chose. */
  gameFiles: {
    folder(game: string): Promise<GameFolderInfo>;
    chooseFolder(game: string): Promise<GameFolderInfo | null>;
    forgetFolder(game: string): Promise<void>;
    scan(game: string): Promise<GameFilesScan>;
    read(game: string, index: number): Promise<Uint8Array>;
    report(report: GameFilesReport): Promise<void>;
  };
  /** A person's own lists of a game, in their file in the maps folder (see `ownListFiles`). */
  ownLists: {
    /** The file's text, or null when the game has none yet. */
    read(gameId: string): Promise<string | null>;
    /** Writes the file whole; with `keepCopy` (a time), keeps the old one beside it first. */
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    /** Deletes the file; whether there was one. */
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * A person's links between guide pages and the map of a game, in their
   * file in the maps folder (`<game id>.guide-links.json`), kept as own lists
   * are (see `ownListFiles`).
   */
  guideLinks: {
    /** The file's text, or null when the game has none yet. */
    read(gameId: string): Promise<string | null>;
    /** Writes the file whole; with `keepCopy` (a time), keeps the old one beside it first. */
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    /** Deletes the file; whether there was one. */
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * A person's own locations, types and areas of a game, in their file in
   * the maps folder (see `ownLocationFiles`).
   */
  ownLocations: {
    read(gameId: string): Promise<string | null>;
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * A person's own guide pages and sections of a game, and their changes to
   * the pack's pages, in their file in the maps folder
   * (`<game id>.my-pages.json`), kept as own lists are (see `ownListFiles`).
   */
  ownPages: {
    read(gameId: string): Promise<string | null>;
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * A person's own photos of a game, in the folder of their own beside the
   * game's folder in the maps folder (`<game id>.my-pictures/`). Kept with
   * the own lists (see `ownListFiles`).
   */
  ownPictures: {
    /** A photo's bytes; empty when it is not there. */
    read(gameId: string, file: string): Promise<Uint8Array>;
    /** Writes a photo (its bytes in base64). */
    write(gameId: string, file: string, data: string): Promise<void>;
    /** The photos kept, by file name. */
    list(gameId: string): Promise<string[]>;
    /** Deletes photos; how many there were. */
    delete(gameId: string, files: string[]): Promise<number>;
    /** Deletes every photo of a game; whether there were any. */
    deleteAll(gameId: string): Promise<boolean>;
    /** Asks for a picture (PNG, JPEG or WebP) and reads it; empty when the dialog was closed. */
    pick(): Promise<Uint8Array>;
  };
  /** Games made in the app from pictures (see `ownGames`). */
  ownGames: {
    /** Asks for a picture and says what it is. Null when the dialog was closed. */
    pickPicture(): Promise<PickedPicture | null>;
    /** Makes a game from its name and its first map's picture. */
    create(title: string, mapName: string, picture: string): Promise<OwnGameChanged>;
    addMap(gameId: string, mapName: string, picture: string): Promise<OwnGameChanged>;
    addLevel(
      gameId: string,
      mapId: string,
      levelName: string,
      picture: string,
    ): Promise<OwnGameChanged>;
    progress(): Promise<CutJobProgress | null>;
    /** Stops the picture being made into a map; nothing is left of it. */
    cancel(): Promise<void>;
    rename(gameId: string, title: string): Promise<OwnGameChanged>;
    deleteMap(gameId: string, mapId: string): Promise<OwnGameChanged>;
  };
  /** Files of one list (`.atlaslist`), through the system's dialogs. */
  listFiles: {
    /** Asks where to save, then saves. Null when the dialog was closed. */
    save(suggestedName: string, contents: string): Promise<{ name: string } | null>;
    /** Asks for a file and reads it. Null when the dialog was closed. */
    open(): Promise<{ name: string; contents: string } | null>;
  };
  /** Map pack files (`.atlaspack`): one game in one file, for another device. */
  packFiles: {
    /** What can be exported of a pack, and how large each detail is. */
    options(packId: string): Promise<PackFileOptions>;
    /**
     * Asks where to save, then writes the file; with `progress` (a progress
     * export's text) saves that beside it, with `includeMine` the person's
     * own lists, locations and types go in the file, and with
     * `includePhotos` the pictures downloaded for their own use. Null when
     * the dialog was closed.
     */
    export(
      packId: string,
      detail: Detail,
      progress?: string,
      includeMine?: boolean,
      includePhotos?: boolean,
    ): Promise<PackFileExported | null>;
    /** Asks for a file to import and reads its description. Null when the dialog was closed. */
    pick(): Promise<PackFileInfo | null>;
    /** Reads the description of the file at a path the app has (for example from Android's picker). */
    inspect(path: string): Promise<PackFileInfo>;
    /**
     * Android: asks for a file with the system's picker, reads its
     * description and checks there is room. Null when the picker was closed.
     */
    pickCopy(): Promise<PickedPackFile | null>;
    /** Android: copies the picked file into the app; the copy's path, for {@link inspect}. */
    copyPicked(): Promise<string>;
    /** Android: deletes a copy made by {@link copyPicked}. */
    discardCopy(path: string): Promise<void>;
    /** Imports the file at `path`, replacing the game with the same id only with `replace`. */
    import(path: string, replace: boolean): Promise<PackFileImported>;
    progress(): Promise<PackFileProgress | null>;
    cancel(): Promise<void>;
    /** What is known about an installed pack. */
    details(packId: string): Promise<PackDetails>;
  };
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/**
 * The download commands of a build without downloads, which never calls
 * them: the shell has no such commands.
 */
function noDownloads(): DesktopBridge['tiles'] {
  const missing = () => Promise.reject(new Error('This app does not download map images.'));
  return {
    plan: missing,
    start: missing,
    pause: missing,
    resume: missing,
    cancel: missing,
    snapshot: missing,
    settings: missing,
    setSettings: missing,
    pictureTiles: missing,
    cancelPicture: missing,
    fetchPage: missing,
    photosPlan: missing,
    photosStart: missing,
    photosPause: missing,
    photosResume: missing,
    photosCancel: missing,
    photosSnapshot: missing,
  };
}

/** Builds the bridge over an `invoke` function. Exported for tests. */
export function createBridge(invoke: Invoke): DesktopBridge {
  const call = <T>(command: string, args?: Record<string, unknown>) =>
    invoke(command, args).catch((error: unknown) => {
      // Commands reject with a plain sentence.
      throw new Error(typeof error === 'string' ? error : String(error));
    }) as Promise<T>;
  return {
    info: () => call('desktop_info'),
    openExternal: (url) => call('open_external', { url }),
    saveTextFile: (suggestedName, contents) => call('save_text_file', { suggestedName, contents }),
    openTextFile: () => call('open_text_file'),
    tiles: __ATLAS_DOWNLOADS__
      ? {
          plan: (packId) => call('tiles_plan', { packId }),
          start: (packId, detail) => call('tiles_start', { packId, detail }),
          pause: (packId) => call('tiles_pause', { packId }),
          resume: (packId) => call('tiles_resume', { packId }),
          cancel: (packId) => call('tiles_cancel', { packId }),
          snapshot: (packId) => call('tiles_snapshot', { packId }),
          settings: () => call('download_settings_get'),
          setSettings: (settings) => call('download_settings_set', { settings }),
          pictureTiles: (request) => call('picture_tiles', { request }),
          cancelPicture: () => call('picture_cancel'),
          fetchPage: (url) => call('import_fetch', { url }),
          photosPlan: (packId) => call('photos_plan', { packId }),
          photosStart: (packId) => call('photos_start', { packId }),
          photosPause: (packId) => call('photos_pause', { packId }),
          photosResume: (packId) => call('photos_resume', { packId }),
          photosCancel: (packId) => call('photos_cancel', { packId }),
          photosSnapshot: (packId) => call('photos_snapshot', { packId }),
        }
      : noDownloads(),
    library: {
      list: () => call('library_list'),
      openPack: () => call('library_open_pack'),
      addFolder: () => call('library_add_folder'),
      removeLocation: (path) => call('library_remove_location', { path }),
      chooseMapsFolder: () => call('library_choose_maps_folder'),
      applyMapsFolder: (movePacks) => call('library_apply_maps_folder', { movePacks }),
      reveal: (target) => call('library_reveal', { target }),
      deletePack: (id) => call('library_delete_pack', { id }),
      imagesInfo: (id) => call('library_images_info', { id }),
      deleteImages: (id) => call('library_delete_images', { id }),
      importSources: (packId, importerId) => call('library_import_sources', { packId, importerId }),
      saveImport: (request) => call('library_save_import', { request }),
    },
    importWindow: {
      open: (url, reader, importer, purpose, measure) =>
        call('import_open', {
          url,
          reader,
          ...(importer ? { importerId: importer.id, waitSeconds: importer.waitSeconds } : {}),
          ...(purpose && purpose !== 'map' ? { purpose } : {}),
          ...(measure ? { measure } : {}),
        }),
      poll: () => call('import_poll'),
      close: () => call('import_close'),
      report: (report) => call('import_report', { report }),
    },
    activityLog: {
      read: () => call('activity_log_read'),
    },
    saves: {
      defaultFolder: (game) => call('saves_default_folder', { game }),
      chooseFolder: (game) => call('saves_choose_folder', { game }),
      chooseFile: (game) => call('saves_choose_file', { game }),
      list: (folder) => call('saves_list', { folder }),
      read: (path) => call<unknown>('saves_read', { path }).then(bytesOf),
      screenshot: (path) => call<unknown>('saves_screenshot', { path }).then(bytesOf),
      watch: (path) => call('saves_watch', { path }),
      watchStatus: () => call('saves_watch_status'),
      unwatch: () => call('saves_unwatch'),
      report: (report) => call('saves_report', { report }),
    },
    gameFiles: {
      folder: (game) => call('game_folder_get', { game }),
      chooseFolder: (game) => call('game_folder_choose', { game }),
      forgetFolder: (game) => call('game_folder_forget', { game }),
      scan: (game) => call('game_files_scan', { game }),
      read: (game, index) => call<unknown>('game_files_read', { game, index }).then(bytesOf),
      report: (report) => call('game_files_report', { report }),
    },
    ownLists: {
      read: (gameId) => call('own_lists_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('own_lists_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('own_lists_delete', { gameId }),
    },
    guideLinks: {
      read: (gameId) => call('guide_links_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('guide_links_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('guide_links_delete', { gameId }),
    },
    ownLocations: {
      read: (gameId) => call('own_locations_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('own_locations_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('own_locations_delete', { gameId }),
    },
    ownPages: {
      read: (gameId) => call('own_pages_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('own_pages_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('own_pages_delete', { gameId }),
    },
    ownPictures: {
      read: (gameId, file) => call<unknown>('own_pictures_read', { gameId, file }).then(bytesOf),
      write: (gameId, file, data) => call('own_pictures_write', { gameId, file, data }),
      list: (gameId) => call('own_pictures_list', { gameId }),
      delete: (gameId, files) => call('own_pictures_delete', { gameId, files }),
      deleteAll: (gameId) => call('own_pictures_delete_all', { gameId }),
      pick: () => call<unknown>('own_picture_pick').then(bytesOf),
    },
    ownGames: {
      pickPicture: () => call('map_picture_pick'),
      create: (title, mapName, picture) => call('own_game_create', { title, mapName, picture }),
      addMap: (gameId, mapName, picture) => call('own_game_add_map', { gameId, mapName, picture }),
      addLevel: (gameId, mapId, levelName, picture) =>
        call('own_game_add_level', { gameId, mapId, levelName, picture }),
      progress: () => call('own_game_progress'),
      cancel: () => call('own_game_cancel'),
      rename: (gameId, title) => call('own_game_rename', { gameId, title }),
      deleteMap: (gameId, mapId) => call('own_game_delete_map', { gameId, mapId }),
    },
    listFiles: {
      save: (suggestedName, contents) => call('list_file_save', { suggestedName, contents }),
      open: () => call('list_file_open'),
    },
    packFiles: {
      options: (id) => call('packfile_options', { id }),
      export: (id, detail, progress, includeMine, includePhotos) =>
        call('packfile_export', {
          id,
          detail,
          progress: progress ?? null,
          includeMine: includeMine ?? false,
          includePhotos: includePhotos ?? false,
        }),
      pick: () => call('packfile_pick'),
      inspect: (path) => call('packfile_inspect', { path }),
      pickCopy: () => call('packfile_pick_copy'),
      copyPicked: () => call('packfile_copy_picked'),
      discardCopy: (path) => call('packfile_discard_copy', { path }),
      import: (path, replace) => call('packfile_import', { path, replace }),
      progress: () => call('packfile_progress'),
      cancel: () => call('packfile_cancel'),
      details: (id) => call('library_pack_details', { id }),
    },
  };
}

/** The bytes of a command that answers with raw bytes (an ArrayBuffer; a number array in older shells). */
function bytesOf(value: unknown): Uint8Array {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  throw new Error('The desktop app sent something that is not a file.');
}

function detect(): DesktopBridge | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  const invoke = internals.invoke.bind(internals) as Invoke;
  return createBridge(invoke);
}

/** The desktop shell's commands, or null in a browser. */
export const desktop: DesktopBridge | null = detect();

/**
 * The folder name the shell serves a pack under, from the pack's URL on the
 * shell's `atlas-pack` protocol (`atlas-pack://localhost/<id>/` on Linux
 * and macOS, `http://atlas-pack.localhost/<id>/` on Windows). Null for
 * packs served any other way, which the shell cannot download for.
 */
export function packFolderOf(url: string): string | null {
  const match =
    /^(?:atlas-pack:\/\/localhost|http:\/\/atlas-pack\.localhost)\/([a-z0-9][a-z0-9_-]*)\/$/.exec(
      url,
    );
  return match?.[1] ?? null;
}

/**
 * The URL to open in the system browser for a link, or null for links that
 * stay in the app: anything but `http` and `https`, and the app's own pages
 * (the bundled frontend is `http://tauri.localhost` on Windows).
 */
export function externalLink(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === new URL(base).origin) return null;
  return url.href;
}

/**
 * Sends clicks on links to other sites to the system browser instead of the
 * app's window, which has no browser around it. Only `http` and `https`
 * links are sent; the shell checks that again.
 */
export function openLinksOutside(bridge: DesktopBridge, root: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button > 1) return;
    const target = event.target as Element | null;
    const link = target?.closest('a[href]') as HTMLAnchorElement | null;
    const url = link ? externalLink(link.href, root.baseURI) : null;
    if (!url) return;
    event.preventDefault();
    bridge.openExternal(url).catch((error: unknown) => {
      console.error(error);
    });
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onClick);
  };
}
