import { groupOf, randomId, siteOf, titleRows, type PackEntry, type TitleRow } from '@atlas/core';
import type { GameGroup } from '@atlas/schema';
import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import type { ListedPack } from '../desktop';
import { notify, saveSetting } from './actions';
import { useGameFacts } from './gameFacts';
import { useGameGroups } from './gameGroups';
import { progressStore, SETTINGS } from './services';
import { useAtlas } from './store';

/**
 * The person's own tags of their games, in groups of tags, and how Games
 * and the Library list the games: as cards or compact rows, one after
 * another or under a heading for each tag of one group.
 *
 * A tag is a short text of the person's own, such as a console's name or
 * "Puzzle", in a group of tags: System and Genre are there from the start,
 * and the person can add groups of their own (such as "Status"), rename
 * them and remove them. A game can have any number of tags, several in one
 * group too. The tags of games shown under one title (see `gameGroups.ts`)
 * are the title's.
 *
 * Tags are the person's own data: kept in the app's own storage on this
 * device, where progress is kept (the `gameTags` setting), never in a
 * game's files. What is kept, by key ({@link tagsKey}): the tags of a game
 * (`game:<id>`) or a title (`title:<group id>`), by group of tags. A group
 * of a game the person has not changed has the tags the game's pack
 * suggests ({@link suggestedTags}), which count as the game's tags until
 * the person changes that group's tags, taking them all off included. A
 * title has, in a group the person has not changed for it, the tags its
 * games have there, so a game keeps its tags when it is put under a title.
 *
 * How the games are listed (the view, the group of tags they are grouped
 * by, the headings folded) is this device's own too (the `gamesList`
 * setting), the same for Games and the Library.
 */

/** The longest tag or name of a group kept, in characters. */
export const MAX_TAG_LENGTH = 60;

/** The most groups of one's own kept. */
export const MAX_OWN_GROUPS = 20;

/** A group of tags. */
export interface TagGroup {
  id: string;
  name: string;
  /** Added by the person: it can be renamed and removed. */
  own: boolean;
  /** Filled in by the app from what each game is (see {@link autoTags}): never typed, never kept. */
  auto?: boolean;
}

/** The groups the app fills in: where each game came from, and what it holds. */
export const AUTO_GROUPS: readonly TagGroup[] = [
  { id: 'source', name: 'Source', own: false, auto: true },
  { id: 'contents', name: 'Contents', own: false, auto: true },
];

/** The groups of the person's tags there are from the start. */
export const BUILT_IN_GROUPS: readonly TagGroup[] = [
  { id: 'system', name: 'System', own: false },
  { id: 'genre', name: 'Genre', own: false },
];

/** Tags by group id. */
export type TagsByGroup = Readonly<Record<string, readonly string[]>>;

/** What the person chose, by {@link tagsKey}, then by group id: the tags of that group (empty: none, on purpose). */
export type TagChoices = Readonly<Record<string, TagsByGroup>>;

/** How the games are listed: as cards with their state, or one short row each. */
export type GamesView = 'cards' | 'compact';

/** A tag a game's pack suggests, in a group. */
export interface SuggestedTag {
  group: string;
  name: string;
}

/**
 * The tags a game gets from its pack until the person changes its tags of
 * that group: the system its pack names (the listing's `system`, such as
 * a console), as a tag of the System group.
 */
export function suggestedTags(pack: ListedPack | undefined): SuggestedTag[] {
  const system = pack?.system?.trim();
  return system ? [{ group: 'system', name: system }] : [];
}

/** The tags each game's pack suggests, by game id (see {@link suggestedTags}). */
export type Suggest = (gameId: string) => readonly SuggestedTag[];

const NO_SUGGESTION: readonly SuggestedTag[] = [];

