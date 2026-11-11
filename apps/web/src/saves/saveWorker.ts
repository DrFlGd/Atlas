/**
 * The save worker: reads and matches saves, and builds the table of the
 * game's map pins, off the page's thread, so large files do not freeze the
 * map. See `process.ts`.
 */

import { processJob, type WorkerJob } from './process';

addEventListener('message', (event: MessageEvent<{ id: number; job: WorkerJob }>) => {
  const { id, job } = event.data;
  postMessage({ id, result: processJob(job) });
});
