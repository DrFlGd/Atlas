import { describe, expect, it } from 'vitest';
import {
  areaNotes,
  categoryCounts,
  floorPreviewFile,
  isMakeReport,
  makeSuggestedFileName,
  makeSummaryLine,
  sceneLines,
  sizeText,
  type MadeArea,
  type MadeFloor,
  type MakeReport,
  type Report,
} from './report';

const game = {
  id: 'dark-souls-remastered' as const,
  title: 'Dark Souls Remastered',
  supported: true,
  version: '1.3.1.0',
  dataFolder: null,
  evidence: [],
};

function makeReport(overrides: Partial<MakeReport> = {}): MakeReport {
  return {
    tool: 'atlas-gamefiles',
    toolVersion: '0.2.0',
    reportVersion: 1,
    kind: 'make',
    createdAt: '2026-11-12T12:00:00Z',
    folder: 'C:/Games/DSR',
    game,
    areas: [],
    pack: null,
    summary: {
      areas: 3,
      areasMade: 2,
      areasSkipped: ['m99_00_00_00'],
      floors: 4,
      markers: 17,
      markersByCategory: { ring: 1, bonfire: 4, souls: 0 },
      notOnFloor: 0,
    },
    warnings: [],
    elapsedSeconds: 3,
    ...overrides,
  };
}

function area(overrides: Partial<MadeArea> = {}): MadeArea {
  return {
    id: 'm15_01_00_00',
    key: 'm15_01',
    name: 'Anor Londo',
    geometry: { used: 'collision' },
    markers: { total: 9, byCategory: {}, notOnFloor: 0, withFlag: 7, placeNames: 1 },
    placement: { verdict: 'placed by part (as the map does)', markersChecked: 6 },
    ...overrides,
  };
}

