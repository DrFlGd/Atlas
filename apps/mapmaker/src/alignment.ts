/** "Compare with a picture…": how a picture lies over an area's map (see Compare.tsx), kept in range. */
import type { CompareAlignment } from './shell';

/** The key an area's picture is remembered by in the Map Maker's settings. */
export function compareKey(game: string, area: string): string {
  return `${game}:${area.slice(0, 6).toLowerCase()}`;
}

/** A new picture: in the middle of the map, as wide as it, half see-through, over the map. */
export function startAlignment(picture: string): CompareAlignment {
  return { picture, x: 0.5, y: 0.5, scale: 1, turn: 0, opacity: 0.5, view: 'overlay' };
}

function within(value: number, low: number, high: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
}

/** The alignment with every number in range (as the shell keeps them: settings.rs, clean_alignment). */
export function clampAlignment(alignment: CompareAlignment): CompareAlignment {
  const turn = within(alignment.turn, -360, 360, 0);
  return {
    picture: alignment.picture,
    x: within(alignment.x, -10, 10, 0.5),
    y: within(alignment.y, -10, 10, 0.5),
    scale: within(alignment.scale, 0.01, 100, 1),
    turn: Math.round((turn > 180 ? turn - 360 : turn < -180 ? turn + 360 : turn) * 10) / 10,
    opacity: within(alignment.opacity, 0, 1, 0.5),
    view: alignment.view === 'side' ? 'side' : 'overlay',
  };
}
