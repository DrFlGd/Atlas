/**
 * Making 3D maps from a game's own files on the person's computer (optional,
 * {@link GameFilesImport}): an importer that reads the files a kind of game
 * keeps its levels in, for the "Make a 3D map from game files" step of the
 * desktop app that downloads.
 *
 * The person chooses a kind of game the importer reads ({@link GameFilesKind}),
 * then the game's folder in the system's folder dialog. The app hands the
 * importer that folder as a {@link GameFolder}: it may list the folder and
 * read byte ranges of its files, read-only, and nothing outside it. The
 * importer says which game it is and lists its maps
 * ({@link GameFilesImport.survey}); the person ticks maps and confirms
 * they are for their own use; the importer reads each map and turns it
 * into one raw 3D model (a glTF binary file it makes on this computer),
 * which it hands to the app's one 3D builder with
 * {@link GameFilesContext.sceneModel} (`model` in place of an address,
 * see {@link SceneModelRequest}). The result is one game whose maps are
 * the ticked levels, saved as any import is.
 *
 * Nothing the importer reads leaves the computer: the folder's files are
 * read where they are, and the models built are kept in the maps folder
 * only. A kind may also offer to download its game's files instead
 * ({@link GameFilesKind.download}): only after the person confirms they
 * own the game, only the files the maps they tick need, one at a time,
 * with the app's own downloader, kept in a folder of the app's so they
 * are not downloaded again ({@link GameFolder.download}).
 */

import type {
  ImportContext,
  ImportFailure,
  ImportOutcome,
  SceneModel,
  SceneModelRequest,
} from './index';

/** A kind of game an importer reads the files of, such as games of one engine. */
export interface GameFilesKind {
  /** Its id: lowercase letters, digits and `-`, at most 40. */
  id: string;
  /** Its name, shown as a choice. */
  title: string;
  /** One or two sentences: which games, and which folder to choose. */
  description: string;
  /**
   * Optional: the importer can download the files this kind's game needs
   * in place of a folder the person chooses. The app offers it beside the
   * folder, and only once the person has confirmed they own the game; it
   * then hands the importer a folder of its own, kept for this importer
   * and kind, that can download ({@link GameFolder.download}). Absent: the
   * folder only. An app that does not know it offers the folder only.
   */
  download?: {
    /** One or two sentences: what is downloaded, and from where. */
    description: string;
  };
}

/** One entry of a folder of the game ({@link GameFolder.list}). */
export interface GameFolderEntry {
  name: string;
  /** A folder (else a file). */
  folder: boolean;
  /** A file's size in bytes; 0 for a folder. */
  size: number;
}

/**
 * The folder the person chose, as the importer reads it. Paths are relative
 * to it, with `/` between their parts and no `.` or `..`, written as the
 * folder's own entries are (the app finds nothing by another case);
 * `''` is the folder itself. Links inside the folder are not listed and
 * not followed. Each call rejects with a plain sentence when the path
 * cannot be read.
 */
export interface GameFolder {
  /** The folder's own name (its last part), to show. */
  name: string;
  /** The entries of a folder in it, sorted by name. */
  list(path: string): Promise<GameFolderEntry[]>;
  /**
   * Bytes of a file in it: `length` bytes from `start` (the whole file
   * when both are absent), fewer at its end. At most
   * {@link GAME_FILE_MAX_READ} bytes a call.
   */
  read(path: string, start?: number, length?: number): Promise<Uint8Array>;
  /**
   * Only in the folder the app keeps for a kind's downloads
   * ({@link GameFilesKind.download}), once the person has confirmed they
   * own the game: fetches the file at `url` (`https`) with the app's own
   * downloader (one request, the app's name and version as its user
   * agent, no cookies, nothing tried again or around a refusal), keeps
   * it at `path` in this folder, and hands its bytes back. Rejects with a
   * plain sentence for any answer but a file: the importer stops there.
   * One at a time: a call waits for the one before it. At most
   * {@link GAME_FILE_MAX_DOWNLOAD} bytes.
   */
  download?(url: string, path: string): Promise<Uint8Array>;
}

/** The most bytes one {@link GameFolder.read} hands back. The desktop shell enforces the same. */
export const GAME_FILE_MAX_READ = 512 * 1024 * 1024;

/** The most bytes one {@link GameFolder.download} fetches. The desktop shell enforces the same. */
export const GAME_FILE_MAX_DOWNLOAD = 256 * 1024 * 1024;

/** A map of the game the importer can make ({@link GameFilesSurvey.maps}). */
export interface GameFilesMap {
  /** Its id, for {@link GameFilesImport.build}: 1 to 64 of `a`–`z`, `0`–`9`, `_` and `-`. */
  id: string;
  /** Its name, shown. */
  name: string;
  /** The group it is shown under, such as a chapter. */
  group?: string;
}

