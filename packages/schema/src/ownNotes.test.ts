import { describe, expect, it } from 'vitest';
import {
  countOwnNotes,
  NO_OWN_NOTES,
  OWN_NOTES_FORMAT,
  readOwnNotesFile,
  writeOwnNotesFile,
  type OwnNotes,
} from './index';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const T = NOW.toISOString();

const own = (): OwnNotes => ({
  notes: {
    'demo:loc:0412': {
      text: 'The ladder is **behind** the well.\n\n||Use the rusted key.||\n',
      name: 'Old well',
      updatedAt: T,
    },
    'demo:loc:0007': {
      text: '',
      name: 'Wolf den 7',
      photos: [{ picture: 'demo:picture:own.ab12', spoiler: true }],
      updatedAt: T,
    },
  },
  pictures: [
    {
      id: 'demo:picture:own.ab12',
      file: 'pictures/own.ab12.png',
      shareable: true,
      width: 20,
      height: 10,
    },
  ],
});

describe('own notes file', () => {
  it('is written strictly with its header and read back whole', () => {
    const text = writeOwnNotesFile('demo', own(), NOW);
    const value = JSON.parse(text) as Record<string, unknown>;
    expect(value).toMatchObject({
      format: OWN_NOTES_FORMAT,
      version: 1,
      gameId: 'demo',
      updatedAt: T,
    });
    // Notes are written in the order of their ids, so a file changes only where a note does.
    expect(Object.keys(value.notes as object)).toEqual(['demo:loc:0007', 'demo:loc:0412']);
    const read = readOwnNotesFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.skipped).toBe(0);
    expect(read.file.own).toEqual(own());
    expect(countOwnNotes(read.file.own)).toBe(2);
  });

  it('refuses what is not valid when writing', () => {
    const write =
      (notes: OwnNotes, game = 'demo') =>
      () =>
        writeOwnNotesFile(game, notes, NOW);
    const note = { text: 'x', name: 'Old well', updatedAt: T };
    // Another game's location, a location of one's own, a note with nothing in it.
    expect(write(own(), 'other')).toThrow();
    expect(write({ notes: { 'demo:loc:own.a': note } })).toThrow();
    expect(write({ notes: { 'demo:loc:0412': { ...note, text: '  ' } } })).toThrow();
    // A name that is empty or too long, a text that is too long.
    expect(write({ notes: { 'demo:loc:0412': { ...note, name: ' ' } } })).toThrow();
    expect(write({ notes: { 'demo:loc:0412': { ...note, name: 'x'.repeat(201) } } })).toThrow();
    expect(write({ notes: { 'demo:loc:0412': { ...note, text: 'x'.repeat(20_001) } } })).toThrow();
    // Not a location id, a field the format does not have.
    expect(write({ notes: { 'demo:guide:0412': note } })).toThrow();
    expect(
      write({ notes: { 'demo:loc:0412': { ...note, colour: 'red' } as typeof note } }),
    ).toThrow();
    // A picture that is not an own picture, or named twice.
    expect(
      write({
        ...NO_OWN_NOTES,
        pictures: [{ id: 'demo:picture:gate', file: 'pictures/gate.png', shareable: true }],
      }),
    ).toThrow();
    const twice = own();
    twice.pictures!.push(twice.pictures![0]!);
    expect(write(twice)).toThrow();
  });

  it('reads tolerantly: what cannot be read is left out and counted', () => {
    const value = JSON.parse(writeOwnNotesFile('demo', own(), NOW)) as {
      notes: Record<string, unknown>;
      pictures: unknown[];
      later?: unknown;
    };
    value.notes['other:loc:1'] = { text: 'x', name: 'X' };
    value.notes['demo:loc:own.a'] = { text: 'x', name: 'X' };
    value.notes['not an id'] = { text: 'x', name: 'X' };
    value.notes['demo:loc:9'] = { text: 7 };
    // A field a newer app writes is left out, the note kept; a broken name is said plainly.
    value.notes['demo:loc:8'] = { text: 'Kept.', name: '', colour: 'red' };
    value.pictures.push({ id: 'demo:picture:x', file: 'x.png' });
    value.later = 'something a newer app writes';
    const read = readOwnNotesFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.skipped).toBe(5);
    expect(Object.keys(read.file.own.notes).sort()).toEqual([
      'demo:loc:0007',
      'demo:loc:0412',
      'demo:loc:8',
    ]);
    expect(read.file.own.notes['demo:loc:8']).toEqual({
      text: 'Kept.',
      name: 'A location',
      updatedAt: new Date(0).toISOString(),
    });
    expect(read.file.own.pictures).toHaveLength(1);
  });

  it('says what is not a notes file, and the version a newer app wrote', () => {
    expect(readOwnNotesFile({ format: 'atlas-own-pages', version: 1, gameId: 'demo' }).ok).toBe(
      false,
    );
    expect(readOwnNotesFile('text').ok).toBe(false);
    const newer = readOwnNotesFile({ format: OWN_NOTES_FORMAT, version: 2, gameId: 'demo' });
    expect(newer.ok && newer.file.version).toBe(2);
    expect(newer.ok && newer.file.own).toEqual(NO_OWN_NOTES);
  });
});
