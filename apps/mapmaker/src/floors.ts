/**
 * The Adjust floors panel's own logic, kept apart from the page so it can be tested: the floors between the cuts,
 * adding, moving and removing cuts, deleting a floor, and the entry written to the player's floor cuts file
 * (`floor-overrides.json`, see src-tauri/src/overrides.rs).
 *
 * A cut is a height where one floor ends and the next begins; `names` has one name per floor, lowest first, and an
 * empty name means "as the Map Maker names it".
 */
import type { FloorEntry } from './shell';
import type {
  FloorMethod,
  HeightProfile,
  MadeArea,
  PassageChoice,
  PassagePlace,
  PassageShow,
} from './report';

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

/** The floor a height is on by the cuts alone (0 below the lowest cut). */
export function bandOf(cuts: readonly number[], height: number): number {
  return cuts.filter((cut) => cut < height).length;
}

/** How far above an item the 3D view is cut when it goes to it: about head height, in metres. */
export const HEAD_ROOM = 3;

/**
 * The height the 3D view is cut at when it goes to an item at `height` on a floor whose top is `top` (null: none):
 * head room above it, never above the floor's top (just under it, 0.2 m, where the head room would reach past),
 * and above the item's head all the same when it stands at the top or over it. As the viewer's 3D view does
 * (apps/web/src/scene/goTo.ts).
 */
export function headCut(height: number, top: number | null): number {
  const head = height + HEAD_ROOM;
  if (top === null || head <= top) return head;
  if (height < top - 0.2) return top - 0.2;
  return height >= top ? head : top;
}

/** How near a marker may lie to a cut before the panel points it out, in metres: things lie at walking height,
 * so a cut through a cluster of them is likely in the wrong place. */
export const NEAR_CUT = 1;

/** The cut within `NEAR_CUT` of a height, if any. */
export function cutNear(cuts: readonly number[], height: number): number | null {
  let best: number | null = null;
  for (const cut of cuts) {
    if (
      Math.abs(cut - height) <= NEAR_CUT &&
      (best === null || Math.abs(cut - height) < Math.abs(best - height))
    )
      best = cut;
  }
  return best;
}

/** The words for each type of marker, one of them. */
export const MARKER_TYPES: Record<string, string> = {
  bonfire: 'Bonfire',
  boss: 'Boss',
  npc: 'NPC',
  drop: 'Guaranteed drop',
  weapon: 'Weapon',
  armour: 'Armour',
  ring: 'Ring',
  spell: 'Spell',
  key: 'Key item',
  upgrade: 'Upgrade material',
  other: 'Other item',
  consumable: 'Consumable',
  souls: 'Souls',
};

export function markerTypeText(type: string): string {
  return MARKER_TYPES[type] ?? 'Other item';
}

/** What the panel says about a marker for some cuts: the floor it is put on, and what to look at. */
export interface MarkerCheck {
  /** The floor it is put on (by the surface under it, or by its height without one). */
  floor: number;
  /** A cut within `NEAR_CUT` of it, or null. */
  nearCut: number | null;
  /** Put on another floor than its height alone gives (it stands on a surface across a cut). */
  otherFloor: boolean;
  /** No walkable surface under it: it goes by its height. */
  noSurface: boolean;
}

export function checkMarker(
  cuts: readonly number[],
  height: number,
  placed: { floor: number; surface: number | null } | undefined,
): MarkerCheck {
  const byHeight = bandOf(cuts, height);
  const floor = placed?.floor ?? byHeight;
  return {
    floor,
    nearCut: cutNear(cuts, height),
    otherFloor: placed !== undefined && floor !== byHeight,
    noSurface: placed?.surface === null,
  };
}

