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
