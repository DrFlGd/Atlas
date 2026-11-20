/**
 * The text read from the pages of a PDF guidebook whose pack has no text
 * file (see `guidebooks.ts`), kept on this device in the app's own
 * storage (IndexedDB), so a guidebook's pages are read once. Storage that
 * cannot be opened or written (a private window, a full disk) keeps
 * nothing: the pages are then read again when the guidebook is next opened.
 */

const DB = 'atlas-guidebook-text';
const STORE = 'texts';

let opening: Promise<IDBDatabase | null> | null = null;

function database(): Promise<IDBDatabase | null> {
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        resolve(null);
      };
      request.onblocked = () => {
        resolve(null);
      };
    } catch {
      resolve(null);
    }
  });
  return opening;
}

function run<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest<T>) {
  return database().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const request = act(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            resolve(null);
          };
        } catch {
          resolve(null);
        }
      }),
  );
}

/** The text kept for a guidebook (see `textId` in `guidebooks.ts`), or null. */
export async function keptText(id: string): Promise<string[] | null> {
  const value: unknown = await run('readonly', (store) => store.get(id));
  return Array.isArray(value) && value.every((page) => typeof page === 'string') ? value : null;
}

/** Keeps the text of a guidebook's pages. */
export async function keepText(id: string, pages: readonly string[]): Promise<void> {
  await run('readwrite', (store) => store.put([...pages], id));
}

/** Forgets the text kept for a guidebook. */
export async function forgetKeptText(id: string): Promise<void> {
  await run('readwrite', (store) => store.delete(id));
}
