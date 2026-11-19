import type { TitleRow } from '@atlas/core';
import type { GameGroup } from '@atlas/schema';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ListedPack } from '../desktop';
import {
  addTagGroup,
  allGroups,
  autoTags,
  contentsTags,
  everyGroup,
  loadGameTags,
  matchesName,
  nameFold,
  parseGameTags,
  parseGamesList,
  removeTagGroup,
  renameTagGroup,
  sectionsByTag,
  setGamesGrouping,
  setGamesView,
  setHeadingFolded,
  setTags,
  sourceTag,
  suggestedTags,
  suggestionsOf,
  tagRows,
  tagsKey,
  tagsOfGame,
  tidyTag,
  titleKey,
  uniqueTags,
  useGameTags,
  withoutTagName,
  type AutoFacts,
  type SuggestedTag,
  type TagChoices,
} from './gameTags';
import { openProgressStore, progressStore, SETTINGS } from './services';

beforeAll(async () => {
  // No IndexedDB here: the store kept in memory, as in a browser that allows none.
  await openProgressStore();
});

/** Until the save under way is done. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A made-up game as the shell lists it, with the system its pack names. */
const listed = (id: string, more: Partial<ListedPack> = {}): ListedPack => ({
  id,
  title: id,
  url: `packs/${id}/`,
  origin: 'maps-folder',
  path: `/maps/${id}`,
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
  ...more,
});

/** The stand-in: suggests the system a listed game names as a System tag, as the real one will. */
const standIn = (pack: ListedPack | undefined): SuggestedTag[] => {
  const system: unknown = pack ? Reflect.get(pack, 'system') : undefined;
  return typeof system === 'string' ? [{ group: 'system', name: system }] : [];
};

const PACKS = [
  listed('emberfall', { system: 'Tern 16' }),
  listed('saltmarsh', { system: 'Heron 64' }),
  listed('glasswing'),
  listed('mossgate', { system: 'Tern 16' }),
];
const suggest = suggestionsOf(PACKS, standIn);
const GROUPS = allGroups([]);

const TITLE: GameGroup = {
  id: 'title-saltmarsh',
  title: 'Saltmarsh',
  members: [{ gameId: 'glasswing' }, { gameId: 'saltmarsh' }],
};

describe('the tags a game gets from its pack', () => {
  it('are the system its pack names, as a tag of the System group', () => {
    expect(suggestedTags(listed('emberfall', { system: 'Tern 16' }))).toEqual([
      { group: 'system', name: 'Tern 16' },
    ]);
    expect(suggestedTags(listed('emberfall', { system: '  ' }))).toEqual([]);
    expect(suggestedTags(listed('emberfall'))).toEqual([]);
    expect(suggestedTags(undefined)).toEqual([]);
    expect(suggestionsOf(PACKS)('emberfall')).toEqual([{ group: 'system', name: 'Tern 16' }]);
  });

  it('count as the game’s tags of their group, tidied', () => {
    expect(tagsOfGame('emberfall', [], GROUPS, {}, suggest)).toEqual({
      system: ['Tern 16'],
      genre: [],
    });
    expect(
      suggestionsOf([listed('mossgate', { system: ' Tern   16 ' })], standIn)('mossgate'),
    ).toEqual([{ group: 'system', name: 'Tern 16' }]);
  });

  it('give way once the person changes that group, taking them all off included', () => {
    const choices: TagChoices = {
      'game:emberfall': { system: ['Tern 16', 'Heron 64'] },
      'game:mossgate': { system: [] },
      // Only the genre changed: the suggested system stays.
      'game:saltmarsh': { genre: ['Puzzle'] },
    };
    expect(tagsOfGame('emberfall', [], GROUPS, choices, suggest).system).toEqual([
      'Heron 64',
      'Tern 16',
    ]);
    expect(tagsOfGame('mossgate', [], GROUPS, choices, suggest).system).toEqual([]);
    expect(tagsOfGame('saltmarsh', [], GROUPS, choices, suggest)).toEqual({
      system: ['Heron 64'],
      genre: ['Puzzle'],
    });
  });

  it('group the games as tags the person set do', () => {
    const rows = ['emberfall', 'glasswing', 'mossgate'].map((id) => ({ id }));
    const choices: TagChoices = { 'game:glasswing': { system: ['tern 16'] } };
    const sections = sectionsByTag(
      rows,
      (row) => tagsOfGame(row.id, [], GROUPS, choices, suggest).system ?? [],
    );
    expect(sections).toEqual([
      {
        key: 'tern 16',
        name: 'Tern 16',
        rows: [{ id: 'emberfall' }, { id: 'glasswing' }, { id: 'mossgate' }],
      },
    ]);
  });
});