/** The suggestions of the games listed, tidied, by game id. */
export function suggestionsOf(
  packs: readonly ListedPack[] | undefined,
  suggest: (pack: ListedPack | undefined) => readonly SuggestedTag[] = suggestedTags,
): Suggest {
  const byId = new Map<string, SuggestedTag[]>();
  for (const pack of packs ?? []) {
    const tags = suggest(pack).flatMap((tag) => {
      const name = tidyTag(tag.name);
      return name ? [{ group: tag.group, name }] : [];
    });
    if (tags.length > 0) byId.set(pack.id, tags);
  }
  return (gameId) => byId.get(gameId) ?? NO_SUGGESTION;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** A tag or a group's name as kept: spaces tidied and cut to {@link MAX_TAG_LENGTH}; null when nothing is left. */
export function tidyTag(text: string): string | null {
  const tidy = text.replace(/\s+/gu, ' ').trim();
  if (tidy === '') return null;
  const letters = Array.from(graphemes.segment(tidy), (part) => part.segment);
  return letters.slice(0, MAX_TAG_LENGTH).join('').trim();
}

/** The same tag, whatever its capitals: "Tern 16" and "tern 16" are one. */
export function tagFold(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase('en');
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Tags each once whatever their capitals (the first spelling kept), A to Z. */
export function uniqueTags(names: Iterable<string | null | undefined>): string[] {
  const byFold = new Map<string, string>();
  for (const name of names) {
    if (name && !byFold.has(tagFold(name))) byFold.set(tagFold(name), name);
  }
  return [...byFold.values()].sort((a, b) => collator.compare(a, b));
}

/** Whether two lists hold the same tags, whatever their order and capitals. */
export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(tagFold));
  const right = new Set(b.map(tagFold));
  return left.size === right.size && [...left].every((tag) => right.has(tag));
}

/** Where a game's tags are kept: its title's when it is shown under one, else its own. */
export function tagsKey(gameId: string, groups: readonly GameGroup[]): string {
  const group = groupOf(groups, gameId);
  return group ? titleKey(group.id) : gameKey(gameId);
}

/** Where a title's tags are kept. */
export const titleKey = (groupId: string) => `title:${groupId}`;
const gameKey = (gameId: string) => `game:${gameId}`;

/** The tags the person chose for a key in a group, if they did. */
function chosen(choices: TagChoices, key: string, group: string): readonly string[] | null {
  const byGroup = choices[key];
  return byGroup && Object.hasOwn(byGroup, group) ? (byGroup[group] ?? []) : null;
}

/** A game's own tags in a group, apart from any title: as set, else as suggested. */
function ownTags(
  gameId: string,
  group: string,
  choices: TagChoices,
  suggest: Suggest,
): readonly string[] {
  return (
    chosen(choices, gameKey(gameId), group) ??
    suggest(gameId).flatMap((tag) => (tag.group === group ? [tag.name] : []))
  );
}

/** A title's tags: in each group, as set for it, else those of its games. */
export function tagsOfTitle(
  group: GameGroup,
  tagGroups: readonly TagGroup[],
  choices: TagChoices,
  suggest: Suggest,
): TagsByGroup {
  return Object.fromEntries(
    tagGroups.map((tagGroup) => [
      tagGroup.id,
      uniqueTags(
        chosen(choices, titleKey(group.id), tagGroup.id) ??
          group.members.flatMap(({ gameId }) => ownTags(gameId, tagGroup.id, choices, suggest)),
      ),
    ]),
  );
}

/** A game's tags: its title's when it is shown under one, else its own. */
export function tagsOfGame(
  gameId: string,
  groups: readonly GameGroup[],
  tagGroups: readonly TagGroup[],
  choices: TagChoices,
  suggest: Suggest,
): TagsByGroup {
  const group = groupOf(groups, gameId);
  if (group) return tagsOfTitle(group, tagGroups, choices, suggest);
  return Object.fromEntries(
    tagGroups.map((tagGroup) => [
      tagGroup.id,
      uniqueTags(ownTags(gameId, tagGroup.id, choices, suggest)),
    ]),
  );
}

/** The tags of a row of a list of games. */
export function tagsOfRow<E extends { id: string }>(
  row: TitleRow<E>,
  groups: readonly GameGroup[],
  tagGroups: readonly TagGroup[],
  choices: TagChoices,
  suggest: Suggest,
): TagsByGroup {
  return row.kind === 'title'
    ? tagsOfTitle(row.group, tagGroups, choices, suggest)
    : tagsOfGame(row.entry.id, groups, tagGroups, choices, suggest);
}

/** The heading key of the games without a tag of the group (a tag's key is its name folded, never empty). */
export const WITHOUT_TAG = '';

/** Games under one heading: a tag, or none of the group. */
export interface TagSection<R> {
  /** The tag folded ({@link tagFold}), or {@link WITHOUT_TAG}. */
  key: string;
  /** The tag as first spelled; null for the games without one. */
  name: string | null;
  rows: R[];
}

