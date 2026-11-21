import type { PictureSummary, PictureTilesRequest } from '@atlas/importer-api';
import type { PinTableStats, TableFit } from '@atlas/saves';
import type { KeptSheetText } from './layoutFrame/frameText';

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
  /** When it ended (done, cancelled or stopped), in milliseconds since 1970; null while not over. */
  finishedAt?: number | null;
}

/** One job of this app, for the Downloads panel (see {@link DesktopBridge.tiles.jobs}). */
export interface JobEntry {
  /** What steers it: the pack id, or the pack id and `#photos`. */
  key: string;
  packId: string;
  kind: 'images' | 'photos';
  job: DownloadSnapshot;
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
  /**
   * Photos of locations and entries here that were kept at most 1,280
   * pixels wide and may be larger on the site: what "Download again at full
   * size" asks for. None while the download settings keep photos smaller,
   * and from a shell before it.
   */
  keptSmaller?: number;
  /**
   * Of `total`, the pictures of the pack's types (the icons of the map it
   * was read from), and how many of those are not here yet: what "Get this
   * map's icons" downloads. None from a shell before it.
   */
  typePictures?: number;
  typePicturesRemaining?: number;
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
   * Pack files are picked with the system's picker and copied into
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
  /**
   * The games shown under one title are kept in one file in the maps
   * folder (`gameGroups`), shared by every Atlas app on the computer. False
   * in the Android app; absent counts as false. Without it the web app keeps
   * them in its own storage.
   */
  gameGroupsFile?: boolean;
  /**
   * The Sites folder of the person's site rules files can be used
   * (`sites`): in a build with downloads, on a desktop. Absent counts as
   * false.
   */
  sites?: boolean;
  /**
   * Settings has "Atlas in the background" (`background`): in the desktop
   * app without downloads, on Windows. Absent counts as false.
   */
  background?: boolean;
  /**
   * Settings has "Start Atlas with a game in Steam" (`steamLaunch`): the
   * line for a game's launch options, which the shell builds from the
   * AppImage Atlas runs from (see the shell's `linux.rs`). In the app
   * without downloads on Linux only; absent elsewhere.
   */
  steamLaunch?: SteamLaunch;
}

/**
 * The Steam launch line, as the shell built it: for the AppImage Atlas
 * runs from (`appImage`), for `$HOME/Applications/Atlas.AppImage` when
 * Atlas does not run from an AppImage (`usual`), or no line, for an
 * AppImage whose path the line cannot hold (`refused`).
 */
export type SteamLaunch =
  | { state: 'appImage'; path: string; line: string }
  | { state: 'usual'; line: string }
  | { state: 'refused'; path: string };

/**
 * The settings of "Atlas in the background", with what the system says
 * (see the shell's `background` module).
 */
export interface BackgroundState {
  /** "Keep Atlas running when its window is closed". */
  keepRunning: boolean;
  /** "Stay above other windows". */
  onTop: boolean;
  hotkey: {
    on: boolean;
    /** The combination, as a person reads it: "Ctrl+Alt+M". */
    keys: string;
    /** The combination offered. */
    offered: string;
    /** Why the hotkey does nothing now, if it does not. */
    problem: string | null;
  };
  /** "Start Atlas when Windows starts", as the system says. */
  startWithSystem: {
    /** Null when it could not be read. */
    on: boolean | null;
    problem: string | null;
  };
}

/** A switch of "Atlas in the background", as the shell names it. */
export type BackgroundSetting = 'keepRunning' | 'hotkey' | 'onTop' | 'startWithSystem';

/** The keys the person pressed for the hotkey. */
export interface KeyPress {
  /** `KeyboardEvent.code`. */
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /** The Windows key (`metaKey`). */
  win: boolean;
}

/** A game another program asked Atlas to show (`--show-pack`, `--show-game`). */
export interface ShowRequest {
  /** The games it names, in the Library's order. */
  packs: string[];
  /** The person's titles that hold several of them, each with those games in its order. */
  groups: { id: string; members: string[] }[];
}

/** One file of the Sites folder: its text, or why the shell could not read it. */
export interface ShellSiteFile {
  name: string;
  text?: string;
  problem?: string;
}

/**
 * Which site rules files are switched on, as the shell keeps them beside
 * the files: `on`, the person's files switched on, each with the digest of
 * the text that was switched on; `off`, the files that come with an
 * importer and were switched off. The keys are the app's (`siteRules.ts`).
 */
export interface SiteSwitches {
  on: Record<string, string>;
  off: string[];
}

/** What the Sites folder holds. */
export interface SitesListing {
  folder: string;
  files: ShellSiteFile[];
  switches: SiteSwitches;
}

/**
 * Where a listed pack comes from. `packs-folder` is a pack file in the
 * packs folder, read where it lies (see {@link ListedPack.packFile});
 * `opened-file` a single pack file the person opened from the file
 * manager, kept in the list of pack files opened (see
 * {@link Listing.openedFiles}).
 */
export type PackOrigin = 'bundled' | 'maps-folder' | 'location' | 'packs-folder' | 'opened-file';

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
  /**
   * The game is kept for personal use (its manifest's `personalUse`): a
   * page of it was read under a licence the person filled in, or with
   * none recorded. Absent (an older shell) counts as false.
   */
  personalUse?: boolean;
  /**
   * The system the game is for, such as a console (its manifest's
   * `system`), as the site it was read from names it. Absent when the
   * manifest names none, or from an older shell.
   */
  system?: string;
  /**
   * The pack is read from a pack file (.atlaspack) where it lies, and
   * `path` is the file's. Atlas never changes, moves or deletes a pack
   * file: nothing is downloaded, edited, exported or deleted for it.
   * Absent (an older shell) counts as false.
   */
  packFile?: boolean;
  /**
   * For a pack read from a pack file, what tells this version of the file
   * from another: when its pack was changed last and when the file was
   * made, in milliseconds since 1970 (null when its description does not
   * say). Absent from an older shell.
   */
  fileVersion?: { changed: number | null; made: number | null };
  /**
   * In the desktop app without downloads: a map made in the app whose
   * folder was made on this computer, or opened for editing here, so
   * "Write the pack file" is offered. Absent counts as false.
   */
  madeHere?: boolean;
  /**
   * A map opened for editing from its pack file: the file it came from,
   * which "Write the pack file" writes again. Absent otherwise.
   */
  editing?: { path: string; fileName: string };
  /**
   * The title the game is shown under, as its pack file says, when that
   * is not its own title. Absent otherwise, and from an older shell.
   */
  gameTitle?: string;
  /**
   * A pack of guidebooks (PDF and CBZ files, see `state/guidebooks.ts`):
   * its title is the title of the game they are for. Absent counts as false.
   */
  guidebooks?: boolean;
  /**
   * A pack of guidebooks Atlas wrote: the person added its guidebooks
   * here, so they can add more and remove them. Absent counts as false.
   */
  guidebooksByAtlas?: boolean;
}

