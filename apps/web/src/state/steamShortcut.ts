import { create } from 'zustand';
import { desktop, type SteamStatus, type SteamUser } from '../desktop';

/**
 * "Atlas in Steam", in the Settings of the desktop app without downloads
 * on Windows and Linux (see the shell's `steam` module): Atlas adds itself
 * to Steam as a non-Steam game with its artwork, or takes itself out.
 * Steam's files are written only while Steam is closed, so while it runs
 * the change waits, and "Restart Steam and add it" closes Steam, writes it
 * and starts Steam again. This module asks the shell and keeps what it
 * answered for the Settings group.
 */

export interface SteamView {
  status: SteamStatus | null;
  /** Why the status could not be read, or the last change was refused. */
  problem: string | null;
  /** A change is under way. */
  working: boolean;
  /** Steam is being restarted: the status is read again until it is done. */
  restarting: boolean;
}

export const useSteam = create<SteamView>()(() => ({
  status: null,
  problem: null,
  working: false,
  restarting: false,
}));

const set = useSteam.setState;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** How often the status is read again while Steam restarts, and for how long. */
export const RESTART_POLL_MS = 3000;
export const RESTART_POLL_FOR_MS = 120_000;

/** Reads the status. */
export async function loadSteam(): Promise<void> {
  const bridge = desktop;
  if (!bridge) return;
  try {
    set({ status: await bridge.steam.status(), problem: null });
  } catch (error) {
    set({ problem: errorText(error) });
  }
}

/** "Add Atlas to Steam" (for `user` when one is chosen) or "Take Atlas out of Steam". */
export async function setSteam(on: boolean, user?: string): Promise<void> {
  const bridge = desktop;
  if (!bridge) return;
  set({ working: true });
  try {
    set({ status: await bridge.steam.set(on, user), problem: null });
  } catch (error) {
    set({ problem: errorText(error) });
  } finally {
    set({ working: false });
  }
}

/**
 * "Restart Steam and add it": the shell starts a helper that closes Steam,
 * writes what waits and starts Steam again. The status is read again every
 * few seconds until nothing waits, for two minutes at most.
 */
export async function restartSteam(): Promise<void> {
  const bridge = desktop;
  if (!bridge) return;
  set({ restarting: true, problem: null });
  try {
    await bridge.steam.restart();
  } catch (error) {
    set({ restarting: false, problem: errorText(error) });
    return;
  }
  const until = Date.now() + RESTART_POLL_FOR_MS;
  const look = async () => {
    await loadSteam();
    const status = useSteam.getState().status;
    if (status && !status.waiting) {
      set({ restarting: false });
    } else if (Date.now() >= until) {
      set({
        restarting: false,
        problem:
          'Steam did not close in time, so nothing was written. Close Steam yourself, then come back here.',
      });
    } else {
      setTimeout(() => void look(), RESTART_POLL_MS);
    }
  };
  setTimeout(() => void look(), RESTART_POLL_MS);
}

/** A Steam user as the group names them. */
export function userName(user: SteamUser): string {
  return user.name.trim() || user.id;
}

/** What was found: Steam and the user Atlas writes for, in one sentence. */
export function foundText(status: SteamStatus): string {
  if (status.folder === null) return "Steam isn't on this computer.";
  const user = status.users.find((u) => u.id === status.user);
  if (!user) return `Steam is in ${status.folder}, but nobody has signed in to it yet.`;
  return `Steam is in ${status.folder}. Atlas uses the Steam user ${userName(user)}.`;
}

/** Where Atlas is now, in one sentence, or null when there is nothing to say. */
export function stateText(status: SteamStatus): string | null {
  if (status.wanted && status.inSteam) {
    if (!status.byHand) return 'Atlas is in Steam with its artwork.';
    return status.kept.length > 0
      ? 'Atlas was in Steam already, so Atlas added its artwork to it and kept the pictures you set yourself.'
      : 'Atlas was in Steam already, so Atlas added its artwork to it.';
  }
  if (status.waiting) return 'Waiting for Steam to close.';
  return null;
}

/** The button that restarts Steam to write what waits. */
export function restartLabel(status: SteamStatus): string {
  return status.wanted ? 'Restart Steam and add it' : 'Restart Steam and take it out';
}

/** What closing Steam does, when Steam has to be closed first. */
export function restartText(status: SteamStatus): string {
  const press = `Steam has to be closed for this. Press ${restartLabel(status)}`;
  const what = status.wanted ? 'adds itself' : 'takes itself out';
  return status.gameMode
    ? `${press}, and Steam closes, Atlas ${what}, and Steam comes back by itself. Atlas closes with Steam.`
    : `${press}, and Steam closes, Atlas ${what}, and Steam starts again.`;
}
