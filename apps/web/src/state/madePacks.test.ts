import { describe, expect, it } from 'vitest';
import {
  mineOfferFrom,
  type ListedPack,
  type MadePackOpenPlan,
  type MadePackPlan,
  type MadePackWritten,
} from '../desktop';
import {
  canOpenForEditing,
  canWritePackFile,
  closeLines,
  editingText,
  mineOfferText,
  openPlanLines,
  restoredText,
  writePlanLines,
  writtenText,
} from './madePacks';
import type { MineRestored } from './packFile';

const listed = (extra: Partial<ListedPack> = {}): ListedPack => ({
  id: 'ruined-keep',
  title: 'Ruined Keep',
  url: 'atlas-pack://localhost/ruined-keep/',
  origin: 'maps-folder',
  path: '/maps/ruined-keep',
  packVersion: '1.0.0',
  bundled: false,
  imported: null,
  madeInApp: true,
  ...extra,
});

const plan = (extra: Partial<MadePackPlan> = {}): MadePackPlan => ({
  id: 'ruined-keep',
  title: 'Ruined Keep',
  folder: '/maps/ruined-keep',
  target: '/packs/Ruined Keep.atlaspack',
  fileName: 'Ruined Keep.atlaspack',
  targetFolder: '/packs',
  replaces: false,
  openedFrom: false,
  newer: null,
  removesFolder: true,
  mine: { lists: 2, locations: 42, types: 1, areas: 0 },
  ...extra,
});

const restored = (extra: Partial<MineRestored> = {}): MineRestored => ({
  lists: 0,
  locations: 0,
  types: 0,
  areas: 0,
  photos: 0,
  guideLinks: false,
  pages: 0,
  sections: 0,
  notes: 0,
  routes: 0,
  title: null,
  problem: null,
  ...extra,
});

describe('which maps are offered what', () => {
  it('offers Write the pack file only for a map made here, in the maps folder', () => {
    expect(canWritePackFile(listed({ madeHere: true }))).toBe(true);
    expect(canWritePackFile(listed())).toBe(false);
    expect(canWritePackFile(listed({ madeHere: true, origin: 'location' }))).toBe(false);
    expect(canWritePackFile(listed({ madeHere: true, bundled: true }))).toBe(false);
    expect(canWritePackFile(undefined)).toBe(false);
  });

  it('offers Open for editing only for a pack file of a map made in the app', () => {
    const file = { origin: 'packs-folder' as const, packFile: true };
    expect(canOpenForEditing(listed(file))).toBe(true);
    expect(canOpenForEditing(listed({ ...file, madeInApp: false }))).toBe(false);
    expect(canOpenForEditing(listed({ madeInApp: true }))).toBe(false);
    expect(canOpenForEditing(undefined)).toBe(false);
  });

  it('says in one line that a map is open for editing and what finishes it', () => {
    expect(editingText(listed({ madeHere: true }))).toBeNull();
    expect(
      editingText(
        listed({
          madeHere: true,
          editing: { path: '/packs/Ruined Keep.atlaspack', fileName: 'Ruined Keep.atlaspack' },
        }),
      ),
    ).toBe(
      'This map is open for editing from its pack file Ruined Keep.atlaspack. Write the pack file finishes it.',
    );
  });
});

