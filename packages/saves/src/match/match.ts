import { PinTableIndex, type GamePinTable } from '../gamefiles/table';
import type { PinKindRule, SaveTuning } from '../reader';
import type { SavePin, SaveSummary } from '../summary';
import {
  autoCalibrate,
  findFit,
  KindGrid,
  type AutoCalibration,
  type KindPoint,
} from './calibrate';
import {
  affineScale,
  applyAffine,
  applyLinear,
  distance,
  invertAffine,
  type Affine,
  type Point2,
} from './transform';
import { mapForWorld, type WorldMapSource } from './worlds';

/**
 * Matching a read save against a loaded pack: where the player is on which
 * map, and which places the save shows as done.
 */

/** The parts of a pack the matcher reads. */
export interface PackForMatching {
  maps: readonly {
    id: string;
    name: string;
    width: number;
    height: number;
    /** Map pixels to world coordinates, when the pack knows it. */
    worldTransform?: Affine | undefined;
  }[];
  categories: readonly { id: string; name: string; trackable: boolean }[];
  locations: readonly {
    id: string;
    mapId: string;
    x: number;
    y: number;
    categoryId: string;
    flagId?: string | undefined;
  }[];
}

/** How a map was lined up with its world. */
export type CalibrationSource = 'pack' | 'manual' | 'auto';

/** A world-to-pixel transform kept for a map, with how it was made. */
export interface MapCalibration {
  source: 'manual' | 'auto';
  /** World coordinates to map pixels. */
  transform: Affine;
  /** For `manual`: the points the person marked. */
  points?: { world: Point2; pixel: Point2 }[];
  /** For `auto`: how well the pins fit. */
  fit?: {
    inliers: number;
    candidates: number;
    rms: number;
    /** From a table: places on the map of the kinds used. */
    places?: number;
    /** From a table: the matching radius in map pixels. */
    radius?: number;
    /** From a table: which pins were used. */
    kinds?: FitKinds;
  };
  /** For `auto` from the game's map pin table: `table:` and the table's stamp. */
  from?: string;
  /** When it was made, in milliseconds since the epoch. */
  at: number;
}

/** The pins a table fit used: the first anchor kind alone (signposts), or every anchor kind. */
export type FitKinds = 'first' | 'anchors';

/** How well the game's map pins lined up with a map, and whether that is good enough to use. */
export interface TableFit {
  kinds: FitKinds;
  /** Table pins that landed on a place of their kind. */
  inliers: number;
  /** Table pins of the kinds used. */
  candidates: number;
  /** Places on the map of those kinds. */
  places: number;
  /** Root mean square distance of the landed pins from their places, in map pixels. */
  rms: number;
  /** The matching radius in map pixels. */
  radius: number;
  passed: boolean;
}

/**
 * The bar a fit from the game's map pin table must pass to be used: at
 * least {@link TABLE_FIT.minInliers} pins land, at least `minShare` of the
 * smaller of pins and places land (a map may show only part of a world,
 * a pack may lack some places), and the landed pins sit closer to their
 * places than `maxRmsShare` of the matching radius on average (pins
 * landing by chance spread over the whole radius).
 */
export const TABLE_FIT = { minInliers: 8, minShare: 0.5, maxRmsShare: 0.5 } as const;

export interface MatchInput {
  summary: SaveSummary;
  pack: PackForMatching;
  tuning: SaveTuning;
  /** The person's choices of map per world id (null: no map). */
  worldMaps: Readonly<Record<string, string | null>>;
  /** Calibrations kept on this device, by map id. */
  calibrations: Readonly<Record<string, MapCalibration>>;
  /** Try to line maps up from the save's pins when nothing else does. Default true. */
  autoCalibrate?: boolean;
  /** The game's own map pins, read on this device; null or left out when there is none. */
  table?: GamePinTable | null;
  now?: number;
}

export interface WorldMatch {
  worldId: string;
  name: string;
  mapId: string | null;
  mapSource: WorldMapSource;
  /** How world coordinates become pixels on that map; null when they cannot yet. */
  calibration: CalibrationSource | null;
  /** How the game's map pins fit the map, when a table was tried for it. */
  fit?: TableFit;
}

