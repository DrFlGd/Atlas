import { describe, expect, it } from 'vitest';
import { notePackSaved, packBusy, packSaves, packTurn } from './packTurns';

describe('one change to a pack at a time', () => {
  it('lets each step for a pack go in turn, and steps for other packs at once', async () => {
    const order: string[] = [];
    const first = packTurn('wiki');
    const second = packTurn('wiki');
    const other = packTurn('another');
    expect([first.waits, second.waits, other.waits]).toEqual([false, true, false]);
    expect(packBusy('wiki')).toBe(true);
    void second.ready.then(() => order.push('second'));
    await other.ready;
    order.push('other');
    await first.ready;
    order.push('first');
    await Promise.resolve();
    expect(order).toEqual(['other', 'first']);
    first.done();
    await second.ready;
    await Promise.resolve();
    expect(order).toEqual(['other', 'first', 'second']);
    second.done();
    other.done();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(packBusy('wiki')).toBe(false);
  });

  it('counts the saves of a pack, so a step can tell it changed meanwhile', () => {
    const before = packSaves('counted');
    notePackSaved('counted');
    expect(packSaves('counted')).toBe(before + 1);
  });
});
