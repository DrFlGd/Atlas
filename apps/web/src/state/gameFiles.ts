import {
  GAME_FILE_MAX_READ,
  checkGameFilesSurvey,
  checkOutcome,
  checkSceneModelRequest,
  gameFilesSource,
  type AtlasImporter,
  type GameFilesContext,
  type GameFilesKind,
  type GameFilesSurvey,
  type GameFolder,
  type ImportOutcome,
  type SceneModel,
  type SceneModelProblem,
} from '@atlas/importer-api';
import { describePack, recordedImages, sceneSchema } from '@atlas/schema';
import { create } from 'zustand';
import { desktop, type ShellGameFolder } from '../desktop';
import { downloadsOffered } from '../features';
import { loadGame } from './actions';
import { importContext, loadImporters, packFiles, packSource } from './importing';
import { applyListing } from './library';
import { notePackSaved, packTurn } from './packTurns';
import { useAtlas } from './store';

/**
 * "Make a 3D map from game files", in a desktop build that downloads and
 * has an importer that reads a game's own files (`gameFiles` of the
 * importer contract): the person chooses a kind of game, then the game's
 * folder in the system's folder dialog; the importer says which game it is
 * and lists its maps; the person ticks maps and confirms they are for
 * their own use; the importer makes each map's model from the files and
 * the shell builds it with Atlas's 3D builder, keeping its textures. The
 * maps are saved as one game, as any import is.
 *
 * The folder's files are read where they are, through the shell, and
 * nothing is fetched or sent anywhere.
 */

/** A kind of game an importer of this app reads the files of. */
export interface GameFilesChoice {
  importerId: string;
  importer: string;
  kind: GameFilesKind;
}

export type GameFilesStep =
  | { kind: 'off' }
  | { kind: 'choose'; choices: GameFilesChoice[] }
  | { kind: 'folder'; choice: GameFilesChoice; reading: boolean; error?: string }
  | {
      kind: 'maps';
      choice: GameFilesChoice;
      folder: ShellGameFolder;
      survey: GameFilesSurvey;
      ticked: string[];
      personal: boolean;
    }
  | {
      kind: 'building';
      choice: GameFilesChoice;
      game: string;
      done: number;
      total: number;
      text: string;
      stopping: boolean;
    }
  | {
      kind: 'done';
      packId: string;
      game: string;
      maps: number;
      leftOut: string[];
    }
  | { kind: 'failed'; message: string };

export const useGameFiles = create<{ step: GameFilesStep }>(() => ({ step: { kind: 'off' } }));

const set = (step: GameFilesStep) => {
  useGameFiles.setState({ step });
};

/** The kinds of game this app's importers read the files of; none in a build that does not download. */
export async function gameFilesChoices(): Promise<GameFilesChoice[]> {
  if (!__ATLAS_DOWNLOADS__ || !desktop || !downloadsOffered(useAtlas.getState())) return [];
  const importers = await loadImporters().catch((): AtlasImporter[] => []);
  return importers.flatMap((importer) =>
    (importer.gameFiles?.kinds ?? []).map((kind) => ({
      importerId: importer.id,
      importer: importer.title,
      kind,
    })),
  );
}

/** Starts the steps: the kinds of game to choose from (or straight to the folder when there is one). */
export async function startGameFiles(): Promise<void> {
  const choices = await gameFilesChoices();
  if (choices.length === 1) set({ kind: 'folder', choice: choices[0]!, reading: false });
  else set({ kind: 'choose', choices });
}

export function chooseGameKind(choice: GameFilesChoice): void {
  set({ kind: 'folder', choice, reading: false });
}

/** Ends the steps, forgetting the folder picked. */
export function closeGameFiles(): void {
  const { step } = useGameFiles.getState();
  if (step.kind === 'maps')
    void desktop?.tiles.closeGameFolder(step.folder.token).catch(() => undefined);
  set({ kind: 'off' });
}

async function importerOf(id: string): Promise<AtlasImporter | null> {
  return (await loadImporters().catch((): AtlasImporter[] => [])).find((i) => i.id === id) ?? null;
}