/**
 * The rows under a heading for each tag, A to Z, each in the order given;
 * a row with two tags stands under both; those without one last.
 */
export function sectionsByTag<R>(
  rows: readonly R[],
  tagsOf: (row: R) => readonly string[],
): TagSection<R>[] {
  const sections = new Map<string, TagSection<R>>();
  const add = (key: string, name: string | null, row: R) => {
    let section = sections.get(key);
    if (!section) {
      section = { key, name, rows: [] };
      sections.set(key, section);
    }
    if (section.rows.at(-1) !== row) section.rows.push(row);
  };
  for (const row of rows) {
    const tags = tagsOf(row);
    if (tags.length === 0) add(WITHOUT_TAG, null, row);
    for (const tag of tags) add(tagFold(tag), tag, row);
  }
  return [...sections.values()].sort((a, b) => {
    if (a.name === null || b.name === null) return a.name === null ? 1 : -1;
    return collator.compare(a.name, b.name);
  });
}

/** The heading of the games without a tag of a group. */
export function withoutTagName(group: TagGroup): string {
  if (group.id === 'contents') return 'Not known yet';
  if (group.id === 'source') return 'No source';
  if (group.id === 'system') return 'No system';
  if (group.id === 'genre') return 'No genre';
  return 'Without a tag';
}

/** Text as compared when finding a game: no accents, no capitals. */
export function nameFold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
}

/** Whether any of a row's words ({@link nameFold}ed) holds what was typed (folded too); everything matches nothing typed. */
export function matchesName(words: readonly string[], folded: string): boolean {
  if (folded === '') return true;
  return words.some((word) => word.includes(folded));
}

/** The names a row can be found by: its title, and for a title those of its games too. */
export function rowNames<E extends { id: string; title: string }>(row: TitleRow<E>): string[] {
  return row.kind === 'title'
    ? [row.group.title, ...row.entries.map((entry) => entry.title)]
    : [row.entry.title];
}

/** Every group of the person's tags: those from the start, then their own. */
export function allGroups(own: readonly TagGroup[]): TagGroup[] {
  return [...BUILT_IN_GROUPS, ...own];
}

/** Every group of tags, those the app fills in first: as "Group by" offers them. */
export function everyGroup(own: readonly TagGroup[]): TagGroup[] {
  return [...AUTO_GROUPS, ...allGroups(own)];
}

// ---------------------------------------------------------------------------
// The tags the app fills in

/**
 * Where a game came from, as a tag of Source: the importer that read it
 * (as its source is named under a title, see `sourceNames` in core), "Made
 * in Atlas" for a game made in the app, else how it got here, in the words
 * of the screen (`folderWords` for a game in the maps folder that was not
 * read from pages).
 */
export function sourceTag(
  listed: Pick<ListedPack, 'madeInApp' | 'imported' | 'bundled' | 'origin' | 'pages'> | undefined,
  folderWords: string,
): string {
  if (!listed) return 'Comes with the app';
  if (listed.madeInApp) return 'Made in Atlas';
  const importer = listed.imported?.importerTitle.trim();
  if (importer) return importer;
  if (listed.imported) return siteOf(listed.pages) ?? folderWords;
  if (listed.bundled || listed.origin === 'bundled') return 'Comes with the app';
  if (listed.origin === 'location') return 'In a folder you added';
  if (listed.origin === 'packs-folder' || listed.origin === 'opened-file') {
    return 'From a pack file';
  }
  return folderWords;
}

/**
 * What a game holds, as tags of Contents, as the Library tells games apart
 * (see `gameKind`): Maps for a game with a map; its pages are Guides beside
 * maps, and Wiki pages in a game of pages only. None while it is not known.
 */
export function contentsTags(
  contents: { maps: number; guides: number } | undefined | null,
): string[] {
  if (!contents) return [];
  return [
    ...(contents.maps > 0 ? ['Maps'] : []),
    ...(contents.guides > 0 ? [contents.maps > 0 ? 'Guides' : 'Wiki pages'] : []),
  ];
}

/** What is known of the games, to fill in the tags of Source and Contents. */
export interface AutoFacts {
  listed: (gameId: string) => ListedPack | undefined;
  contents: (gameId: string) => { maps: number; guides: number } | undefined | null;
  /** Said of a game in the maps folder that was not read from pages. */
  folderWords: string;
}

