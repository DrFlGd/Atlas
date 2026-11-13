import { describe, expect, it } from 'vitest';
import { isNothing, leadingNumber, sortedOrder } from './tableSort';

/** The keys in the order they are shown. */
const sorted = (keys: string[], direction: 'ascending' | 'descending' = 'ascending') =>
  sortedOrder(keys, direction).map((index) => keys[index]);

describe('sorting a table by a column', () => {
  it('reads the number a cell starts with', () => {
    expect(leadingNumber('147-279 (230-437)')).toBe(147);
    expect(leadingNumber('+408%')).toBe(408);
    expect(leadingNumber('-13%')).toBe(-13);
    expect(leadingNumber('−5')).toBe(-5);
    expect(leadingNumber('1,200 gold')).toBe(1200);
    expect(leadingNumber('0.4%')).toBe(0.4);
    expect(leadingNumber('.5')).toBe(0.5);
    expect(leadingNumber('10 seconds')).toBe(10);
    expect(leadingNumber('x2')).toBeNull();
    expect(leadingNumber('N/A')).toBeNull();
    expect(leadingNumber('-')).toBeNull();
  });

  it('knows a cell with nothing to sort by', () => {
    for (const text of ['', ' ', '-', '–', '—', '?', 'N/A', 'n/a', 'NA']) {
      expect(isNothing(text), text).toBe(true);
    }
    expect(isNothing('-13%')).toBe(false);
    expect(isNothing('Nail')).toBe(false);
  });

  it('sorts a column of numbers by number, both ways, with nothing last either way', () => {
    const keys = ['10 seconds', 'N/A', '+408%', '-13%', '1,200', '-', '147-279 (230-437)', '2'];
    expect(sorted(keys)).toEqual([
      '-13%',
      '2',
      '10 seconds',
      '147-279 (230-437)',
      '+408%',
      '1,200',
      'N/A',
      '-',
    ]);
    expect(sorted(keys, 'descending')).toEqual([
      '1,200',
      '+408%',
      '147-279 (230-437)',
      '10 seconds',
      '2',
      '-13%',
      'N/A',
      '-',
    ]);
  });

  it('sorts words without regard to case, numbers in words in their order', () => {
    expect(sorted(['banner', 'Axe', 'level 10', 'Level 2', 'axe'])).toEqual([
      'Axe',
      'axe',
      'banner',
      'Level 2',
      'level 10',
    ]);
    // Not every cell starts with a number: by words.
    expect(sorted(['3 wolves', 'many', '12 wolves'])).toEqual(['3 wolves', '12 wolves', 'many']);
  });

  it('keeps the page’s order for cells that are the same, both ways', () => {
    const keys = ['b', 'a', 'B', 'a', ''];
    expect(sortedOrder(keys, 'ascending')).toEqual([1, 3, 0, 2, 4]);
    expect(sortedOrder(keys, 'descending')).toEqual([0, 2, 1, 3, 4]);
  });
});