/** The folder the person picked, as an importer reads it ({@link GameFolder}). */
export function gameFolderOf(
  shell: Pick<NonNullable<typeof desktop>['tiles'], 'listGameFolder' | 'readGameFile'>,
  folder: ShellGameFolder,
): GameFolder {
  return {
    name: folder.name,
    list: (path) => shell.listGameFolder(folder.token, path),
    read: (path, start, length) =>
      shell.readGameFile(
        folder.token,
        path,
        Math.max(0, Math.floor(start ?? 0)),
        Math.min(GAME_FILE_MAX_READ, Math.max(0, Math.floor(length ?? GAME_FILE_MAX_READ))),
      ),
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Asks for the game's folder, and has the importer read what is in it. */
export async function pickGameFolder(): Promise<void> {
  const shell = desktop;
  const { step } = useGameFiles.getState();
  if (!shell || step.kind !== 'folder') return;
  const { choice } = step;
  let folder: ShellGameFolder | null;
  try {
    folder = await shell.tiles.pickGameFolder();
  } catch (error) {
    set({ kind: 'folder', choice, reading: false, error: errorText(error) });
    return;
  }
  if (!folder) return;
  set({ kind: 'folder', choice, reading: true });
  const importer = await importerOf(choice.importerId);
  let survey: ReturnType<typeof checkGameFilesSurvey>;
  try {
    survey = importer?.gameFiles
      ? checkGameFilesSurvey(
          await importer.gameFiles.survey(choice.kind.id, gameFolderOf(shell.tiles, folder)),
        )
      : { ok: false, message: 'This app no longer has that importer.' };
  } catch (error) {
    survey = { ok: false, message: `The folder could not be read: ${errorText(error)}` };
  }
  if (useGameFiles.getState().step.kind !== 'folder') return;
  if (!survey.ok) {
    void shell.tiles.closeGameFolder(folder.token).catch(() => undefined);
    set({ kind: 'folder', choice, reading: false, error: survey.message });
    return;
  }
  if (survey.maps.length === 0) {
    void shell.tiles.closeGameFolder(folder.token).catch(() => undefined);
    set({
      kind: 'folder',
      choice,
      reading: false,
      error: `${survey.game.title} was found in ${folder.name}, but none of its maps can be made.`,
    });
    return;
  }
  set({ kind: 'maps', choice, folder, survey, ticked: [], personal: false });
}

export function tickGameMap(id: string, on: boolean): void {
  const { step } = useGameFiles.getState();
  if (step.kind !== 'maps') return;
  const ticked = step.ticked.filter((t) => t !== id);
  set({ ...step, ticked: on ? [...ticked, id] : ticked });
}

export function tickGameMaps(ids: readonly string[], on: boolean): void {
  const { step } = useGameFiles.getState();
  if (step.kind !== 'maps') return;
  const rest = step.ticked.filter((t) => !ids.includes(t));
  set({ ...step, ticked: on ? [...rest, ...ids] : rest });
}

export function setPersonalUse(personal: boolean): void {
  const { step } = useGameFiles.getState();
  if (step.kind === 'maps') set({ ...step, personal });
}

let stopRequested = false;

/** Stops a build after the map it is on. */
export function stopGameBuild(): void {
  const { step } = useGameFiles.getState();
  if (step.kind !== 'building') return;
  stopRequested = true;
  set({ ...step, stopping: true });
}

/** The most bytes of a model sent to the shell at a time. */
export const MODEL_PART_BYTES = 32 * 1024 * 1024;

/**
 * The builder for a game files build: the model the importer made, sent
 * to the shell in parts and built with its textures kept. `builds`
 * gathers the builds made, so those no saved pack names are thrown away.
 */
export function localSceneModels(
  shell: Pick<NonNullable<typeof desktop>['tiles'], 'keepModel' | 'buildScene'>,
  builds: string[],
): (request: unknown) => Promise<SceneModel> {
  const failed = (problem: SceneModelProblem, message: string): SceneModel => ({
    ok: false,
    problem,
    message,
  });
  return async (given) => {
    const request = checkSceneModelRequest(given);
    if (typeof request === 'string') return failed('failed', request);
    const { model, url: _url, pieces: _pieces, ...how } = request;
    if (!model) return failed('failed', 'A model made from game files is never read from a site.');
    try {
      let build: string | null = null;
      for (let at = 0; at < model.byteLength; at += MODEL_PART_BYTES) {
        build = await shell.keepModel(model.subarray(at, at + MODEL_PART_BYTES), build);
        if (at === 0) builds.push(build);
      }
      if (build === null) return failed('format', 'The model is empty.');
      const built = await shell.buildScene(build, { ...how, textures: how.textures ?? 'keep' });
      if (!built.ok || !built.rendered) {
        const problem = (['format', 'size', 'missing'] as const).find((p) => p === built.problem);
        return failed(problem ?? 'failed', built.message ?? 'The model could not be built.');
      }
      const scene = sceneSchema.safeParse(built.scene);
      if (!scene.success) {
        return failed('failed', 'The model was built into a scene this app cannot show.');
      }
      return {
        ok: true,
        build,
        scene: scene.data,
        width: built.rendered.width,
        height: built.rendered.height,
        worldTransform: built.rendered.worldTransform,
        layers: built.rendered.layers.map(({ id, url, minZoom, maxZoom, tileSize }) => ({
          id,
          url,
          minZoom,
          maxZoom,
          tileSize,
        })),
        triangles: built.triangles,
        warnings: built.warnings.slice(0, 20),
      };
    } catch (error) {
      return failed('failed', `It could not be built: ${errorText(error)}`);
    }
  };
}

/** Has the importer make the ticked maps, and saves them as one game. */
export async function buildGameMaps(): Promise<void> {
  const shell = desktop;
  const { step } = useGameFiles.getState();
  if (!shell || step.kind !== 'maps' || step.ticked.length === 0 || !step.personal) return;
  const { choice, folder, survey } = step;
  const maps = survey.maps.filter((m) => step.ticked.includes(m.id)).map((m) => m.id);
  const importer = await importerOf(choice.importerId);
  if (!importer?.gameFiles) {
    set({ kind: 'failed', message: 'This app no longer has that importer.' });
    return;
  }
  stopRequested = false;
  const building = {
    kind: 'building' as const,
    choice,
    game: survey.game.title,
    done: 0,
    total: maps.length,
    text: 'Reading the game’s files',
    stopping: false,
  };
  set(building);
  const importedAt = new Date().toISOString();
  const source = gameFilesSource(choice.kind.id, survey.game.id);
  const base = importContext(source, importedAt, importer.id);
  const builds: string[] = [];
  const saved = new Set<string>();
  const context: GameFilesContext = {
    importedAt,
    app: base.app,
    existingPack: (packId) => base.existingPack(packId),
    isBundled: (packId) => base.isBundled(packId),
    cancelled: () => stopRequested,
    progress: (given) => {
      const now = useGameFiles.getState().step;
      if (now.kind !== 'building') return;
      const { done, total, text } = given as { done?: unknown; total?: unknown; text?: unknown };
      if (typeof done !== 'number' || typeof total !== 'number' || total < 1) return;
      set({
        ...now,
        done: Math.max(0, Math.min(Math.floor(done), Math.floor(total))),
        total: Math.floor(total),
        ...(typeof text === 'string' && text.trim() !== '' ? { text: text.slice(0, 200) } : {}),
      });
    },
    sceneModel: localSceneModels(shell.tiles, builds),
  };
  try {
    let outcome: ImportOutcome;
    try {
      outcome = checkOutcome(
        await importer.gameFiles.build(
          choice.kind.id,
          gameFolderOf(shell.tiles, folder),
          maps,
          context,
        ),
        source,
      );
    } catch (error) {
      outcome = { ok: false, message: `The importer stopped with an error: ${errorText(error)}` };
    }
    if (!outcome.ok) {
      set({ kind: 'failed', message: outcome.message });
      return;
    }
    const result = await saveGameFiles(importer, outcome, source, importedAt, {
      kind: choice.kind.id,
      game: survey.game.id,
      maps,
    });
    if (typeof result === 'string') {
      set({ kind: 'failed', message: result });
      return;
    }
    for (const built of outcome.sceneBuilds ?? []) saved.add(built.build);
    set({
      kind: 'done',
      packId: outcome.packId,
      game: outcome.summary.game,
      maps: outcome.sceneBuilds?.length ?? 0,
      leftOut: outcome.summary.leftOut ?? [],
    });
  } finally {
    void shell.tiles.closeGameFolder(folder.token).catch(() => undefined);
    const unused = builds.filter((name) => !saved.has(name));
    if (unused.length > 0) void shell.tiles.discardScenes(unused).catch(() => undefined);
  }
}

/** Saves a game made from game files as any import is; a plain sentence when it was not saved. */
async function saveGameFiles(
  importer: AtlasImporter,
  outcome: Extract<ImportOutcome, { ok: true }>,
  source: string,
  importedAt: string,
  data: { kind: string; game: string; maps: string[] },
): Promise<true | string> {
  const library = desktop?.library;
  if (!library) return 'This app cannot save games.';
  const context = importContext(source, importedAt, importer.id);
  if (context.isBundled(outcome.packId)) {
    return `${outcome.summary.game} comes with this app, so it is not replaced. Nothing was added.`;
  }
  const turn = packTurn(outcome.packId);
  try {
    await turn.ready;
    const existing = await context.existingPack(outcome.packId).catch(() => null);
    const stored = await library.importSourceList(outcome.packId, importer.id).catch(() => []);
    const app = useAtlas.getState().app;
    const manifest = describePack(outcome.pack, {
      ...(existing?.manifest.schemaVersion === 2 && existing.manifest.created
        ? { created: existing.manifest.created }
        : {}),
      updated: importedAt,
      writtenBy: { name: app?.name ?? 'Atlas', version: app?.version ?? '0.0.0' },
      source: packSource(importer, stored, {
        key: outcome.sourceKey,
        url: source,
        mapId: outcome.mapId,
        importedAt,
      }),
      images: existing ? recordedImages(existing.manifest) : new Map(),
    });
    const listing = await library.saveImport({
      packId: outcome.packId,
      importer: { id: importer.id, title: importer.title },
      sourceKey: outcome.sourceKey,
      pageUrl: source,
      importedAt,
      ...(outcome.mapId ? { mapId: outcome.mapId } : {}),
      // What was made, never the files: the kind, the game and its maps.
      pageData: JSON.stringify(data),
      files: packFiles({ ...outcome.pack, manifest }),
      ...(outcome.sceneBuilds ? { sceneBuilds: outcome.sceneBuilds } : {}),
    });
    notePackSaved(outcome.packId);
    applyListing(listing);
    return true;
  } catch (error) {
    return errorText(error);
  } finally {
    turn.done();
  }
}

/** Shows the game made. */
export async function openGameFilesGame(packId: string): Promise<void> {
  const entry = useAtlas.getState().catalog.find((p) => p.id === packId);
  if (entry) await loadGame(entry);
}
