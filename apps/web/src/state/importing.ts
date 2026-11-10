import { loadPack } from '@atlas/core';
import {
  DEFAULT_WAIT_SECONDS,
  MAX_PAGE_DATA_CHARS,
  asImporter,
  checkOutcome,
  findImporter,
  isAllowedPageUrl,
  type AtlasImporter,
  type ImportContext,
  type ImportSummary,
  type SavedSource,
} from '@atlas/importer-api';
import {
  COLLECTION_NAMES,
  MANIFEST_FILE,
  PACK_COLLECTIONS,
  describePack,
  recordedImages,
  type PackData,
  type PackSource,
} from '@atlas/schema';
import { create } from 'zustand';
import type { ImporterEntry } from '../config';
import { desktop, type Listing, type StoredSource } from '../desktop';
import { loadGame, notify } from './actions';
import { applyListing } from './library';
import { useAtlas } from './store';

/**
 * "Add a map": the person pastes a page address, an importer that
 * recognises it is chosen, the shell opens the page in a window of its own
 * and reads the page data out of it with the importer's page reader, and
 * the importer turns that data into a pack, which the shell writes to the
 * maps folder. See `packages/importer-api` for the contract.
 *
 * The page cannot call the app. Page data is untrusted: it is capped,
 * parsed as JSON and only handed to the importer's `convert`, whose result
 * is checked against the pack schema before anything is written.
 */

export type ImportPhase =
  | { kind: 'idle' }
  /** The page is open; the app asks it for its data every few seconds. */
  | {
      kind: 'waiting';
      url: string;
      importer: string;
      startedAt: number;
      now: number;
      waitSeconds: number;
      loading: boolean;
      note: string | null;
    }
  | { kind: 'converting'; url: string; importer: string }
  | { kind: 'done'; packId: string; title: string; summary: ImportSummary; rebuilt: boolean }
  | { kind: 'failed'; message: string };

export const useImport = create<{ phase: ImportPhase }>()(() => ({ phase: { kind: 'idle' } }));

const setPhase = (phase: ImportPhase) => {
  useImport.setState({ phase });
};

/** How often the open page is asked for its data. */
export const POLL_MS = 2000;
/** After this long, the dialog explains what may be holding the page up. */
export const STILL_WAITING_SECONDS = 20;

/** A wait in words: "45 seconds", "5 minutes". */
export const waitText = (seconds: number) =>
  seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// Importers

const loaded = new Map<string, Promise<AtlasImporter>>();

/** Loads an importer module listed in `config.json` (once). */
function loadImporter(entry: ImporterEntry): Promise<AtlasImporter> {
  let promise = loaded.get(entry.id);
  if (!promise) {
    promise = (import(/* @vite-ignore */ entry.moduleUrl) as Promise<{ default: unknown }>).then(
      (module) => {
        const importer = asImporter(module.default, `The importer “${entry.title}”`);
        if (importer.id !== entry.id) {
          throw new Error(`The importer “${entry.title}” has a different id than listed.`);
        }
        return importer;
      },
    );
    promise.catch(() => loaded.delete(entry.id));
    loaded.set(entry.id, promise);
  }
  return promise;
}

/** Every importer of this build that loads. */
async function loadImporters(): Promise<AtlasImporter[]> {
  const entries = useAtlas.getState().config?.importers ?? [];
  const results = await Promise.allSettled(entries.map(loadImporter));
  return results.flatMap((result) => {
    if (result.status === 'fulfilled') return [result.value];
    console.error(result.reason);
    return [];
  });
}

