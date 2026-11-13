import { describe, expect, it } from 'vitest';
import {
  checklistItemSchema,
  checklistSchema,
  isOwnId,
  LIST_FILE_FORMAT,
  listFileSchema,
  OWN_LISTS_FORMAT,
  ownListsFileSchema,
  packReadSchemas,
  readListFile,
  readOwnListsFile,
  writeListFile,
  writeOwnListsFile,
  type OwnList,
} from './index';

const NOW = new Date('2026-11-13T10:00:00.000Z');

function list(id = 'demo:checklist:own.a1'): OwnList {
  return {
    checklist: { id, name: 'Flame build', order: 0, type: 'build' },
    items: [
      {
        id: `demo:checkitem:own.s1`,
        checklistId: id,
        name: 'Start as the scholar',
        order: 1,
        locationIds: [],
        entityIds: [],
        section: 'Early game',
      },
      {
        id: `demo:checkitem:own.s2`,
        checklistId: id,
        name: 'Ember staff',
        order: 2,
        locationIds: ['demo:loc:0001'],
        entityIds: [],
        section: 'Early game',
        note: 'Past ||the bridge||.',
        optional: true,
      },
    ],
    headings: [{ id: 'demo:checkitem:own.h1', title: 'Early game', order: 0 }],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

describe('own ids', () => {
  it('tells own ids from a pack’s', () => {
    expect(isOwnId('demo:checklist:own.a1')).toBe(true);
    expect(isOwnId('demo:checklist:owner')).toBe(false);
    expect(isOwnId('demo:checklist:waystones')).toBe(false);
    expect(isOwnId('not an id')).toBe(false);
  });

  it('keeps own ids out of packs being written, and reads them anyway', () => {
    const own = { id: 'demo:checklist:own.x', name: 'Mine', order: 0 };
    expect(checklistSchema.safeParse(own).success).toBe(false);
    expect(packReadSchemas.checklistSchema.safeParse(own).success).toBe(true);
    const item = {
      id: 'demo:checkitem:own.y',
      checklistId: 'demo:checklist:a',
      name: 'Step',
      order: 0,
      locationIds: [],
      entityIds: [],
    };
    expect(checklistItemSchema.safeParse(item).success).toBe(false);
    expect(packReadSchemas.checklistItemSchema.safeParse(item).success).toBe(true);
  });
});

describe('pack entries', () => {
  it('takes an optional step, and a step with no location', () => {
    const step = {
      id: 'demo:checkitem:a',
      checklistId: 'demo:checklist:a',
      name: 'Raise Mind to 20',
      order: 0,
      locationIds: [],
      entityIds: [],
      optional: true,
    };
    expect(checklistItemSchema.parse(step).optional).toBe(true);
    expect(checklistItemSchema.safeParse({ ...step, optional: 'yes' }).success).toBe(false);
  });
});

describe('the own lists file', () => {
  it('is written strictly and read back', () => {
    const text = writeOwnListsFile('demo', [list()], NOW);
    const value: unknown = JSON.parse(text);
    expect(value).toMatchObject({ format: OWN_LISTS_FORMAT, version: 1, gameId: 'demo' });
    const read = readOwnListsFile(value);
    expect(read).toEqual({
      ok: true,
      file: { gameId: 'demo', version: 1, lists: [list()], skipped: 0 },
    });
  });

  it('refuses to write what is not an own list', () => {
    expect(() => writeOwnListsFile('demo', [list('demo:checklist:waystones')], NOW)).toThrow();
    const wrongList = list();
    wrongList.items[0]!.checklistId = 'demo:checklist:own.other';
    expect(() => writeOwnListsFile('demo', [wrongList], NOW)).toThrow();
    const twice = list();
    twice.headings[0]!.id = twice.items[0]!.id;
    expect(() => writeOwnListsFile('demo', [twice], NOW)).toThrow();
    const extra = { ...list(), colour: 'red' };
    expect(() => writeOwnListsFile('demo', [extra], NOW)).toThrow();
  });

  it('reads a later version tolerantly, leaving out a list it cannot read', () => {
    const value = {
      format: OWN_LISTS_FORMAT,
      version: 7,
      gameId: 'demo',
      somethingNew: true,
      lists: [
        { ...list(), photos: [] },
        { checklist: { id: 'demo:checklist:own.b' } },
        { ...list('other:checklist:own.c') },
        list(),
      ],
    };
    const read = readOwnListsFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.version).toBe(7);
    expect(read.file.lists).toEqual([list()]);
    // The second, the list of another game and the repeated one.
    expect(read.file.skipped).toBe(3);
  });

  it('fills in what a tolerant read leaves out', () => {
    const { createdAt: _c, updatedAt: _u, headings: _h, ...bare } = list();
    const read = readOwnListsFile({
      format: OWN_LISTS_FORMAT,
      version: 1,
      gameId: 'demo',
      lists: [{ ...bare, headings: 'not a list' }],
    });
    expect(read.ok && read.file.lists[0]?.headings).toEqual([]);
    expect(read.ok && read.file.lists[0]?.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('is not anything else', () => {
    expect(readOwnListsFile({ format: 'something', lists: [] }).ok).toBe(false);
    expect(ownListsFileSchema.safeParse({}).success).toBe(false);
  });
});

describe('the list file', () => {
  it('holds one list and no marks, and reads back', () => {
    const text = writeListFile('demo', 'Demo', list(), NOW);
    expect(JSON.parse(text)).toMatchObject({ format: LIST_FILE_FORMAT, gameId: 'demo' });
    expect(text).not.toMatch(/found|progress/i);
    expect(readListFile(text)).toEqual({
      ok: true,
      gameId: 'demo',
      gameTitle: 'Demo',
      list: list(),
      pictureFiles: [],
    });
    expect(listFileSchema.safeParse({ ...JSON.parse(text), marks: [] }).success).toBe(false);
  });

  it('says plainly what is wrong with a file', () => {
    expect(readListFile('not json')).toEqual({
      ok: false,
      error: 'This file is not an Atlas list: it is not JSON.',
    });
    expect(readListFile('{"format":"atlas-progress","gameId":"demo"}')).toEqual({
      ok: false,
      error: 'This file is not an Atlas list.',
    });
    const damaged = JSON.parse(writeListFile('demo', 'Demo', list(), NOW)) as {
      list: { items: unknown[] };
    };
    damaged.list.items = [{ id: 'x' }];
    expect(readListFile(JSON.stringify(damaged))).toEqual({
      ok: false,
      error: 'This Atlas list is damaged, so it cannot be imported.',
    });
  });
});
