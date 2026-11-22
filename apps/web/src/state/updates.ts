import { create } from 'zustand';
import { desktop, type DesktopInfo, type UpdateCheck, type UpdateWay } from '../desktop';
import { saveEverything } from './saveAll';
import { progressStore, SETTINGS } from './services';
import { useAtlas } from './store';

/**
 * Updating Atlas itself, in the desktop app where the shell says it does
 * (`DesktopInfo.updates`, see the shell's `updates` module): on Windows,
 * and on Linux from an AppImage, in the app without downloads. Never in a
 * browser or the Android app, where the shell gives no `updates`.
 *
 * - **At the start**, a few seconds in, Atlas looks quietly, while the
 *   setting "Check for updates when Atlas starts" is on (it is unless the
 *   person turned it off) and the shell says this start may look (not when
 *   Steam started it with a game). It says nothing when there is no update
 *   or the computer is offline.
 * - **In Settings**, "Check for updates" looks at any time and says what it
 *   found.
 * - **An update found** opens a notice that covers nothing: the new version
 *   and what is new, with "Install now", "Later" (until the next start) and
 *   "Skip this version". "Install now" downloads it with its progress,
 *   saves what the person changed (as "Exit Atlas" does), and installs it:
 *   Atlas ends and starts again in the new version.
 */

/** How long after the start Atlas looks, so that the start itself is not slowed. */
export const START_DELAY_MS = 5_000;
/** How often the progress of a download is read. */
const PROGRESS_MS = 400;

/** The update found, as the notice shows it. */
export type FoundUpdate = Extract<UpdateCheck, { state: 'available' }>;

export interface UpdatesView {
  /** "Check for updates when Atlas starts"; null until read. */
  atStart: boolean | null;
  /** The version whose notice the person chose to skip. */
  skipped: string | null;
  /** A look is under way. */
  checking: boolean;
  /** What the last look found; null before any. */
  found: UpdateCheck | null;
  /** Why the last look asked for in Settings did not work. */
  problem: string | null;
  /** The notice of the update found is shown. */
  notice: boolean;
  /** Where "Install now" is. */
  phase: 'idle' | 'downloading' | 'installing' | 'failed';
  /** Bytes downloaded, and of how many, while downloading. */
  received: number;
  total: number | null;
  /** Why installing did not work. */
  installProblem: string | null;
}

const INITIAL: UpdatesView = {
  atStart: null,
  skipped: null,
  checking: false,
  found: null,
  problem: null,
  notice: false,
  phase: 'idle',
  received: 0,
  total: null,
  installProblem: null,
};

export const useUpdates = create<UpdatesView>()(() => ({ ...INITIAL }));

const set = useUpdates.setState;
const get = useUpdates.getState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How this copy gets its updates, or null where there is nothing to say (a browser, Android). */
export function updateWayOf(state: { app: Pick<DesktopInfo, 'updates'> | null }): UpdateWay | null {
  return state.app?.updates ?? null;
}

/** Whether Atlas updates itself here: "Check for updates" is offered. */
export function updatesItself(state: { app: Pick<DesktopInfo, 'updates'> | null }): boolean {
  return updateWayOf(state)?.way === 'itself';
}

/** "Check for updates when Atlas starts", from what is kept: on unless turned off. */
export function checkAtStartSetting(value: unknown): boolean {
  return value !== false;
}

/**
 * Whether the start may look, by what the shell says of this start and
 * the person's setting.
 */
export function looksAtStart(way: UpdateWay | null, setting: boolean): boolean {
  return way?.way === 'itself' && way.atStart && setting;
}

/** Reads the person's settings of updates. */
export async function loadUpdateSettings(): Promise<void> {
  const store = progressStore();
  const [atStart, skipped] = await Promise.all([
    store.getSetting(SETTINGS.updateCheckAtStart),
    store.getSetting(SETTINGS.updateSkipped),
  ]);
  set({
    atStart: checkAtStartSetting(atStart),
    skipped: typeof skipped === 'string' ? skipped : null,
  });
}

/** Switches "Check for updates when Atlas starts", and keeps it. */
export function setCheckAtStart(on: boolean): void {
  set({ atStart: on });
  void progressStore()
    .putSetting(SETTINGS.updateCheckAtStart, on)
    .catch(() => undefined);
}

/**
 * Looks for an update. `quiet` (the look at the start): nothing is said
 * unless an update is found that the person did not skip. Otherwise (from
 * Settings) the answer is kept for Settings to show, and an update found
 * opens the notice, a skipped one too.
 */
export async function checkForUpdates({ quiet }: { quiet: boolean }): Promise<void> {
  const bridge = desktop;
  if (!bridge || !updatesItself(useAtlas.getState()) || get().checking) return;
  set({ checking: true, ...(quiet ? {} : { problem: null }) });
  try {
    const found = await bridge.updates.check();
    const offered = found.state === 'available' && (!quiet || found.version !== get().skipped);
    // A notice open for another version, or being installed, stays as it is.
    const busy = get().phase === 'downloading' || get().phase === 'installing';
    set({
      found,
      checking: false,
      ...(offered && !busy ? { notice: true, phase: 'idle', installProblem: null } : {}),
    });
  } catch (error) {
    set({ checking: false, ...(quiet ? {} : { problem: errorText(error) }) });
  }
}

