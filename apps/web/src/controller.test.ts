import { describe, expect, it } from 'vitest';
import { chooseTarget, padDirection, repeatDue, type Box, type Direction } from './controller';

/** A box from its left, top, width and height. */
const box = (left: number, top: number, width = 100, height = 40): Box => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

/**
 * A grid of three rows of three buttons, 100 by 40 with gaps of 20:
 *   0 1 2
 *   3 4 5
 *   6 7 8
 */
const grid = Array.from({ length: 9 }, (_, i) => box((i % 3) * 120, Math.floor(i / 3) * 60));

/** The button reached from one of the grid; the grid holds it too, as the page does. */
const from = (index: number, direction: Direction) => chooseTarget(grid[index]!, direction, grid);

describe('chooseTarget', () => {
  it('moves to the neighbour in each direction of a grid', () => {
    expect(from(4, 'up')).toBe(1);
    expect(from(4, 'down')).toBe(7);
    expect(from(4, 'left')).toBe(3);
    expect(from(4, 'right')).toBe(5);
    expect(from(0, 'right')).toBe(1);
    expect(from(2, 'down')).toBe(5);
  });

  it('finds nothing past the edge', () => {
    expect(chooseTarget(grid[0]!, 'up', grid.slice(1))).toBe(-1);
    expect(chooseTarget(grid[0]!, 'left', grid.slice(1))).toBe(-1);
    expect(chooseTarget(grid[8]!, 'down', grid.slice(0, 8))).toBe(-1);
    expect(chooseTarget(box(0, 0), 'down', [])).toBe(-1);
  });

  it('prefers a control in line over a nearer one beside it', () => {
    const start = box(0, 0);
    // Below and in line, but further; below and to the side, nearer, and
    // not over before the one in line starts.
    const inLine = box(0, 140);
    const beside = box(300, 110);
    expect(chooseTarget(start, 'down', [beside, inLine])).toBe(1);
  });

  it('takes one beside it when it ends before the one in line starts', () => {
    const start = box(0, 0);
    const beside = box(150, 50, 100, 20);
    const inLine = box(0, 400);
    expect(chooseTarget(start, 'down', [inLine, beside])).toBe(1);
  });

  it('sideways, a control in line always wins', () => {
    const start = box(0, 0);
    const inLine = box(800, 0);
    const beside = box(120, 60);
    expect(chooseTarget(start, 'right', [beside, inLine])).toBe(1);
  });

  it('of two out of line, the nearest in the direction wins', () => {
    const start = box(0, 0, 100, 40);
    const far = box(300, 300);
    const near = box(300, 100);
    expect(chooseTarget(start, 'down', [far, near])).toBe(1);
  });

  it('moves from a wide area such as the map to what lies beside it', () => {
    const map = box(80, 0, 1200, 800);
    const rail = [box(0, 0, 80, 60), box(0, 70, 80, 60), box(0, 140, 80, 60)];
    // From the map leftwards: the rail button whose middle is nearest the
    // middle of the map.
    expect(chooseTarget(map, 'left', rail)).toBe(2);
    expect(chooseTarget(map, 'right', rail)).toBe(-1);
  });

  it('skips empty boxes and keeps the page order on a tie', () => {
    const start = box(0, 0);
    expect(chooseTarget(start, 'down', [box(0, 100, 0, 0), box(0, 100), box(0, 100)])).toBe(1);
  });

  it('does not take a control around the focused one or behind it', () => {
    const start = box(100, 100);
    const around = box(0, 0, 400, 400);
    const behind = box(100, 0);
    expect(chooseTarget(start, 'down', [around, behind])).toBe(-1);
  });
});

describe('padDirection', () => {
  const none = () => false;
  it('reads the D-pad first, then the left stick past half way', () => {
    expect(padDirection([0, 0], (b) => b === 12)).toBe('up');
    expect(padDirection([0, 0], (b) => b === 13)).toBe('down');
    expect(padDirection([0, 0], (b) => b === 14)).toBe('left');
    expect(padDirection([0, 0], (b) => b === 15)).toBe('right');
    expect(padDirection([0.9, 0.1], (b) => b === 12)).toBe('up');
    expect(padDirection([0.9, 0.1], none)).toBe('right');
    expect(padDirection([-0.2, -0.7], none)).toBe('up');
    expect(padDirection([0.3, 0.3], none)).toBeNull();
    expect(padDirection([], none)).toBeNull();
  });
});

describe('repeatDue', () => {
  it('moves at once, then after a wait, then often', () => {
    expect(repeatDue(1000, 1000, -1)).toBe(true);
    expect(repeatDue(1200, 1000, 1000)).toBe(false);
    expect(repeatDue(1400, 1000, 1000)).toBe(true);
    expect(repeatDue(1450, 1000, 1400)).toBe(false);
    expect(repeatDue(1520, 1000, 1400)).toBe(true);
  });
});
