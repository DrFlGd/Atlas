/**
 * The commands of the Map Maker's desktop shell (`src-tauri`). Like the Atlas viewer, the page has no dependency on
 * Tauri: inside the shell, Tauri injects an `invoke` function. In a plain browser `shell` is null.
 */
import type { AnyReport } from './report';

export interface AppInfo {
  version: string;
  helperFound: boolean;
  lastFolder: string | null;
  /** Where Steam usually installs Dark Souls Remastered, when that folder exists on this computer. */
  typicalFolder: string | null;
  /** Where Make map installs the pack: the Atlas viewer's maps folder. */
  mapsFolder: string | null;
}

export type CheckState = 'idle' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled';

export interface CheckLine {
  kind: 'warning' | 'area' | 'game' | 'info' | 'pack';
  text: string;
}

export interface MadePack {
  folder: string;
  id: string;
  installed: boolean;
  counts?: Record<string, number>;
}

export interface CheckStatus {
  state: CheckState;
  /** A check, or a make (Make map). */
  kind: 'check' | 'make';
  runId: number;
  folder: string | null;
  fraction: number;
  message: string;
  lines: CheckLine[];
  report: AnyReport | null;
  /** The map pack a make installed. */
  pack: MadePack | null;
  error: string | null;
  /** The last lines the helper wrote to standard error, for a failed check. */
  helperOutput: string[];
  elapsedSeconds: number;
}

export interface SavedReport {
  path: string;
  name: string;
}

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface Shell {
  appInfo(): Promise<AppInfo>;
  chooseFolder(): Promise<string | null>;
  checkStart(folder: string): Promise<CheckStatus>;
  checkStatus(): Promise<CheckStatus>;
  checkCancel(): Promise<void>;
  makeStart(folder: string): Promise<CheckStatus>;
  revealPack(): Promise<void>;
  previewImage(file: string): Promise<string>;
  saveReport(suggestedName: string): Promise<SavedReport | null>;
  revealSavedReport(): Promise<void>;
}

export function createShell(invoke: Invoke): Shell {
  return {
    appInfo: () => invoke('app_info') as Promise<AppInfo>,
    chooseFolder: () => invoke('choose_folder') as Promise<string | null>,
    checkStart: (folder) => invoke('check_start', { folder }) as Promise<CheckStatus>,
    checkStatus: () => invoke('check_status') as Promise<CheckStatus>,
    checkCancel: async () => {
      await invoke('check_cancel');
    },
    makeStart: (folder) => invoke('make_start', { folder }) as Promise<CheckStatus>,
    revealPack: async () => {
      await invoke('reveal_pack');
    },
    previewImage: (file) => invoke('preview_image', { file }) as Promise<string>,
    saveReport: (suggestedName) =>
      invoke('save_report', { suggestedName }) as Promise<SavedReport | null>,
    revealSavedReport: async () => {
      await invoke('reveal_saved_report');
    },
  };
}

function findShell(): Shell | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
    .__TAURI_INTERNALS__;
  if (typeof internals?.invoke !== 'function') return null;
  return createShell(internals.invoke.bind(internals) as Invoke);
}

export const shell = findShell();

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