/** A PDF or CBZ file picked for "Add a guidebook…", served by the shell while it is picked. */
export interface PickedGuidebook {
  /** Names the picked file to `guidebooks.add`. */
  token: string;
  /** Where the pack protocol serves it, read in parts. */
  url: string;
  fileName: string;
  /** The title offered: the file's name without its extension. */
  title: string;
  type: 'pdf' | 'cbz';
  bytes: number;
  /** Its pages when the shell counted them (a CBZ's pictures, a PDF's page tree). */
  pages: number | null;
}

/** A guidebook added or removed: what to say, and the packs listed after. */
export interface GuidebooksChanged {
  packId: string;
  message: string;
  listing: Listing;
}

/** A single pack file the person opened from the file manager. */
export interface OpenedFileInfo {
  path: string;
  /** Its folder cannot be found either, as on a drive that is not connected. */
  missing: boolean;
  /** The id of the pack it holds; null when it cannot be used. */
  pack: string | null;
}

/** What opening a pack file from the file manager came to. */
export interface PackFileOpened {
  path: string;
  /** The id of the game to show for it; null when it could not be used. */
  show: string | null;
  /** It is in the list of pack files opened. */
  remembered: boolean;
  /** Something went wrong; the message says what. */
  problem: boolean;
  message: string;
}

/**
 * What opening pack files came to, from the shell's answer: only entries
 * of the shape above are taken, and any other answer (a shell without the
 * command may answer with nothing) is no pack file opened. Exported for
 * tests.
 */
export function openedFrom(answer: unknown): PackFileOpened[] {
  if (!Array.isArray(answer)) return [];
  return answer.filter((entry: unknown): entry is PackFileOpened => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { path, show, remembered, problem, message } = entry as Record<string, unknown>;
    return (
      typeof path === 'string' &&
      (show === null || typeof show === 'string') &&
      typeof remembered === 'boolean' &&
      typeof problem === 'boolean' &&
      typeof message === 'string'
    );
  });
}

/** A pack file the shell found and cannot use, with why. */
export interface UnreadablePackFile {
  path: string;
  reason: string;
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
  /**
   * The folder of pack files read where they lie; absent from an older
   * shell. `isDefault` says it is the default one (none chosen); absent
   * from a shell where it cannot be changed yet.
   */
  packsFolder?: { path: string; exists: boolean; isDefault?: boolean };
  packs: ListedPack[];
  hidden: HiddenPack[];
  /** Pack files found that cannot be used; absent from an older shell. */
  unreadable?: UnreadablePackFile[];
  locations: LocationInfo[];
  /** The single pack files the person opened; absent from an older shell. */
  openedFiles?: OpenedFileInfo[];
  /** Packs whose files are being moved, for example from an older version. */
  busy: string[];
  /**
   * Grows when a listing differs from the one before, so one that arrives
   * late is told from a newer one. Absent from an older shell.
   */
  serial?: number;
}

/** A maps folder the person picked, before it is used. */
export interface FolderChoice {
  path: string;
  /** Packs in the current maps folder. */
  packs: number;
  /** They can be moved quickly and safely (same drive). */
  canMove: boolean;
}

/** A packs folder the person picked, before it is used. */
export interface PacksFolderChoice {
  path: string;
  /** The packs folder now. */
  current: string;
  /** The folder picked is the default packs folder. */
  isDefault: boolean;
  /** The pack files in the packs folder now, and their size in bytes. */
  files: number;
  bytes: number;
  /** Both folders are on one drive: moving renames each file. */
  sameDrive: boolean;
}

/** What changing the packs folder came to. */
export interface PacksFolderChanged {
  /** The packs folder now. */
  folder: string;
  /** The pack files moved, under another name or not. */
  moved: number;
  /** Files moved under another name, because theirs was taken there. */
  renamed: { from: string; to: string }[];
  /** Files that stayed in the old folder, each with why. */
  left: { path: string; reason: string }[];
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

/** A page stored with an imported pack, without its data. */
export type StoredPage = Omit<StoredSource, 'data'>;

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
  /**
   * Pictures the page showed as the person browsed it (`pictureFiles` of
   * the import outcome): each picture file of the pack with its bytes in
   * base64, written into the pack folder with the pack.
   */
  pictures?: Record<string, string>;
  /**
   * Whole pictures of maps cut for this import (`ImportSuccess.cutPictures`),
   * each moved into the pack's `tiles/<folder>/`.
   */
  cutPictures?: { picture: string; folder: string }[];
}

/** What the shell found when it looked at the import window. */
export type PollResult =
  /**
   * `attention`: a page of a window kept for a go has loaded and given no
   * data for a while, and the window asked for the person's attention.
   */
  | { state: 'waiting'; loading: boolean; note: string | null; attention?: boolean }
  /**
   * The page data has been read and the map picture is being measured from
   * the page: the importer's step has run `steps` times, `presses` of which
   * pressed the page's zoom control.
   */
  | { state: 'measuring'; steps: number; presses: number }
  /**
   * The page data, and when the page was measured, what it loaded
   * (`PageObservations`, unchecked). In a kept window, the address of the
   * document it was read from; `forwarded` when that address is one of the
   * page shown before, where the site led from the page asked for (a second
   * name of that page), and the shell has checked that the document is not
   * the one that page was read from.
   */
  | { state: 'ready'; data: string; page?: unknown; address?: string; forwarded?: boolean }
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
  /**
   * The size location photos are kept at: `full`, up to 4,096 pixels wide
   * with a smaller copy for cards made on this computer, or `smaller`, at
   * most 1,280 pixels wide. A shell before it leaves it out (full size).
   */
  photos?: PhotoSize;
  /**
   * Whether a map's location photos are downloaded after it is added, once
   * its map images are downloaded or need no download (see `mapPhotos.ts`).
   * A shell before it leaves it out (on).
   */
  photosWithMap?: boolean;
}

/** The sizes downloaded location photos can be kept at (see {@link DownloadSettings.photos}). */
export type PhotoSize = 'full' | 'smaller';

/** The download settings that are numbers. */
export type DownloadNumbers = Exclude<keyof DownloadSettings, 'photos' | 'photosWithMap'>;

