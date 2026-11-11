import { describe, expect, it } from 'vitest';
import {
  boundsText,
  gameHeadline,
  previewFile,
  sourceDetails,
  sourceText,
  sourceTone,
  suggestedFileName,
  summaryLine,
  type AreaReport,
  type Report,
  type SourceResult,
} from './report';

function source(overrides: Partial<SourceResult>): SourceResult {
  return {
    status: 'ok',
    format: 'made up',
    files: [],
    entries: 4,
    read: 4,
    failed: 0,
    triangles: 0,
    vertices: 0,
    seconds: 0,
    ...overrides,
  };
}

const report: Report = {
  tool: 'atlas-gamefiles',
  toolVersion: '0.1.1',
  reportVersion: 1,
  createdAt: '2026-11-11T12:00:00Z',
  folder: 'C:\\Games\\Made Up',
  game: {
    id: 'dark-souls-remastered',
    title: 'Dark Souls Remastered',
    supported: true,
    version: '1.3.1.0',
    dataFolder: 'C:\\Games\\Made Up',
    evidence: [],
  },
  gameData: null,
  areas: [],
  summary: {
    areas: 17,
    areasRead: 16,
    parts: 9000,
    treasures: 1234,
    itemLotsReferenced: 1500,
    itemLotsFound: 1499,
    bonfireCandidates: 1,
    geometry: {
      collision: { ok: 17, partial: 0, failed: 0, missing: 0, 'not-decoded': 0, triangles: 1 },
      navmesh: { ok: 17, partial: 0, failed: 0, missing: 0, 'not-decoded': 0, triangles: 1 },
      mapPieces: { ok: 17, partial: 0, failed: 0, missing: 0, 'not-decoded': 0, triangles: 1 },
    },
    previews: 17,
    recommendedGeometry: 'collision',
    recommendation: 'Collision was read.',
  },
  warnings: [],
  elapsedSeconds: 30,
};

describe('report wording', () => {
  it('describes each geometry status', () => {
    expect(sourceText(source({ triangles: 12345 }))).toBe('Read (12,345 triangles)');
    expect(sourceText(source({ triangles: 0, read: 1 }))).toBe('Read (1 file)');
    expect(sourceText(source({ status: 'partial', read: 3, entries: 5 }))).toBe(
      'Partly read (3 of 5 files)',
    );
    expect(sourceText(source({ status: 'failed', entries: 2 }))).toBe('Could not read (2 files)');
    expect(sourceText(source({ status: 'missing' }))).toBe('No files');
    expect(sourceText(source({ status: 'not-decoded', read: 7 }))).toBe(
      'Opens, not decoded yet (7 files)',
    );
    expect(
      sourceText(source({ status: 'timed-out', timeLimitSeconds: 90, seconds: 90.2, read: 0 })),
    ).toBe('Took too long: stopped after 90 seconds');
    expect(sourceTone('timed-out')).toBe('warn');
  });

  it('says when only a sample was read', () => {
    expect(sourceText(source({ sampled: true, entries: 150, read: 12, triangles: 34567 }))).toBe(
      'Read a sample (12 of 150 files, 34,567 triangles)',
    );
    expect(sourceText(source({ sampled: true, entries: 40, read: 12 }))).toBe(
      'Read a sample (12 of 40 files)',
    );
    expect(
      sourceText(source({ status: 'partial', sampled: true, entries: 150, read: 10, failed: 2 })),
    ).toBe('Partly read (10 of 12 sampled files)');
  });

  it('shows how long the files took', () => {
    expect(
      sourceDetails(
        source({
          status: 'timed-out',
          note: 'Stopped after 90 s while reading h1000B0A10.hkx.dcx (collision file 3 of 12).',
          fileSeconds: { files: 2, min: 0.25, median: 3.4, max: 42.4 },
          slowestFile: 'h0200B0A10.hkx.dcx',
          openSeconds: 12.6,
        }),
      ),
    ).toEqual([
      'Stopped after 90 s while reading h1000B0A10.hkx.dcx (collision file 3 of 12).',
      'Reading time: 0.25 to 42 seconds per file (middle 3.4), slowest h0200B0A10.hkx.dcx',
      'Opening the files took 13 seconds',
    ]);
    expect(
      sourceDetails(
        source({ fileSeconds: { files: 1, min: 0.5, median: 0.5, max: 0.5 }, openSeconds: 0.2 }),
      ),
    ).toEqual(['Reading time: 0.50 seconds for 1 file']);
  });

  it('lists notes and errors', () => {
    expect(
      sourceDetails(
        source({
          note: 'A note',
          unplaced: 1,
          errors: ['ValueError: bad'],
          havokClasses: ['hkpX'],
        }),
      ),
    ).toEqual([
      'A note',
      '1 file placed by no part of the map layout',
      'Havok contents: hkpX',
      'Error: ValueError: bad',
    ]);
  });

  it('sums up a report', () => {
    expect(gameHeadline(report.game)).toBe('Dark Souls Remastered, version 1.3.1.0');
    expect(summaryLine(report)).toBe(
      '17 areas found, 16 read, 1,234 treasure events, 1,500 item lots referenced (1,499 in the item table), 1 bonfire candidate.',
    );
    const unknown: Report = {
      ...report,
      summary: null,
      game: { ...report.game, id: 'unknown', reason: 'Nothing here.' },
    };
    expect(gameHeadline(unknown.game)).toBe('No supported game found in this folder');
    expect(summaryLine(unknown)).toBe('Nothing here.');
  });

  it('formats ranges, file names and preview paths', () => {
    expect(boundsText({ x: [-120.4, 340], y: [0, 95.2], z: [-80, 410] })).toBe(
      'x -120 to 340, z -80 to 410 (height 0 to 95)',
    );
    expect(boundsText(null)).toBe('');
    expect(suggestedFileName(report, new Date(2026, 10, 1))).toBe(
      'atlas-check-dark-souls-remastered-2026-11-01.zip',
    );
    const area = { preview: { file: 'previews/m10_01_00_00.png' } } as AreaReport;
    expect(previewFile(area)).toBe('previews/m10_01_00_00.png');
    expect(previewFile({ preview: { file: '../secret.png' } } as AreaReport)).toBeNull();
    expect(previewFile({ preview: null } as AreaReport)).toBeNull();
  });
});