describe('the tags of games shown under one title', () => {
  it('are kept for the title', () => {
    expect(tagsKey('saltmarsh', [TITLE])).toBe(titleKey(TITLE.id));
    expect(tagsKey('glasswing', [TITLE])).toBe('title:title-saltmarsh');
    expect(tagsKey('emberfall', [TITLE])).toBe('game:emberfall');
  });

  it('are the title’s where set, else those of its games', () => {
    const own: TagChoices = { 'game:glasswing': { genre: ['Racing'], system: ['Tern 16'] } };
    expect(tagsOfGame('saltmarsh', [TITLE], GROUPS, own, suggest)).toEqual({
      system: ['Heron 64', 'Tern 16'],
      genre: ['Racing'],
    });
    const choices = { ...own, [titleKey(TITLE.id)]: { genre: [] } };
    expect(tagsOfGame('glasswing', [TITLE], GROUPS, choices, suggest)).toEqual({
      system: ['Heron 64', 'Tern 16'],
      genre: [],
    });
  });
});

describe('the tags the app fills in', () => {
  it('name where a game came from', () => {
    const imported = { importerId: 'reeds', importerTitle: 'Reed Archive' };
    expect(sourceTag(listed('a', { imported }), 'In the maps folder')).toBe('Reed Archive');
    expect(sourceTag(listed('b', { madeInApp: true }), 'In the maps folder')).toBe('Made in Atlas');
    expect(sourceTag(listed('c', { origin: 'location' }), 'In the maps folder')).toBe(
      'In a folder you added',
    );
    expect(sourceTag(listed('d'), 'Imported from a pack file')).toBe('Imported from a pack file');
    expect(sourceTag(listed('f', { origin: 'packs-folder' }), 'In the maps folder')).toBe(
      'From a pack file',
    );
    expect(sourceTag(listed('g', { origin: 'opened-file' }), 'In the maps folder')).toBe(
      'From a pack file',
    );
    expect(sourceTag(listed('e', { bundled: true, origin: 'bundled' }), 'x')).toBe(
      'Comes with the app',
    );
    expect(sourceTag(undefined, 'x')).toBe('Comes with the app');
  });

  it('say what a game holds', () => {
    expect(contentsTags({ maps: 2, guides: 0 })).toEqual(['Maps']);
    expect(contentsTags({ maps: 2, guides: 5 })).toEqual(['Maps', 'Guides']);
    expect(contentsTags({ maps: 0, guides: 40 })).toEqual(['Wiki pages']);
    expect(contentsTags(undefined)).toEqual([]);
  });

  it('put a title under each of its sources, and what each holds', () => {
    const facts: AutoFacts = {
      listed: (id) =>
        ({
          glasswing: listed('glasswing', {
            imported: { importerId: 'reeds', importerTitle: 'Reed Archive' },
          }),
          saltmarsh: listed('saltmarsh', { madeInApp: true }),
        })[id],
      contents: (id) => (id === 'glasswing' ? { maps: 0, guides: 12 } : { maps: 3, guides: 0 }),
      folderWords: 'In the maps folder',
    };
    const row: TitleRow<{ id: string; title: string }> = {
      kind: 'title',
      group: TITLE,
      entries: [
        { id: 'glasswing', title: 'Glasswing' },
        { id: 'saltmarsh', title: 'Saltmarsh (old)' },
      ],
    };
    expect(autoTags(row, facts)).toEqual({
      source: ['Made in Atlas', 'Reed Archive'],
      contents: ['Maps', 'Wiki pages'],
    });
    // Found by them, and by its games' names and its tags.
    const { items, known } = tagRows([row as never], [TITLE], GROUPS, {}, suggest, facts);
    expect(matchesName(items[0]!.words, nameFold('reed'))).toBe(true);
    expect(matchesName(items[0]!.words, nameFold('WIKI PAGES'))).toBe(true);
    expect(matchesName(items[0]!.words, nameFold('heron'))).toBe(true);
    expect(matchesName(items[0]!.words, nameFold('saltmarsh (old)'))).toBe(true);
    expect(matchesName(items[0]!.words, nameFold('tern'))).toBe(false);
    expect(known.system).toEqual(['Heron 64']);
    expect(known.source).toBeUndefined();
  });

  it('are offered first to group by, and never kept', () => {
    expect(everyGroup([]).map((group) => group.name)).toEqual([
      'Source',
      'Contents',
      'System',
      'Genre',
    ]);
    expect(
      parseGameTags({ version: 1, tags: { 'game:a': { source: ['x'], system: ['Tern 16'] } } })
        .choices,
    ).toEqual({ 'game:a': { system: ['Tern 16'] } });
  });
});