export interface DownloadSettingsInfo {
  settings: DownloadSettings;
  /** Lowest and highest allowed value of each setting that is a number. */
  bounds: Record<DownloadNumbers, [number, number]>;
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
  | { kind: 'packs-folder' }
  | { kind: 'pack'; id: string }
  | { kind: 'location'; path: string }
  | { kind: 'log-folder' };

/** The app that wrote a pack file. */
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
  /** The name of the site its pages were read from, as its guide pages name it (pack files only). */
  name?: string;
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
  /** Types drawn with a picture of the map the game was read from; none in older shells. */
  typePictures?: number;
}

/** The map images of one layer in a pack file. */
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

/** `atlaspack.json`, the description at the start of a pack file. */
export interface PackFileHeader {
  format: 'atlas-pack-file';
  version: number;
  packId: string;
  title: string;
  /** The game: the title it is shown under with other games when the file carries one, and its system. */
  game?: { title: string; system?: string };
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
  /** The pack is kept for the person's own use (its manifest's `personalUse`); only ever true. */
  personalUse?: true;
  /** Each map, with the entry name of its small picture when the file holds one (version 7). */
  maps?: PackFileMap[];
  /** The pack's pages, as one guide or one wiki (`other`: a type of a newer file). */
  guides?: { title: string; type: 'guide' | 'wiki' | 'other'; pages: number }[];
  /** The entry name of the small picture to show for the file. */
  cover?: string;
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
    /** Notes on the game's locations (version 5). */
    notes?: number;
    /** The title the game is shown under with other games (version 6). */
    group?: boolean;
    /** Own routes (version 9). */
    routes?: number;
  };
}

/** One map in a pack file's description. */
export interface PackFileMap {
  id: string;
  name: string;
  width: number;
  height: number;
  locations: number;
  /** `preview/<name>.jpg`, right after the description. */
  preview?: string;
}

/** What is known about an installed pack, as a pack file would say. */
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
  /** The pack file it was imported from. */
  packFile: { importedAt: string; fileName: string; header: PackFileHeader } | null;
  /**
   * The pack file it is read from where it lies, if it is: every other fact
   * here is then the file's description's.
   */
  readFrom?: { path: string; fileName: string; header: PackFileHeader };
  /**
   * The style sheets kept from the pages it was read from (`library.keepStyles`),
   * when there are any: distinct sheets, their bytes, and sheets noted as not kept.
   */
  styles?: { sheets: number; bytes: number; leftOut: number };
}

/** What is kept of a game's style sheets (`import/styles/` in its folder). */
export interface KeptStyles {
  /** Each sheet kept: its address (none for a block of a page), the page's mark of its text, its bytes. */
  sheets: { address?: string; mark?: string; bytes: number }[];
  /** Distinct texts kept, and their bytes. */
  files: number;
  bytes: number;
  /** Sheets noted as not kept. */
  leftOut: number;
}

/** How a style sheet was got: fetched by the app, or handed over by a page in its window. */
export type StylesWay = 'fetch' | 'window' | 'browse';

/** Why a style sheet was not kept, as the index notes it. */
export type StyleLeftOutReason =
  | 'too-large'
  | 'no-room'
  | 'other-address'
  | 'other-host'
  | 'robots'
  | 'kept-off'
  | 'refused'
  | 'failed'
  | 'not-asked';

/** Style sheets to keep with a game, and those that could not be got. */
export interface KeepStylesRequest {
  way: StylesWay;
  sheets: { address?: string; text: string; mark?: string }[];
  leftOut: { address?: string; reason: StyleLeftOutReason; bytes?: number }[];
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
  /**
   * The pictures of the pack's types (the map's icons) whose file is here,
   * which "Include this map's icons" would add, and their bytes. None from
   * a shell that does not offer it.
   */
  typePictures?: number;
  typePictureBytes?: number;
  /**
   * The pictures that may be passed on whose file is here, which every file
   * carries, and their bytes at full size. None from a shell that cannot
   * make them smaller.
   */
  pictures?: number;
  pictureBytes?: number;
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
  /** Why the progress export could not be saved; the pack file is fine. */
  progressError: string | null;
}

/** A pack file picked for import, before anything is written. */
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
  /**
   * In the desktop app without downloads, what adding the file does: it is
   * copied into the packs folder and read there, never unpacked, so it
   * replaces nothing. Absent where pack files are imported into the maps
   * folder (the app with downloads, the Android app, an older shell).
   */
  adds?: PackFileAdds | null;
}

/** What adding a pack file to the packs folder does, before anything is written. */
export interface PackFileAdds {
  /** The packs folder. */
  folder: string;
  /** The name the file has in the packs folder once added. */
  fileName: string;
  /** It is copied there; otherwise it is there already. */
  copy: boolean;
  /** Another file has its own name there, so the copy is called `fileName`. */
  renamed: boolean;
  /** Which pack of the same game is shown once it is added, when that is not simply this file. */
  note: string | null;
}

/** A pack file added to the packs folder. */
export interface PackFileAdded {
  /** The file in the packs folder. */
  path: string;
  fileName: string;
  /** It was copied there now; otherwise it was there already. */
  copied: boolean;
  /** It is the pack shown for its game. */
  shown: boolean;
  /** Which pack of the game is shown instead, and why. */
  note: string | null;
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
  /** The text of the own notes file the file carried, to add to the person's. */
  ownNotes?: string | null;
  /** The text of the own routes file the file carried, to add to the person's. */
  ownRoutes?: string | null;
  /** The title the game is shown under with other games, as the file carried it. */
  gameGroup?: string | null;
  /** The person's own photos the file carried: their file names and bytes in base64. */
  ownPictures?: { file: string; data: string }[] | null;
  /** The pack file was added to the packs folder rather than imported (see {@link PackFileInfo.adds}). */
  added?: PackFileAdded | null;
}

/** A folder map, wiki or guide in the maps folder that the app no longer uses. */
export interface OldFolder {
  /** The folder's name in the maps folder: what a removal names. */
  folder: string;
  path: string;
  id: string;
  title: string;
  /** The pack file of the same game that is shown once the folder is gone, if any. */
  packFile: string | null;
}

/** The old folders of the maps folder, in the desktop app without downloads. */
export interface OldFolders {
  mapsFolder: string;
  /** Another app that reads sites uses this maps folder: nothing is offered. */
  siteReader: boolean;
  folders: OldFolder[];
  /** Games made in the app on this computer, offered apart. */
  madeHere: OldFolder[];
}

