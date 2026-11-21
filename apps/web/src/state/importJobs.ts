import { randomId } from '@atlas/core';
import { create } from 'zustand';
import { notify } from './actions';
import { gamesLeft, runGamesOf, useGameSession, type SessionGame } from './gameSession';
import {
  loadImporters,
  needsPerson,
  pagesOfAddresses,
  pagesOfChoice,
  runJobPages,
  sessionGoing,
  sitePauseMs,
  useImport,
  type JobPage,
} from './importing';
import { RUN_PAUSE_MS, runSummary, stopReasonText } from './importRun';
import { setDownloadsOpen } from './libraryView';
import { SETTINGS, progressStore } from './services';

/**
 * Jobs: imports saved to run later (the issue: create a job). Beside the
 * buttons that start an import, "Save as a job" keeps what it would read
 * and how (the map pages ticked or pasted, or the games of a site's list to
 * add one at a time, with their system), never the pages themselves. The
 * jobs are listed in Downloads, with what each reads, and can be started,
 * renamed, changed and removed. Several started are queued and run one
 * after another, never reading a site faster than its rules file says
 * (the pause between pages holds between jobs too); a refusal, a closed
 * window or Stop ends the queue. A job is read as the importers and the
 * site rules files are when it runs, and one whose site needs the person
 * (it is read only as they browse it, or shows its pages only to a person)
 * cannot run by itself: it says so instead.
 *
 * Jobs are kept on this device among the settings, with the Importer's
 * other settings (`importJobs`).
 */

/** What a job reads. */
export type JobWhat =
  /** Map pages, one go. */
  | { kind: 'pages'; site: string; pages: JobPage[] }
  /** Games of a site's list, one at a time (see `gameSession.ts`). */
  | {
      kind: 'games';
      importerId: string;
      importerTitle: string;
      site: string;
      catalogue: string;
      system: string;
      games: SessionGame[];
    };

export interface ImportJob {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  what: JobWhat;
  /** How it went the last time it ran, in a sentence, with when. */
  last?: { at: string; text: string };
}

/** The most jobs kept. */
export const MAX_JOBS = 100;
/** The most pages or games one job holds. */
export const MAX_JOB_ITEMS = 2000;

interface JobsState {
  jobs: ImportJob[];
  loaded: boolean;
  /** Ids of the jobs started and waiting their turn, in order. */
  queue: string[];
  /** The job running now. */
  running: string | null;
}

export const useImportJobs = create<JobsState>()(() => ({
  jobs: [],
  loaded: false,
  queue: [],
  running: null,
}));

const get = useImportJobs.getState;
const set = useImportJobs.setState;