describe('the confirmations', () => {
  it('say where the file goes, what it carries, the check and the folder removed', () => {
    const lines = writePlanLines(plan());
    expect(lines[0]).toBe(
      'Writes Ruined Keep as the new pack file Ruined Keep.atlaspack in /packs, at full detail with every map image.',
    );
    expect(lines[1]).toBe(
      'Your own 2 lists, 42 locations and 1 type of the map go in the file with it.',
    );
    expect(lines.join(' ')).toContain('checked whole');
    expect(lines.join(' ')).toContain('removed from the maps folder');
    expect(lines.at(-1)).toBe('If anything fails, nothing is removed, and you are told why.');
  });

  it('name the file the map was opened from, and a folder that is kept', () => {
    const lines = writePlanLines(
      plan({ replaces: true, openedFrom: true, removesFolder: false, mine: null }),
    );
    expect(lines[0]).toContain('over the pack file it was opened from, Ruined Keep.atlaspack');
    expect(lines[1]).toContain('the file carries none');
    expect(lines.join(' ')).toContain('stays in the maps folder');
    expect(writePlanLines(plan({ replaces: true }))[0]).toContain(
      'over the pack file this computer wrote of it last',
    );
  });

  it('say what opening for editing adds, and what closing loses', () => {
    const open: MadePackOpenPlan = {
      id: 'ruined-keep',
      title: 'Ruined Keep',
      path: '/packs/Ruined Keep.atlaspack',
      fileName: 'Ruined Keep.atlaspack',
      folder: '/maps/ruined-keep',
      mine: { lists: 0, locations: 3, types: 0, areas: 0 },
    };
    const lines = openPlanLines(open);
    expect(lines[0]).toContain('into a folder in the maps folder, /maps/ruined-keep');
    expect(lines[1]).toBe('The 3 locations the file carries are added to yours.');
    expect(openPlanLines({ ...open, mine: null })).toHaveLength(2);
    expect(
      closeLines(
        listed({
          editing: { path: '/p/Ruined Keep.atlaspack', fileName: 'Ruined Keep.atlaspack' },
        }),
      )[0],
    ).toContain('The pack file Ruined Keep.atlaspack stays as it was');
  });
});

describe('the offer of the maker’s own things', () => {
  it('counts them in one line', () => {
    expect(mineOfferText({ lists: 2, locations: 42, types: 0, areas: 0 })).toBe(
      'This pack file carries 2 lists and 42 locations made with the map.',
    );
  });

  it('takes only an answer of the shape of an offer', () => {
    const offer = {
      id: 'ruined-keep',
      title: 'Ruined Keep',
      path: '/packs/Ruined Keep.atlaspack',
      exportedAt: '2026-11-12T10:00:00Z',
      facts: { lists: 2, locations: 42, types: 0, areas: 0 },
    };
    expect(mineOfferFrom(offer)).toEqual(offer);
    expect(mineOfferFrom(null)).toBeNull();
    expect(mineOfferFrom(undefined)).toBeNull();
    expect(mineOfferFrom('an error')).toBeNull();
    expect(mineOfferFrom({ ...offer, facts: null })).toBeNull();
    expect(mineOfferFrom({ ...offer, facts: { lists: '2' } })).toBeNull();
    expect(mineOfferFrom({ ...offer, exportedAt: 5 })).toBeNull();
  });

  it('says what was added', () => {
    expect(restoredText(restored({ locations: 42, lists: 2 }))).toBe(
      'Added the 2 lists and 42 locations from the pack file to yours.',
    );
    expect(restoredText(restored())).toBe(
      'You had all of the maker’s own things from the pack file already.',
    );
    expect(restoredText(restored({ lists: 1, problem: 'Your notes could not be added.' }))).toBe(
      'Added the 1 list from the pack file to yours. Your notes could not be added.',
    );
    expect(restoredText(null)).toBe('The pack file carried none of the maker’s own things.');
  });
});

describe('what writing came to', () => {
  const written = (extra: Partial<MadePackWritten>): MadePackWritten =>
    ({
      id: 'ruined-keep',
      path: '/packs/Ruined Keep.atlaspack',
      fileName: 'Ruined Keep.atlaspack',
      size: 10,
      folderRemoved: true,
      folderComplete: true,
      note: null,
      ...extra,
    }) as MadePackWritten;

  it('says the map is read from the file, or why its folder was kept', () => {
    expect(writtenText(written({}))).toBe(
      'Wrote the pack file Ruined Keep.atlaspack. Atlas reads the map from it now.',
    );
    expect(writtenText(written({ folderComplete: false }))).toContain('go at the next start');
    expect(writtenText(written({ folderRemoved: false, note: 'The map’s folder was kept.' }))).toBe(
      'Wrote the pack file Ruined Keep.atlaspack. The map’s folder was kept.',
    );
  });
});