/** How much room a folder takes; not complete when a limit stopped the count. */
export interface FolderSize {
  bytes: number;
  files: number;
  complete: boolean;
}

/** What removing old folders came to, and the games listed after it. */
export interface OldFoldersRemoved {
  removed: {
    folder: string;
    id: string;
    removed: boolean;
    /** Every file went; otherwise some go at the next start. */
    complete: boolean;
    problem: string | null;
  }[];
  listing: Listing;
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

/** The person's own things a pack file carries, counted (see {@link PackFileHeader.mine}). */
export type MineFacts = NonNullable<PackFileHeader['mine']>;

/** What "Write the pack file" would do for a map made here, before anything is written. */
export interface MadePackPlan {
  id: string;
  title: string;
  /** The map's working folder. */
  folder: string;
  /** The pack file written, its name and the folder it goes in. */
  target: string;
  fileName: string;
  targetFolder: string;
  /** A pack file is there, and is written over. */
  replaces: boolean;
  /** It is the file the map was opened from. */
  openedFrom: boolean;
  /** The file there is newer than the one opened: why, in words. Written over only on Replace. */
  newer: string | null;
  /** The working folder is removed once the file is written and checked. */
  removesFolder: boolean;
  /** The person's own things that go in the file. */
  mine: MineFacts | null;
}

/** A map made here, written as a pack file. */
export interface MadePackWritten {
  id: string;
  path: string;
  fileName: string;
  size: number;
  header: PackFileHeader;
  folderRemoved: boolean;
  /** Every file of the folder went; otherwise some go at the next start. */
  folderComplete: boolean;
  /** What else to know, such as why the folder was kept. */
  note: string | null;
  listing: Listing;
}

/** What "Open for editing" would do for a map read from its pack file. */
export interface MadePackOpenPlan {
  id: string;
  title: string;
  /** The pack file, and its name. */
  path: string;
  fileName: string;
  /** The working folder it is unpacked into. */
  folder: string;
  /** The own things the file carries that this computer does not have yet: they are added. */
  mine: MineFacts | null;
}

/** The own things a pack file of a map made in the app carries, offered to the person. */
export interface MineOffer {
  id: string;
  title: string;
  path: string;
  /** The version of the file offered from. */
  exportedAt: string;
  facts: MineFacts;
}

/** What a change to a game made in the app gives back. */
export interface OwnGameChanged {
  /** What was added: the game's id, and the map and level made. */
  added: { gameId: string; mapId: string; layerId: string } | null;
  listing: Listing;
}

/** A pack file picked with Android's picker, before it is copied into the app. */
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

/** How far the pack file being saved, imported or copied into the app is. */
export interface PackFileProgress {
  /**
   * `copy`: a picked file copied into the app, counted in bytes only.
   * `add`: a pack file copied into the packs folder (counted in bytes,
   * with no files) and then checked (counted in files).
   */
  kind: 'export' | 'import' | 'copy' | 'add' | 'write' | 'open';
  packId: string;
  title: string;
  entriesDone: number;
  entriesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** An export with smaller pictures, before it writes: how many are made smaller. */
  picturesDone?: number;
  picturesTotal?: number;
  cancelling: boolean;
}

/** One answer to {@link DesktopBridge.tiles.fetchPicture}. */
export interface ShellFetchedPicture {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  retryAfter: string | null;
  /** The shell's name of the picture it kept, for a successful answer it kept whole. */
  picture: string | null;
  /** The answer was larger than the shell keeps, so it was not kept. */
  tooLarge: boolean;
}

/** What {@link DesktopBridge.tiles.cutPicture} gave. */
export interface ShellPictureCut {
  ok: boolean;
  width: number;
  height: number;
  maxZoom: number;
  tileSize: number;
  extension: string;
  /** Why it was not cut: `format`, `size`, `missing` or `failed`. */
  problem: string | null;
  message: string | null;
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

/** How often the folder of kept packs is checked, besides after each change. */
export type KeptPacksSchedule = 'start' | 'daily' | 'weekly';

/** The state of one game in the folder of kept packs. */
export type KeptPackState =
  | 'up-to-date'
  | 'waiting'
  | 'writing'
  | 'newer-in-folder'
  | 'not-in-folder'
  | 'left-out'
  | 'failed';

/** One game in the list of kept packs. */
export interface KeptPackRow {
  id: string;
  title: string;
  state: KeptPackState;
  /** Where its pack file lies, or lay for one not in the folder. */
  path: string | null;
  /** When this app wrote it (ISO 8601). */
  writtenAt: string | null;
  /** Why it waits, was left out or failed, or what else to know. */
  reason: string | null;
  /** Other pack files of the same game in the folder, left alone. */
  extraCopies: string[];
}

/** The pack being written into the folder now. */
export interface KeptPacksWriting {
  id: string;
  title: string;
  phase: 'writing' | 'checking';
  bytesDone: number;
  bytesTotal: number;
  /** Its place among the packs of this run, from 1, and how many. */
  number: number;
  count: number;
}

/**
 * The setting "Keep packs up to date" and what it did (see the shell's
 * `keep` module). Only in a build with downloads.
 */
export interface KeptPacksStatus {
  on: boolean;
  /** The folder, to show; the page never names one. */
  folder: string;
  folderIsDefault: boolean;
  /** The person chose a folder in the folder dialog. */
  folderChosen: boolean;
  schedule: KeptPacksSchedule;
  /** A check or a write is under way. */
  running: boolean;
  writing: KeptPacksWriting | null;
  lastCheckAt: string | null;
  /** Why the last run failed as a whole. */
  problem: string | null;
  /** A notice for the whole run, to show once (by its serial). */
  notice: { serial: number; text: string } | null;
  games: KeptPackRow[];
  /** Grows with each change. */
  serial: number;
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
    /**
     * Reads one whole picture of a map for an importer, as the app, and
     * keeps it until it is cut (`ImportContext.wholePicture`): the answer,
     * whatever its status. Rejects when the site could not be reached.
     */
    fetchPicture(url: string): Promise<ShellFetchedPicture>;
    /** Cuts a picture `fetchPicture` kept into map images, as "New map from a picture" does. */
    cutPicture(picture: string): Promise<ShellPictureCut>;
    /** Throws away kept pictures and cuts that no saved import names. */
    discardPictures(pictures: string[]): Promise<void>;
    /** "Download location photos": the pictures a pack lists to be fetched later. */
    photosPlan(packId: string): Promise<PhotoPlan>;
    photosStart(packId: string): Promise<DownloadSnapshot>;
    /** "Download again at full size": the photos kept smaller, asked for once more each. */
    photosStartAgain(packId: string): Promise<DownloadSnapshot>;
    /** "Get this map's icons": downloads the pictures of the pack's types only. */
    photosStartTypes(packId: string): Promise<DownloadSnapshot>;
    photosPause(packId: string): Promise<DownloadSnapshot>;
    photosResume(packId: string): Promise<DownloadSnapshot>;
    photosCancel(packId: string): Promise<void>;
    photosSnapshot(packId: string): Promise<DownloadSnapshot | null>;
    /**
     * Every map image and photo job of this session: the one downloading,
     * then the queue in order, then paused ones, then those that are over.
     */
    jobs(): Promise<JobEntry[]>;
    /** Moves a job waiting its turn one place earlier or later in the queue. */
    moveJob(key: string, earlier: boolean): Promise<void>;
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
    /**
     * Asks for a new packs folder (a desktop only); it is used only after
     * {@link applyPacksFolder}. Null when the dialog was closed.
     */
    choosePacksFolder(): Promise<PacksFolderChoice | null>;
    /** What going back to the default packs folder would do; used only after {@link applyPacksFolder}. */
    defaultPacksFolder(): Promise<PacksFolderChoice>;
    /** Uses the chosen packs folder, moving the pack files there or leaving them. */
    applyPacksFolder(moveFiles: boolean): Promise<PacksFolderChanged>;
    reveal(target: RevealTarget): Promise<void>;
    /** Deletes a pack from the maps folder, stopping its download first. */
    deletePack(id: string): Promise<PackDeleted>;
    /**
     * What opening pack files from the file manager came to since the last
     * time this was asked, oldest first. Empty from a shell without it.
     */
    takeOpened(): Promise<PackFileOpened[]>;
    /** Takes a pack file off the list of pack files opened; the file stays. */
    forgetPackFile(path: string): Promise<void>;
    /** The old folder maps and wikis of the maps folder (the desktop app without downloads). */
    oldFolders(): Promise<OldFolders>;
    /** How much room one old folder takes, by its name. */
    oldFolderSize(folder: string): Promise<FolderSize>;
    /** Removes the old folders named, then lists the games again. */
    removeOldFolders(folders: { folder: string; id: string }[]): Promise<OldFoldersRemoved>;
    /** How many map images were downloaded for a pack. */
    imagesInfo(id: string): Promise<ImagesInfo>;
    /** Deletes a pack's downloaded map images only, stopping its download first. */
    deleteImages(id: string): Promise<ImagesDeleted>;
    importSources(packId: string, importerId: string): Promise<StoredSource[]>;
    /** The pages stored with an imported pack, without their data. */
    importSourceList(packId: string, importerId: string): Promise<StoredPage[]>;
    /** One page stored with an imported pack, by its key; null when there is none. */
    importSource(packId: string, importerId: string, key: string): Promise<StoredSource | null>;
    saveImport(request: SaveImportRequest): Promise<Listing>;
    /** What is kept of a game's style sheets; nothing for a game without any. */
    styles(packId: string): Promise<KeptStyles>;
    /** Keeps style sheets with a game, once each, and notes those not got; what is kept after. */
    keepStyles(packId: string, request: KeepStylesRequest): Promise<KeptStyles>;
    /**
     * The sheets kept with a game, with their texts, in the order they were
     * kept, to lay its saved pages out (see `layoutFrame/`). Only in a build
     * with downloads; none for a game without any.
     */
    styleTexts(packId: string): Promise<KeptSheetText[]>;
  };
  importWindow: {
    open(
      url: string,
      reader: string,
      importer?: { id: string; waitSeconds?: number },
      /** What is read, for the activity log: a map page (default), a game page, or a list of games. */
      purpose?: 'map' | 'game' | 'catalogue',
      /**
       * The importer's page measuring step (`PageMeasure.step`), when the
       * person asked for the map picture to be measured from the page. Only
       * a shell with downloads takes it.
       */
      measure?: string,
      /**
       * Keep the window for the next pages of the go on the same site
       * ({@link navigate}); only for pages an importer opens in a window
       * through `fetch.inWindow`, never with `measure`.
       */
      keep?: boolean,
      /**
       * Browse and keep: the person browses the site in the window, which
       * the app never moves, and each page they open is handed over once,
       * with its address, once it has loaded.
       */
      browse?: boolean,
    ): Promise<void>;
    /**
     * Moves the window kept for a go to its next page on the same site,
     * without bringing it to the front; `closed` when the person closed it.
     */
    navigate(
      url: string,
      reader: string,
      importer?: { id: string; waitSeconds: number },
    ): Promise<'navigated' | 'closed'>;
    poll(): Promise<PollResult>;
    /**
     * Runs a script of the importer's (the source of a function taking one
     * argument) once in the page whose data was read last, with `argument`,
     * while the window still shows that very page: what it returned, as
     * JSON text, or null.
     */
    runOnce(script: string, argument: unknown): Promise<string | null>;
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
   * A person's own notes on the locations of a game, in their file in the
   * maps folder (`<game id>.my-notes.json`), kept as own lists are (see
   * `ownListFiles`).
   */
  ownNotes: {
    read(gameId: string): Promise<string | null>;
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * A person's own routes of a game, in their file in the maps folder
   * (`<game id>.my-routes.json`), kept as own lists are (see
   * `ownListFiles`).
   */
  ownRoutes: {
    read(gameId: string): Promise<string | null>;
    write(gameId: string, contents: string, keepCopy?: string): Promise<string | null>;
    delete(gameId: string): Promise<boolean>;
  };
  /**
   * The Sites folder of the person's site rules files, beside the maps
   * folder (see `sites`). Only in a build with downloads.
   */
  sites: {
    list(): Promise<SitesListing>;
    /** Asks for a file and reads it, at most 64 KB. Null when the dialog was closed. */
    pick(): Promise<{ name: string; text: string } | null>;
    /**
     * Asks for one saved page (`.html`), or a map's saved data file
     * (`.json`), and reads it, at most 8 MB, to try a file on. Nothing of
     * it is kept. Null when the dialog was closed.
     */
    pickPage(): Promise<{ name: string; text: string } | null>;
    /** Keeps a checked file in the folder under `name`, in place of one of that name. */
    add(name: string, text: string): Promise<void>;
    /** Removes a file, and its switch `key`. Whether it was there. */
    remove(name: string, key: string): Promise<boolean>;
    /** Keeps which files are switched on. */
    switch(switches: SiteSwitches): Promise<SiteSwitches>;
    /** Asks where to save the guide or the schema, then saves. Null when the dialog was closed. */
    save(what: 'guide' | 'schema', contents: string): Promise<{ name: string } | null>;
  };
  /**
   * Keeping pack files of the games read from sites up to date in one
   * folder (see {@link KeptPacksStatus}). Only in a build with downloads.
   */
  keptPacks: {
    status(): Promise<KeptPacksStatus>;
    /** Asks for the folder in the system's dialog and turns the setting on. Null when the dialog was closed. */
    chooseFolder(): Promise<KeptPacksStatus | null>;
    /** Turns it on or off and keeps how often it checks; the folder stays. */
    set(on: boolean, schedule: KeptPacksSchedule): Promise<KeptPacksStatus>;
    /** Checks every game and writes each pack that is not current. */
    writeAll(): Promise<KeptPacksStatus>;
    /** Writes a pack that was removed from the folder. */
    writeAgain(id: string): Promise<KeptPacksStatus>;
    /** Stops the run under way. */
    cancel(): Promise<KeptPacksStatus>;
    /** Opens the folder in the system's file manager. */
    reveal(): Promise<void>;
  };
  /**
   * The games a person shows under one title, in one file in the maps
   * folder (`game-groups.json`, see `gameGroupsFile`).
   */
  gameGroups: {
    /** The file's text, or null when there is none yet. */
    read(): Promise<string | null>;
    /** Writes the file whole; with `keepCopy` (a time), keeps the old one beside it first. */
    write(contents: string, keepCopy?: string): Promise<string | null>;
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
  /**
   * Maps made here becoming pack files, in the desktop app without
   * downloads (see the shell's `madepack` module). Other builds answer
   * each with why not.
   */
  madePacks: {
    /** What "Write the pack file" would do. */
    plan(id: string): Promise<MadePackPlan>;
    /** Writes the pack file, then removes the working folder; with `replaceNewer`, over a newer file. */
    write(id: string, replaceNewer: boolean): Promise<MadePackWritten>;
    /** What "Open for editing" would do. */
    openPlan(id: string): Promise<MadePackOpenPlan>;
    /** Unpacks the pack file into a working folder; gives back what an import gives. */
    open(id: string): Promise<PackFileImported>;
    /** Removes the working folder of a map opened for editing; its pack file stays. */
    close(id: string): Promise<Listing>;
    /** The own things the pack file a map is read from carries, when they are offered. */
    mineOffer(id: string): Promise<MineOffer | null>;
    /** Reads the own things of that version of the file, in the shape an import gives them. */
    mineTake(id: string, exportedAt: string): Promise<PackFileImported>;
    /** Notes they were added, or are not wanted, so they are not offered again. */
    mineChoose(id: string, exportedAt: string, added: boolean): Promise<void>;
  };
  /**
   * Guidebooks a person adds here ("Add a guidebook…", see the shell's
   * `guidebooks` module), on a desktop; the Android app answers each with
   * why not.
   */
  guidebooks: {
    /** Asks for a PDF or CBZ file; null when the dialog is closed. */
    pick(): Promise<PickedGuidebook | null>;
    /** The picked file is no longer served. */
    forgetPicked(): Promise<void>;
    /** Adds the picked file to the game's own pack of guidebooks. */
    add(request: {
      gameId: string;
      gameTitle: string;
      token: string;
      title: string;
      pages: number | null;
      text: string[] | null;
    }): Promise<GuidebooksChanged>;
    /** Takes a guidebook out of a pack of guidebooks Atlas wrote. */
    remove(packId: string, file: string): Promise<GuidebooksChanged>;
  };
  /**
   * Atlas in the background, in the desktop app without downloads on
   * Windows (see the shell's `background` module); other apps answer each
   * with why not. `takeShow` is in the app without downloads on every
   * desktop, and answers null elsewhere.
   */
  background: {
    state(): Promise<BackgroundState>;
    /** Switches one setting; the settings after it, or why not (nothing changed then). */
    set(setting: BackgroundSetting, on: boolean): Promise<BackgroundState>;
    /** Sets the hotkey's keys; refused with a sentence, keeping the old ones. */
    setHotkey(keys: KeyPress): Promise<BackgroundState>;
    /** The hotkey does nothing while the person presses new keys. */
    pauseHotkey(paused: boolean): Promise<BackgroundState>;
    /** The game another program asked for, if not taken yet. */
    takeShow(): Promise<ShowRequest | null>;
  };
  /** Files of one list (`.atlaslist`), through the system's dialogs. */
  listFiles: {
    /** Asks where to save, then saves. Null when the dialog was closed. */
    save(suggestedName: string, contents: string): Promise<{ name: string } | null>;
    /** Asks for a file and reads it. Null when the dialog was closed. */
    open(): Promise<{ name: string; contents: string } | null>;
  };
  /**
   * The shell's events. Each resolves to a function that stops listening;
   * outside the shell, or without events, nothing ever comes.
   */
  events: {
    /** The Library's listing changed by itself: a pack file arrived, changed or went. */
    libraryChanged(handler: (listing: Listing) => void): Promise<() => void>;
    /** A pack file was opened from the file manager; take it with `library.takeOpened`. */
    packFileOpened(handler: () => void): Promise<() => void>;
    /** The state of the kept packs changed (only in a build with downloads). */
    keptPacksChanged(handler: (status: KeptPacksStatus) => void): Promise<() => void>;
    /** The settings of Atlas in the background changed from the tray. */
    backgroundChanged(handler: (state: BackgroundState) => void): Promise<() => void>;
    /** Another program asked to show a game; take it with `background.takeShow`. */
    showRequested(handler: () => void): Promise<() => void>;
  };
  /** Pack files (`.atlaspack`): one game in one file, for another device. */
  packFiles: {
    /** What can be exported of a pack, and how large each detail is. */
    options(packId: string): Promise<PackFileOptions>;
    /**
     * Asks where to save, then writes the file; with `progress` (a progress
     * export's text) saves that beside it, with `includeMine` the person's
     * own lists, locations and types go in the file, and with
     * `includePhotos` the pictures downloaded for their own use; with
     * `smallerPictures` ("Pictures in the file: Smaller") the pictures are
     * made smaller as they are written, never on this computer; with
     * `includeTypePictures` the pictures of the pack's types (the map's
     * icons), which a file otherwise leaves out. Null when the dialog was
     * closed.
     */
    export(
      packId: string,
      detail: Detail,
      progress?: string,
      includeMine?: boolean,
      includePhotos?: boolean,
      smallerPictures?: boolean,
      includeTypePictures?: boolean,
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
    /**
     * Imports the file at `path`, replacing the game with the same id only
     * with `replace`; in the desktop app without downloads, adds it to the
     * packs folder instead (see {@link PackFileInfo.adds}).
     */
    import(path: string, replace: boolean): Promise<PackFileImported>;
    progress(): Promise<PackFileProgress | null>;
    cancel(): Promise<void>;
    /** What is known about an installed pack. */
    details(packId: string): Promise<PackDetails>;
  };
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Listens to one of the shell's events; resolves to a function that stops. */
export type Listen = (event: string, handler: (payload: unknown) => void) => Promise<() => void>;

/** No events: in a browser, and in tests that do not need them. */
const noEvents: Listen = () => Promise.resolve(() => undefined);

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
    fetchPicture: missing,
    cutPicture: missing,
    discardPictures: missing,
    photosPlan: missing,
    photosStart: missing,
    photosStartAgain: missing,
    photosStartTypes: missing,
    photosPause: missing,
    photosResume: missing,
    photosCancel: missing,
    photosSnapshot: missing,
    jobs: missing,
    moveJob: missing,
  };
}

/** The Sites folder in a build without downloads: none. */
function noSites(): DesktopBridge['sites'] {
  const missing = () => Promise.reject(new Error('This app does not read site rules files.'));
  return {
    list: missing,
    pick: missing,
    pickPage: missing,
    add: missing,
    remove: missing,
    switch: missing,
    save: missing,
  };
}

/** Keeping packs up to date in a build without downloads: none. */
function noKeptPacks(): DesktopBridge['keptPacks'] {
  const missing = () => Promise.reject(new Error('This app does not keep packs up to date.'));
  return {
    status: missing,
    chooseFolder: missing,
    set: missing,
    writeAll: missing,
    writeAgain: missing,
    cancel: missing,
    reveal: missing,
  };
}

/** Builds the bridge over an `invoke` function. Exported for tests. */
export function createBridge(invoke: Invoke, listen: Listen = noEvents): DesktopBridge {
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
          fetchPicture: (url) => call('import_fetch_picture', { url }),
          cutPicture: (picture) => call('import_cut_picture', { picture }),
          discardPictures: (pictures) => call('import_discard_pictures', { pictures }),
          photosPlan: (packId) => call('photos_plan', { packId }),
          photosStart: (packId) => call('photos_start', { packId }),
          photosStartAgain: (packId) => call('photos_start_again', { packId }),
          photosStartTypes: (packId) => call('photos_start_types', { packId }),
          photosPause: (packId) => call('photos_pause', { packId }),
          photosResume: (packId) => call('photos_resume', { packId }),
          photosCancel: (packId) => call('photos_cancel', { packId }),
          photosSnapshot: (packId) => call('photos_snapshot', { packId }),
          jobs: () => call('downloads_jobs'),
          moveJob: (key, earlier) => call('downloads_move', { key, earlier }),
        }
      : noDownloads(),
    library: {
      list: () => call('library_list'),
      openPack: () => call('library_open_pack'),
      addFolder: () => call('library_add_folder'),
      removeLocation: (path) => call('library_remove_location', { path }),
      chooseMapsFolder: () => call('library_choose_maps_folder'),
      applyMapsFolder: (movePacks) => call('library_apply_maps_folder', { movePacks }),
      choosePacksFolder: () => call('library_choose_packs_folder'),
      defaultPacksFolder: () => call('library_default_packs_folder'),
      applyPacksFolder: (moveFiles) => call('library_apply_packs_folder', { moveFiles }),
      reveal: (target) => call('library_reveal', { target }),
      deletePack: (id) => call('library_delete_pack', { id }),
      takeOpened: () => call<unknown>('library_take_opened').then(openedFrom, () => []),
      forgetPackFile: (path) => call('library_forget_pack_file', { path }),
      oldFolders: () => call('library_old_folders'),
      oldFolderSize: (folder) => call('library_old_folder_size', { folder }),
      removeOldFolders: (folders) => call('library_remove_old_folders', { folders }),
      imagesInfo: (id) => call('library_images_info', { id }),
      deleteImages: (id) => call('library_delete_images', { id }),
      importSources: (packId, importerId) => call('library_import_sources', { packId, importerId }),
      importSourceList: (packId, importerId) =>
        call('library_import_source_list', { packId, importerId }),
      importSource: (packId, importerId, key) =>
        call('library_import_source', { packId, importerId, key }),
      saveImport: (request) => call('library_save_import', { request }),
      styles: (packId) => call('library_styles', { packId }),
      keepStyles: (packId, request) => call('library_keep_styles', { packId, request }),
      styleTexts: __ATLAS_DOWNLOADS__
        ? (packId) => call('library_style_texts', { packId })
        : () => Promise.reject(new Error('This app does not lay pages out.')),
    },
    importWindow: {
      open: (url, reader, importer, purpose, measure, keep, browse) =>
        call('import_open', {
          url,
          reader,
          ...(importer
            ? {
                importerId: importer.id,
                ...(importer.waitSeconds !== undefined
                  ? { waitSeconds: importer.waitSeconds }
                  : {}),
              }
            : {}),
          ...(purpose && purpose !== 'map' ? { purpose } : {}),
          ...(measure ? { measure } : {}),
          ...(keep ? { keep: true } : {}),
          ...(browse ? { browse: true } : {}),
        }),
      navigate: (url, reader, importer) =>
        call('import_navigate', {
          url,
          reader,
          ...(importer ? { importerId: importer.id, waitSeconds: importer.waitSeconds } : {}),
        }),
      poll: () => call('import_poll'),
      runOnce: (script, argument) => call('import_run_once', { script, argument }),
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
    ownNotes: {
      read: (gameId) => call('own_notes_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('own_notes_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('own_notes_delete', { gameId }),
    },
    ownRoutes: {
      read: (gameId) => call('own_routes_read', { gameId }),
      write: (gameId, contents, keepCopy) =>
        call('own_routes_write', { gameId, contents, keepCopy: keepCopy ?? null }),
      delete: (gameId) => call('own_routes_delete', { gameId }),
    },
    sites: __ATLAS_DOWNLOADS__
      ? {
          list: () => call('sites_list'),
          pick: () => call('sites_pick'),
          pickPage: () => call('sites_pick_page'),
          add: (name, text) => call('sites_add', { name, text }),
          remove: (name, key) => call('sites_remove', { name, key }),
          switch: (switches) => call('sites_switch', { switches }),
          save: (what, contents) => call('sites_save', { what, contents }),
        }
      : noSites(),
    keptPacks: __ATLAS_DOWNLOADS__
      ? {
          status: () => call('kept_packs_status'),
          chooseFolder: () => call('kept_packs_choose_folder'),
          set: (on, schedule) => call('kept_packs_set', { choice: { on, schedule } }),
          writeAll: () => call('kept_packs_write_all'),
          writeAgain: (id) => call('kept_packs_write_again', { id }),
          cancel: () => call('kept_packs_cancel'),
          reveal: () => call('kept_packs_reveal'),
        }
      : noKeptPacks(),
    gameGroups: {
      read: () => call('game_groups_read'),
      write: (contents, keepCopy) =>
        call('game_groups_write', { contents, keepCopy: keepCopy ?? null }),
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
    madePacks: {
      plan: (id) => call('made_pack_plan', { id }),
      write: (id, replaceNewer) => call('made_pack_write', { id, replaceNewer }),
      openPlan: (id) => call('made_pack_open_plan', { id }),
      open: (id) => call('made_pack_open', { id }),
      close: (id) => call('made_pack_close', { id }),
      mineOffer: (id) => call<unknown>('made_pack_mine_offer', { id }).then(mineOfferFrom),
      mineTake: (id, exportedAt) => call('made_pack_mine_take', { id, exportedAt }),
      mineChoose: (id, exportedAt, added) =>
        call('made_pack_mine_choose', { id, exportedAt, added }),
    },
    guidebooks: {
      pick: () => call('guidebook_pick'),
      forgetPicked: () => call('guidebook_forget_picked'),
      add: (request) => call('guidebook_add', { request }),
      remove: (packId, file) => call('guidebook_remove', { packId, file }),
    },
    background: {
      state: () => call('background_state'),
      set: (setting, on) => call('background_set', { setting, on }),
      setHotkey: (keys) => call('background_set_hotkey', { keys }),
      pauseHotkey: (paused) => call('background_pause_hotkey', { paused }),
      takeShow: () => call<unknown>('background_take_show').then(showRequestFrom, () => null),
    },
    listFiles: {
      save: (suggestedName, contents) => call('list_file_save', { suggestedName, contents }),
      open: () => call('list_file_open'),
    },
    events: {
      libraryChanged: (handler) =>
        listen('library-changed', (payload) => {
          handler(payload as Listing);
        }),
      packFileOpened: (handler) =>
        listen('pack-file-opened', () => {
          handler();
        }),
      keptPacksChanged: (handler) =>
        __ATLAS_DOWNLOADS__
          ? listen('kept-packs-changed', (payload) => {
              handler(payload as KeptPacksStatus);
            })
          : noEvents('kept-packs-changed', () => undefined),
      backgroundChanged: (handler) =>
        listen('background-changed', (payload) => {
          handler(payload as BackgroundState);
        }),
      showRequested: (handler) =>
        listen('show-requested', () => {
          handler();
        }),
    },
    packFiles: {
      options: (id) => call('packfile_options', { id }),
      export: (
        id,
        detail,
        progress,
        includeMine,
        includePhotos,
        smallerPictures,
        includeTypePictures,
      ) =>
        call('packfile_export', {
          id,
          detail,
          progress: progress ?? null,
          includeMine: includeMine ?? false,
          includePhotos: includePhotos ?? false,
          includeTypePictures: includeTypePictures ?? false,
          smallerPictures: smallerPictures ?? false,
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

/**
 * An offer of own things from the shell's answer: only one of the shape of
 * {@link MineOffer} is taken; anything else (none, or a shell without the
 * command answering with nothing) is no offer. Exported for tests.
 */
export function mineOfferFrom(value: unknown): MineOffer | null {
  if (typeof value !== 'object' || value === null) return null;
  const offer = value as Partial<MineOffer>;
  const facts = offer.facts as Partial<MineFacts> | null | undefined;
  if (
    typeof offer.id !== 'string' ||
    typeof offer.title !== 'string' ||
    typeof offer.path !== 'string' ||
    typeof offer.exportedAt !== 'string' ||
    typeof facts !== 'object' ||
    facts === null ||
    typeof facts.lists !== 'number' ||
    typeof facts.locations !== 'number' ||
    typeof facts.types !== 'number' ||
    typeof facts.areas !== 'number'
  ) {
    return null;
  }
  return offer as MineOffer;
}

/**
 * A game asked for from the shell's answer: only one of the shape of
 * {@link ShowRequest} naming at least one game is taken; anything else
 * (none, or a shell without the command answering with nothing) is no
 * request. Exported for tests.
 */
export function showRequestFrom(value: unknown): ShowRequest | null {
  if (typeof value !== 'object' || value === null) return null;
  const { packs, groups } = value as { packs?: unknown; groups?: unknown };
  const strings = (list: unknown): list is string[] =>
    Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (!strings(packs) || packs.length === 0) return null;
  const found: ShowRequest['groups'] = [];
  for (const group of Array.isArray(groups) ? (groups as unknown[]) : []) {
    if (typeof group !== 'object' || group === null) continue;
    const { id, members } = group as { id?: unknown; members?: unknown };
    if (typeof id === 'string' && strings(members)) found.push({ id, members });
  }
  return { packs, groups: found };
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

interface TauriInternals {
  invoke?: unknown;
  transformCallback?: unknown;
}

/**
 * Listening to the shell's events as Tauri's own event module does: the
 * handler is registered as a callback, and the shell's event plugin is
 * asked to call it for the event. The shell grants only listening and
 * stopping (see the shell's `capabilities/main.json`). Exported for tests.
 */
export function eventListener(internals: TauriInternals, invoke: Invoke): Listen {
  const register = internals.transformCallback;
  if (typeof register !== 'function') return noEvents;
  return async (event, handler) => {
    const callback = (
      register as (
        this: TauriInternals,
        callback: (message: { payload: unknown }) => void,
      ) => number
    ).call(internals, (message) => {
      handler(message.payload);
    });
    const eventId = await invoke('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: callback,
    });
    return () => {
      const plugin = (
        globalThis as {
          __TAURI_EVENT_PLUGIN_INTERNALS__?: {
            unregisterListener?: (event: string, id: unknown) => void;
          };
        }
      ).__TAURI_EVENT_PLUGIN_INTERNALS__;
      plugin?.unregisterListener?.(event, eventId);
      invoke('plugin:event|unlisten', { event, eventId }).catch(() => undefined);
    };
  };
}

function detect(): DesktopBridge | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return null;
  const invoke = internals.invoke.bind(internals) as Invoke;
  return createBridge(invoke, eventListener(internals, invoke));
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