/** The tags the app fills in for a row: those of each of its games. */
export function autoTags<E extends { id: string }>(
  row: TitleRow<E>,
  facts: AutoFacts,
): TagsByGroup {
  const ids = row.kind === 'title' ? row.entries.map((entry) => entry.id) : [row.entry.id];
  return {
    source: uniqueTags(ids.map((id) => sourceTag(facts.listed(id), facts.folderWords))),
    contents: uniqueTags(ids.flatMap((id) => contentsTags(facts.contents(id)))),
  };
}

// ---------------------------------------------------------------------------
// The rows of a list, with their tags

/** A row of a list of games with its tags, worked out once for the whole list. */
export interface TaggedRow {
  row: TitleRow<PackEntry>;
  /** The row's key in the list: its title's or its game's id. */
  id: string;
  tags: TagsByGroup;
  /** What the row is found by, folded (see {@link nameFold}): its names and tags. */
  words: string[];
}

/** See {@link useTaggedRows}. `before` are the rows worked out last time: those that did not change are kept as they were. */
export function tagRows(
  rows: readonly TitleRow<PackEntry>[],
  groups: readonly GameGroup[],
  tagGroups: readonly TagGroup[],
  choices: TagChoices,
  suggest: Suggest,
  auto: AutoFacts | null = null,
  before: ReadonlyMap<string, TaggedRow> = new Map(),
): { items: TaggedRow[]; known: Record<string, string[]> } {
  const items = rows.map((row): TaggedRow => {
    const id = row.kind === 'title' ? row.group.id : row.entry.id;
    const tags = {
      ...(auto ? autoTags(row, auto) : {}),
      ...tagsOfRow(row, groups, tagGroups, choices, suggest),
    };
    const last = before.get(id);
    if (last?.row === row && sameTagsByGroup(last.tags, tags)) return last;
    return {
      row,
      id,
      tags,
      words: [...rowNames(row), ...Object.values(tags).flat()].map(nameFold),
    };
  });
  const known = Object.fromEntries(
    tagGroups.map((group) => [group.id, uniqueTags(items.flatMap((i) => i.tags[group.id] ?? []))]),
  );
  return { items, known };
}

function sameTagsByGroup(a: TagsByGroup, b: TagsByGroup): boolean {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => {
      const left = a[key] ?? [];
      const right = b[key];
      return right?.length === left.length && left.every((t, i) => t === right[i]);
    })
  );
}

/**
 * The rows of a list of games with their tags (Source and Contents among
 * them, from what the shell lists and what is known of each game's
 * contents), and the tags there are in each group: worked out again only
 * when the games, titles, tags or what is known of them change, never for
 * each row as it is drawn. A row that did not change stays the same object.
 */
export function useTaggedRows(rows: readonly TitleRow<PackEntry>[], folderWords: string) {
  const groups = useGameGroups((s) => s.groups);
  const own = useGameTags((s) => s.groups);
  const choices = useGameTags((s) => s.choices);
  const packs = useAtlas((s) => s.library?.packs);
  const facts = useGameFacts((s) => s.byId);
  const tagGroups = useMemo(() => allGroups(own), [own]);
  const last = useRef<ReadonlyMap<string, TaggedRow>>(new Map());
  const tagged = useMemo(() => {
    const byId = new Map(packs?.map((pack) => [pack.id, pack]));
    const made = tagRows(
      rows,
      groups,
      tagGroups,
      choices,
      suggestionsOf(packs),
      {
        listed: (id) => byId.get(id),
        contents: (id) => facts[id]?.details?.contents,
        folderWords,
      },
      last.current,
    );
    return made;
  }, [rows, groups, tagGroups, choices, packs, facts, folderWords]);
  useEffect(() => {
    last.current = new Map(tagged.items.map((item) => [item.id, item]));
  }, [tagged]);
  return { ...tagged, tagGroups: everyGroup(own) };
}

/** A game's tags (its title's under one), where they are kept, every group and the tags there are in each. */
export function useTagsOfGame(gameId: string) {
  const catalog = useAtlas((s) => s.catalog);
  const groups = useGameGroups((s) => s.groups);
  const own = useGameTags((s) => s.groups);
  const choices = useGameTags((s) => s.choices);
  const packs = useAtlas((s) => s.library?.packs);
  useEffect(() => {
    void loadGameTags();
  }, []);
  return useMemo(() => {
    const suggest = suggestionsOf(packs);
    const tagGroups = allGroups(own);
    return {
      tags: tagsOfGame(gameId, groups, tagGroups, choices, suggest),
      key: tagsKey(gameId, groups),
      tagGroups,
      known: tagRows(titleRows(catalog, groups), groups, tagGroups, choices, suggest).known,
    };
  }, [gameId, catalog, groups, own, choices, packs]);
}

