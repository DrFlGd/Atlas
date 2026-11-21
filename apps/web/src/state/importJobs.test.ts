import { beforeAll, describe, expect, it } from 'vitest';
import {
  changeJob,
  jobName,
  jobText,
  keptJobs,
  loadJobs,
  removeJob,
  renameJob,
  saveJob,
  useImportJobs,
  type JobWhat,
} from './importJobs';
import { openProgressStore, progressStore, SETTINGS } from './services';

const SITE = 'https://maps.example.com';

const pages: JobWhat = {
  kind: 'pages',
  site: 'Demo map site',
  pages: [
    { url: `${SITE}/a/east`, title: 'East', importerId: 'demo' },
    { url: `${SITE}/a/west`, title: 'West', importerId: 'demo' },
  ],
};

const games: JobWhat = {
  kind: 'games',
  importerId: 'demo',
  importerTitle: 'Demo',
  site: 'Demo map site',
  catalogue: `${SITE}/games`,
  system: 'Tern 16',
  games: [
    { id: 'emberfall', name: 'Emberfall', address: `${SITE}/emberfall`, direct: false, maps: 3 },
    { id: 'frostvale', name: 'Frostvale', address: `${SITE}/frostvale/one`, direct: true },
  ],
};

describe('jobs', () => {
  beforeAll(async () => {
    // No IndexedDB here: the store kept in memory, as in a browser that allows none.
    await openProgressStore();
  });

  it('says what a job reads, and names it', () => {
    expect(jobText(pages)).toBe('Reads 2 map pages on Demo map site, one at a time.');
    expect(jobName(pages)).toBe('Demo map site: 2 pages');
    expect(jobText(games)).toBe(
      'Adds 2 games from Demo map site, one at a time: each game page, then its maps not in your maps folder yet. The list gives 3 maps for 1 game. Files them under Tern 16.',
    );
    expect(jobName(games)).toBe('Demo map site: 2 games');
  });

  it('keeps jobs on this device: saved, renamed, changed and removed', async () => {
    await loadJobs();
    const job = await saveJob(pages);
    expect(job?.name).toBe('Demo map site: 2 pages');
    renameJob(job!.id, '  Weekly maps  ');
    changeJob(job!.id, { ...pages, pages: pages.pages.slice(0, 1) });
    // Nothing to read: not changed.
    changeJob(job!.id, { ...pages, pages: [] });
    const kept = keptJobs(await progressStore().getSetting(SETTINGS.importJobs));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ name: 'Weekly maps', what: { pages: [{ title: 'East' }] } });
    removeJob(job!.id);
    expect(useImportJobs.getState().jobs).toEqual([]);
    expect(await saveJob({ ...pages, pages: [] })).toBeNull();
  });

  it('reads only jobs it can use', () => {
    const good = {
      id: 'job-1',
      name: 'A',
      createdAt: '2026-11-21T00:00:00.000Z',
      updatedAt: '2026-11-21T00:00:00.000Z',
      what: games,
    };
    expect(keptJobs([good, { ...good, what: { kind: 'other', site: 'x' } }, 'nonsense'])).toEqual([
      good,
    ]);
    expect(keptJobs(null)).toEqual([]);
  });
});
