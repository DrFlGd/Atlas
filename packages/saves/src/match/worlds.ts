import type { GameWorld } from '../reader';

/**
 * Which pack map shows which game world. Atlas suggests one by name; the
 * person can choose another or none, and their choice is kept on the
 * device (it is not part of the pack).
 */

export interface MapName {
  id: string;
  name: string;
}

const normalise = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim();

/** The map whose name best names the world, or null when none does. */
export function suggestMap(
  worldId: string,
  maps: readonly MapName[],
  worlds: readonly GameWorld[],
): string | null {
  const world = worlds.find((w) => w.id === worldId);
  const keywords = world
    ? [...world.mapKeywords, world.name].map(normalise)
    : [normalise(worldId.replace(/_/g, ' '))];
  let best: { id: string; score: number } | null = null;
  for (const map of maps) {
    const name = ` ${normalise(map.name)} `;
    let score = 0;
    for (const keyword of keywords) {
      if (keyword && name.includes(` ${keyword} `)) score += keyword.length;
      else if (keyword && name.includes(keyword)) score += keyword.length / 2;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: map.id, score };
  }
  return best?.id ?? null;
}

/** How a world came to be shown on a map. */
export type WorldMapSource = 'chosen' | 'suggested' | 'none';

export interface WorldMap {
  mapId: string | null;
  source: WorldMapSource;
}

/**
 * The map for a world: the person's choice when they made one (a choice
 * of no map counts too), otherwise the suggestion.
 */
export function mapForWorld(
  worldId: string,
  maps: readonly MapName[],
  worlds: readonly GameWorld[],
  chosen: Readonly<Record<string, string | null>>,
): WorldMap {
  if (Object.hasOwn(chosen, worldId)) {
    const mapId = chosen[worldId] ?? null;
    if (mapId === null) return { mapId: null, source: 'chosen' };
    if (maps.some((map) => map.id === mapId)) return { mapId, source: 'chosen' };
  }
  const suggested = suggestMap(worldId, maps, worlds);
  return suggested ? { mapId: suggested, source: 'suggested' } : { mapId: null, source: 'none' };
}
