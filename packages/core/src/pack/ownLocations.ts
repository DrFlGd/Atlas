import {
  makeId,
  parseId,
  type Category,
  type CategoryGroup,
  type GuideEntry,
  type Location,
  type OwnLocation,
  type OwnLocations,
  type PackData,
  type Picture,
  type Region,
} from '@atlas/schema';
import { newOwnId, randomText, type RandomText } from '../checklists/ownLists';

/**
 * A person's own locations, types, type groups and areas (see
 * `ownLocations.ts` in the schema package) added to a game's pack data, and
 * the pure changes the app makes to them. Every change returns new data
 * and leaves what it was given as it was, so a change can be undone by
 * keeping what was there before.
 */

/** What adding a game's own records to its pack left out. */
export interface MergedOwnLocations {
  data: PackData;
  /** Own records left out: their map, layer, type or group is not in the game. */
  skipped: number;
}

/** The id of the note of an own location: a guide with the location's own local id. */
export function ownNoteId(locationId: string): string {
  const parsed = parseId(locationId);
  return parsed ? makeId(parsed.gameId, 'guide', parsed.localId) : locationId;
}

/** An own location as the app shows every location: with a note when it has one. */
export function locationOfOwn(own: OwnLocation): Location {
  const note = own.note?.trim() ? own.note : undefined;
  return {
    id: own.id,
    mapId: own.mapId,
    layerId: own.layerId,
    x: own.x,
    y: own.y,
    categoryId: own.categoryId,
    regionId: own.regionId,
    name: own.name,
    entityIds: [],
    guideId: note === undefined ? null : ownNoteId(own.id),
    since: '0.0.0',
    ...(own.photos && own.photos.length > 0 ? { photos: own.photos } : {}),
  };
}

/**
 * The pack's data with the game's own records added after its own, so they
 * are on the map, in the filters, search, counts and lists like any other.
 * An own record whose map, layer, type or group the game does not have
 * (the map was deleted, the pack changed) is left out and counted, and an
 * area that is not on the location's map is dropped from it. A record with
 * an id the pack already uses is left out too, though packs may not use
 * own ids. A location outside its map is moved to the nearest edge.
 */
