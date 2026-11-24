/**
 * "Look" in the 3D view: how the model is drawn.
 *
 * - **Textured**: the model's own materials, textures and colours, as it
 *   was made. A model that has none of its own (a model the Map Maker made
 *   from a game's collision, coloured only by height) cannot be shown so:
 *   it is shown shaded.
 * - **Shaded**: the model in one colour the person picks, darker low and
 *   lighter high over the model's heights, and darker on steep slopes and
 *   walls, then lit as always, so its shapes read clearly. The first colour,
 *   teal, is the Map Maker's own height ramp (`RAMP` in
 *   tools/gamefiles/atlas_gamefiles/render.py) with its slope shades
 *   (`SLOPE_SHADE` in scene.py): a model made from collision looks as it was
 *   made. "Darker walls and slopes" shades them more, for a clearer outline.
 *
 * The engine does the same on the graphics card (`PAINT_FRAGMENT` in
 * `engine.ts`); this module gives the colours and the sums, for it, for the
 * 3D tools and for tests. It holds no three.js, so the tools can use it.
 */

export type SceneLook = 'textured' | 'shaded';

/** Where along the model's heights (0 its lowest, 1 its highest) each colour of a ramp is. */
export const RAMP_STOPS = [0, 0.45, 0.8, 1] as const;

/** Four colours, `#rrggbb`, at `RAMP_STOPS`. */
export type ShadeRamp = readonly [string, string, string, string];

/** How light a surface is by how steep it is: up to each slope (in degrees from flat), this shade. */
export type SlopeShades = readonly (readonly [number, number])[];

/** As the Map Maker shades a model it makes from collision. */
export const SLOPE_SHADE: SlopeShades = [
  [50, 1],
  [70, 0.78],
  [90, 0.55],
];

/** "Darker walls and slopes". */
export const STRONG_SLOPE_SHADE: SlopeShades = [
  [50, 1],
  [70, 0.55],
  [90, 0.3],
];

export interface ShadePreset {
  id: string;
  /** As the tools name it. */
  name: string;
  ramp: ShadeRamp;
}

/**
 * The ramp of one colour: dark at the model's lowest, the colour itself
 * high up, lighter at the top.
 */
export function rampOf(colour: string): ShadeRamp {
  const base = channels(colour);
  const scaled = (by: number) => hex(base.map((value) => value * by));
  const lighter = hex(base.map((value) => value + (255 - value) * 0.45));
  return [scaled(0.4), scaled(0.7), hex(base), lighter];
}

/** The colours the tools offer, the first the one at first. */
export const SHADE_PRESETS: readonly ShadePreset[] = [
  // render.py's RAMP.
  { id: 'teal', name: 'Teal', ramp: ['#2e4856', '#3c767c', '#68b2a4', '#ace0d2'] },
  { id: 'stone', name: 'Stone grey', ramp: rampOf('#b4b0a8') },
  { id: 'sand', name: 'Sand', ramp: rampOf('#d8bd8a') },
  { id: 'slate', name: 'Slate blue', ramp: rampOf('#8fa3c8') },
  // Light, with dark lows: the most contrast, and coloured icons stand out on it.
  { id: 'light', name: 'Light', ramp: rampOf('#f4f2ec') },
];

/** The colour shaded with at first. */
export const DEFAULT_SHADE = 'teal';

/**
 * Whether a value is a colour to shade with: a preset's id, or a colour
 * of the person's own, `#rrggbb`.
 */
export function isShade(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (SHADE_PRESETS.some((preset) => preset.id === value) || /^#[0-9a-f]{6}$/i.test(value))
  );
}

/** The ramp of a colour to shade with (see `isShade`); teal's for anything else. */
export function shadeRamp(shade: string): ShadeRamp {
  const preset = SHADE_PRESETS.find((entry) => entry.id === shade);
  if (preset) return preset.ramp;
  if (/^#[0-9a-f]{6}$/i.test(shade)) return rampOf(shade.toLowerCase());
  return SHADE_PRESETS[0]!.ramp;
}

/** The colour that stands for a shade in the tools: its ramp high up, where most of a model is. */
export function shadeSwatch(shade: string): string {
  return shadeRamp(shade)[2];
}

/**
 * The look the model is drawn with: textured where asked for and the
 * model has its own textures or colours (`own`), else shaded.
 */
export function lookShown(look: SceneLook, own: boolean): SceneLook {
  return look === 'textured' && own ? 'textured' : 'shaded';
}

/** Why "Textured" cannot be used on the model shown (`own`: null while nothing is loaded yet); null when it can. */
export function texturedReason(own: boolean | null): string | null {
  if (own === null) return 'The 3D map is still loading';
  return own ? null : 'This 3D map has no textures';
}

/** Where a height lies on the ramp: 0 at `low`, 1 at `high`; 0.5 when they are one. */
export function rampAt(low: number, high: number, height: number): number {
  if (!(high > low)) return 0.5;
  return Math.min(Math.max((height - low) / (high - low), 0), 1);
}

/** The shade of a slope, in degrees from flat. */
export function slopeShade(shades: SlopeShades, degrees: number): number {
  for (const [limit, shade] of shades) if (degrees <= limit) return shade;
  return shades[shades.length - 1]![1];
}

/**
 * The colour of a surface, `#rrggbb` as the page shows it, before light:
 * the ramp at `t` (see `rampAt`), times the shade of its slope.
 */
export function shadedColourAt(ramp: ShadeRamp, t: number, shade: number): string {
  const at = Math.min(Math.max(t, 0), 1);
  let i = 0;
  while (i < RAMP_STOPS.length - 2 && at > RAMP_STOPS[i + 1]!) i++;
  const from = RAMP_STOPS[i]!;
  const to = RAMP_STOPS[i + 1]!;
  const k = (at - from) / (to - from);
  const a = channels(ramp[i]!);
  const b = channels(ramp[i + 1]!);
  return hex(a.map((value, c) => (value + (b[c]! - value) * k) * shade));
}

/** A `#rrggbb` colour's channels, 0 to 255. */
export function channels(colour: string): [number, number, number] {
  return [1, 3, 5].map((at) => parseInt(colour.slice(at, at + 2), 16)) as [number, number, number];
}

function hex(values: readonly number[]): string {
  return `#${values
    .map((value) =>
      Math.min(Math.max(Math.round(value), 0), 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
