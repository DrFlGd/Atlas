/**
 * Marker icon names the app can draw. Packs name one of these in
 * `category.icon`; the app draws any other name as `pin`, so a pack stays
 * valid when it uses a name a newer app version adds.
 */
export const ICON_NAMES = [
  'pin',
  'star',
  'diamond',
  'square',
  'triangle',
  'circle',
  'hexagon',
  'cross',
  'skull',
  'key',
  'chest',
  'flask',
  'scroll',
  'sword',
  'shield',
  'gem',
  'flame',
  'leaf',
  'person',
  'door',
  'tower',
  'cave',
  'anchor',
  'flag',
  'book',
  'coin',
  'crown',
  'eye',
  'paw',
  'hammer',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

/** The icon drawn for names that are not in {@link ICON_NAMES}. */
export const FALLBACK_ICON: IconName = 'pin';

const KNOWN = new Set<string>(ICON_NAMES);

export function isIconName(name: string): name is IconName {
  return KNOWN.has(name);
}

/** The icon to draw for a category's `icon` value. */
export function resolveIconName(name: string): IconName {
  return isIconName(name) ? name : FALLBACK_ICON;
}