// ---------------------------------------------------------------------------
// What a job says

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString('en')} ${count === 1 ? one : many}`;

/** What a job reads, in a sentence. */
export function jobText(what: JobWhat): string {
  if (what.kind === 'pages') {
    return `Reads ${plural(what.pages.length, 'map page', 'map pages')} on ${what.site}, one at a time.`;
  }
  const maps = what.games.reduce((sum, game) => sum + (game.maps ?? 0), 0);
  const unknown = what.games.filter((game) => game.maps === undefined).length;
  const bytes = what.games.reduce((sum, game) => sum + (game.bytes ?? 0), 0);
  const known =
    unknown === what.games.length
      ? ''
      : ` The list gives ${plural(maps, 'map', 'maps')}${unknown > 0 ? ` for ${plural(what.games.length - unknown, 'game', 'games')}` : ''}${bytes > 0 ? `, about ${(bytes / 1_000_000).toLocaleString('en', { maximumFractionDigits: 1 })} MB` : ''}.`;
  return `Adds ${plural(what.games.length, 'game', 'games')} from ${what.site}, one at a time: each game page, then its maps not in your maps folder yet.${known}${
    what.system ? ` Files them under ${what.system}.` : ''
  }`;
}

/** The name a job gets when it is saved. */
export function jobName(what: JobWhat): string {
  return what.kind === 'pages'
    ? `${what.site}: ${plural(what.pages.length, 'page', 'pages')}`
    : `${what.site}: ${plural(what.games.length, 'game', 'games')}`;
}

/** The jobs as they were kept, those that can be read; anything else is left out. */
export function keptJobs(value: unknown): ImportJob[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((job): job is ImportJob => {
      if (!job || typeof job !== 'object') return false;
      const j = job as Partial<ImportJob>;
      const what = j.what as Partial<JobWhat> | undefined;
      return (
        typeof j.id === 'string' &&
        typeof j.name === 'string' &&
        typeof j.createdAt === 'string' &&
        typeof j.updatedAt === 'string' &&
        typeof what?.site === 'string' &&
        ((what.kind === 'pages' && Array.isArray(what.pages)) ||
          (what.kind === 'games' &&
            Array.isArray(what.games) &&
            typeof what.importerId === 'string' &&
            typeof what.catalogue === 'string'))
      );
    })
    .slice(0, MAX_JOBS);
}

// ---------------------------------------------------------------------------
// Kept on this device

let reading: Promise<void> | null = null;

export function loadJobs(): Promise<void> {
  reading ??= (async () => {
    const value = await progressStore()
      .getSetting(SETTINGS.importJobs)
      .catch(() => null);
    set({ jobs: keptJobs(value), loaded: true });
  })();
  return reading;
}

function write(jobs: ImportJob[]): void {
  set({ jobs });
  progressStore()
    .putSetting(SETTINGS.importJobs, jobs)
    .catch(() => {
      notify('The jobs could not be saved on this device.', 'error');
    });
}

/** Saves an import as a job, and says where it is. Returns the job, or null when it cannot be kept. */
export async function saveJob(what: JobWhat): Promise<ImportJob | null> {
  await loadJobs();
  const items = what.kind === 'pages' ? what.pages.length : what.games.length;
  if (items === 0) return null;
  if (items > MAX_JOB_ITEMS) {
    notify(`A job holds at most ${MAX_JOB_ITEMS.toLocaleString('en')} pages or games.`, 'error');
    return null;
  }
  if (get().jobs.length >= MAX_JOBS) {
    notify(`You have ${MAX_JOBS} jobs, the most there can be. Remove one first.`, 'error');
    return null;
  }
  const now = new Date().toISOString();
  const job: ImportJob = {
    id: `job-${randomId().slice(0, 12)}`,
    name: jobName(what),
    createdAt: now,
    updatedAt: now,
    what,
  };
  write([...get().jobs, job]);
  notify(`Saved as a job: ${job.name}. Start it from Downloads whenever you like.`, 'info', {
    action: {
      label: 'Open Downloads',
      run: () => {
        setDownloadsOpen(true);
      },
    },
  });
  return job;
}

/** The site of pages, for the person: their importer's title, when they have one. */
async function siteOf(pages: readonly JobPage[]): Promise<string> {
  const ids = new Set(pages.map((page) => page.importerId));
  if (ids.size !== 1) return 'several sites';
  const importer = (await loadImporters()).find((one) => ids.has(one.id));
  return importer?.title ?? 'its site';
}

/** "Save as a job" beside Add: the map pages pasted in the address box. */
export async function saveAddressesAsJob(text: string): Promise<ImportJob | null> {
  const found = await pagesOfAddresses(text);
  if ('problem' in found) {
    notify(found.problem, 'error');
    return null;
  }
  return saveJob({ kind: 'pages', site: await siteOf(found.pages), pages: found.pages });
}

/** "Save as a job" beside Add in a list of pages: the pages ticked. */
export async function saveChoiceAsJob(): Promise<ImportJob | null> {
  const pages = pagesOfChoice();
  if (pages.length === 0) return null;
  return saveJob({ kind: 'pages', site: await siteOf(pages), pages });
}

/** "Save as a job" in the plan of games to add one at a time: the games left in it. */
export function saveGamesAsJob(): Promise<ImportJob | null> {
  const session = useGameSession.getState().session;
  if (!session) return Promise.resolve(null);
  return saveJob({
    kind: 'games',
    importerId: session.importerId,
    importerTitle: session.importerTitle,
    site: session.site,
    catalogue: session.catalogue,
    system: session.system.trim(),
    games: gamesLeft(session),
  });
}

/** Gives a job another name. */
export function renameJob(id: string, name: string): void {
  const tidy = name.trim().slice(0, 100);
  if (!tidy) return;
  write(
    get().jobs.map((job) =>
      job.id === id ? { ...job, name: tidy, updatedAt: new Date().toISOString() } : job,
    ),
  );
}

/** Changes what a job reads. */
export function changeJob(id: string, what: JobWhat): void {
  if ((what.kind === 'pages' ? what.pages.length : what.games.length) === 0) return;
  write(
    get().jobs.map((job) =>
      job.id === id ? { ...job, what, updatedAt: new Date().toISOString() } : job,
    ),
  );
}

/** Removes a job; one waiting its turn leaves the queue. Nothing it added is removed. */
export function removeJob(id: string): void {
  set({ queue: get().queue.filter((queued) => queued !== id) });
  write(get().jobs.filter((job) => job.id !== id));
}

/** Takes a job waiting its turn out of the queue. */
export function unqueueJob(id: string): void {
  set({ queue: get().queue.filter((queued) => queued !== id) });
}

function noteRun(id: string, text: string): void {
  write(
    get().jobs.map((job) =>
      job.id === id ? { ...job, last: { at: new Date().toISOString(), text } } : job,
    ),
  );
}

// ---------------------------------------------------------------------------
// Running

/**
 * Why a job cannot run by itself, or null when it can: the first page or
 * game of it whose site needs the person, as the rules are now.
 */
export async function whyJobNeedsPerson(what: JobWhat): Promise<string | null> {
  const importers = await loadImporters();
  if (what.kind === 'pages') {
    const seen = new Set<string>();
    for (const page of what.pages) {
      const importer = importers.find((one) => one.id === page.importerId);
      if (!importer) return 'The importer that reads its pages is not in this app now.';
      const origin = `${page.importerId} ${new URL(page.url).origin}`;
      if (seen.has(origin)) continue;
      seen.add(origin);
      const why = await needsPerson(importer, page.url);
      if (why) return why;
    }
    return null;
  }
  const importer = importers.find((one) => one.id === what.importerId);
  if (!importer) return 'The importer of its list of games is not in this app now.';
  const game = what.games.find((one) => !one.direct) ?? what.games[0];
  return game ? needsPerson(importer, game.address, game.direct ? 'map' : 'game') : null;
}

/** When the last page of a job was read, and the pause its site asks for after it. */
let lastEnd = 0;
let lastPauseMs = RUN_PAUSE_MS;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/**
 * Starts a job, or puts it in the queue when another job runs: they run one
 * after another. Says why when it cannot start.
 */
export async function startJob(id: string): Promise<void> {
  await loadJobs();
  const job = get().jobs.find((one) => one.id === id);
  if (!job || get().queue.includes(id) || get().running === id) return;
  set({ queue: [...get().queue, id] });
  if (get().running === null) await runQueue();
}

async function runQueue(): Promise<void> {
  while (get().queue.length > 0 && get().running === null) {
    const [id, ...rest] = get().queue;
    set({ queue: rest });
    const job = get().jobs.find((one) => one.id === id);
    if (!job) continue;
    if (sessionGoing(useImport.getState().phase) || useGameSession.getState().going) {
      noteRun(job.id, 'Not started: pages were being read already. Start it when they are done.');
      notify(`${job.name} did not start: pages are being read now.`, 'error');
      set({ queue: [] });
      return;
    }
    const why = await whyJobNeedsPerson(job.what);
    if (why) {
      noteRun(job.id, `Cannot run by itself. ${why}`);
      notify(`${job.name} cannot run by itself. ${why}`, 'error');
      continue;
    }
    set({ running: job.id });
    const stopped = await (async () => {
      try {
        // The pause after the last job, as its site's rules file asks, holds before this one.
        await wait(lastEnd + lastPauseMs - Date.now());
        return await runOne(job);
      } finally {
        lastEnd = Date.now();
        set({ running: null });
      }
    })();
    if (stopped && get().queue.length > 0) {
      const left = get().queue.length;
      set({ queue: [] });
      notify(
        `The jobs stopped. ${plural(left, 'job', 'jobs')} waiting ${left === 1 ? 'its' : 'their'} turn did not start.`,
        'error',
      );
    }
  }
}

/** Runs one job; whether it stopped early (a refusal, a window closed, Stop). */
async function runOne(job: ImportJob): Promise<boolean> {
  const importers = await loadImporters();
  const what = job.what;
  if (what.kind === 'pages') {
    const importer = importers.find((one) => one.id === what.pages[0]?.importerId);
    lastPauseMs = Math.max(
      RUN_PAUSE_MS,
      importer && what.pages[0] ? sitePauseMs(importer, what.pages[0].url) : 0,
    );
    const final = await runJobPages(what.pages);
    if (!final) {
      noteRun(job.id, 'Not run: this app cannot read pages here.');
      return true;
    }
    const text = `${runSummary(final)}.${final.stopReason ? ` ${stopReasonText(final.stopReason)}` : ''}`;
    noteRun(job.id, text);
    return final.stopReason !== null;
  }
  const importer = importers.find((one) => one.id === what.importerId);
  lastPauseMs = Math.max(
    RUN_PAUSE_MS,
    importer && what.games[0] ? sitePauseMs(importer, what.games[0].address) : 0,
  );
  const session = await runGamesOf({
    importerId: what.importerId,
    importerTitle: what.importerTitle,
    site: what.site,
    catalogue: what.catalogue,
    system: what.system,
    games: what.games,
  });
  if (!session) {
    noteRun(job.id, 'Not run: games were being added already.');
    return true;
  }
  const added = Object.values(session.results).filter(
    (result) => result.kind === 'added' && result.partial !== true,
  ).length;
  const left = gamesLeft(session).length;
  noteRun(
    job.id,
    `${plural(added, 'game', 'games')} added${left > 0 ? `, ${plural(left, 'game', 'games')} left` : ''}.${session.stopped ? ` ${session.stopped}` : ''}`,
  );
  return session.stopped !== null;
}
