/**
 * The measuring step of `@atlas/importer-api` as a module of the app's
 * own code, made from the package's source when the app is built (see
 * `tooling/layoutNotesPlugin.ts`).
 */
declare module 'virtual:atlas-layout-notes' {
  import type { LayoutNotesLimits } from '@atlas/importer-api';

  /** `LAYOUT_NOTES_SCRIPT`'s function: the copy of `article` with the notes, or without them; null for no copy. */
  const measure: (
    article: Element,
    copy?: Element | null,
    limits?: LayoutNotesLimits,
  ) => Element | null;
  export default measure;
}
