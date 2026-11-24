import { describe, expect, it } from 'vitest';
import {
  defaultPack,
  isRedrawReport,
  redrawnMapLine,
  redrawSummaryLine,
  type RedrawReport,
} from './redrawing';
import type { PackWithScenes } from './shell';

const report: RedrawReport = {
  kind: 'redraw',
  toolVersion: '0.6.0',
  createdAt: '2026-11-24T12:00:00Z',
  pack: { id: 'made-up', folder: 'C:\\Maps\\made-up', title: 'Made up', madeByMapMaker: true },
  options: { mapStyle: 'floors' },
  maps: [
    { id: 'a', name: 'Low Town', redrawn: true, floors: 2, floorsFrom: 'pack', levels: { '0': 4 } },
    {
      id: 'b',
      name: 'High Town',
      redrawn: true,
      floors: 1,
      floorsFrom: 'yours',
      layersChanged: { before: 2, after: 1 },
      locationsMoved: 3,
      levels: { '1': 2 },
    },
    { id: 'c', name: 'Shrine', redrawn: false, reason: 'it has no 3D model' },
    { id: 'd', name: 'Caves', redrawn: false, reason: 'its 3D model could not be read (bad file)' },
  ],
  summary: { maps: 4, redrawn: 2, skipped: 2, tiles: 40 },
  warnings: [],
};

describe('Draw all areas again', () => {
  it('knows its report', () => {
    expect(isRedrawReport(report)).toBe(true);
    expect(isRedrawReport({ kind: 'make', areas: [] })).toBe(false);
    expect(isRedrawReport(null)).toBe(false);
    expect(isRedrawReport({ kind: 'redraw' })).toBe(false);
  });

  it('says what was drawn again and what was left', () => {
    expect(redrawSummaryLine(report)).toBe(
      '2 of 3 maps with a 3D model drawn again in Colour by floor; 1 left as it was; 1 map without a 3D model not touched.',
    );
    expect(redrawnMapLine(report.maps[0]!)).toBe('drawn again, 2 floors (the pack’s floors)');
    expect(redrawnMapLine(report.maps[1]!)).toBe(
      'drawn again, 1 floor (your floor cuts); its layers went from 2 to 1; 3 locations on another floor now; from a coarser level of its 3D model',
    );
    expect(redrawnMapLine(report.maps[3]!)).toBe(
      'left as it was: its 3D model could not be read (bad file)',
    );
  });

  it('offers the pack just made first', () => {
    const packs: PackWithScenes[] = [
      { id: 'b', title: 'B', maps3d: 1, maps: 1, madeByMapMaker: false },
      { id: 'made', title: 'Made', maps3d: 3, maps: 4, madeByMapMaker: true },
    ];
    expect(defaultPack(packs, 'made')).toBe('made');
    expect(defaultPack(packs, 'gone')).toBe('b');
    expect(defaultPack([], null)).toBeNull();
  });
});
