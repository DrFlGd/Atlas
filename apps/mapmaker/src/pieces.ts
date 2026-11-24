/**
 * Remove pieces, in the Adjust floors panel: the area's connected pieces of surface (as the views helper gives them,
 * see the helper's atlas_gamefiles/pieces.py), choosing one by pressing it in the 3D view, and the list of removed
 * pieces written to the player's floor cuts file with the area's cuts.
 *
 * A piece is a connected piece of surface of one collision part; the whole part can be removed too. A removed piece
 * is written down by its part's name and its bounds (never by triangle numbers, which change with the order the
 * game files are read in), and found again as the helper finds it: the piece of that part with those bounds, each
 * side within `TOLERANCE`.
 */
import { fromBase64 } from './floors';
import { count, heightText, plural, sameRecord, type MadeArea } from './report';
import type { AreaPieces, RemovedPiece } from './shell';

/** Metres: a piece's bounds are found again within this on each side (as pieces.py). */
export const TOLERANCE = 0.05;
/** The most pieces removed in one area (as the floor cuts file keeps). */
export const MAX_REMOVED = 256;
/** A whole part is offered for removal when it holds at most this share of the area's triangles. */
export const WHOLE_PART_SHARE = 0.25;

export interface PieceTable {
  /** Each triangle's piece. */
  triangle: Uint32Array;
  /** Per piece: its part (an index in `parts`), bounds (six numbers), triangles and area (m²). */
  part: Uint32Array;
  box: Float32Array;
  triangles: Uint32Array;
  area: Float32Array;
  parts: string[];
  /** Per part: its pieces and triangles. */
  partPieces: number[];
  partTriangles: number[];
}

function view<T extends Uint32Array | Float32Array>(
  text: string,
  make: (buffer: ArrayBuffer, offset: number, length: number) => T,
): T {
  const bytes = fromBase64(text);
  // A copy on its own buffer, so that the typed array starts at a multiple of 4.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return make(copy.buffer, 0, Math.floor(bytes.length / 4));
}

/** The pieces the helper gave, ready to look up. */
export function readPieces(pieces: AreaPieces): PieceTable {
  const u32 = (text: string) => view(text, (b, o, n) => new Uint32Array(b, o, n));
  const f32 = (text: string) => view(text, (b, o, n) => new Float32Array(b, o, n));
  const table: PieceTable = {
    triangle: u32(pieces.triangle),
    part: u32(pieces.part),
    box: f32(pieces.box),
    triangles: u32(pieces.triangles),
    area: f32(pieces.area),
    parts: [...pieces.parts],
    partPieces: pieces.parts.map(() => 0),
    partTriangles: pieces.parts.map(() => 0),
  };
  table.part.forEach((part, piece) => {
    if (part < table.parts.length) {
      table.partPieces[part]! += 1;
      table.partTriangles[part]! += table.triangles[piece] ?? 0;
    }
  });
  return table;
}

const round = (value: number) => Math.round(value * 100) / 100 + 0; // never -0

function boxOf(table: PieceTable, piece: number): RemovedPiece['box'] {
  return Array.from({ length: 6 }, (_, k) =>
    round(table.box[piece * 6 + k] ?? 0),
  ) as RemovedPiece['box'];
}

/** What is written down to remove piece `piece`. */
export function pieceRecord(table: PieceTable, piece: number): RemovedPiece {
  return {
    part: table.parts[table.part[piece] ?? 0] ?? '',
    box: boxOf(table, piece),
    triangles: table.triangles[piece] ?? 0,
    area: round(table.area[piece] ?? 0),
  };
}

/** What is written down to remove the whole part `part`: its name, and the bounds, triangles and area of all its
 * pieces. */
