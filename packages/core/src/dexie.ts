/**
 * The IndexedDB backend for user state, kept out of the main entry point so
 * code that never touches the browser database (the pipeline, tests) does
 * not load Dexie.
 */
export * from './progress/dexieStore';