// ---------------------------------------------------------------------------
// The store

export interface GameTagsState {
  /** The tags have been read from this device. */
  ready: boolean;
  /** The person's own groups. */
  groups: readonly TagGroup[];
  choices: TagChoices;
  view: GamesView;
  /** The group of tags the games are listed under, by id; `none`: one after another. */
  groupBy: string;
  /** The headings folded, by `<group id>:<tag key>` (see {@link TagSection.key}). */
  folded: readonly string[];
  /** The person changed how games are listed since the app started: what is kept, read later, is older. */
  listChosen: boolean;
}

export const useGameTags = create<GameTagsState>()(() => ({
  ready: false,
  groups: [],
  choices: {},
  view: 'cards',
  groupBy: 'none',
  folded: [],
  listChosen: false,
}));

const get = useGameTags.getState;
const set = useGameTags.setState;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The tags and groups as kept: what could be read of them. */
export function parseGameTags(value: unknown): {
  groups: TagGroup[];
  choices: Record<string, Record<string, string[]>>;
} {
  const kept = isRecord(value) ? value : {};
  const groups: TagGroup[] = [];
  const names = new Set(everyGroup([]).map((group) => tagFold(group.name)));
  for (const group of Array.isArray(kept.groups) ? kept.groups : []) {
    if (!isRecord(group) || typeof group.id !== 'string' || typeof group.name !== 'string')
      continue;
    const name = tidyTag(group.name);
    if (!/^own-[a-z0-9-]{1,40}$/u.test(group.id) || !name || names.has(tagFold(name))) continue;
    if (groups.some((other) => other.id === group.id) || groups.length >= MAX_OWN_GROUPS) continue;
    names.add(tagFold(name));
    groups.push({ id: group.id, name, own: true });
  }
  const ids = new Set(allGroups(groups).map((group) => group.id));
  const choices: Record<string, Record<string, string[]>> = {};
  for (const [key, byGroup] of Object.entries(isRecord(kept.tags) ? kept.tags : {})) {
    if (!/^(game|title):./u.test(key) || !isRecord(byGroup)) continue;
    const read: Record<string, string[]> = {};
    for (const [group, tags] of Object.entries(byGroup)) {
      if (!ids.has(group) || !Array.isArray(tags)) continue;
      read[group] = uniqueTags(
        tags.map((tag) => (typeof tag === 'string' ? tidyTag(tag) : null)),
      ).slice(0, 100);
    }
    if (Object.keys(read).length > 0) choices[key] = read;
  }
  return { groups, choices };
}

/** How the games are listed, as kept: what could be read of it, else as at first. */
export function parseGamesList(value: unknown): Pick<GameTagsState, 'view' | 'groupBy' | 'folded'> {
  const kept = isRecord(value) ? value : {};
  return {
    view: kept.view === 'compact' ? 'compact' : 'cards',
    groupBy: typeof kept.groupBy === 'string' && kept.groupBy !== '' ? kept.groupBy : 'none',
    folded: Array.isArray(kept.folded)
      ? kept.folded.filter((key): key is string => typeof key === 'string').slice(0, 500)
      : [],
  };
}

let loading: Promise<void> | null = null;

/** Reads the tags and how the games are listed, once. */
export function loadGameTags(): Promise<void> {
  loading ??= (async () => {
    let tags: unknown = null;
    let list: unknown = null;
    try {
      const store = progressStore();
      [tags, list] = await Promise.all([
        store.getSetting(SETTINGS.gameTags),
        store.getSetting(SETTINGS.gamesList),
      ]);
    } catch {
      // As at first: no tags, the cards.
    }
    const read = parseGameTags(tags);
    // Tags set meanwhile are kept, over what was read.
    set({
      ready: true,
      groups: get().groups.length > 0 ? get().groups : read.groups,
      choices: { ...read.choices, ...get().choices },
    });
    if (!get().listChosen) set(parseGamesList(list));
  })();
  return loading;
}

function saveList(): void {
  const { view, groupBy, folded } = get();
  saveSetting(SETTINGS.gamesList, { view, groupBy, folded });
}