export function mergeOwnLocations(data: PackData, own: OwnLocations): MergedOwnLocations {
  let skipped = 0;
  const taken = new Set<string>();
  for (const record of [
    ...data.categoryGroups,
    ...data.categories,
    ...data.regions,
    ...data.locations,
    ...data.guides,
  ]) {
    taken.add(record.id);
  }
  const keep = (record: { id: string }, ok: boolean): boolean => {
    if (!ok || taken.has(record.id)) {
      skipped++;
      return false;
    }
    taken.add(record.id);
    return true;
  };
  const maps = new Map(data.maps.map((m) => [m.id, m]));
  const layers = new Map(data.layers.map((l) => [l.id, l]));

  const groups = own.categoryGroups.filter((g) => keep(g, true));
  const groupIds = new Set([...data.categoryGroups, ...groups].map((g) => g.id));
  const categories = own.categories.filter((c) => keep(c, groupIds.has(c.groupId)));
  const categoryIds = new Set([...data.categories, ...categories].map((c) => c.id));
  const regions = own.regions
    .filter((r) => keep(r, maps.has(r.mapId)))
    .map((r) => (r.parentId === null ? r : { ...r, parentId: null }));
  const regionMaps = new Map([...data.regions, ...regions].map((r) => [r.id, r.mapId]));

  const locations: Location[] = [];
  const guides: GuideEntry[] = [];
  for (const record of own.locations) {
    const map = maps.get(record.mapId);
    const layer = layers.get(record.layerId);
    const ok =
      map !== undefined && layer?.mapId === record.mapId && categoryIds.has(record.categoryId);
    if (!keep(record, ok) || !map) continue;
    const location = locationOfOwn({
      ...record,
      x: Math.min(Math.max(record.x, 0), map.width),
      y: Math.min(Math.max(record.y, 0), map.height),
      regionId:
        record.regionId !== null && regionMaps.get(record.regionId) === record.mapId
          ? record.regionId
          : null,
    });
    if (location.guideId !== null) {
      if (taken.has(location.guideId)) {
        location.guideId = null;
      } else {
        guides.push({
          id: location.guideId,
          title: location.name,
          body: record.note ?? '',
          locationIds: [location.id],
        });
      }
    }
    locations.push(location);
  }
  if (
    groups.length === 0 &&
    categories.length === 0 &&
    regions.length === 0 &&
    locations.length === 0
  ) {
    return { data, skipped };
  }
  return {
    data: {
      ...data,
      categoryGroups: [...data.categoryGroups, ...groups],
      categories: [...data.categories, ...categories],
      regions: [...data.regions, ...regions],
      locations: [...data.locations, ...locations],
      guides: [...data.guides, ...guides],
    },
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Changes

/** Every id a new own record must not take: the pack's and the own ones. */
export function takenRecordIds(data: PackData, own: OwnLocations): Set<string> {
  const taken = new Set<string>();
  for (const record of [
    ...data.categoryGroups,
    ...data.categories,
    ...data.regions,
    ...data.locations,
    ...own.categoryGroups,
    ...own.categories,
    ...own.regions,
    ...own.locations,
    ...(own.pictures ?? []),
  ]) {
    taken.add(record.id);
  }
  return taken;
}

/** The colours offered for a new type, in order. */
export const OWN_TYPE_COLOURS = [
  '#e07a2f',
  '#d64545',
  '#c2408f',
  '#7a5cd6',
  '#3f7fd9',
  '#2aa3a3',
  '#3a9d5d',
  '#9aa531',
  '#c9a227',
  '#8a6a4f',
  '#6b7785',
  '#e8e2d0',
] as const;

/** Adds a location. */
export function addOwnLocation(own: OwnLocations, location: OwnLocation): OwnLocations {
  return { ...own, locations: [...own.locations, location] };
}

/** What can change of an own location. */
export type OwnLocationChanges = Partial<
  Pick<OwnLocation, 'name' | 'categoryId' | 'regionId' | 'note' | 'x' | 'y'>
>;

/** Changes an own location; the same data when nothing changes. */
export function changeOwnLocation(
  own: OwnLocations,
  id: string,
  changes: OwnLocationChanges,
  now: Date,
): OwnLocations {
  const index = own.locations.findIndex((location) => location.id === id);
  const location = own.locations[index];
  if (!location) return own;
  const next: OwnLocation = { ...location };
  let touched = false;
  for (const [key, value] of Object.entries(changes) as [keyof OwnLocationChanges, unknown][]) {
    if (value === undefined && key !== 'note') continue;
    if (next[key] === value) continue;
    touched = true;
    if (key === 'note' && (value === undefined || value === '')) delete next.note;
    else (next as Record<string, unknown>)[key] = value;
  }
  if (!touched) return own;
  next.updatedAt = now.toISOString();
  const locations = [...own.locations];
  locations[index] = next;
  return { ...own, locations };
}

/** Removes an own location, and the own photos only it showed. */
export function removeOwnLocation(own: OwnLocations, id: string): OwnLocations {
  const locations = own.locations.filter((location) => location.id !== id);
  return locations.length === own.locations.length
    ? own
    : keepOwnPicturesInUse({ ...own, locations });
}

/** The own records keeping only the own pictures their locations show. */
export function keepOwnPicturesInUse(own: OwnLocations): OwnLocations {
  if (!own.pictures) return own;
  const used = new Set(own.locations.flatMap((l) => (l.photos ?? []).map((p) => p.picture)));
  const pictures = own.pictures.filter((picture) => used.has(picture.id));
  if (pictures.length === own.pictures.length) return own;
  const { pictures: _pictures, ...rest } = own;
  return pictures.length > 0 ? { ...rest, pictures } : rest;
}

/** Adds a photo to an own location; an own picture is kept with the locations. */
export function addOwnLocationPhoto(
  own: OwnLocations,
  id: string,
  picture: Picture,
  now: Date,
  spoiler = false,
): OwnLocations {
  if (!own.locations.some((location) => location.id === id)) return own;
  return {
    ...own,
    locations: own.locations.map((location) =>
      location.id === id
        ? {
            ...location,
            photos: [
              ...(location.photos ?? []).filter((photo) => photo.picture !== picture.id),
              { picture: picture.id, ...(spoiler ? { spoiler: true } : {}) },
            ],
            updatedAt: now.toISOString(),
          }
        : location,
    ),
    ...(parseId(picture.id)?.localId.startsWith('own.')
      ? { pictures: [...(own.pictures ?? []).filter((p) => p.id !== picture.id), picture] }
      : {}),
  };
}

/** Takes a photo off an own location; an own picture nothing else shows goes too. */
export function removeOwnLocationPhoto(
  own: OwnLocations,
  id: string,
  pictureId: string,
  now: Date,
): OwnLocations {
  const locations = own.locations.map((location) => {
    if (location.id !== id || !location.photos) return location;
    const photos = location.photos.filter((photo) => photo.picture !== pictureId);
    const { photos: _photos, ...rest } = location;
    return {
      ...rest,
      ...(photos.length > 0 ? { photos } : {}),
      updatedAt: now.toISOString(),
    };
  });
  return keepOwnPicturesInUse({ ...own, locations });
}

/** Marks a photo of an own location as a spoiler, or not. */
export function setOwnLocationPhotoSpoiler(
  own: OwnLocations,
  id: string,
  pictureId: string,
  spoiler: boolean,
  now: Date,
): OwnLocations {
  return {
    ...own,
    locations: own.locations.map((location) =>
      location.id !== id || !location.photos
        ? location
        : {
            ...location,
            photos: location.photos.map((photo) =>
              photo.picture === pictureId
                ? { picture: photo.picture, ...(spoiler ? { spoiler: true } : {}) }
                : photo,
            ),
            updatedAt: now.toISOString(),
          },
    ),
  };
}

/** A new own type group, ordered after every group there is. */
export function newOwnTypeGroup(
  gameId: string,
  name: string,
  data: PackData,
  own: OwnLocations,
  random: RandomText = randomText,
): CategoryGroup {
  const order = Math.max(0, ...[...data.categoryGroups, ...own.categoryGroups].map((g) => g.order));
  return {
    id: newOwnId(gameId, 'catgroup', takenRecordIds(data, own), random),
    name: name.trim(),
    order: order + 1,
  };
}

/** What a person gives a type. */
export interface OwnTypeFields {
  name: string;
  color: string;
  icon: string;
  groupId: string;
}

/** A new own type: shown before any filter is changed, and can be marked found. */
export function newOwnType(
  gameId: string,
  fields: OwnTypeFields,
  data: PackData,
  own: OwnLocations,
  random: RandomText = randomText,
): Category {
  return {
    id: newOwnId(gameId, 'cat', takenRecordIds(data, own), random),
    groupId: fields.groupId,
    name: fields.name.trim(),
    icon: fields.icon,
    color: fields.color.toLowerCase(),
    trackable: true,
    defaultVisible: true,
  };
}

/** Adds or replaces an own type, and adds its group when it is a new one. */
export function putOwnType(own: OwnLocations, type: Category, group?: CategoryGroup): OwnLocations {
  const at = own.categories.findIndex((c) => c.id === type.id);
  const categories =
    at < 0 ? [...own.categories, type] : own.categories.map((c, i) => (i === at ? type : c));
  const groups =
    group && !own.categoryGroups.some((g) => g.id === group.id)
      ? [...own.categoryGroups, group]
      : own.categoryGroups;
  return dropEmptyGroups({ ...own, categories, categoryGroups: groups });
}

/** Own locations of a type, own or the pack's. */
export function ownLocationsOfType(own: OwnLocations, typeId: string): OwnLocation[] {
  return own.locations.filter((location) => location.categoryId === typeId);
}

/** Removes an own type that no own location uses; the same data otherwise. */
export function removeOwnType(own: OwnLocations, id: string): OwnLocations {
  if (ownLocationsOfType(own, id).length > 0) return own;
  return dropEmptyGroups({ ...own, categories: own.categories.filter((c) => c.id !== id) });
}

/** Own groups that no own type is in any more go. */
function dropEmptyGroups(own: OwnLocations): OwnLocations {
  const used = new Set(own.categories.map((c) => c.groupId));
  const groups = own.categoryGroups.filter((g) => used.has(g.id));
  return groups.length === own.categoryGroups.length ? own : { ...own, categoryGroups: groups };
}

/** A new own area of a map: a name, no outline. */
export function newOwnArea(
  gameId: string,
  mapId: string,
  name: string,
  data: PackData,
  own: OwnLocations,
  random: RandomText = randomText,
): Region {
  return {
    id: newOwnId(gameId, 'region', takenRecordIds(data, own), random),
    mapId,
    parentId: null,
    name: name.trim(),
  };
}

/** Adds or renames an own area. */
export function putOwnArea(own: OwnLocations, area: Region): OwnLocations {
  const at = own.regions.findIndex((r) => r.id === area.id);
  return {
    ...own,
    regions: at < 0 ? [...own.regions, area] : own.regions.map((r, i) => (i === at ? area : r)),
  };
}

/** Removes an own area; the own locations in it are then in no area. */
export function removeOwnArea(own: OwnLocations, id: string, now: Date): OwnLocations {
  return {
    ...own,
    regions: own.regions.filter((r) => r.id !== id),
    locations: own.locations.map((location) =>
      location.regionId === id
        ? { ...location, regionId: null, updatedAt: now.toISOString() }
        : location,
    ),
  };
}

/** Removes every own record of a map (when the map is deleted). */
export function removeOwnOfMap(own: OwnLocations, mapId: string): OwnLocations {
  return keepOwnPicturesInUse({
    ...own,
    regions: own.regions.filter((r) => r.mapId !== mapId),
    locations: own.locations.filter((l) => l.mapId !== mapId),
  });
}

/** Adds what one game's file has to what is there: a record of the same id is replaced. */
export function mergeOwnFiles(here: OwnLocations, incoming: OwnLocations): OwnLocations {
  const merge = <T extends { id: string }>(a: readonly T[], b: readonly T[]): T[] => {
    const ids = new Set(b.map((r) => r.id));
    return [...a.filter((r) => !ids.has(r.id)), ...b];
  };
  const pictures = merge(here.pictures ?? [], incoming.pictures ?? []);
  return keepOwnPicturesInUse({
    categoryGroups: merge(here.categoryGroups, incoming.categoryGroups),
    categories: merge(here.categories, incoming.categories),
    regions: merge(here.regions, incoming.regions),
    locations: merge(here.locations, incoming.locations),
    ...(pictures.length > 0 ? { pictures } : {}),
  });
}
