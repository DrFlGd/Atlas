/**
 * The save worker: reads and matches saves off the page's thread, so a
 * large save does not freeze the map. See `process.ts`.
 */

import { processSave, type SaveJob } from './process';

addEventListener('message', (event: MessageEvent<{ id: number; job: SaveJob }>) => {
  const { id, job } = event.data;
  postMessage({ id, result: processSave(job) });
});