/** What the importer found in the folder ({@link GameFilesImport.survey}). */
export interface GameFilesSurvey {
  ok: true;
  /** The game, as its pack will be named. */
  game: { id: string; title: string };
  /** Its maps, in the order to show them. At most {@link MAX_GAME_FILES_MAPS}. */
  maps: GameFilesMap[];
  /** Plain sentences to show about the folder (what it found, what it cannot read). */
  notes?: string[];
}

export const MAX_GAME_FILES_MAPS = 2000;

/** How far a build is, for the person to see ({@link GameFilesContext.progress}). */
export interface GameFilesProgress {
  /** Maps done, of `total`. */
  done: number;
  total: number;
  /** What it is doing, one short plain sentence. */
  text?: string;
}

/**
 * What the app gives a build ({@link GameFilesImport.build}): the parts of
 * {@link ImportContext} an importer needs to make a pack, and the builder.
 */
export interface GameFilesContext extends Pick<
  ImportContext,
  'importedAt' | 'app' | 'existingPack' | 'isBundled'
> {
  /** Tells the app how far the build is; shown at the app's own pace. */
  progress?(step: GameFilesProgress): void;
  /** Whether the person stopped the build: the importer stops at the next step. */
  cancelled(): boolean;
  /**
   * Builds one map's raw model, made by the importer from the game's files
   * (`model`; never an address), with Atlas's one 3D builder: lined up
   * with the world as asked, cut into cells with levels of detail,
   * compressed and drawn from above, its textures kept when `textures` is
   * `keep`. As {@link ImportContext.sceneModel} otherwise: nothing is
   * written into a pack until the importer names the build in
   * {@link ImportSuccess.sceneBuilds} and the pack is saved.
   */
  sceneModel(request: SceneModelRequest): Promise<SceneModel>;
}

/** Making 3D maps from a game's own files (see the top of this file). */
export interface GameFilesImport {
  /** The kinds of game it reads, offered as choices. At least one. */
  kinds: GameFilesKind[];
  /**
   * Reads the chosen folder: which game it is and its maps, or a failure
   * with one plain sentence (the folder is not a game of that kind, a file
   * it needs is missing). Reads only what it needs to say so.
   */
  survey(kind: string, folder: GameFolder): Promise<GameFilesSurvey | ImportFailure>;
  /**
   * Makes the maps `maps` (ids from the survey) into one pack: the game's
   * pack with those maps added or made again, and its other maps kept.
   * The person has confirmed the maps are for their own use. Maps that
   * cannot be made are left out with a sentence each
   * (`summary.leftOut`); none made is a failure.
   */
  build(
    kind: string,
    folder: GameFolder,
    maps: string[],
    context: GameFilesContext,
  ): Promise<ImportOutcome>;
}

/** A kind's id ({@link GameFilesKind.id}). */
export const GAME_FILES_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The page address a pack made from game files names as its source: no site, the kind and the game. */
export function gameFilesSource(kind: string, gameId: string): string {
  return `game-files:${kind}/${gameId}`;
}

/**
 * The survey as the app takes it: maps with usable ids and names, each id
 * once, at most {@link MAX_GAME_FILES_MAPS}; a failure for anything else.
 */
export function checkGameFilesSurvey(value: unknown): GameFilesSurvey | ImportFailure {
  const failed = (message: string): ImportFailure => ({ ok: false, message });
  if (typeof value !== 'object' || value === null) {
    return failed('The importer did not say what is in the folder.');
  }
  const given = value as Record<string, unknown>;
  if (given.ok === false) {
    return typeof given.message === 'string' && given.message.trim() !== ''
      ? failed(given.message.slice(0, 1000))
      : failed('The folder could not be read.');
  }
  const game = given.game as { id?: unknown; title?: unknown } | undefined;
  if (
    typeof game?.id !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(game.id) ||
    typeof game.title !== 'string' ||
    game.title.trim() === ''
  ) {
    return failed('The importer did not name the game.');
  }
  const seen = new Set<string>();
  const maps: GameFilesMap[] = [];
  for (const entry of Array.isArray(given.maps) ? (given.maps as unknown[]) : []) {
    if (maps.length >= MAX_GAME_FILES_MAPS) break;
    const { id, name, group } = (entry ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || seen.has(id)) continue;
    if (typeof name !== 'string' || name.trim() === '') continue;
    seen.add(id);
    maps.push({
      id,
      name: name.slice(0, 200),
      ...(typeof group === 'string' && group.trim() !== '' ? { group: group.slice(0, 200) } : {}),
    });
  }
  const notes = Array.isArray(given.notes)
    ? (given.notes as unknown[])
        .filter((note): note is string => typeof note === 'string' && note.trim() !== '')
        .slice(0, 20)
        .map((note) => note.slice(0, 500))
    : [];
  return {
    ok: true,
    game: { id: game.id, title: game.title.slice(0, 200) },
    maps,
    ...(notes.length > 0 ? { notes } : {}),
  };
}
