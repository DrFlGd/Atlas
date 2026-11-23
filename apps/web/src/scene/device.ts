import type { DeviceSignals } from '@atlas/core';
import { useAtlas } from '../state/store';

/** What the 3D view can tell of this device, for its budget (see `sceneBudget` in `@atlas/core`). */
export function deviceSignals(): DeviceSignals {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    platform: useAtlas.getState().app?.platform ?? null,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    deviceMemory: typeof memory === 'number' ? memory : undefined,
  };
}
