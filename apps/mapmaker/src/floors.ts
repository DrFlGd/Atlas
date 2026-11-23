/**
 * The Adjust floors panel's own logic, kept apart from the page so it can be tested: the floors between the cuts,
 * adding, moving and removing cuts, deleting a floor, and the entry written to the player's floor cuts file
 * (`floor-overrides.json`, see src-tauri/src/overrides.rs).
 *
 * A cut is a height where one floor ends and the next begins; `names` has one name per floor, lowest first, and an
 * empty name means "as the Map Maker names it".
 */
import type { FloorEntry } from './shell';
import type { HeightProfile, MadeArea } from './report';

/** The least height between two cuts, in metres. */
export const MIN_GAP = 0.5;

export interface FloorsDraft {
  cuts: number[];
  names: string[];
}

export interface FloorBand {
  index: number;
  from: number;
  to: number;
}

/** A height in metres, to the centimetre. */
export function roundHeight(height: number): number {
  return Math.round(height * 100) / 100;
}

function padNames(names: readonly string[], floors: number): string[] {
  return Array.from({ length: floors }, (_, index) => names[index] ?? '');
}

/** The floors between the cuts, lowest first, from `low` to `high`. */
export function floorBands(cuts: readonly number[], low: number, high: number): FloorBand[] {
  const bounds = [low, ...cuts, high];
  return cuts.length === 0
    ? [{ index: 0, from: low, to: high }]
    : bounds.slice(0, -1).map((from, index) => ({ index, from, to: bounds[index + 1]! }));
}

/** Square metres of walkable floor between two heights, from the height profile (part bars count in part). */
export function walkableBetween(profile: HeightProfile, from: number, to: number): number {
  let total = 0;
  profile.areas.forEach((area, index) => {
    const barLow = profile.low + index * profile.step;
    const barHigh = barLow + profile.step;
    const overlap = Math.min(to, barHigh) - Math.max(from, barLow);
    if (overlap > 0) total += (area * overlap) / profile.step;
  });
  return Math.round(total);
}

/** Where "Add a floor" suggests a cut: the middle of the floor with the most walkable floor. */
export function suggestedCut(profile: HeightProfile, cuts: readonly number[]): number {
  const bands = floorBands(cuts, profile.low, profile.high);
  let best = bands[0]!;
  let most = -1;
  for (const band of bands) {
    const area = walkableBetween(profile, band.from, band.to);
    if (area > most) {
      most = area;
      best = band;
    }
  }
  return Math.round(((best.from + best.to) / 2) * 10) / 10;
}

/** Whether a cut at `height` can be added: inside the area's heights and not too close to another cut. */
export function canAddCut(draft: FloorsDraft, height: number, low: number, high: number): boolean {
  return (
    Number.isFinite(height) &&
    height > low &&
    height < high &&
    draft.cuts.every((cut) => Math.abs(cut - height) >= MIN_GAP)
  );
}

/** Adds a cut: the floor it splits keeps its name below the cut; the new floor above it has none yet. */
export function addCut(draft: FloorsDraft, height: number): FloorsDraft {
  const cut = roundHeight(height);
  const split = draft.cuts.filter((c) => c < cut).length;
  const names = padNames(draft.names, draft.cuts.length + 1);
  names.splice(split + 1, 0, '');
  return { cuts: [...draft.cuts, cut].sort((a, b) => a - b), names };
}

/** Removes cut `index`: the floors on each side become one, named as the lower one (or else the upper). */
export function removeCut(draft: FloorsDraft, index: number): FloorsDraft {
  if (index < 0 || index >= draft.cuts.length) return draft;
  const names = padNames(draft.names, draft.cuts.length + 1);
  const merged = names[index] !== '' ? names[index]! : names[index + 1]!;
  names.splice(index, 2, merged);
  return { cuts: draft.cuts.filter((_, i) => i !== index), names };
}

/** Deletes floor `index`: it joins the floor below it (the lowest joins the one above), which keeps its name. */
export function deleteFloor(draft: FloorsDraft, index: number): FloorsDraft {
  if (draft.cuts.length === 0 || index < 0 || index > draft.cuts.length) return draft;
  const cut = index === 0 ? 0 : index - 1;
  const names = padNames(draft.names, draft.cuts.length + 1);
  names.splice(index, 1);
  return { cuts: draft.cuts.filter((_, i) => i !== cut), names };
}

/** Moves cut `index` to `height`, kept between its neighbours (and inside the area's heights). */
export function moveCut(
  draft: FloorsDraft,
  index: number,
  height: number,
  low: number,
  high: number,
): FloorsDraft {
  if (!Number.isFinite(height) || index < 0 || index >= draft.cuts.length) return draft;
  const below = index > 0 ? draft.cuts[index - 1]! + MIN_GAP : low + 0.1;
  const above = index < draft.cuts.length - 1 ? draft.cuts[index + 1]! - MIN_GAP : high - 0.1;
  const cut = roundHeight(Math.min(Math.max(height, below), above));
  if (cut === draft.cuts[index]) return draft;
  return { ...draft, cuts: draft.cuts.map((c, i) => (i === index ? cut : c)) };
}

export function renameFloor(draft: FloorsDraft, index: number, name: string): FloorsDraft {
  const names = padNames(draft.names, draft.cuts.length + 1);
  names[index] = name.slice(0, 80);
  return { ...draft, names };
}

/** The panel's starting point for an area: its cuts as made, and the names given by hand (by the player or the
 * Map Maker's settings) where there are some. */
export function startDraft(area: MadeArea): FloorsDraft {
  const cuts = area.floorPlan?.cuts ?? [];
  const given = area.floorPlan?.overrides?.names ?? [];
  return { cuts: [...cuts], names: padNames(given, cuts.length + 1) };
}

/** Where "Back to automatic" goes: the area's floors without the player's own cuts. */
export function shippedDraft(area: MadeArea, shippedCuts?: readonly number[]): FloorsDraft {
  const shipped = area.floorPlan?.shipped;
  const cuts = [...(shippedCuts ?? shipped?.cuts ?? area.floorPlan?.cuts ?? [])];
  return { cuts, names: padNames(shipped?.names ?? [], cuts.length + 1) };
}

/** The entry written to the player's floor cuts file: every cut, and the names when any is given. */
export function entryOf(draft: FloorsDraft): FloorEntry {
  const names = padNames(draft.names, draft.cuts.length + 1).map((name) => name.trim());
  return {
    cuts: draft.cuts.map(roundHeight),
    ...(names.some((name) => name !== '') ? { names } : {}),
  };
}

export function sameDraft(a: FloorsDraft, b: FloorsDraft): boolean {
  return JSON.stringify(entryOf(a)) === JSON.stringify(entryOf(b));
}

/** The colour of each floor in the panel, lowest first, as the side views draw them (floorviews.py). */
export const FLOOR_COLOURS = ['#4fc1b2', '#f0aa50', '#a08cf5', '#f06e82', '#6eb4f5', '#aad25a'];

export function floorColour(index: number): string {
  return FLOOR_COLOURS[index % FLOOR_COLOURS.length]!;
}

/** Tick heights for the height axis: about six, on a round step. */
export function heightTicks(low: number, high: number): number[] {
  const range = Math.max(high - low, 1);
  const steps = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
  const step = steps.find((s) => range / s <= 8) ?? 1000;
  const ticks: number[] = [];
  for (let tick = Math.ceil(low / step) * step; tick <= high + 1e-9; tick += step) {
    ticks.push(roundHeight(tick) + 0); // never -0
  }
  return ticks;
}
