import type { SaveJob, SaveJobResult } from './process';

/**
 * Runs save jobs in a module worker, one at a time, or on the page when a
 * worker cannot be started (an old browser, a test without workers).
 */

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (result: SaveJobResult | null) => void>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener(
      'message',
      (event: MessageEvent<{ id: number; result: SaveJobResult }>) => {
        pending.get(event.data.id)?.(event.data.result);
        pending.delete(event.data.id);
      },
    );
    worker.addEventListener('error', (event) => {
      // The worker could not start or broke: run on the page from now on.
      event.preventDefault();
      worker?.terminate();
      worker = null;
      for (const [id, done] of pending) {
        pending.delete(id);
        done(null);
      }
    });
  } catch {
    worker = null;
  }
  return worker;
}

export async function runSaveJob(job: SaveJob): Promise<SaveJobResult> {
  const target = typeof Worker === 'function' ? startWorker() : null;
  if (target) {
    const id = nextId++;
    const result = await new Promise<SaveJobResult | null>((resolve) => {
      pending.set(id, resolve);
      // The bytes are copied rather than moved, so the caller keeps them.
      target.postMessage({ id, job });
    });
    if (result) return result;
  }
  // Loaded only when needed: the worker has its own copy.
  const { processSave } = await import('./process');
  return processSave(job);
}
