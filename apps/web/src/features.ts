import type { AtlasState } from './state/store';

declare global {
  /**
   * Map image downloads and "View map page and save images as I browse" are
   * in this build: true only when it was made with
   * `ATLAS_ENABLE_DOWNLOADS=1` (see `vite.config.ts`). The bundler replaces
   * it with a constant, so where it is false the code it guards, and the
   * modules only that code uses, are left out of the bundle. Test it
   * directly where such code is mounted or called, not through a variable,
   * so that this always happens.
   */
  const __ATLAS_DOWNLOADS__: boolean;
}

/**
 * Whether the app offers map image downloads and saving from map pages: the
 * web build has them and so does the desktop shell it runs in, which says
 * so in `desktop_info`. Guard code with `__ATLAS_DOWNLOADS__ &&
 * downloadsOffered(state)`, so a build without them leaves it out.
 */
export function downloadsOffered(state: Pick<AtlasState, 'app'>): boolean {
  return __ATLAS_DOWNLOADS__ && state.app?.downloads === true;
}

/**
 * Whether the Maps dialog has its folder choices and "Open folder"
 * buttons: not where the shell says it has no folders (the Android app,
 * which keeps its maps in its own storage).
 */
export function foldersOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.folders !== false;
}

/**
 * Whether the app offers the Maps dialog: in the desktop app, and in the
 * Android app without its folder choices (see {@link foldersOffered}). A
 * browser has no Maps dialog either way.
 */
export function mapsOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.maps !== false;
}

/**
 * Whether pack files are picked with the system's picker and copied
 * into the app before they are imported: the Android app.
 */
export function copiesPickedFiles(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.copyPickedFiles === true;
}

/**
 * Whether progress can be exported to and imported from files: in a
 * browser, and in a shell that has the dialogs for it (the desktop and
 * Android apps).
 */
export function progressFilesOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.progressFiles !== false;
}

/** Whether "Add a map" can open web pages: not in the Android app. */
export function importsOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.imports !== false;
}

/**
 * Whether to show keyboard shortcuts (key badges, "( / )" in the search
 * field, keys in tooltips, the list of keys): not in the Android app,
 * where there is usually no keyboard. The keys still work there.
 */
export function keyboardHintsOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.platform !== 'android';
}

/**
 * Whether the app always shows its standard layout (`src/touch/`) made for
 * fingers, for a phone or tablet beside the game: in the Android app. Other
 * apps show it made for a mouse unless the screen is a touch screen, or the
 * classic layout where the person chose it (see `touch/uiMode.ts`).
 */
export function touchUiOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.platform === 'android';
}

/**
 * Whether the settings offer the choice between the standard and the
 * classic layout: everywhere but the Android app, which has only the
 * standard one.
 */
export function layoutChoiceOffered(state: Pick<AtlasState, 'app'>): boolean {
  return state.app?.platform !== 'android';
}

/**
 * Whether Settings has "Sites", the person's site rules files for the
 * importers: in a build with downloads (Atlas Importer) whose shell keeps
 * them. Guard code with `__ATLAS_DOWNLOADS__ && sitesOffered(state)`.
 */
export function sitesOffered(state: Pick<AtlasState, 'app'>): boolean {
  return __ATLAS_DOWNLOADS__ && state.app?.sites === true;
}

/**
 * Whether the app reads maps, wikis and guides for games from pack files
 * only and keeps no folder of them: the desktop app without downloads.
 * There, adding a pack file copies it into the packs folder, where it is
 * read as it is; the Library starts from pack files; and the settings
 * offer the old folder maps and wikis of the maps folder for removal (see
 * `library/OldFolders.tsx`, guarded with `!__ATLAS_DOWNLOADS__` too). The
 * app with downloads, which reads sites, and the Android app import pack
 * files into the maps folder.
 */
export function readsPackFilesOnly(state: Pick<AtlasState, 'app'>): boolean {
  const app = state.app;
  return app !== null && app.platform !== 'android' && app.folders !== false && !app.downloads;
}

/**
 * Whether Settings has "Atlas in the background" (keep running with an
 * icon in the notification area, a hotkey, staying above other windows,
 * starting with Windows): in the desktop app without downloads, where its
 * shell says it works (on Windows for now). Guarded with
 * `!__ATLAS_DOWNLOADS__` too, so the app with downloads leaves it out.
 */
export function backgroundOffered(state: Pick<AtlasState, 'app'>): boolean {
  return !__ATLAS_DOWNLOADS__ && readsPackFilesOnly(state) && state.app?.background === true;
}
