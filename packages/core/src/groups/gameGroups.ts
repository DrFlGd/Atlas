import { MAX_GROUP_MEMBERS, type GameGroup } from '@atlas/schema';
import { normalizeText } from '../search/searchIndex';

/**
 * Games shown under one title (see `gameGroups.ts` in the schema package):
 * the rows a list of games shows, the name of each source, which source a
 * title opens, and the pure changes the app makes to the groups. Every
 * change returns new groups and leaves what it was given as it was.
 *
 * Nothing here merges games: each source stays a game of its own, with its
 * own ids, found marks, lists and notes.
 */

/**
 * A title tidied for comparing: without case, accents or punctuation, its
 * words joined by single spaces, so "The Isle: Remastered" and "the isle
 * remastered" are the same title.
 */
export function titleKey(title: string): string {
  return normalizeText(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ');
}

/** The group a game is in, if any. */
export function groupOf(groups: readonly GameGroup[], gameId: string): GameGroup | undefined {
  return groups.find((group) => group.members.some((member) => member.gameId === gameId));
}

const members = (ids: readonly string[]) => ids.map((gameId) => ({ gameId }));
const idsOf = (group: GameGroup | undefined) => group?.members.map((m) => m.gameId) ?? [];

/**
 * Shows `other` with `first` under one `title`. A game already under a
 * title brings that title's games with it, so the games of both end up in
 * one group: the group of `first`, or a new one (`newId`). Throws when the
 * title would hold too many games.
 */
export function joinGames(
  groups: readonly GameGroup[],
  first: string,
  other: string,
  title: string,
  newId: string,
): GameGroup[] {
  const named = title.trim();
  if (named === '') throw new Error('A title needs a name.');
  if (first === other) throw new Error('A game cannot be shown with itself.');
  const a = groupOf(groups, first);
  const b = groupOf(groups, other);
  const ids = [...new Set([...(a ? idsOf(a) : [first]), ...(b ? idsOf(b) : [other])])];
  if (ids.length > MAX_GROUP_MEMBERS) {
    throw new Error(`A title can show ${MAX_GROUP_MEMBERS} games at most.`);
  }
  const joined: GameGroup = { id: a?.id ?? b?.id ?? newId, title: named, members: members(ids) };
  if (a) return groups.flatMap((group) => (group === a ? [joined] : group === b ? [] : [group]));
  if (b) return groups.map((group) => (group === b ? joined : group));
  return [...groups, joined];
}

/** Gives a group another title. */
export function renameGroup(
  groups: readonly GameGroup[],
  groupId: string,
  title: string,
): GameGroup[] {
  const named = title.trim();
  if (named === '') throw new Error('A title needs a name.');
  return groups.map((group) => (group.id === groupId ? { ...group, title: named } : group));
}

/** Shows the games of a group separately again. */
export function ungroup(groups: readonly GameGroup[], groupId: string): GameGroup[] {
  return groups.filter((group) => group.id !== groupId);
}

/**
 * Takes one game out of its group: it is shown on its own again. A group
 * left with one game is no more.
 */
export function takeOut(groups: readonly GameGroup[], gameId: string): GameGroup[] {
  const group = groupOf(groups, gameId);
  if (!group) return [...groups];
  const left = group.members.filter((member) => member.gameId !== gameId);
  if (left.length < 2) return groups.filter((g) => g !== group);
  return groups.map((g) => (g === group ? { ...g, members: left } : g));
}

/** Makes `gameId` the first game of its group, the one its title opens the first time. */
export function makeFirst(groups: readonly GameGroup[], gameId: string): GameGroup[] {
  const group = groupOf(groups, gameId);
  if (!group || group.members[0]?.gameId === gameId) return [...groups];
  const ids = [gameId, ...idsOf(group).filter((id) => id !== gameId)];
  return groups.map((g) => (g === group ? { ...g, members: members(ids) } : g));
}

/**
 * Adds the group a map pack file carried: the file's game joins the group
 * one of its games is in already, with the file's other games that are in
 * no group; when none is in a group, the file's group is added as it is
 * (`newId`), its games that are not on this device included, so the title
 * shows once they are. A game already under another title stays there.
 * `group` is the group the file's game is in afterwards, if any.
 */
export function addCarriedGroup(
  groups: readonly GameGroup[],
  carried: { gameId: string; title: string; members: readonly { gameId: string }[] },
  newId: string,
): { groups: GameGroup[]; group: GameGroup | null } {
  const carriedIds = [...new Set([carried.gameId, ...carried.members.map((m) => m.gameId)])];
  const here =
    groupOf(groups, carried.gameId) ??
    carriedIds.map((id) => groupOf(groups, id)).find((group) => group !== undefined);
  if (!here) {
    const free = carriedIds.filter((id) => !groupOf(groups, id)).slice(0, MAX_GROUP_MEMBERS);
    if (free.length < 2) return { groups: [...groups], group: null };
    const group: GameGroup = { id: newId, title: carried.title.trim(), members: members(free) };
    return { groups: [...groups, group], group };
  }
  const ids = idsOf(here);
  for (const id of carriedIds) {
    if (ids.length >= MAX_GROUP_MEMBERS) break;
    const already = groupOf(groups, id);
    if (!ids.includes(id) && (!already || already === here)) ids.push(id);
  }
  const group: GameGroup = { ...here, members: members(ids) };
  return { groups: groups.map((g) => (g === here ? group : g)), group };
}

// ---------------------------------------------------------------------------
// As a list of games shows them

/** One row of a list of games: a game alone, or a title with its sources on this device. */
export type TitleRow<E extends { id: string }> =
  { kind: 'game'; entry: E; group: null } | { kind: 'title'; group: GameGroup; entries: E[] };

/**
 * The rows of a list of games, in its order: the games of a group with two
 * or more on the device become one row, where the first of them is; a group
 * with one game here shows as that game (with its group, for the record).
 */
export function titleRows<E extends { id: string }>(
  catalog: readonly E[],
  groups: readonly GameGroup[],
): TitleRow<E>[] {
  const byId = new Map(catalog.map((entry) => [entry.id, entry]));
  const rows: TitleRow<E>[] = [];
  const done = new Set<string>();
  for (const entry of catalog) {
    if (done.has(entry.id)) continue;
    const group = groupOf(groups, entry.id);
    const entries = group
      ? group.members.flatMap(({ gameId }) => {
          const present = byId.get(gameId);
          return present ? [present] : [];
        })
      : [];
    if (!group || entries.length < 2) {
      rows.push({ kind: 'game', entry, group: null });
      continue;
    }
    for (const present of entries) done.add(present.id);
    rows.push({ kind: 'title', group, entries });
  }
  return rows;
}

/** What is known of a source to name it. */
export interface SourceFacts {
  gameId: string;
  /** The game's own title. */
  title: string;
  /** The title of the importer that made it (its manifest's `source.importer.title`). */
  importerTitle?: string | null;
  /** It was made in the app. */
  madeInApp?: boolean;
}

/**
 * The name of each source of a title, by game id: the importer that made
 * it, "Your own" for a game made in the app, else the game's own title.
 * Sources that would have the same name are numbered in the title's order
 * ("Demo map site 1", "Demo map site 2").
 */
export function sourceNames(sources: readonly SourceFacts[]): Map<string, string> {
  const base = sources.map((source) => {
    const importer = source.importerTitle?.trim();
    if (importer) return importer;
    if (source.madeInApp) return 'Your own';
    return source.title.trim() || source.gameId;
  });
  const counts = new Map<string, number>();
  for (const name of base) counts.set(titleKey(name), (counts.get(titleKey(name)) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<string, string>();
  sources.forEach((source, i) => {
    const name = base[i]!;
    const key = titleKey(name);
    if ((counts.get(key) ?? 0) < 2) {
      names.set(source.gameId, name);
      return;
    }
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    names.set(source.gameId, `${name} ${n}`);
  });
  return names;
}

/**
 * The source a title opens: the one last used under it when it is still
 * here, else the first one here. A source with a map is chosen before a
 * wiki (`hasMap` false) where the title has one, since a wiki of a title
 * shows in the Guides of every source.
 */
export function sourceToOpen(
  group: GameGroup,
  present: ReadonlySet<string>,
  last: string | null,
  hasMap: (gameId: string) => boolean | undefined = () => true,
): string | null {
  const here = group.members.map((m) => m.gameId).filter((id) => present.has(id));
  const maps = here.filter((id) => hasMap(id) !== false);
  const choices = maps.length > 0 ? maps : here;
  if (last && choices.includes(last)) return last;
  return choices[0] ?? null;
}

/** The other games of a list whose title is the same as this one's, tidied (see {@link titleKey}). */
export function sameTitleGames<E extends { id: string; title: string }>(
  catalog: readonly E[],
  gameId: string,
): E[] {
  const entry = catalog.find((e) => e.id === gameId);
  if (!entry) return [];
  const key = titleKey(entry.title);
  if (key === '') return [];
  return catalog.filter((e) => e.id !== gameId && titleKey(e.title) === key);
}
