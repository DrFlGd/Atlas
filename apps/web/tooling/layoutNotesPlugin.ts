import type { Plugin } from 'vite';
import { LAYOUT_NOTES_SCRIPT } from '../../../packages/importer-api/src/layoutNotes.ts';

/**
 * The measuring step of `@atlas/importer-api` (`LAYOUT_NOTES_SCRIPT`) as a
 * module of the app's own code: `import measure from
 * 'virtual:atlas-layout-notes'`. The step is kept as the text of a function,
 * for importers to put in their page readers; the app measures the closed
 * frame it lays saved pages out in (`src/layoutFrame/`) with the very same
 * step, but its window allows no text to be run as code. So the text is made
 * a module here, when the app is built, from the package's own source: the
 * app runs only its own code, never text an importer or a site hands it.
 */

export const LAYOUT_NOTES_MODULE = 'virtual:atlas-layout-notes';
const RESOLVED = `\0${LAYOUT_NOTES_MODULE}`;

/** The module's code: the step's function, as its default export. */
export const layoutNotesModule = (): string => `export default (${LAYOUT_NOTES_SCRIPT});\n`;

export function layoutNotesPlugin(): Plugin {
  return {
    name: 'atlas-layout-notes',
    resolveId(id) {
      return id === LAYOUT_NOTES_MODULE ? RESOLVED : null;
    },
    load(id) {
      return id === RESOLVED ? layoutNotesModule() : null;
    },
  };
}