export interface MatchedLocation {
  locationId: string;
  /** The pin kind, or `flag` for a match by the location's `flagId`. */
  kind: string;
  /** Why it matched, in plain words. */
  reason: string;
}

export interface CategoryCount {
  categoryId: string;
  kind: string;
  /** Places of this category the save marks found. */
  matched: number;
}

/** Done pins that did not become a found place, counted by kind and reason. */
export interface Unmatched {
  kind: string;
  label: string;
  reason: 'no-category' | 'no-place-nearby' | 'no-position' | 'no-map' | 'not-lined-up';
  count: number;
}

export interface PlayerOnMap {
  mapId: string;
  x: number;
  y: number;
  /** Facing on the map, in degrees clockwise from up; null when unknown. */
  heading: number | null;
  /** The point lies inside the map image. */
  onMap: boolean;
}

/**
 * Why a save marks nothing:
 * - `no-map`: the save's map could not be read;
 * - `nothing-done`: the save has not discovered or cleared any place yet
 *   (a new game);
 * - `no-tag-table`: the save names its discovered or cleared places by the
 *   game's tags alone, without positions, and no place of the pack names
 *   them; telling which places they are needs a table of where each tag is
 *   (in the game's own files), which Atlas does not have;
 * - `not-in-table`: as `no-tag-table`, but Atlas has the table, and it
 *   does not hold those tags.
 */
export type NothingReason = 'no-map' | 'nothing-done' | 'no-tag-table' | 'not-in-table';

/** What the game's map pin table did for a save. */
export interface TableUse {
  /** Pins the save names by tag alone. */
  tags: number;
  /** Of those, how many the table holds. */
  found: number;
}

export interface SaveMatch {
  /** The world the player is in, with its map. */
  current: WorldMatch | null;
  /** Every world with pins or the player, with its map. */
  worlds: WorldMatch[];
  player: PlayerOnMap | null;
  /** Places to mark found. */
  found: MatchedLocation[];
  categories: CategoryCount[];
  unmatched: Unmatched[];
  /** New automatic calibrations made now, by map id, for the caller to keep. */
  calibrated: Record<string, MapCalibration>;
  /** The current world has a map that cannot be lined up yet: ask the person to mark points. */
  needsCalibration: boolean;
  /**
   * Pins the save shows discovered or cleared that it names by tag alone,
   * with no position, and that no place of the pack names by its `flagId`.
   */
  unplaced: number;
  /** Why nothing is found, when nothing is; null when something is, or when `unmatched` says why. */
  nothingBecause: NothingReason | null;
  /** What the game's map pin table did; null without one. */
  table: TableUse | null;
}