/** The message for an address no importer recognises. */
export function unrecognisedMessage(url: string, titles: readonly string[]): string {
  if (!isAllowedPageUrl(url)) {
    return 'That is not a web address this app can open. Paste the full address of the map page, starting with https://.';
  }
  return titles.length === 0
    ? 'This app has no importers, so it cannot add maps from web pages.'
    : `None of the importers in this app recognises that address. It can add maps from: ${titles.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Waiting for the page

let session = 0;

/** Starts an import from a page address. */
export async function startImport(text: string): Promise<void> {
  const shell = desktop;
  if (!shell) return;
  const url = text.trim();
  const id = ++session;
  const importers = await loadImporters();
  const importer = findImporter(importers, url);
  if (!importer) {
    setPhase({
      kind: 'failed',
      message: unrecognisedMessage(
        url,
        importers.map((i) => i.title),
      ),
    });
    return;
  }
  const waitSeconds = importer.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  const startedAt = Date.now();
  const waiting = {
    kind: 'waiting',
    url,
    importer: importer.title,
    startedAt,
    now: startedAt,
    waitSeconds,
    loading: true,
    note: null,
  } as const;
  setPhase(waiting);
  try {
    await shell.importWindow.open(url, importer.pageReader);
  } catch (error) {
    if (id === session) setPhase({ kind: 'failed', message: errorText(error) });
    return;
  }

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (id !== session) return;
    const now = Date.now();
    if (now - startedAt > waitSeconds * 1000) {
      await shell.importWindow.close().catch(() => undefined);
      setPhase({
        kind: 'failed',
        message: `The page did not provide the map data within ${waitText(waitSeconds)}. If it asked you to sign in, to confirm you are a person or to wait, it may not have let the map load; you can try again later. Nothing was added.`,
      });
      return;
    }
    let result;
    try {
      result = await shell.importWindow.poll();
    } catch (error) {
      result = { state: 'failed', message: errorText(error) } as const;
    }
    if (id !== session) return;
    if (result.state === 'waiting') {
      setPhase({ ...waiting, now, loading: result.loading, note: result.note });
      continue;
    }
    await shell.importWindow.close().catch(() => undefined);
    if (result.state === 'closed') {
      setPhase({
        kind: 'failed',
        message:
          'The page window was closed before the page provided the map data. Nothing was added.',
      });
      return;
    }
    if (result.state === 'failed') {
      setPhase({ kind: 'failed', message: result.message });
      return;
    }
    setPhase({ kind: 'converting', url, importer: importer.title });
    const outcome = await convertAndSave(importer, {
      url,
      pageData: result.data,
      importedAt: new Date().toISOString(),
    });
    if (id === session) setPhase(outcome);
    return;
  }
}

/** Stops waiting and closes the page window. */
export async function cancelImport(): Promise<void> {
  session++;
  setPhase({ kind: 'idle' });
  await desktop?.importWindow.close().catch(() => undefined);
}

/** Back to the address field, after a result or a failure. */
export function resetImport(): void {
  if (useImport.getState().phase.kind !== 'waiting') setPhase({ kind: 'idle' });
}

// ---------------------------------------------------------------------------
// Converting and saving

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The context an importer gets: earlier imports and the pack it would replace. */
function importContext(url: string, importedAt: string, importerId: string): ImportContext {
  const state = useAtlas.getState();
  const listing = state.library;
  const bundled = new Set([
    ...state.bundledCatalog.map((p) => p.id),
    ...(listing?.packs ?? []).filter((p) => p.bundled).map((p) => p.id),
  ]);
  return {
    url,
    importedAt,
    app: { name: state.app?.name ?? 'Atlas', version: state.app?.version ?? '' },
    async savedSources(packId) {
      if (!desktop) return [];
      const stored = await desktop.library.importSources(packId, importerId).catch(() => []);
      return stored.flatMap((source): SavedSource[] => {
        const data = parse(source.data);
        return data === undefined
          ? []
          : [{ key: source.key, url: source.url, importedAt: source.importedAt, data }];
      });
    },
    async existingPack(packId) {
      const listed = listing?.packs.find((p) => p.id === packId);
      if (!listed) return null;
      try {
        return (await loadPack(listed.url)).data;
      } catch {
        return null;
      }
    },
    isBundled: (packId) => bundled.has(packId),
  };
}

/** The `source` block of the manifest: every page the pack was made from. */
function packSource(
  importer: AtlasImporter,
  stored: readonly StoredSource[],
  current: { key: string; url: string; mapId: string; importedAt: string },
): PackSource {
  const pages = stored
    .filter((source) => source.key !== current.key)
    .map((source) => ({
      url: source.url,
      ...(source.mapId ? { mapId: source.mapId } : {}),
      importedAt: source.importedAt,
    }));
  pages.push({ url: current.url, mapId: current.mapId, importedAt: current.importedAt });
  return { importer: { id: importer.id, title: importer.title }, pages };
}

/** The pack's files as JSON text, with a manifest that describes it. */
export function packFiles(pack: PackData): Record<string, string> {
  const files: Record<string, string> = {
    [MANIFEST_FILE]: `${JSON.stringify(pack.manifest, null, 2)}\n`,
  };
  for (const name of COLLECTION_NAMES) {
    files[PACK_COLLECTIONS[name].file] = `${JSON.stringify(pack[name], null, 2)}\n`;
  }
  return files;
}

/**
 * Hands page data to the importer, checks what it returns, and writes the
 * pack. Returns the phase to show.
 */
async function convertAndSave(
  importer: AtlasImporter,
  page: { url: string; pageData: string; importedAt: string },
  rebuilt = false,
): Promise<ImportPhase> {
  const shell = desktop;
  if (!shell) return { kind: 'idle' };
  if (page.pageData.length > MAX_PAGE_DATA_CHARS) {
    return { kind: 'failed', message: 'The page provided more data than this app accepts.' };
  }
  const data = parse(page.pageData);
  if (data === undefined) {
    return { kind: 'failed', message: 'The page data was not in the expected shape.' };
  }
  const context = importContext(page.url, page.importedAt, importer.id);
  let returned: unknown;
  try {
    returned = await importer.convert(data, context);
  } catch (error) {
    return {
      kind: 'failed',
      message: `The importer stopped with an error, so nothing was added: ${errorText(error)}`,
    };
  }
  const outcome = checkOutcome(returned);
  if (!outcome.ok) return { kind: 'failed', message: outcome.message };
  if (context.isBundled(outcome.packId)) {
    return {
      kind: 'failed',
      message: `${outcome.summary.game} comes with this app, so it is not replaced by an import. Nothing was added.`,
    };
  }

  const existing = await context.existingPack(outcome.packId);
  const stored = await shell.library
    .importSources(outcome.packId, importer.id)
    .catch((): StoredSource[] => []);
  const app = useAtlas.getState().app;
  const manifest = describePack(outcome.pack, {
    ...(existing?.manifest.schemaVersion === 2 && existing.manifest.created
      ? { created: existing.manifest.created }
      : {}),
    updated: rebuilt ? new Date().toISOString() : page.importedAt,
    writtenBy: { name: app?.name ?? 'Atlas', version: app?.version ?? '0.0.0' },
    source: packSource(importer, stored, {
      key: outcome.sourceKey,
      url: page.url,
      mapId: outcome.mapId,
      importedAt: page.importedAt,
    }),
    images: existing ? recordedImages(existing.manifest) : new Map(),
  });
  let listing: Listing;
  try {
    listing = await shell.library.saveImport({
      packId: outcome.packId,
      importer: { id: importer.id, title: importer.title },
      sourceKey: outcome.sourceKey,
      pageUrl: page.url,
      importedAt: page.importedAt,
      mapId: outcome.mapId,
      pageData: page.pageData,
      files: packFiles({ ...outcome.pack, manifest }),
    });
  } catch (error) {
    return { kind: 'failed', message: errorText(error) };
  }
  applyListing(listing);
  const entry = useAtlas.getState().catalog.find((p) => p.id === outcome.packId);
  if (entry) {
    // Load the new pack and show the imported map.
    await loadGame(entry);
    const game = useAtlas.getState().game;
    const layer = game?.pack.layersOf(outcome.mapId)[0];
    if (game && layer) useAtlas.setState({ mapId: outcome.mapId, layerId: layer.id });
  }
  return {
    kind: 'done',
    packId: outcome.packId,
    title: outcome.summary.game,
    summary: outcome.summary,
    rebuilt,
  };
}

/**
 * Builds an imported pack again from the page data kept with it, without
 * visiting the page: for example after the importer was updated.
 */
export async function rebuildPack(packId: string): Promise<void> {
  const shell = desktop;
  const state = useAtlas.getState();
  const listed = state.library?.packs.find((p) => p.id === packId);
  const entry = state.config?.importers.find((i) => i.id === listed?.imported?.importerId);
  if (!shell || !listed?.imported) return;
  if (!entry) {
    notify(
      `${listed.title} was added with “${listed.imported.importerTitle}”, which this app does not have.`,
      'error',
    );
    return;
  }
  const id = ++session;
  try {
    const importer = await loadImporter(entry);
    const stored = await shell.library.importSources(packId, importer.id);
    const last = stored.at(-1);
    if (!last) {
      notify(`No page data is kept with ${listed.title}, so it cannot be rebuilt.`, 'error');
      return;
    }
    setPhase({ kind: 'converting', url: last.url, importer: importer.title });
    useAtlas.setState({ addMapOpen: true, mapsDialogOpen: false });
    const outcome = await convertAndSave(
      importer,
      { url: last.url, pageData: last.data, importedAt: last.importedAt },
      true,
    );
    if (id === session) setPhase(outcome);
  } catch (error) {
    if (id === session) setPhase({ kind: 'failed', message: errorText(error) });
  }
}

export function setAddMapOpen(open: boolean): void {
  useAtlas.setState({ addMapOpen: open });
  if (!open) resetImport();
}