export function partRecord(table: PieceTable, part: number): RemovedPiece {
  const box: RemovedPiece['box'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let area = 0;
  table.part.forEach((owner, piece) => {
    if (owner !== part) return;
    for (let k = 0; k < 3; k++) {
      box[k] = Math.min(box[k]!, table.box[piece * 6 + k]!);
      box[k + 3] = Math.max(box[k + 3]!, table.box[piece * 6 + k + 3]!);
    }
    area += table.area[piece] ?? 0;
  });
  return {
    part: table.parts[part] ?? '',
    box: box.map(round) as RemovedPiece['box'],
    whole: true,
    triangles: table.partTriangles[part] ?? 0,
    area: round(area),
  };
}

/** The pieces of the table that a removed piece is (none when it is not in this area). */
export function piecesOf(table: PieceTable, record: RemovedPiece): number[] {
  const parts = new Set(
    table.parts.flatMap((name, index) => (name === record.part ? [index] : [])),
  );
  const out: number[] = [];
  table.part.forEach((part, piece) => {
    if (!parts.has(part)) return;
    if (record.whole) {
      out.push(piece);
      return;
    }
    let close = true;
    for (let k = 0; k < 6 && close; k++)
      close = Math.abs(table.box[piece * 6 + k]! - record.box[k]!) <= TOLERANCE + 1e-4;
    if (close) out.push(piece);
  });
  return out;
}

/** The list with `record` removed too: a whole part takes the place of its pieces in the list. */
export function addRemoved(list: readonly RemovedPiece[], record: RemovedPiece): RemovedPiece[] {
  if (list.some((piece) => sameRecord(piece, record))) return [...list];
  if (list.some((piece) => piece.whole && piece.part === record.part)) return [...list];
  const rest = record.whole ? list.filter((piece) => piece.part !== record.part) : list;
  return [...rest, record].slice(0, MAX_REMOVED);
}

/** The list without entry `index` (put back). */
export function putBack(list: readonly RemovedPiece[], index: number): RemovedPiece[] {
  return list.filter((_, i) => i !== index);
}

/** The removed entry (an index in `list`) that holds piece `piece`, or -1. */
export function removedIndexOf(
  table: PieceTable,
  list: readonly RemovedPiece[],
  piece: number,
): number {
  return list.findIndex((record) => piecesOf(table, record).includes(piece));
}

/** Whether removing the whole part of piece `piece` is offered: the part has other pieces, and is not a large share of
 * the area (removing most of the area by one press is never what is meant). */
export function offersWholePart(table: PieceTable, piece: number): boolean {
  const part = table.part[piece];
  if (part === undefined) return false;
  const total = table.triangle.length;
  return (
    (table.partPieces[part] ?? 0) > 1 &&
    (table.partTriangles[part] ?? 0) <= Math.max(1, total * WHOLE_PART_SHARE)
  );
}

/** How the 3D view shows each triangle: 0 as it is, 1 the chosen piece, 2 removed, 3 the rest of the chosen
 * piece's part. */
export type PieceMark = 0 | 1 | 2 | 3;

/** Each triangle's mark for the removed pieces and the chosen piece (null: none). */
export function triangleMarks(
  table: PieceTable,
  removed: readonly RemovedPiece[],
  chosen: number | null,
): Uint8Array {
  const pieceMark = new Uint8Array(table.part.length);
  if (chosen !== null && chosen < pieceMark.length) {
    const part = table.part[chosen];
    table.part.forEach((owner, piece) => {
      if (owner === part) pieceMark[piece] = 3;
    });
  }
  for (const record of removed) for (const piece of piecesOf(table, record)) pieceMark[piece] = 2;
  if (chosen !== null && chosen < pieceMark.length) pieceMark[chosen] = 1;
  const marks = new Uint8Array(table.triangle.length);
  table.triangle.forEach((piece, triangle) => {
    marks[triangle] = pieceMark[piece] ?? 0;
  });
  return marks;
}

/** "8 m², 2 triangles, at 15 m" or "from 3 m to 9 m". */
function sizeText(record: RemovedPiece): string {
  const [, low, , , high] = record.box;
  const where =
    Math.abs(high - low) < 0.5
      ? `at ${heightText(low)}`
      : `from ${heightText(low).replace(/ m$/, '')} to ${heightText(high)}`;
  const parts = [
    record.area !== undefined ? `${count(Math.round(record.area))} m²` : null,
    record.triangles !== undefined ? plural(record.triangles, 'triangle') : null,
    where,
  ];
  return parts.filter(Boolean).join(', ');
}

/** What a removed (or chosen) piece is, in words. */
export function pieceText(record: RemovedPiece): string {
  const part = record.part ? `part ${record.part}` : 'the area';
  return record.whole
    ? `The whole of ${part}: ${sizeText(record)}`
    : `A piece of ${part}: ${sizeText(record)}`;
}

/** The pieces the area was made without (as its report says). */
export function startRemoved(area: MadeArea): RemovedPiece[] {
  return [...(area.floorPlan?.overrides?.removed ?? [])];
}
