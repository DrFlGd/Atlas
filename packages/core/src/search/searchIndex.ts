import type { LoadedPack } from '../pack/loadedPack';

export type SearchKind = 'location' | 'entity' | 'guide';

/** One searchable thing: a location, an entity or a guide entry. */
export interface SearchEntry {
  kind: SearchKind;
  id: string;
  title: string;
  /** Short context shown under the title, such as category and region. */
  detail: string;
  /** Map of a location; null for entities and guides. */
  mapId: string | null;
  /** Locations to show when the entry is chosen: the location itself, or those it refers to. */
  locationIds: string[];
}

export interface SearchHit {
  entry: SearchEntry;
  /** Lower is better. */
  score: number;
}

interface Indexed {
  entry: SearchEntry;
  /** Normalised title. */
  text: string;
  words: string[];
  /** The words joined by single spaces, for whole-title and prefix matches. */
  joined: string;
}

/** Lowercase, without accents, for matching. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const KIND_ORDER: Record<SearchKind, number> = { location: 0, entity: 1, guide: 2 };

/**
 * An in-memory search index over a pack's location names, entity names and
 * guide titles, across every map. Built once when a pack loads; each query is
 * a linear scan over pre-normalised text, which stays well under a frame for
 * tens of thousands of entries.
 *
 * Every word of the query must occur in the title. Matches that start the
 * title rank first, then matches at word starts, then the rest; ties sort by
 * kind and then naturally by title ("Shard 2" before "Shard 10").
 */
export class SearchIndex {
  readonly size: number;
  private readonly items: Indexed[];

  constructor(pack: LoadedPack) {
    const entries: SearchEntry[] = [];
    const mapsWithLocations = new Set(pack.data.locations.map((l) => l.mapId));
    const showMap = mapsWithLocations.size > 1;

    for (const location of pack.data.locations) {
      const category = pack.categories.get(location.categoryId);
      const region = location.regionId ? pack.regions.get(location.regionId) : undefined;
      const map = pack.maps.get(location.mapId);
      const detail = [category?.name, region?.name, showMap ? map?.name : undefined]
        .filter(Boolean)
        .join(' · ');
      entries.push({
        kind: 'location',
        id: location.id,
        title: location.name,
        detail,
        mapId: location.mapId,
        locationIds: [location.id],
      });
    }

    const byEntity = new Map<string, string[]>();
    const byGuide = new Map<string, string[]>();
    const push = (index: Map<string, string[]>, key: string, value: string) => {
      const list = index.get(key);
      if (list) {
        if (!list.includes(value)) list.push(value);
      } else index.set(key, [value]);
    };
    for (const location of pack.data.locations) {
      for (const entityId of location.entityIds) push(byEntity, entityId, location.id);
      if (location.guideId) push(byGuide, location.guideId, location.id);
    }
    for (const guide of pack.data.guides) {
      for (const locationId of guide.locationIds) push(byGuide, guide.id, locationId);
    }

    for (const entity of pack.data.entities) {
      const locationIds = byEntity.get(entity.id) ?? [];
      entries.push({
        kind: 'entity',
        id: entity.id,
        title: entity.name,
        detail: `${capitalize(entity.kind)} · ${plural(locationIds.length, 'location')}`,
        mapId: null,
        locationIds,
      });
    }
    for (const guide of pack.data.guides) {
      const locationIds = byGuide.get(guide.id) ?? [];
      entries.push({
        kind: 'guide',
        id: guide.id,
        title: guide.title,
        detail: `Guide · ${plural(locationIds.length, 'location')}`,
        mapId: null,
        locationIds,
      });
    }

    // Sorted once here, so a query only has to bucket its hits by score.
    const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
    entries.sort(
      (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || collator.compare(a.title, b.title),
    );
    this.items = entries.map((entry) => {
      const text = normalizeText(entry.title);
      const words = text.split(WORD_SPLIT).filter(Boolean);
      return { entry, text, words, joined: words.join(' ') };
    });
    this.size = this.items.length;
  }

  /** Best matches for a query, at most `limit`. An empty query finds nothing. */
  search(query: string, limit = 50): SearchHit[] {
    const terms = normalizeText(query).split(WORD_SPLIT).filter(Boolean);
    if (terms.length === 0 || limit <= 0) return [];
    const phrase = terms.join(' ');

    // Score 0: the whole title; 1: the title starts with the query; 2: every
    // word of the query starts a word of the title; 3: every word occurs.
    const buckets: SearchHit[][] = [[], [], [], []];
    for (const item of this.items) {
      let score: number;
      if (item.joined === phrase) score = 0;
      else if (item.joined.startsWith(phrase)) score = 1;
      else {
        let allWordStarts = true;
        let all = true;
        for (const term of terms) {
          if (!item.text.includes(term)) {
            all = false;
            break;
          }
          if (allWordStarts && !item.words.some((word) => word.startsWith(term))) {
            allWordStarts = false;
          }
        }
        if (!all) continue;
        score = allWordStarts ? 2 : 3;
      }
      const bucket = buckets[score]!;
      if (bucket.length < limit) bucket.push({ entry: item.entry, score });
    }
    return buckets.flat().slice(0, limit);
  }

  /** How many entries match, without sorting; for "n more" hints. */
  count(query: string): number {
    const terms = normalizeText(query).split(WORD_SPLIT).filter(Boolean);
    if (terms.length === 0) return 0;
    let total = 0;
    for (const item of this.items) if (terms.every((t) => item.text.includes(t))) total++;
    return total;
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