/** Bytes from base64. */
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function rgbOf(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The colour of walls and slopes in the side views of automatic passages, whose floors are not apart in height. */
const NO_FLOOR_COLOUR = '#8a909a';

/**
 * The section's pixels (see floorviews.py: 0 nothing, 1 to 127 walls by how many stand there, 128 to 255 walkable
 * floor by how near) coloured for the cuts: each row in the colour of the floor its height is on, the selected
 * floor brightest. With `pixelFloors` (automatic passages: each pixel's floor, 255 for none), each walkable pixel
 * in the colour of its own floor, walls grey. RGBA, rows from the top height down.
 */
export function paintSection(
  pixels: Uint8Array,
  columns: number,
  rows: number,
  low: number,
  high: number,
  cuts: readonly number[],
  selected: number,
  pixelFloors?: Uint8Array | null,
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(columns * rows * 4);
  const background = [22, 26, 32];
  const byPixel = pixelFloors?.length === columns * rows ? pixelFloors : null;
  const grey = rgbOf(NO_FLOOR_COLOUR);
  const palette = FLOOR_COLOURS.map(rgbOf);
  for (let row = 0; row < rows; row++) {
    const height = high - ((row + 0.5) / rows) * (high - low);
    const rowBand = bandOf(cuts, height);
    for (let column = 0; column < columns; column++) {
      const value = pixels[row * columns + column] ?? 0;
      const at = (row * columns + column) * 4;
      const own = byPixel ? (byPixel[row * columns + column] ?? 255) : rowBand;
      const band = own === 255 ? -1 : own;
      const [r, g, b] = band < 0 ? grey : palette[band % palette.length]!;
      const dim = band === selected || (byPixel && band < 0) ? 1 : 0.62;
      let shade: [number, number, number];
      if (value >= 128) {
        const near = 0.55 + (0.45 * (value - 128)) / 127;
        shade = [
          r * near * dim + 40 * (1 - dim),
          g * near * dim + 40 * (1 - dim),
          b * near * dim + 40 * (1 - dim),
        ];
      } else if (value > 0) {
        // Walls: the floor's colour greyed, light where many stand one behind another.
        const t = 0.34 + (0.56 * value) / 127;
        const grey = (r + g + b) / 3;
        shade = [0, 1, 2].map((k) => {
          const base = [r, g, b][k]! * 0.45 + grey * 0.55;
          return background[k]! + (base - background[k]!) * t * (0.75 + 0.25 * dim);
        }) as [number, number, number];
      } else {
        shade = background as [number, number, number];
      }
      out[at] = shade[0];
      out[at + 1] = shade[1];
      out[at + 2] = shade[2];
      out[at + 3] = 255;
    }
  }
  return out;
}

/** Side-by-side slots for the overlapping places' brackets in a section: places seen at the same spot (across within
 * `span` metres, heights overlapping) go in the next slot to the right, so that each stays pressable. Returns each
 * place's slot, 0 first. */
export function placeSlots(
  places: readonly { across: number; low: number; high: number }[],
  span: number,
): number[] {
  const slots = new Array<number>(places.length).fill(0);
  const order = places.map((place, index) => ({ ...place, index }));
  order.sort((a, b) => a.across - b.across);
  const taken: ((typeof order)[number] & { slot: number })[] = [];
  for (const here of order) {
    let slot = 0;
    while (
      taken.some(
        (other) =>
          other.slot === slot &&
          Math.abs(other.across - here.across) < span &&
          other.low <= here.high &&
          here.low <= other.high,
      )
    )
      slot += 1;
    slots[here.index] = slot;
    taken.push({ ...here, slot });
  }
  return slots;
}

/** Where a pixel of a side view lies, as a fraction across and down: the floor drawn there (automatic passages), or
 * none. */
export function floorAtPixel(
  pixelFloors: Uint8Array | null,
  columns: number,
  rows: number,
  across: number,
  down: number,
): number | null {
  if (!pixelFloors) return null;
  const column = Math.min(columns - 1, Math.max(0, Math.floor(across * columns)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor(down * rows)));
  // The floor drawn nearest the point, within a few pixels (floors are lines three pixels thick).
  for (let reach = 0; reach <= 6; reach++) {
    for (const dy of reach === 0 ? [0] : [-reach, reach]) {
      const r = row + dy;
      if (r < 0 || r >= rows) continue;
      const value = pixelFloors[r * columns + column];
      if (value !== undefined && value !== 255) return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic passages: the player's Upper / Lower choices per overlapping place.

/** The storey a place shows on the main floor: the player's choice there, else upper. */
export function showOf(place: PassagePlace, choices: readonly PassageChoice[]): PassageShow {
  return choices.find((choice) => choiceIsFor(choice, place))?.show ?? 'upper';
}

/** Whether a choice is for this place: it is at the place's point (the helper finds the place again by it). */
function choiceIsFor(choice: PassageChoice, place: PassagePlace): boolean {
  return Math.abs(choice.x - place.x) < 0.01 && Math.abs(choice.z - place.z) < 0.01;
}

/** The choices with this place's set to `show` (upper, the default, is not written). */
export function setShow(
  choices: readonly PassageChoice[],
  place: PassagePlace,
  show: PassageShow,
): PassageChoice[] {
  // A choice the helper matched to this place before (by its cells or a near point) is replaced too.
  const rest = choices.filter(
    (choice) =>
      !choiceIsFor(choice, place) &&
      !(place.set && choice.show === place.show && near(choice, place)),
  );
  return show === 'upper' ? rest : [...rest, { x: place.x, z: place.z, show }];
}

function near(choice: PassageChoice, place: PassagePlace): boolean {
  return Math.hypot(choice.x - place.x, choice.z - place.z) <= Math.max(6, Math.sqrt(place.area));
}

/** The panel's starting choices for an area: those it was made with. */
export function startChoices(area: MadeArea): PassageChoice[] {
  return [...(area.floorPlan?.overrides?.passages ?? [])];
}

/** How the panel starts finding an area's floors: as it was made. */
export function startMethod(area: MadeArea): FloorMethod {
  return area.floorPlan?.method === 'passages' ? 'passages' : 'cuts';
}

/** The entry written to the player's floor cuts file for the floor method chosen in the panel. */
export function methodEntry(
  method: FloorMethod,
  draft: FloorsDraft,
  choices: readonly PassageChoice[],
  floors: number,
): FloorEntry {
  if (method === 'cuts') return { method, ...entryOf(draft) };
  const names = padNames(draft.names, floors).map((name) => name.trim());
  return {
    method,
    passages: choices.map((choice) => ({ ...choice })),
    ...(names.some((name) => name !== '') ? { names } : {}),
  };
}

/** A marker's look in the views: 0 plain, 1 within `NEAR_CUT` of a cut, 2 on another floor than its height gives
 * or with no floor under it. */
export type MarkerLook = 0 | 1 | 2;

export function lookOf(check: MarkerCheck): MarkerLook {
  if (check.otherFloor || check.noSurface) return 2;
  return check.nearCut === null ? 0 : 1;
}

const NORTH = ['north up', 'north to the right', 'north down', 'north to the left'];

/** Where north is on a floor seen from above, turned `turn` quarters clockwise. */
export function northText(turn: number): string {
  return NORTH[((turn % 4) + 4) % 4]!;
}

/** Where a marker's note goes beside its dot (at `x`, `y` as fractions of the view): above it, or below it near the
 * top; to its right near the left edge, to its left near the right edge. A CSS transform. */
export function tipPlace(x: number, y: number): string {
  const across = x < 0.25 ? '-8%' : x > 0.75 ? '-92%' : '-50%';
  const down = y < 0.2 ? '14px' : 'calc(-100% - 12px)';
  return `translate(${across}, ${down})`;
}
