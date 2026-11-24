/**
 * "Floor colours" in the 3D view: each floor of the map in its own colour,
 * darker low and lighter high within it, worked out from the floors' heights
 * (the layers' `heights`) when the map is shown, whatever made its model.
 * The engine does the same on the graphics card (`FLOOR_FRAGMENT` in
 * `engine.ts`); this module gives the colours and the sums, for it and for
 * tests. The palette is Okabe and Ito's, told apart with the common types of
 * colour blindness, in the order the Map Maker's 2D style "Colour by floor"
 * uses (`FLOOR_PALETTE` in tools/gamefiles/atlas_gamefiles/render.py), so a
 * floor is the same colour in both.
 *
 * A height is on the floor `floorAt` (in `@atlas/schema`) gives: the highest
 * floor that starts at or below it, the lowest floor below every floor.
 */

/** The floors' colours, lowest floor first; past the seventh they come round again. */
export const FLOOR_PALETTE = [
  '#0072b2', // blue
  '#e69f00', // orange
  '#009e73', // bluish green
  '#cc79a7', // reddish purple
  '#56b4e9', // sky blue
  '#d55e00', // vermillion
  '#f0e442', // yellow
] as const;

/** A floor's colour times this at its lowest and at its highest. */
export const FLOOR_SHADE: readonly [number, number] = [0.55, 1];

/** The most floors the view tells apart; above them, the top one takes the rest. */
export const MAX_FLOORS = 32;

/** One floor as the view colours it. */
export interface FloorBand {
  low: number;
  high: number;
  /** `#rrggbb`. */
  color: string;
}

/** The colour of floor `index` (0 the lowest). */
export function floorColour(index: number): string {
  return FLOOR_PALETTE[index % FLOOR_PALETTE.length]!;
}

/**
 * The bands of a map's floors, lowest first (as `floorsOf` gives them);
 * empty for a map without floors.
 */
export function floorBands(
  floors: readonly { heights?: readonly [number, number] | undefined }[],
): FloorBand[] {
  const bands: FloorBand[] = [];
  for (const floor of floors) {
    if (!floor.heights || bands.length >= MAX_FLOORS) continue;
    bands.push({ low: floor.heights[0], high: floor.heights[1], color: floorColour(bands.length) });
  }
  return bands;
}

/** The index of the band a height is on (as `floorAt`); -1 without bands. */
export function floorBandAt(bands: readonly FloorBand[], height: number): number {
  if (bands.length === 0) return -1;
  let found = 0;
  bands.forEach((band, index) => {
    if (band.low <= height) found = index;
  });
  return found;
}

/** How light a height is within its floor: `FLOOR_SHADE[0]` at its bottom to `FLOOR_SHADE[1]` at its top. */
export function floorShade(band: FloorBand, height: number): number {
  const t = band.high > band.low ? (height - band.low) / (band.high - band.low) : 0.5;
  const clamped = Math.min(Math.max(t, 0), 1);
  return FLOOR_SHADE[0] + (FLOOR_SHADE[1] - FLOOR_SHADE[0]) * clamped;
}

/** The colour at a height, `#rrggbb`, before light: its floor's colour, shaded; null without bands. */
export function floorColourAt(bands: readonly FloorBand[], height: number): string | null {
  const index = floorBandAt(bands, height);
  if (index < 0) return null;
  const band = bands[index]!;
  const shade = floorShade(band, height);
  const channels = [1, 3, 5].map((at) =>
    Math.round(parseInt(band.color.slice(at, at + 2), 16) * shade),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