let started = false;

/**
 * The look at the start: once a run, a few seconds after the shell said
 * how this copy updates, if it may look and the setting is on. Returns a
 * function that stops waiting.
 */
export function startUpdateCheck(): () => void {
  if (started || !desktop) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Once the shell said what it is (`app`), with or without `updates`.
  const begin = (state: Parameters<typeof updateWayOf>[0]) => {
    if (started || state.app === null) return;
    started = true;
    stop();
    const way = updateWayOf(state);
    if (way?.way !== 'itself' || !way.atStart) return;
    timer = setTimeout(() => {
      void (async () => {
        try {
          await loadUpdateSettings();
        } catch {
          return;
        }
        if (looksAtStart(way, get().atStart === true)) await checkForUpdates({ quiet: true });
      })();
    }, START_DELAY_MS);
  };
  const stop = useAtlas.subscribe(begin);
  begin(useAtlas.getState());
  return () => {
    stop();
    clearTimeout(timer);
  };
}

/** Opens the notice of the update found last (Settings, "Show what is new"). */
export function showUpdateNotice(): void {
  if (get().found?.state === 'available') set({ notice: true });
}

/** "Later": the notice goes until the next start. */
export function updateLater(): void {
  set({
    notice: false,
    installProblem: null,
    phase: get().phase === 'failed' ? 'idle' : get().phase,
  });
}

/** "Skip this version": no notice of it at a start again; Settings still finds it. */
export function skipUpdate(): void {
  const found = get().found;
  if (found?.state !== 'available') return;
  set({ skipped: found.version, notice: false });
  void progressStore()
    .putSetting(SETTINGS.updateSkipped, found.version)
    .catch(() => undefined);
}

/**
 * "Install now": downloads the update with its progress, saves what the
 * person changed, and installs it; Atlas then ends and starts again. Says
 * why not in the notice when it does not work.
 */
export async function installUpdate(): Promise<void> {
  const bridge = desktop;
  const phase = get().phase;
  if (!bridge || phase === 'downloading' || phase === 'installing') return;
  set({ phase: 'downloading', received: 0, total: null, installProblem: null });
  const timer = setInterval(() => {
    void bridge.updates.progress().then(
      (progress) => {
        if (progress.state === 'downloading' && get().phase === 'downloading') {
          set({ received: progress.received, total: progress.total });
        }
      },
      () => undefined,
    );
  }, PROGRESS_MS);
  try {
    await bridge.updates.download();
  } catch (error) {
    set({ phase: 'failed', installProblem: errorText(error) });
    return;
  } finally {
    clearInterval(timer);
  }
  set({ phase: 'installing' });
  try {
    await saveEverything();
    await bridge.updates.install();
  } catch (error) {
    set({ phase: 'failed', installProblem: errorText(error) });
  }
}

/** The parts of a release's notes, for the notice: paragraphs and list items. */
export interface NotesPart {
  kind: 'text' | 'item';
  text: string;
}

/**
 * A release's "what is new", as plain parts: headings and paragraphs as
 * text, `-` and `*` lines as list items, without the Markdown marks of
 * bold and code.
 */
export function notesParts(notes: string): NotesPart[] {
  const parts: NotesPart[] = [];
  for (const raw of notes.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-*]\s+(.*)$/.exec(line);
    const text = (item ? item[1]! : line.replace(/^#+\s*/, ''))
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .trim();
    if (text) parts.push({ kind: item ? 'item' : 'text', text });
  }
  return parts;
}

/** Megabytes, for the progress of a download. */
function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

/** The progress of a download, in words. */
export function downloadText(received: number, total: number | null): string {
  if (total && total > 0) {
    const percent = Math.min(100, Math.floor((received / total) * 100));
    return `Downloading… ${percent}% (${megabytes(received)} of ${megabytes(total)} MB)`;
  }
  return received > 0 ? `Downloading… ${megabytes(received)} MB` : 'Downloading…';
}

/** What "Install now" does, by system. */
export function installText(platform: string | undefined): string {
  return platform === 'windows'
    ? 'Install now downloads the update, saves your changes and closes Atlas. The installer then updates Atlas and starts it again.'
    : 'Install now downloads the update, saves your changes, replaces this version with the new one and starts Atlas again.';
}

/** Where the updates of a copy that does not update itself come from, in a sentence. */
export function elsewhereText(from: Extract<UpdateWay, { way: 'elsewhere' }>['from']): string {
  switch (from) {
    case 'otherApp':
      return 'Updates for this copy of Atlas come from where you got it, not from the releases of the Atlas viewer. It does not update itself.';
    case 'system':
      return 'Updates for this copy of Atlas come from your system’s software updates, since it was installed as a package. Atlas.AppImage from the Atlas releases page updates itself.';
    case 'releases':
      return 'Updates for this copy of Atlas come from the Atlas releases page. It does not update itself.';
  }
}

/** Puts everything back as at the start; for tests. */
export function resetUpdatesForTests(): void {
  started = false;
  set({ ...INITIAL });
}
