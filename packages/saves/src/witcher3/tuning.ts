import type { GameWorld, PinKindRule, SaveTuning } from '../reader';

/**
 * Everything about The Witcher 3 that the matcher can be tuned with, in
 * one place: its worlds, its map pin kinds and the matching radius.
 *
 * GUESSWORK until checked against real saves and packs: which pin types
 * the save holds, the `...Disabled` suffix as "cleared", which type is a
 * "person in distress", and the radius.
 */

/**
 * The game's worlds by their folder in the game files (`levels\<id>\…`,
 * `dlc\bob\data\levels\bob\bob.w2w`). Map keywords are lowercase words
 * that name the same place in map packs.
 */
export const WITCHER3_WORLDS: GameWorld[] = [
  {
    id: 'novigrad',
    name: 'Velen and Novigrad',
    mapKeywords: ['velen', 'novigrad', "no man's land", 'no mans land', 'oxenfurt'],
  },
  { id: 'skellige', name: 'Skellige', mapKeywords: ['skellige'] },
  { id: 'kaer_morhen', name: 'Kaer Morhen', mapKeywords: ['kaer morhen'] },
  { id: 'prolog_village', name: 'White Orchard', mapKeywords: ['white orchard'] },
  {
    id: 'prolog_village_winter',
    name: 'White Orchard (winter)',
    mapKeywords: ['white orchard'],
  },
  {
    id: 'wyzima_castle',
    name: 'Royal Palace in Vizima',
    mapKeywords: ['vizima', 'wyzima', 'royal palace'],
  },
  { id: 'island_of_mist', name: 'Isle of Mists', mapKeywords: ['isle of mist', 'island of mist'] },
  { id: 'the_spiral', name: 'The Spiral', mapKeywords: ['spiral'] },
  { id: 'bob', name: 'Toussaint', mapKeywords: ['toussaint', 'beauclair'] },
];

/**
 * Map pin kinds and the pack categories they match. `types` are the
 * game's own map pin type names; a type with the suffix `Disabled` is the
 * same kind, cleared.
 */
export const WITCHER3_PIN_KINDS: PinKindRule[] = [
  {
    kind: 'signpost',
    label: 'Signposts',
    types: ['RoadSign'],
    categoryKeywords: ['signpost', 'road sign', 'fast travel'],
    foundWhen: 'discovered',
    anchor: true,
  },
  {
    kind: 'harbor',
    label: 'Harbors',
    types: ['Harbor'],
    categoryKeywords: ['harbor', 'harbour'],
    foundWhen: 'discovered',
    anchor: true,
  },
  {
    kind: 'place-of-power',
    label: 'Places of power',
    types: ['PlaceOfPower'],
    categoryKeywords: ['place of power', 'places of power'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'monster-nest',
    label: 'Monster nests',
    types: ['MonsterNest'],
    categoryKeywords: ['monster nest', 'monster den'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'bandit-camp',
    label: 'Bandit camps',
    types: ['BanditCamp', 'BanditCampfire'],
    categoryKeywords: ['bandit camp'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'guarded-treasure',
    label: 'Guarded treasures',
    types: ['BossAndTreasure'],
    categoryKeywords: ['guarded treasure'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'hidden-treasure',
    label: 'Hidden treasures',
    types: ['TreasureHuntMappin', 'TreasureHunt'],
    categoryKeywords: ['hidden treasure'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'spoils-of-war',
    label: 'Spoils of war',
    types: ['SpoilsOfWar'],
    categoryKeywords: ['spoils of war'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'abandoned-site',
    label: 'Abandoned sites',
    types: ['RescuingTown'],
    categoryKeywords: ['abandoned site'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'person-in-distress',
    label: 'People in distress',
    types: ['PersonInDistress', 'KnightErrant'],
    categoryKeywords: ['person in distress', 'people in distress'],
    foundWhen: 'cleared',
    anchor: false,
  },
  {
    kind: 'smugglers-cache',
    label: "Smugglers' caches",
    types: ['Contraband', 'ContrabandShip'],
    categoryKeywords: ['smuggler'],
    foundWhen: 'cleared',
    anchor: true,
  },
  {
    kind: 'infested-vineyard',
    label: 'Infested vineyards',
    types: ['InfestedVineyard'],
    categoryKeywords: ['infested vineyard'],
    foundWhen: 'cleared',
    anchor: true,
  },
];

export const WITCHER3_TUNING: SaveTuning = {
  worlds: WITCHER3_WORLDS,
  pinKinds: WITCHER3_PIN_KINDS,
  // Metres in the game world. Map pins sit on the place they mark, but a
  // map site may put its marker a few metres off.
  matchRadius: 25,
  minRadiusPx: 6,
};

/** The world id of a world path: its folder (`levels\novigrad\novigrad.w2w` is `novigrad`). */
export function worldIdOf(path: string): string | null {
  const parts = path
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const file = parts[parts.length - 1]!;
  if (parts.length >= 2) return parts[parts.length - 2]!;
  return file.replace(/\.w2w$/, '') || null;
}

/** A name for people for a world id; unknown ids are shown as they are. */
export function worldName(id: string): string {
  return WITCHER3_WORLDS.find((world) => world.id === id)?.name ?? id;
}

/** The pin kind of a game pin type, and whether the type is a cleared one. */
export function pinKindOf(type: string): { kind: string | null; cleared: boolean } {
  const cleared = /disabled$/i.test(type);
  const base = type.replace(/disabled$/i, '').toLowerCase();
  const rule = WITCHER3_PIN_KINDS.find((r) => r.types.some((t) => t.toLowerCase() === base));
  return { kind: rule?.kind ?? null, cleared };
}