describe('headings', () => {
  it('are A to Z, a game under each of its tags, those without one last', () => {
    const rows = [
      { id: 'a', tags: ['tern 16'] },
      { id: 'b', tags: [] },
      { id: 'c', tags: ['Heron 64', 'Tern 16'] },
      { id: 'd', tags: ['Tern 2'] },
    ];
    const sections = sectionsByTag(rows, (row) => row.tags);
    expect(sections.map((s) => [s.name, s.rows.map((r) => r.id).join('')])).toEqual([
      ['Heron 64', 'c'],
      ['Tern 2', 'd'],
      ['tern 16', 'ac'],
      [null, 'b'],
    ]);
    expect(sections.at(-1)?.key).toBe('');
  });

  it('name the games without a tag of the group', () => {
    const [source, contents, system, genre] = everyGroup([]);
    expect([source, contents, system, genre].map((g) => withoutTagName(g!))).toEqual([
      'No source',
      'Not known yet',
      'No system',
      'No genre',
    ]);
    expect(withoutTagName({ id: 'own-x', name: 'Status', own: true })).toBe('Without a tag');
  });

  it('name each tag once, A to Z', () => {
    expect(uniqueTags(['Tern 16', null, 'puzzle', 'tern 16', 'Heron 64'])).toEqual([
      'Heron 64',
      'puzzle',
      'Tern 16',
    ]);
  });
});

describe('what is kept', () => {
  it('reads only what it understands', () => {
    expect(tidyTag('   ')).toBeNull();
    expect(tidyTag(' Tern\n16 ')).toBe('Tern 16');
    expect(tidyTag('x'.repeat(80))).toHaveLength(60);
    expect(
      parseGameTags({
        version: 1,
        groups: [
          { id: 'own-status', name: 'Status' },
          { id: 'own-dup', name: 'genre' },
          { id: 'bad id', name: 'Mood' },
        ],
        tags: {
          'game:a': {
            system: ['Tern 16', 'tern 16', 4],
            'own-status': ['Done'],
            'own-gone': ['x'],
          },
          'title:b': { genre: [] },
          other: { genre: ['x'] },
        },
      }),
    ).toEqual({
      groups: [{ id: 'own-status', name: 'Status', own: true }],
      choices: {
        'game:a': { system: ['Tern 16'], 'own-status': ['Done'] },
        'title:b': { genre: [] },
      },
    });
    expect(parseGameTags('nonsense')).toEqual({ groups: [], choices: {} });
    expect(parseGamesList(null)).toEqual({ view: 'cards', groupBy: 'none', folded: [] });
    expect(parseGamesList({ view: 'compact', groupBy: 'genre', folded: ['a', 3] })).toEqual({
      view: 'compact',
      groupBy: 'genre',
      folded: ['a'],
    });
  });

  describe('on this device', () => {
    beforeEach(() => {
      useGameTags.setState({ choices: {}, groups: [] });
    });

    it('keeps tags spelled as those already there, and puts them back with Undo', async () => {
      await loadGameTags();
      await setTags('game:emberfall', { system: [' tern 16 '], genre: [] }, 'Emberfall', {
        system: ['Tern 16'],
      });
      await settled();
      expect(useGameTags.getState().choices).toEqual({
        'game:emberfall': { system: ['Tern 16'], genre: [] },
      });
      expect(await progressStore().getSetting(SETTINGS.gameTags)).toEqual({
        version: 1,
        groups: [],
        tags: { 'game:emberfall': { system: ['Tern 16'], genre: [] } },
      });
      // Another group changed later leaves these as they are.
      await setTags('game:emberfall', { genre: ['Puzzle'] }, 'Emberfall');
      expect(useGameTags.getState().choices['game:emberfall']).toEqual({
        system: ['Tern 16'],
        genre: ['Puzzle'],
      });
    });

    it('adds, renames and removes a group of one’s own, its tags with it', async () => {
      await loadGameTags();
      expect(await addTagGroup('genre')).toBe('There is a group named genre already.');
      expect(await addTagGroup('Source')).toBe('There is a group named Source already.');
      const status = await addTagGroup(' Status ');
      if (typeof status === 'string') throw new Error(status);
      expect(status).toMatchObject({ name: 'Status', own: true });
      expect(await renameTagGroup(status.id, 'System')).toBe(
        'There is a group named System already.',
      );
      expect(await renameTagGroup(status.id, 'Progress')).toBeNull();
      await setTags('game:mossgate', { [status.id]: ['Finished'], genre: ['Racing'] }, 'Mossgate');
      setGamesGrouping(status.id);
      await removeTagGroup(status.id);
      expect(useGameTags.getState().groups).toEqual([]);
      expect(useGameTags.getState().choices).toEqual({ 'game:mossgate': { genre: ['Racing'] } });
      expect(useGameTags.getState().groupBy).toBe('none');
    });

    it('keeps how the games are listed', async () => {
      setGamesView('compact');
      setGamesGrouping('system');
      setHeadingFolded('system:tern 16', true);
      setHeadingFolded('system:', true);
      setHeadingFolded('system:tern 16', false);
      await settled();
      expect(await progressStore().getSetting(SETTINGS.gamesList)).toEqual({
        view: 'compact',
        groupBy: 'system',
        folded: ['system:'],
      });
    });
  });
});
