import { describe, expect, it } from 'vitest';
import {
  GAME_GROUPS_FORMAT,
  GAME_GROUP_FORMAT,
  readGameGroupFile,
  readGameGroupsFile,
  writeGameGroupFile,
  writeGameGroupsFile,
  type GameGroup,
} from './index';

const NOW = new Date('2026-11-14T10:00:00.000Z');

const groups = (): GameGroup[] => [
  {
    id: 'g-isles',
    title: 'Sundered Isles',
    members: [{ gameId: 'isles-maps' }, { gameId: 'isles-other' }, { gameId: 'isles-wiki' }],
  },
  { id: 'g-valley', title: 'Test Valley', members: [{ gameId: 'valley' }, { gameId: 'vale' }] },
];

describe('games under one title', () => {
  it('are written strictly with their header and read back whole', () => {
    const text = writeGameGroupsFile(groups(), NOW);
    const value = JSON.parse(text) as Record<string, unknown>;
    expect(value).toMatchObject({
      format: GAME_GROUPS_FORMAT,
      version: 1,
      updatedAt: NOW.toISOString(),
    });
    const read = readGameGroupsFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file).toEqual({ version: 1, groups: groups(), skipped: 0 });
  });

  it('refuses what is not valid when writing', () => {
    const write = (value: GameGroup[]) => () => writeGameGroupsFile(value, NOW);
    const [isles, valley] = groups() as [GameGroup, GameGroup];
    // One game, a game under two titles, the same id twice.
    expect(write([{ ...isles, members: [{ gameId: 'isles-maps' }] }])).toThrow();
    expect(
      write([isles, { ...valley, members: [{ gameId: 'valley' }, { gameId: 'isles-wiki' }] }]),
    ).toThrow();
    expect(write([isles, { ...valley, id: isles.id }])).toThrow();
    // An empty or too long title, a game id or group id that is not one.
    expect(write([{ ...isles, title: '  ' }])).toThrow();
    expect(write([{ ...isles, title: 'x'.repeat(201) }])).toThrow();
    expect(write([{ ...isles, members: [{ gameId: 'Isles' }, { gameId: 'b' }] }])).toThrow();
    expect(write([{ ...isles, id: 'Not an id' }])).toThrow();
  });

  it('reads tolerantly: what cannot be read is left out and counted', () => {
    const value = JSON.parse(writeGameGroupsFile(groups(), NOW)) as {
      groups: unknown[];
      later?: unknown;
    };
    value.groups.push(
      // A game already under a title, so this one has one game left.
      { id: 'g-again', title: 'Again', members: [{ gameId: 'valley' }, { gameId: 'new' }] },
      // No title.
      { id: 'g-untitled', members: [{ gameId: 'a' }, { gameId: 'b' }] },
      // A game named twice and one that is not a game id; two games are left.
      {
        id: 'g-hills',
        title: 'Hills',
        members: [{ gameId: 'hills' }, { gameId: 'hills' }, { gameId: 'HILLS!' }, { gameId: 'h2' }],
        later: 'a field a newer app writes',
      },
    );
    value.later = 'something a newer app writes';
    const read = readGameGroupsFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.groups.map((group) => group.id)).toEqual(['g-isles', 'g-valley', 'g-hills']);
    expect(read.file.groups[2]!.members).toEqual([{ gameId: 'hills' }, { gameId: 'h2' }]);
    // valley again, the group left with one, the untitled one, hills twice, HILLS!.
    expect(read.file.skipped).toBe(5);
    // A game of a group left out is free for a later one.
    const later = readGameGroupsFile({
      format: GAME_GROUPS_FORMAT,
      version: 1,
      groups: [
        { id: 'a', title: 'A', members: [{ gameId: 'x' }] },
        { id: 'b', title: 'B', members: [{ gameId: 'x' }, { gameId: 'y' }] },
      ],
    });
    expect(later.ok && later.file.groups.map((group) => group.id)).toEqual(['b']);
  });

  it('says what is not this file, and the version a newer app wrote', () => {
    expect(readGameGroupsFile({ format: 'atlas-own-notes', version: 1 }).ok).toBe(false);
    expect(readGameGroupsFile('text').ok).toBe(false);
    const newer = readGameGroupsFile({ format: GAME_GROUPS_FORMAT, version: 2, groups: [] });
    expect(newer.ok && newer.file.version).toBe(2);
  });
});

describe('the title of one game in a map pack file', () => {
  it('names the game it was made from among the games of its title', () => {
    const [isles] = groups() as [GameGroup];
    const text = writeGameGroupFile('isles-other', isles, NOW);
    expect(JSON.parse(text)).toMatchObject({
      format: GAME_GROUP_FORMAT,
      version: 1,
      gameId: 'isles-other',
      title: 'Sundered Isles',
    });
    const read = readGameGroupFile(JSON.parse(text));
    expect(read).toEqual({
      ok: true,
      group: { gameId: 'isles-other', title: 'Sundered Isles', members: isles.members, version: 1 },
    });
    expect(() => writeGameGroupFile('valley', isles, NOW)).toThrow();
  });

  it('is refused without another game, or without its own', () => {
    const file = (members: unknown[]) => ({
      format: GAME_GROUP_FORMAT,
      version: 1,
      gameId: 'a',
      title: 'A',
      members,
    });
    expect(readGameGroupFile(file([{ gameId: 'a' }, { gameId: 'b' }])).ok).toBe(true);
    expect(readGameGroupFile(file([{ gameId: 'a' }, { gameId: 'a' }])).ok).toBe(false);
    expect(readGameGroupFile(file([{ gameId: 'b' }, { gameId: 'c' }])).ok).toBe(false);
    expect(readGameGroupFile({ ...file([]), format: GAME_GROUPS_FORMAT }).ok).toBe(false);
  });
});