/** The pin kind of each category whose name holds one of a kind's keywords. */
export function categoryKinds(
  categories: readonly { id: string; name: string }[],
  rules: readonly PinKindRule[],
): Map<string, string> {
  const kinds = new Map<string, string>();
  for (const category of categories) {
    const name = category.name.toLowerCase().replace(/[’`]/g, "'");
    const rule = rules.find((r) => r.categoryKeywords.some((keyword) => name.includes(keyword)));
    if (rule) kinds.set(category.id, rule.kind);
  }
  return kinds;
}

/** The pin kind of a game pin type (a `Disabled` suffix is the same kind), or null. */
export function kindOfType(type: string, rules: readonly PinKindRule[]): string | null {
  const base = type.replace(/disabled$/i, '').toLowerCase();
  if (!base) return null;
  return rules.find((rule) => rule.types.some((t) => t.toLowerCase() === base))?.kind ?? null;
}

/**
 * The save's pins, with those it names by tag alone placed from the table:
 * their world, type, kind and position.
 */
export function placePinsFromTable(
  pins: readonly SavePin[],
  index: PinTableIndex,
  currentWorld: string | null,
  rules: readonly PinKindRule[],
): { pins: SavePin[]; use: TableUse } {
  const use: TableUse = { tags: 0, found: 0 };
  const placed = pins.map((pin) => {
    if (pin.position) return pin;
    use.tags++;
    const found = index.find(pin.id, pin.world ?? currentWorld);
    if (!found) return pin;
    use.found++;
    const type = found.pin.type || pin.type;
    return {
      ...pin,
      world: found.world,
      type,
      kind: (type ? kindOfType(type, rules) : null) ?? pin.kind,
      position: { x: found.pin.x, y: found.pin.y, z: found.pin.z },
    };
  });
  return { pins: placed, use };
}

/** Whether a pin is in the state that makes its place found. */
export function pinIsDone(pin: SavePin, rule: PinKindRule): boolean {
  if (pin.cleared) return true;
  return rule.foundWhen === 'discovered' && pin.discovered === true;
}

/** World to pixels for a map: the person's points, the pack's own transform, or an automatic fit. */
export function transformFor(
  map: PackForMatching['maps'][number],
  calibrations: Readonly<Record<string, MapCalibration>>,
): { transform: Affine; source: CalibrationSource } | null {
  const kept = calibrations[map.id];
  if (kept?.source === 'manual') return { transform: kept.transform, source: 'manual' };
  if (map.worldTransform) {
    const inverse = invertAffine(map.worldTransform);
    if (inverse) return { transform: inverse, source: 'pack' };
  }
  if (kept) return { transform: kept.transform, source: 'auto' };
  return null;
}

export function matchSave(input: MatchInput): SaveMatch {
  const { summary: read, pack, tuning } = input;
  const index = input.table ? new PinTableIndex(input.table) : null;
  const fromTable = index
    ? placePinsFromTable(read.pins, index, read.world?.id ?? null, tuning.pinKinds)
    : null;
  const summary: SaveSummary = fromTable ? { ...read, pins: fromTable.pins } : read;
  const tableKey = input.table ? `table:${input.table.stamp}` : null;
  const rules = new Map(tuning.pinKinds.map((rule) => [rule.kind, rule]));
  const kindOfCategory = categoryKinds(pack.categories, tuning.pinKinds);
  const trackable = new Set(pack.categories.filter((c) => c.trackable).map((c) => c.id));
  const mapsById = new Map(pack.maps.map((map) => [map.id, map]));
  const calibrations: Record<string, MapCalibration> = { ...input.calibrations };
  const calibrated: Record<string, MapCalibration> = {};

  const worldIds = new Set<string>();
  if (summary.world) worldIds.add(summary.world.id);
  for (const pin of summary.pins) if (pin.world) worldIds.add(pin.world);
  const nameOf = (id: string) =>
    summary.worlds.find((w) => w.id === id)?.name ??
    tuning.worlds.find((w) => w.id === id)?.name ??
    id;

  // Lines a world up with its map, automatically from pins when it has to:
  // from every pin of the game's table when there is one, else from the
  // save's own pins.
  const worlds = new Map<string, WorldMatch & { transform: Affine | null }>();
  for (const worldId of worldIds) {
    const { mapId, source } = mapForWorld(worldId, pack.maps, tuning.worlds, input.worldMaps);
    const map = mapId ? mapsById.get(mapId) : undefined;
    let found = map ? transformFor(map, calibrations) : null;
    let fit: TableFit | undefined;
    const kept = map ? calibrations[map.id] : undefined;
    const tablePins = index?.pinsOf(worldId) ?? [];
    if (map && found?.source === 'auto' && kept?.from && kept.from === tableKey && kept.fit) {
      // Made from this very table before.
      fit = keptFit(kept.fit);
    } else if (
      map &&
      (!found || found.source === 'auto') &&
      input.autoCalibrate !== false &&
      tablePins.length > 0
    ) {
      const tried = calibrateFromTable(tablePins, map, pack, kindOfCategory, tuning);
      if (tried) {
        const { transform, ...report } = tried;
        fit = report;
        if (report.passed) {
          const calibration: MapCalibration = {
            source: 'auto',
            transform,
            fit: {
              inliers: report.inliers,
              candidates: report.candidates,
              rms: report.rms,
              places: report.places,
              radius: report.radius,
              kinds: report.kinds,
            },
            from: tableKey!,
            at: input.now ?? Date.now(),
          };
          calibrated[map.id] = calibration;
          calibrations[map.id] = calibration;
          found = { transform, source: 'auto' };
        }
      }
    } else if (map && (!found || found.source === 'auto') && input.autoCalibrate !== false) {
      const auto = calibrateFromPins(summary.pins, worldId, map, pack, kindOfCategory, tuning);
      if (auto) {
        const calibration: MapCalibration = {
          source: 'auto',
          transform: auto.transform,
          fit: { inliers: auto.inliers, candidates: auto.candidates, rms: auto.rms },
          at: input.now ?? Date.now(),
        };
        calibrated[map.id] = calibration;
        calibrations[map.id] = calibration;
        found = { transform: auto.transform, source: 'auto' };
      }
    }
    worlds.set(worldId, {
      worldId,
      name: nameOf(worldId),
      mapId: mapId ?? null,
      mapSource: source,
      calibration: found?.source ?? null,
      ...(fit ? { fit } : {}),
      transform: found?.transform ?? null,
    });
  }

  const strip = ({ transform: _transform, ...world }: WorldMatch & { transform: Affine | null }) =>
    world;
  const currentWorld = summary.world ? worlds.get(summary.world.id) : undefined;

  // The player.
  let player: PlayerOnMap | null = null;
  if (summary.player && currentWorld?.mapId && currentWorld.transform) {
    const map = mapsById.get(currentWorld.mapId)!;
    const at = applyAffine(currentWorld.transform, summary.player.position);
    player = {
      mapId: map.id,
      x: at.x,
      y: at.y,
      heading:
        summary.player.yaw === null
          ? null
          : headingOnMap(currentWorld.transform, summary.player.yaw),
      onMap: at.x >= 0 && at.y >= 0 && at.x <= map.width && at.y <= map.height,
    };
  }

  // Places by the save's flags (a location's `flagId` naming a fact or a pin).
  const found = new Map<string, MatchedLocation>();
  const pinsById = new Map(summary.pins.map((pin) => [pin.id, pin]));
  for (const location of pack.locations) {
    if (!location.flagId || !trackable.has(location.categoryId)) continue;
    const fact = summary.facts[location.flagId];
    const pin = pinsById.get(location.flagId);
    // A pin named by tag alone has no kind: its place's category says what done means.
    const kind = pin?.kind ?? kindOfCategory.get(location.categoryId);
    const rule = kind ? rules.get(kind) : undefined;
    const done = pin
      ? pin.cleared === true || (rule ? pinIsDone(pin, rule) : pin.discovered === true)
      : false;
    if (fact !== undefined && fact > 0) {
      found.set(location.id, {
        locationId: location.id,
        kind: 'flag',
        reason: `The save has the fact “${location.flagId}” set.`,
      });
    } else if (pin && done) {
      found.set(location.id, {
        locationId: location.id,
        kind: 'flag',
        reason: `The save shows the map pin “${location.flagId}” as ${pin.cleared ? 'cleared' : 'discovered'}.`,
      });
    }
  }

  // Places by done pins near them.
  const unmatched = new Map<string, Unmatched>();
  const miss = (kind: string, reason: Unmatched['reason']) => {
    const key = `${kind}\u0000${reason}`;
    const entry = unmatched.get(key);
    if (entry) entry.count++;
    else unmatched.set(key, { kind, label: rules.get(kind)?.label ?? kind, reason, count: 1 });
  };
  const kindsWithCategory = new Set(kindOfCategory.values());
  const grids = new Map<string, KindGrid<KindPoint & { id: string }>>();
  const gridFor = (mapId: string) => {
    let grid = grids.get(mapId);
    if (!grid) {
      const map = mapsById.get(mapId)!;
      const places = pack.locations
        .filter(
          (l) =>
            l.mapId === mapId && kindOfCategory.has(l.categoryId) && trackable.has(l.categoryId),
        )
        .map((l) => ({ id: l.id, x: l.x, y: l.y, kind: kindOfCategory.get(l.categoryId)! }));
      grid = new KindGrid(places, map.width, map.height);
      grids.set(mapId, grid);
    }
    return grid;
  };
  // Pins a location names by its flagId were matched above, not by distance.
  const named = new Set(pack.locations.map((l) => l.flagId).filter((id) => id !== undefined));
  const options: { pin: SavePin; locationId: string; distance: number; metres: number }[] = [];
  const pinsToPlace: SavePin[] = [];
  for (const pin of summary.pins) {
    const rule = pin.kind ? rules.get(pin.kind) : undefined;
    if (!rule || !pinIsDone(pin, rule) || named.has(pin.id)) continue;
    if (!kindsWithCategory.has(rule.kind)) {
      miss(rule.kind, 'no-category');
      continue;
    }
    if (!pin.position) {
      miss(rule.kind, 'no-position');
      continue;
    }
    const world = pin.world ? worlds.get(pin.world) : currentWorld;
    if (!world?.mapId) {
      miss(rule.kind, 'no-map');
      continue;
    }
    if (!world.transform) {
      miss(rule.kind, 'not-lined-up');
      continue;
    }
    const scale = affineScale(world.transform);
    const radius = Math.max(tuning.minRadiusPx, tuning.matchRadius * scale);
    const at = applyAffine(world.transform, pin.position);
    pinsToPlace.push(pin);
    for (const place of gridFor(world.mapId).within(at, rule.kind, radius)) {
      const d = distance(at, place);
      options.push({ pin, locationId: place.id, distance: d, metres: d / scale });
    }
  }
  options.sort((a, b) => a.distance - b.distance);
  const placed = new Set<SavePin>();
  for (const option of options) {
    if (placed.has(option.pin) || found.has(option.locationId)) continue;
    placed.add(option.pin);
    const rule = rules.get(option.pin.kind!)!;
    found.set(option.locationId, {
      locationId: option.locationId,
      kind: rule.kind,
      reason: `${singular(rule.label)} ${option.pin.cleared ? 'cleared' : 'discovered'} in the save, ${Math.round(option.metres)} m from this place.`,
    });
  }
  for (const pin of pinsToPlace) if (!placed.has(pin)) miss(pin.kind!, 'no-place-nearby');

  // Done pins named by tag alone, which nothing here can place.
  let done = 0;
  let unplaced = 0;
  for (const pin of summary.pins) {
    if (pin.cleared !== true && pin.discovered !== true) continue;
    done++;
    if (!pin.position && !pin.kind && !named.has(pin.id)) unplaced++;
  }
  const nothingBecause: NothingReason | null =
    found.size > 0
      ? null
      : !summary.map
        ? 'no-map'
        : done === 0
          ? 'nothing-done'
          : unplaced > 0
            ? index
              ? 'not-in-table'
              : 'no-tag-table'
            : null;

  // Counts by category.
  const counts = new Map<string, CategoryCount>();
  const categoryOf = new Map(pack.locations.map((l) => [l.id, l.categoryId]));
  for (const match of found.values()) {
    const categoryId = categoryOf.get(match.locationId)!;
    const count = counts.get(categoryId);
    if (count) count.matched++;
    else counts.set(categoryId, { categoryId, kind: match.kind, matched: 1 });
  }

  return {
    current: currentWorld ? strip(currentWorld) : null,
    worlds: [...worlds.values()].map(strip),
    player,
    found: [...found.values()],
    categories: [...counts.values()],
    unmatched: [...unmatched.values()],
    calibrated,
    needsCalibration: Boolean(currentWorld?.mapId && !currentWorld.transform),
    unplaced,
    nothingBecause,
    table: fromTable?.use ?? null,
  };
}

function singular(label: string): string {
  const special: Record<string, string> = {
    'People in distress': 'Person in distress',
    'Spoils of war': 'Spoils of war',
    "Smugglers' caches": "Smugglers' cache",
    'Places of power': 'Place of power',
  };
  return special[label] ?? label.replace(/s$/, '');
}

/**
 * The player's facing on the map, in degrees clockwise from up. The game
 * faces along (-sin yaw, cos yaw) in world coordinates (yaw 0 is +y,
 * north); the map's transform turns that into a direction in pixels.
 */
export function headingOnMap(transform: Affine, yawDegrees: number): number {
  const yaw = (yawDegrees * Math.PI) / 180;
  const direction = applyLinear(transform, { x: -Math.sin(yaw), y: Math.cos(yaw) });
  const degrees = (Math.atan2(direction.x, -direction.y) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** An automatic world-to-pixel fit for a map from the anchor pins of a world. */
export function calibrateFromPins(
  pins: readonly SavePin[],
  worldId: string,
  map: PackForMatching['maps'][number],
  pack: PackForMatching,
  kindOfCategory: ReadonlyMap<string, string>,
  tuning: SaveTuning,
): AutoCalibration | null {
  const anchors = new Set(tuning.pinKinds.filter((rule) => rule.anchor).map((rule) => rule.kind));
  const worldPins = pins
    .filter((pin) => pin.position && pin.kind && anchors.has(pin.kind) && pin.world === worldId)
    .map((pin) => ({ x: pin.position!.x, y: pin.position!.y, kind: pin.kind! }));
  if (worldPins.length === 0) return null;
  const places = pack.locations
    .filter((l) => l.mapId === map.id && kindOfCategory.has(l.categoryId))
    .map((l) => ({ x: l.x, y: l.y, kind: kindOfCategory.get(l.categoryId)! }))
    .filter((p) => anchors.has(p.kind));
  return autoCalibrate({
    pins: worldPins,
    places,
    radiusWorld: tuning.matchRadius,
    minRadiusPx: tuning.minRadiusPx,
    mapSize: { width: map.width, height: map.height },
  });
}

/** A fit kept from before, as a report. */
function keptFit(fit: NonNullable<MapCalibration['fit']>): TableFit {
  return {
    kinds: fit.kinds ?? 'anchors',
    inliers: fit.inliers,
    candidates: fit.candidates,
    places: fit.places ?? 0,
    rms: fit.rms,
    radius: fit.radius ?? 0,
    passed: true,
  };
}

/**
 * Lines a map up from the game's own map pins of its world: every pin of
 * the first anchor kind (signposts in The Witcher 3) against the map's
 * places of that kind, then, when that does not pass {@link TABLE_FIT},
 * every anchor kind. Returns the better report, with its transform; null
 * when the map has no places of an anchor kind or nothing landed at all.
 */
export function calibrateFromTable(
  pins: readonly { x: number; y: number; type: string }[],
  map: PackForMatching['maps'][number],
  pack: PackForMatching,
  kindOfCategory: ReadonlyMap<string, string>,
  tuning: SaveTuning,
): (TableFit & { transform: Affine }) | null {
  const anchors = tuning.pinKinds.filter((rule) => rule.anchor);
  const first = anchors[0];
  if (!first) return null;
  const typed = pins
    .map((pin) => ({ x: pin.x, y: pin.y, kind: kindOfType(pin.type, tuning.pinKinds) }))
    .filter((pin): pin is KindPoint => pin.kind !== null);
  const places = pack.locations
    .filter((l) => l.mapId === map.id && kindOfCategory.has(l.categoryId))
    .map((l) => ({ x: l.x, y: l.y, kind: kindOfCategory.get(l.categoryId)! }));
  const attempt = (kinds: FitKinds, wanted: ReadonlySet<string>) => {
    const found = findFit({
      pins: typed.filter((pin) => wanted.has(pin.kind)),
      places: places.filter((place) => wanted.has(place.kind)),
      radiusWorld: tuning.matchRadius,
      minRadiusPx: tuning.minRadiusPx,
      mapSize: { width: map.width, height: map.height },
      neighbourPairs: true,
      // Hundreds of pins against hundreds of places need more guesses than a save's few.
      iterations: 30_000,
    });
    if (!found) return null;
    const passed =
      found.inliers >= TABLE_FIT.minInliers &&
      found.inliers >= TABLE_FIT.minShare * Math.min(found.candidates, found.places) &&
      found.rms <= TABLE_FIT.maxRmsShare * found.radius;
    return {
      kinds,
      inliers: found.inliers,
      candidates: found.candidates,
      places: found.places,
      rms: found.rms,
      radius: found.radius,
      passed,
      transform: found.transform,
    };
  };
  const firstFit = attempt('first', new Set([first.kind]));
  if (firstFit?.passed) return firstFit;
  const allFit = attempt('anchors', new Set(anchors.map((rule) => rule.kind)));
  if (allFit?.passed) return allFit;
  // Neither passed: report the one that came closer.
  if (!firstFit) return allFit;
  if (!allFit) return firstFit;
  return allFit.inliers / Math.max(1, Math.min(allFit.candidates, allFit.places)) >
    firstFit.inliers / Math.max(1, Math.min(firstFit.candidates, firstFit.places))
    ? allFit
    : firstFit;
}
