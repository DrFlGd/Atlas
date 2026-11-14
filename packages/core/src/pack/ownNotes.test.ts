import type { GuideEntry, Location, OwnNotes, Picture } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { passesFilter } from '../filters/visibility';
import {
  mergeOwnNotes,
  noteHasContent,
  notesOnPack,
  noteTexts,
  putNote,
  removeNote,
} from './ownNotes';

const T1 = '2026-11-13T10:00:00.000Z';
const T2 = '2026-11-14T10:00:00.000Z';
const NOW = new Date('2026-11-14T12:00:00.000Z');

const picture = (local: string): Picture => ({
  id: `isle:picture:${local}`,
  file: `pictures/${local}.png`,
  shareable: true,
  width: 10,
  height: 10,
});

const notes = (): OwnNotes => ({
  notes: {
    'isle:loc:well': { text: 'Ladder behind it.', name: 'Old well', updatedAt: T1 },
    // Kept under an id the pack has since renamed.
    'isle:loc:old-den': { text: 'Three wolves.', name: 'Wolf den', updatedAt: T1 },
    'isle:loc:gone': {
      text: 'A chest was here.',
      name: 'Sunken chest',
      photos: [{ picture: 'isle:picture:own.a' }],
      updatedAt: T1,
    },
  },
  pictures: [picture('own.a')],
});

const here = new Set(['isle:loc:well', 'isle:loc:den', 'isle:loc:own.mine']);
const migrations: Record<string, string> = { 'isle:loc:old-den': 'isle:loc:den' };
const currentId = (id: string) => migrations[id] ?? id;