describe('make reports', () => {
  it('are told apart from check reports', () => {
    expect(isMakeReport(makeReport())).toBe(true);
    expect(isMakeReport({ game } as unknown as Report)).toBe(false);
    expect(isMakeReport(null)).toBe(false);
  });

  it('sum up what was made', () => {
    expect(makeSummaryLine(makeReport())).toBe(
      '2 areas drawn, 4 floors, 17 markers, 1 area left out.',
    );
    expect(makeSummaryLine(makeReport({ summary: null }))).toBe(
      'No map could be made from this folder.',
    );
  });

  it('count markers by category in the usual order, leaving out empty ones', () => {
    expect(categoryCounts({ ring: 1, bonfire: 4, souls: 0 })).toBe('Bonfires 4, Rings 1');
    expect(categoryCounts({})).toBe('');
  });

  it('note nothing for an area that went as expected', () => {
    expect(areaNotes(area())).toEqual([]);
  });

  it('note what to look at', () => {
    const notes = areaNotes(
      area({
        markers: { total: 9, byCategory: {}, notOnFloor: 2, withFlag: 7, placeNames: 1 },
        characters: { total: 3, bosses: 0, bossesNotFound: ['Dark Sun Gwyndolin'] },
        treasure: { events: 3, lotsReferenced: 5, lotsFound: 4, lotsMissing: { count: 1 } },
        bonfires: { method: 'event script', objectsNotFound: [1511962] },
        frame: { width: 6144, height: 6144, pixelsPerMetre: 2, cropped: true },
        placement: { verdict: 'stored positions fit better', markersChecked: 6 },
      }),
    );
    expect(notes).toEqual([
      '2 markers not over any floor (put on the main floor)',
      'Bosses not found: Dark Sun Gwyndolin',
      '1 item lot not in the item table (left off the map)',
      '1 bonfire registered by the event script but not placed',
      'Too large for one picture: drawn at 2 pixels per metre and cropped',
      'Collision placement: stored positions fit better',
    ]);
    expect(areaNotes(area({ geometry: { used: null } }))[0]).toContain('markers only');
    expect(areaNotes(area({ geometry: { used: 'navmesh' } }))[0]).toContain('navmesh');
    expect(areaNotes(area({ skipped: 'a debug map' }))).toEqual(['Left out: a debug map']);
  });

  it('tell of the 3D models', () => {
    const summary = makeReport().summary!;
    const threeD = {
      areasMade: 2,
      areasNotMade: 0,
      trianglesBefore: 900_000,
      trianglesAfter: 880_000,
      cells: 30,
      files: 90,
      bytes: 25 * 1024 * 1024,
      seconds: 40,
      noSurfaceUnder: 0,
    };
    expect(makeSummaryLine(makeReport({ summary: { ...summary, threeD } }))).toBe(
      '2 areas drawn, 4 floors, 17 markers, 3D models of 2 areas (25 MB), 1 area left out.',
    );
    expect(sizeText(2_500)).toBe('2 KB');
    expect(sizeText(5.25 * 1024 * 1024)).toBe('5.3 MB');
    expect(
      sceneLines({
        made: true,
        trianglesBefore: 120_000,
        trianglesAfter: 118_500,
        levels: [
          { level: 0, cells: 4, triangles: 118_500, bytes: 2_000_000 },
          { level: 1, cells: 4, triangles: 35_000, bytes: 700_000 },
          { level: 2, cells: 4, triangles: 9_400, bytes: 200_000 },
        ],
        cells: 4,
        files: 12,
        bytes: 2_900_000,
        seconds: 3.42,
      }),
    ).toEqual([
      '120,000 triangles read, 118,500 in the model',
      'Levels of detail: 118,500, 35,000, 9,400 triangles',
      '4 cells, 12 files, 2.8 MB',
      '3.4 s',
    ]);
    expect(sceneLines(undefined)).toEqual([]);
    const failed = { made: false, reason: 'it was stopped after 600 s', trianglesBefore: 5 };
    expect(sceneLines(failed)).toEqual(['Not made: it was stopped after 600 s']);
    expect(areaNotes(area({ scene: failed }))).toEqual(['No 3D model: it was stopped after 600 s']);
  });

  it('tell what the 3D maps and the textured maps were made from', () => {
    const fromModels = {
      made: true,
      look: 'models' as const,
      trianglesBefore: 82,
      trianglesAfter: 80,
      cells: 1,
      files: 3,
      bytes: 16_748,
      seconds: 0.4,
      textures: { kept: 4, leftOut: 0 },
    };
    expect(sceneLines(fromModels)[0]).toBe('From the game’s models, 4 textures at their own size');
    // With the textures counted: read, not readable and not found, and the model's size.
    const counted = {
      ...fromModels,
      bytes: 180 * 1024 * 1024,
      textures: { kept: 130, wanted: 124, read: 120, failed: 3, missing: 1, eachOnce: true },
    };
    expect(sceneLines(counted)).toEqual([
      'From the game’s models, 120 of 124 textures read at their own size (3 could not be read, 1 not found)',
      '82 triangles read, 80 in the model',
      '1 cell, 3 files, 180 MB',
      '0.40 s',
    ]);
    expect(
      sceneLines({ ...counted, textures: { wanted: 2, read: 2, failed: 0, missing: 0 } })[0],
    ).toBe('From the game’s models, 2 of 2 textures read at their own size');
    const fromCollision = {
      ...fromModels,
      look: 'collision' as const,
      lookNote: 'the game’s models could not be read (made-up reason)',
      textures: undefined,
    };
    expect(sceneLines(fromCollision)[0]).toBe('From the collision');
    expect(
      areaNotes(
        area({
          scene: fromCollision,
          mapStyle: 'shaded',
          mapStyleAsked: 'textured',
          mapStyleNote: 'drawn height shaded: the game’s models could not be read (made-up reason)',
        }),
      ),
    ).toEqual([
      '3D map from the collision: the game’s models could not be read (made-up reason)',
      'Map drawn height shaded: the game’s models could not be read (made-up reason)',
    ]);
  });

  it('suggest a file name and accept only preview files', () => {
    expect(makeSuggestedFileName(makeReport(), new Date(2026, 10, 12))).toBe(
      'atlas-make-dark-souls-remastered-2026-11-12.zip',
    );
    const floor = { preview: 'previews/m15_01_f1.png' } as MadeFloor;
    expect(floorPreviewFile(floor)).toBe('previews/m15_01_f1.png');
    expect(floorPreviewFile({ ...floor, preview: 'previews/../x.png' })).toBeNull();
  });
});
