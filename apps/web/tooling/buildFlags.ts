/**
 * Build-time switches of the web app, read from the environment by
 * `vite.config.ts` and folded into the bundle as constants, so code behind
 * a switch that is off is left out of the build, not only hidden.
 */

/**
 * `ATLAS_ENABLE_DOWNLOADS=1`: the desktop app downloads map images and saves
 * them from map pages ("Download map images", "View map page and save
 * images as I browse"). Off when unset, empty or `0`; the desktop build
 * scripts set it together with the shell's `downloads` feature.
 */
export function downloadsEnabled(value: string | undefined): boolean {
  const text = value?.trim() ?? '';
  if (text === '' || text === '0') return false;
  if (text === '1') return true;
  throw new Error(`ATLAS_ENABLE_DOWNLOADS must be 1, 0 or unset, not "${value}".`);
}
