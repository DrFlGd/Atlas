import { siteOf, type PackEntry, type TitleRow } from '@atlas/core';
import { useEffect, useMemo, useState } from 'react';
import type { ListedPack, PackDetails } from '../desktop';
import { numberFormat } from './derived';
import { useGameFacts } from './gameFacts';
import { namesOfSources, useGameGroups } from './gameGroups';
import {
  loadGameTags,
  matchesName,
  nameFold,
  sectionsByTag,
  useGameTags,
  useTaggedRows,
  type TaggedRow,
} from './gameTags';
import { useAtlas } from './store';

/**
 * What Games and the Library share to list the games (see
 * `components/GameListTools.tsx` for what they show): the rows found by
 * what was typed, their headings when grouped, and the words of compact rows.
 */

/**
 * Where a game came from, in a few words, for a compact row: the site it
 * was read from (else its importer), or how it got here. `folderWords` is
 * said of a game in the maps folder that was not read from pages.
 */
export function sourceWords(listed: ListedPack | undefined, folderWords: string): string {
  if (!listed) return 'Comes with the app';
  if (listed.guidebooks) return 'Guidebooks';
  if (listed.madeInApp) return 'Made in Atlas';
  if (listed.imported) return siteOf(listed.pages) ?? listed.imported.importerTitle;
  if (listed.bundled || listed.origin === 'bundled') return 'Comes with the app';
  if (listed.origin === 'location') return 'In a folder you added';
  if (listed.origin === 'packs-folder' || listed.origin === 'opened-file') {
    return 'From a pack file';
  }
  return folderWords;
}

/** What games hold, added up, in a few words ("3 maps, 12 guides"); null when nothing is known. */
export function holdsWords(
  contents: readonly (Pick<PackDetails['contents'], 'maps' | 'guides'> | undefined)[],
): string | null {
  const known = contents.filter((c) => c !== undefined);
  if (known.length === 0) return null;
  const maps = known.reduce((sum, c) => sum + c.maps, 0);
  const guides = known.reduce((sum, c) => sum + c.guides, 0);
  const parts = [
    maps > 0 ? `${numberFormat.format(maps)} ${maps === 1 ? 'map' : 'maps'}` : null,
    guides > 0 ? `${numberFormat.format(guides)} ${guides === 1 ? 'guide' : 'guides'}` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * What each compact row says in small text: where the game came from (the
 * names of a title's sources) and what it holds, when that is known
 * already. Worked out when the rows or what is known of them change.
 */
export function useRowWords(
  items: readonly TaggedRow[],
  folderWords: string,
): ReadonlyMap<string, { sources: string; holds: string | null }> {
  const packs = useAtlas((s) => s.library?.packs);
  const catalog = useAtlas((s) => s.catalog);
  const facts = useGameFacts((s) => s.byId);
  const sourceFacts = useGameGroups((s) => s.facts);
  return useMemo(() => {
    const byId = new Map(packs?.map((pack) => [pack.id, pack]));
    return new Map(
      items.map((item) => {
        const { row } = item;
        if (row.kind === 'title') {
          const names = namesOfSources(row.group, catalog, sourceFacts);
          return [
            item.id,
            {
              sources: `Sources: ${row.entries.map((e) => names.get(e.id) ?? e.title).join(', ')}`,
              holds: holdsWords(row.entries.map((e) => facts[e.id]?.details?.contents)),
            },
          ];
        }
        return [
          item.id,
          {
            sources: sourceWords(byId.get(row.entry.id), folderWords),
            holds: holdsWords([facts[row.entry.id]?.details?.contents]),
          },
        ];
      }),
    );
  }, [items, packs, catalog, facts, sourceFacts, folderWords]);
}

/** The games to list: the rows found by what was typed, and their headings when grouped. */
export function useGamesList(rows: readonly TitleRow<PackEntry>[], folderWords: string) {
  const { items, tagGroups } = useTaggedRows(rows, folderWords);
  const view = useGameTags((s) => s.view);
  const groupById = useGameTags((s) => s.groupBy);
  const folded = useGameTags((s) => s.folded);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    void loadGameTags();
  }, []);
  // A group removed since: one after another.
  const groupBy = tagGroups.find((group) => group.id === groupById) ?? null;
  const typed = nameFold(filter.trim());
  const shown = useMemo(
    () => items.filter((item) => matchesName(item.words, typed)),
    [items, typed],
  );
  const sections = useMemo(
    () => (groupBy ? sectionsByTag(shown, (item) => item.tags[groupBy.id] ?? []) : null),
    [shown, groupBy],
  );
  return {
    items,
    shown,
    sections,
    tagGroups,
    view,
    groupBy,
    folded,
    filter,
    setFilter,
    /** Something is typed: every heading with a game found shows it, folded or not. */
    finding: typed !== '',
  };
}
