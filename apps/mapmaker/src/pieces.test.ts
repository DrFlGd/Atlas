import { describe, expect, it } from 'vitest';
import { methodEntry } from './floors';
import {
  addRemoved,
  offersWholePart,
  partRecord,
  pieceRecord,
  pieceText,
  piecesOf,
  putBack,
  readPieces,
  removedIndexOf,
  startRemoved,
  triangleMarks,
} from './pieces';
import { redrawnMapLine } from './redrawing';
import { removedLine, sameRemoved, waitingCuts, type MadeArea } from './report';
import type { AreaPieces, RemovedPiece } from './shell';

function base64(values: Uint32Array | Float32Array): string {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  return btoa(String.fromCharCode(...bytes));
}

// A made-up area of 40 triangles: a ground (part "ground", 32 triangles), a stray panel 15 m up in the same part
// (2 triangles), and a small hut of its own part ("hut") in two pieces (4 and 2 triangles).
const triangles = [...Array.from({ length: 32 }, () => 0), 1, 1, 2, 2, 2, 2, 3, 3];
const madeUp: AreaPieces = {
  triangle: base64(new Uint32Array(triangles)),
  part: base64(new Uint32Array([0, 0, 1, 1])),
  box: base64(
    new Float32Array([
      -40, 0, -40, 40, 0, 40, 10, 15, 10, 14, 15, 12, 30, 0, 30, 34, 3, 34, 30, 3, 30, 34, 3.2, 34,
    ]),
  ),
  triangles: base64(new Uint32Array([32, 2, 4, 2])),
  area: base64(new Float32Array([6400, 8, 40.25, 16])),
  parts: ['ground', 'hut'],
};

describe('Remove pieces', () => {
  const table = readPieces(madeUp);

  it('reads the pieces and writes a piece or a whole part down', () => {
    expect(table.triangle.length).toBe(40);
    expect(table.partPieces).toEqual([2, 2]);
    expect(table.partTriangles).toEqual([34, 6]);
    expect(pieceRecord(table, 1)).toEqual({
      part: 'ground',
      box: [10, 15, 10, 14, 15, 12],
      triangles: 2,
      area: 8,
    });
    expect(partRecord(table, 1)).toEqual({
      part: 'hut',
      box: [30, 0, 30, 34, 3.2, 34],
      whole: true,
      triangles: 6,
      area: 56.25,
    });
  });

  it('finds a removed piece again by its part and bounds, within 5 cm', () => {
    const stray = pieceRecord(table, 1);
    expect(piecesOf(table, stray)).toEqual([1]);
    expect(piecesOf(table, { ...stray, box: [10.04, 15, 10, 14, 15, 12] })).toEqual([1]);
    expect(piecesOf(table, { ...stray, box: [10.2, 15, 10, 14, 15, 12] })).toEqual([]);
    expect(piecesOf(table, { ...stray, part: 'other' })).toEqual([]);
    expect(piecesOf(table, partRecord(table, 1))).toEqual([2, 3]);
  });

  it('keeps each piece once, a whole part in place of its pieces, and puts pieces back', () => {
    const stray = pieceRecord(table, 1);
    const hutPiece = pieceRecord(table, 3);
    let list = addRemoved([], stray);
    expect(addRemoved(list, { ...stray })).toEqual(list);
    list = addRemoved(list, hutPiece);
    expect(list).toHaveLength(2);
    list = addRemoved(list, partRecord(table, 1));
    expect(list.map((piece) => piece.whole ?? false)).toEqual([false, true]);
    // A piece of a part removed whole is removed already.
    expect(addRemoved(list, hutPiece)).toEqual(list);
    expect(removedIndexOf(table, list, 2)).toBe(1);
    expect(removedIndexOf(table, list, 0)).toBe(-1);
    expect(putBack(list, 0)).toEqual([list[1]]);
  });

  it('marks the chosen piece, the rest of its part and the removed pieces', () => {
    const marks = triangleMarks(table, [pieceRecord(table, 1)], 2);
    expect(marks[0]).toBe(0);
    expect([marks[32], marks[33]]).toEqual([2, 2]);
    expect([marks[34], marks[38]]).toEqual([1, 3]);
    expect(triangleMarks(table, [], null).every((mark) => mark === 0)).toBe(true);
  });

  it('offers the whole part only when it has other pieces and is not most of the area', () => {
    expect(offersWholePart(table, 2)).toBe(true);
    // The ground part holds most of the area's triangles.
    expect(offersWholePart(table, 1)).toBe(false);
  });

  it('says what a piece is', () => {
    expect(pieceText(pieceRecord(table, 1))).toBe(
      'A piece of part ground: 8 m², 2 triangles, at 15 m',
    );
    expect(pieceText(partRecord(table, 1))).toBe(
      'The whole of part hut: 56 m², 6 triangles, from 0 to 3.2 m',
    );
  });

  it('writes the removed pieces with the cuts, and compares them in any order', () => {
    const stray = pieceRecord(table, 1);
    const draft = { cuts: [4.5], names: ['', ''] };
    expect(methodEntry('cuts', draft, [], 2, [stray])).toEqual({
      method: 'cuts',
      cuts: [4.5],
      removed: [stray],
    });
    expect(methodEntry('cuts', draft, [], 2)).toEqual({ method: 'cuts', cuts: [4.5] });
    expect(methodEntry('passages', draft, [], 2, [stray]).removed).toEqual([stray]);
    const hut = partRecord(table, 1);
    expect(sameRemoved([stray, hut], [hut, { ...stray, triangles: 9 }])).toBe(true);
    expect(sameRemoved([stray], [hut])).toBe(false);
    expect(sameRemoved(undefined, [])).toBe(true);
  });
});

describe('Removed pieces in the report', () => {
  const stray: RemovedPiece = { part: 'h000100', box: [10, 15, 10, 14, 15, 12], area: 8 };
  const area = (removed?: RemovedPiece[]): MadeArea => ({
    id: 'm24_01_00_00',
    key: 'm24_01',
    name: 'Made-up Ward',
    geometry: { used: 'collision' },
    floorPlan: {
      cuts: [],
      overrides: { from: 'yours', cuts: [], ...(removed ? { removed } : {}) },
    },
  });

  it('says how many pieces were removed', () => {
    expect(removedLine(undefined)).toBeNull();
    expect(removedLine({ asked: 2, found: 2, triangles: 4 })).toBe('2 pieces removed by you');
    expect(removedLine({ asked: 2, found: 1, triangles: 2 })).toBe(
      '1 piece removed by you; 1 removed piece not found (it is not in this map now)',
    );
    expect(startRemoved(area([stray]))).toEqual([stray]);
    expect(startRemoved(area())).toEqual([]);
  });

  it('points out removed pieces saved but not yet in the map', () => {
    expect(waitingCuts(area(), { cuts: [], removed: [stray] }, true)).toBe(true);
    expect(waitingCuts(area([stray]), { cuts: [], removed: [{ ...stray }] }, true)).toBe(false);
    expect(waitingCuts(area([stray]), { cuts: [] }, true)).toBe(true);
  });

  it('says a map drawn again left the removed pieces out', () => {
    expect(
      redrawnMapLine({
        id: 'p:map:m24_01',
        name: 'Made-up Ward',
        redrawn: true,
        floors: 1,
        floorsFrom: 'yours',
        removedPieces: { asked: 1, found: 1, triangles: 2 },
      }),
    ).toBe(
      'drawn again, 1 floor (your floor cuts); 1 piece removed by you, left out of its pictures and its 3D model',
    );
  });
});