describe('own notes on a pack', () => {
  it('shows each note on its location now, following renamed ids', () => {
    const shown = notesOnPack(notes(), (id) => here.has(id), currentId);
    expect([...shown.byLocation.keys()].sort()).toEqual(['isle:loc:den', 'isle:loc:well']);
    expect(shown.byLocation.get('isle:loc:den')).toMatchObject({
      locationId: 'isle:loc:den',
      keptAs: 'isle:loc:old-den',
    });
  });

  it('keeps a note whose location is gone, with the name it had', () => {
    const shown = notesOnPack(notes(), (id) => here.has(id), currentId);
    expect(shown.unplaced.map((n) => [n.keptAs, n.note.name])).toEqual([
      ['isle:loc:gone', 'Sunken chest'],
    ]);
  });

  it('shows the newer of two notes that lead to one location, and keeps the other apart', () => {
    const both: OwnNotes = {
      notes: {
        ...notes().notes,
        'isle:loc:den': { text: 'Newer.', name: 'Wolf den', updatedAt: T2 },
      },
    };
    const shown = notesOnPack(both, (id) => here.has(id), currentId);
    expect(shown.byLocation.get('isle:loc:den')?.note.text).toBe('Newer.');
    expect(shown.unplaced.map((n) => n.keptAs)).toEqual(['isle:loc:gone', 'isle:loc:old-den']);
  });

  it('writes a note under the location’s id now, leaving none under its old ids', () => {
    const put = putNote(
      notes(),
      { id: 'isle:loc:den', name: 'Wolf den' },
      { text: 'Five wolves now.' },
      NOW,
      currentId,
    );
    expect(Object.keys(put.notes).sort()).toEqual([
      'isle:loc:den',
      'isle:loc:gone',
      'isle:loc:well',
    ]);
    expect(put.notes['isle:loc:den']).toEqual({
      text: 'Five wolves now.',
      name: 'Wolf den',
      updatedAt: NOW.toISOString(),
    });
    // What it was given stays as it was.
    expect(notes().notes['isle:loc:old-den']).toBeDefined();
  });

  it('keeps the own pictures the notes show, and lets go of those none shows', () => {
    const put = putNote(
      notes(),
      { id: 'isle:loc:well', name: 'Old well' },
      { text: '', photos: [{ picture: 'isle:picture:own.b', spoiler: true }] },
      NOW,
      currentId,
      [picture('own.b'), picture('own.c')],
    );
    expect(put.notes['isle:loc:well']?.photos).toEqual([
      { picture: 'isle:picture:own.b', spoiler: true },
    ]);
    expect(put.pictures?.map((p) => p.id)).toEqual(['isle:picture:own.a', 'isle:picture:own.b']);
    const removed = removeNote(put, 'isle:loc:gone');
    expect(removed.pictures?.map((p) => p.id)).toEqual(['isle:picture:own.b']);
    expect(removeNote(removed, 'isle:loc:nothing')).toBe(removed);
  });

  it('removes a note when it is written empty', () => {
    const put = putNote(notes(), { id: 'isle:loc:well', name: 'Old well' }, { text: '  ' }, NOW);
    expect(put.notes['isle:loc:well']).toBeUndefined();
    expect(noteHasContent({ text: ' ' })).toBe(false);
    expect(noteHasContent({ text: '', photos: [{ picture: 'isle:picture:x' }] })).toBe(true);
  });

  it('adds the notes of a file to the person’s, the file’s note winning', () => {
    const merged = mergeOwnNotes(notes(), {
      notes: {
        'isle:loc:well': { text: 'From the file.', name: 'Old well', updatedAt: T2 },
        'isle:loc:new': {
          text: 'x',
          name: 'New',
          photos: [{ picture: 'isle:picture:own.z' }],
          updatedAt: T2,
        },
      },
      pictures: [picture('own.z')],
    });
    expect(merged.notes['isle:loc:well']?.text).toBe('From the file.');
    expect(Object.keys(merged.notes)).toHaveLength(4);
    expect(merged.pictures?.map((p) => p.id).sort()).toEqual([
      'isle:picture:own.a',
      'isle:picture:own.z',
    ]);
  });

  it('gives the texts to search: notes on the game’s locations, and on one’s own', () => {
    const loc = (id: string, guideId: string | null = null) =>
      ({
        id,
        mapId: 'isle:map:m',
        layerId: 'isle:layer:l',
        x: 0,
        y: 0,
        categoryId: 'isle:cat:c',
        regionId: null,
        name: id,
        entityIds: [],
        guideId,
        since: '0.0.0',
      }) satisfies Location;
    const guide = (id: string, body: string): GuideEntry => ({
      id,
      title: 'x',
      body,
      locationIds: [],
    });
    const shown = notesOnPack(notes(), (id) => here.has(id), currentId);
    const texts = noteTexts(
      {
        locations: [
          loc('isle:loc:well', 'isle:guide:lore'),
          loc('isle:loc:own.mine', 'isle:guide:own.mine'),
        ],
        guides: [
          guide('isle:guide:lore', 'The pack’s own note.'),
          guide('isle:guide:own.mine', 'Mine.'),
        ],
      },
      shown,
    );
    expect(texts.map((t) => [t.locationId, t.text]).sort()).toEqual([
      ['isle:loc:den', 'Three wolves.'],
      ['isle:loc:own.mine', 'Mine.'],
      ['isle:loc:well', 'Ladder behind it.'],
    ]);
  });
});

describe('the filter of locations with notes', () => {
  const location = (id: string, categoryId: string) => ({ id, categoryId }) as unknown as Location;
  const filter = {
    visibleCategories: new Set(['isle:cat:shown']),
    hideFound: true,
    isFound: (id: string) => id === 'isle:loc:found',
    withNotes: new Set(['isle:loc:a', 'isle:loc:hidden-type', 'isle:loc:found']),
  };

  it('shows only locations with notes, whatever types are shown, found ones hidden as asked', () => {
    expect(passesFilter(location('isle:loc:a', 'isle:cat:shown'), filter)).toBe(true);
    expect(passesFilter(location('isle:loc:hidden-type', 'isle:cat:off'), filter)).toBe(true);
    expect(passesFilter(location('isle:loc:b', 'isle:cat:shown'), filter)).toBe(false);
    expect(passesFilter(location('isle:loc:found', 'isle:cat:shown'), filter)).toBe(false);
  });

  it('with the locations of a list shown alone, only those of them with notes', () => {
    const only = { ...filter, only: new Set(['isle:loc:a', 'isle:loc:b']) };
    expect(passesFilter(location('isle:loc:a', 'isle:cat:off'), only)).toBe(true);
    expect(passesFilter(location('isle:loc:b', 'isle:cat:shown'), only)).toBe(false);
    expect(passesFilter(location('isle:loc:hidden-type', 'isle:cat:off'), only)).toBe(false);
  });
});
