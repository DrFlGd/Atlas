import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  column,
  fitZoom,
  GAP,
  MAX_ZOOM,
  marksIn,
  MIN_ZOOM,
  nextHit,
  pageAt,
  pagesInView,
  searchWords,
  stepZoom,
  typedPage,
} from './layout';

describe('the column of pages', () => {
  const guess = { width: 100, height: 200 };

  it('puts each page under the one before, a gap between', () => {
    const sizes = new Map([[2, { width: 300, height: 100 }]]);
    const { starts, heights, height, width } = column(3, sizes, guess, 2);
    expect([...starts]).toEqual([GAP, GAP + 400 + GAP, GAP + 400 + GAP + 200 + GAP]);
    expect([...heights]).toEqual([400, 200, 400]);
    expect(height).toBe(GAP + 400 + GAP + 200 + GAP + 400 + GAP);
    expect(width).toBe(600 + 2 * GAP);
  });

  it('finds the page at a place, and the pages in view', () => {
    const { starts } = column(10, new Map(), guess, 1);
    expect(pageAt(starts, 0)).toBe(1);
    expect(pageAt(starts, GAP + 199)).toBe(1);
    expect(pageAt(starts, GAP + 200 + GAP)).toBe(2);
    expect(pageAt(starts, 1e9)).toBe(10);
    expect(pagesInView(starts, 500, 900, 1)).toEqual({ first: 2, last: 6 });
    expect(pagesInView(starts, 0, 10, 2)).toEqual({ first: 1, last: 3 });
  });
});

describe('zoom', () => {
  it('stays within its bounds and steps in whole percents', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
  });

  it('fits the width, or the whole page', () => {
    const page = { width: 600, height: 800 };
    const room = { width: 600 + 2 * GAP, height: 400 + 2 * GAP };
    expect(fitZoom('width', page, room, 1)).toBe(1);
    expect(fitZoom('page', page, room, 1)).toBe(0.5);
    expect(fitZoom('width', page, room, 2)).toBe(0.5);
  });
});

describe('search in the reader', () => {
  it('goes to the next and previous page found, round', () => {
    expect(nextHit([3, 8, 20], 3, 1)).toBe(8);
    expect(nextHit([3, 8, 20], 20, 1)).toBe(3);
    expect(nextHit([3, 8, 20], 8, -1)).toBe(3);
    expect(nextHit([3, 8, 20], 3, -1)).toBe(20);
    expect(nextHit([], 1, 1)).toBeNull();
  });

  it('marks the words looked for in a run of text', () => {
    expect(searchWords('  Heron, "reeds"! ')).toEqual(['heron', 'reeds']);
    expect(marksIn('The Heron', ['heron'])).toEqual([{ start: 4 / 9, width: 5 / 9 }]);
    expect(marksIn('heron heron', ['heron'])).toHaveLength(2);
    expect(marksIn('', ['heron'])).toEqual([]);
  });

  it('takes a page typed only when the guidebook has it', () => {
    expect(typedPage(' 12 ', 20)).toBe(12);
    expect(typedPage('0', 20)).toBeNull();
    expect(typedPage('21', 20)).toBeNull();
    expect(typedPage('2.5', 20)).toBeNull();
    expect(typedPage('x', 20)).toBeNull();
  });
});
