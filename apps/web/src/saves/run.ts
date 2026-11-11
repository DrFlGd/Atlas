import type {
  SaveJob,
  SaveJobResult,
  TableJob,
  TableJobResult,
  WorkerJob,
  WorkerResult,
} from './process';

/**
 * Runs save and table jobs in a module worker, one at a time, or on the
 * page when a worker cannot be started (an old browser, a test without
 * workers).
 */

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<number, (result: WorkerResult | null) => void>();

function startWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' });
    worker.addEventListener(
      'message',
      (event: MessageEvent<{ id: number; result: WorkerResult }>) => {
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

async function run(job: WorkerJob): Promise<WorkerResult> {
  const target = typeof Worker === 'function' ? startWorker() : null;
  if (target) {
    const id = nextId++;
    const result = await new Promise<WorkerResult | null>((resolve) => {
      pending.set(id, resolve);
      // The bytes are copied rather than moved, so the caller keeps them.
      target.postMessage({ id, job });
    });
    if (result) return result;
  }
  // Loaded only when needed: the worker has its own copy.
  const { processJob } = await import('./process');
  return processJob(job);
}

export function runSaveJob(job: SaveJob): Promise<SaveJobResult> {
  return run(job) as Promise<SaveJobResult>;
}

export function runTableJob(job: TableJob): Promise<TableJobResult> {
  return run(job) as Promise<TableJobResult>;
}