/** Shows the games as cards or compact rows, and keeps it for the next time. */
export function setGamesView(view: GamesView): void {
  set({ view, listChosen: true });
  saveList();
}

/** Lists the games one after another (`none`), or under the tags of a group, and keeps it. */
export function setGamesGrouping(groupBy: string): void {
  set({ groupBy, listChosen: true });
  saveList();
}

/** Folds a heading away, or opens it again, and keeps it. */
export function setHeadingFolded(key: string, folded: boolean): void {
  const others = get().folded.filter((k) => k !== key);
  set({ folded: folded ? [...others, key] : others, listChosen: true });
  saveList();
}

function saveTags(): void {
  const { groups, choices } = get();
  saveSetting(SETTINGS.gameTags, { version: 1, groups, tags: choices });
}

/** Spells each tag as one of `known` when it is one whatever its capitals. */
function spelled(tags: readonly string[], known: readonly string[]): string[] {
  return uniqueTags(
    tags.map((tag) => {
      const tidy = tidyTag(tag);
      return tidy ? (known.find((other) => tagFold(other) === tagFold(tidy)) ?? tidy) : null;
    }),
  );
}

/**
 * Sets the tags kept at `key` (see {@link tagsKey}) in the groups given:
 * those groups' tags are then the person's, even none, and no suggestion
 * takes their place. Other groups are left as they were. Says so, with Undo.
 */
export async function setTags(
  key: string,
  changes: Readonly<Record<string, readonly string[]>>,
  title: string,
  known: Readonly<Record<string, readonly string[]>> = {},
): Promise<void> {
  await loadGameTags();
  const groups = Object.keys(changes);
  if (groups.length === 0) return;
  const before = get().choices;
  const next = { ...before[key] };
  for (const group of groups) next[group] = spelled(changes[group] ?? [], known[group] ?? []);
  set({ choices: { ...before, [key]: next } });
  saveTags();
  notify(`The tags of ${title} are saved.`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        set({ choices: before });
        saveTags();
        notify('Undone.');
      },
    },
  });
}

/** Why a name cannot be a group's name, or null when it can. */
export function groupNameProblem(name: string, except: string | null = null): string | null {
  const tidy = tidyTag(name);
  if (!tidy) return 'Type the name of the group.';
  const taken = everyGroup(get().groups).some(
    (group) => group.id !== except && tagFold(group.name) === tagFold(tidy),
  );
  return taken ? `There is a group named ${tidy} already.` : null;
}

/** Adds a group of the person's own; returns it, or why it could not be added. */
export async function addTagGroup(name: string): Promise<TagGroup | string> {
  await loadGameTags();
  const problem = groupNameProblem(name);
  if (problem) return problem;
  if (get().groups.length >= MAX_OWN_GROUPS) {
    return `You have ${MAX_OWN_GROUPS} groups of your own, the most there can be.`;
  }
  const group: TagGroup = { id: `own-${randomId().slice(0, 10)}`, name: tidyTag(name)!, own: true };
  set({ groups: [...get().groups, group] });
  saveTags();
  return group;
}

/** Renames a group of the person's own; returns why it could not, or null. */
export async function renameTagGroup(id: string, name: string): Promise<string | null> {
  await loadGameTags();
  const problem = groupNameProblem(name, id);
  if (problem) return problem;
  set({
    groups: get().groups.map((group) =>
      group.id === id ? { ...group, name: tidyTag(name)! } : group,
    ),
  });
  saveTags();
  return null;
}

/** Removes a group of the person's own, and its tags from every game. Says so, with Undo. */
export async function removeTagGroup(id: string): Promise<void> {
  await loadGameTags();
  const before = get();
  const group = before.groups.find((g) => g.id === id);
  if (!group) return;
  const choices = Object.fromEntries(
    Object.entries(before.choices).flatMap(([key, byGroup]) => {
      const rest = Object.fromEntries(Object.entries(byGroup).filter(([g]) => g !== id));
      return Object.keys(rest).length > 0 ? [[key, rest]] : [];
    }),
  );
  set({ groups: before.groups.filter((g) => g.id !== id), choices });
  saveTags();
  if (before.groupBy === id) setGamesGrouping('none');
  notify(`The group ${group.name} is removed, and its tags with it.`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        set({ groups: before.groups, choices: before.choices });
        saveTags();
        notify('Undone.');
      },
    },
  });
}
