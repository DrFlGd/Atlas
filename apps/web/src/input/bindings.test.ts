import { describe, expect, it } from 'vitest';
import {
  BINDINGS,
  CONTEXTS,
  HINTS,
  guideRows,
  hintsFor,
  isKeyOf,
  keyAction,
  keyLabel,
  padAction,
  wordsOf,
  type PadButton,
  type PadContext,
} from './bindings';

const PAD_CONTEXTS: PadContext[] = ['map', 'card', 'reading', 'lists', 'menus'];

describe('the table of keys and buttons', () => {
  it('names each action once, with words and something to press', () => {
    const ids = BINDINGS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of BINDINGS) {
      expect(item.keys.length + item.pad.length).toBeGreaterThan(0);
      expect(wordsOf(item, { lists: 'Lists' }).length).toBeGreaterThan(3);
    }
  });

  it('gives no button two actions in one context', () => {
    for (const context of PAD_CONTEXTS) {
      const seen = new Map<PadButton, string>();
      for (const item of BINDINGS) {
        if (item.context !== context && !item.alsoIn?.includes(context)) continue;
        for (const button of item.pad) {
          expect(seen.get(button), `${button} in ${context}`).toBeUndefined();
          seen.set(button, item.id);
        }
      }
    }
  });

  it('keeps the keys the app always had', () => {
    const keys = (id: Parameters<typeof isKeyOf>[0]) =>
      BINDINGS.find((item) => item.id === id)?.keys;
    expect(keys('search')).toEqual(['/']);
    expect(keys('mark-found')).toEqual(['f']);
    expect(keys('undo')).toEqual(['z']);
    expect(keys('nearest')).toEqual(['n']);
    expect(keys('lists')).toEqual(['c']);
    expect(keys('guides-home')).toEqual(['h']);
    expect(keys('guides-bar')).toEqual(['b']);
    expect(keys('turn-page')).toEqual(['[', ']']);
    expect(keys('back')).toEqual(['Escape']);
    expect(keys('keys-guide')).toEqual(['?']);
    expect(isKeyOf('mark-found', 'F')).toBe(true);
    expect(isKeyOf('zoom', '=')).toBe(true);
    expect(isKeyOf('back', 'Escape')).toBe(true);
  });

  it('lists every context in the guide, C only where there are lists', () => {
    expect(CONTEXTS.map((context) => context.id)).toEqual([
      'map',
      'reading',
      'lists',
      'menus',
      'everywhere',
    ]);
    const all = CONTEXTS.flatMap((context) => guideRows(context.id, { lists: 'Lists' }));
    expect(all).toHaveLength(BINDINGS.length);
    const without = CONTEXTS.flatMap((context) => guideRows(context.id, { lists: null }));
    expect(without.map((item) => item.id)).not.toContain('lists');
    const lists = guideRows('everywhere', { lists: 'Checklists and guides' }).find(
      (item) => item.id === 'lists',
    )!;
    expect(wordsOf(lists, { lists: 'Checklists and guides' })).toBe(
      'Checklists and guides, or back to the map',
    );
  });

  it('prints keys as the keyboard does', () => {
    expect(keyLabel('f')).toBe('F');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('PageDown')).toBe('Page Down');
    expect(keyLabel('[')).toBe('[');
  });
});

describe('padAction', () => {
  it('moves and zooms the map on the map, and moves between buttons elsewhere', () => {
    expect(padAction('map', 'ls')).toBe('pan');
    expect(padAction('map', 'rs')).toBe('pan-fine');
    expect(padAction('map', 'rt')).toBe('zoom');
    expect(padAction('map', 'dpad')).toBe('jump');
    expect(padAction('map', 'a')).toBe('open-location');
    expect(padAction('map', 'x')).toBe('mark-found');
    expect(padAction('map', 'y')).toBe('filters');
    expect(padAction('map', 'r3')).toBe('reset-view');
    expect(padAction('menus', 'ls')).toBe('move-focus');
    expect(padAction('menus', 'rs')).toBe('scroll');
    expect(padAction('menus', 'a')).toBe('press');
    expect(padAction('menus', 'y')).toBeNull();
  });

  it('turns pages with the triggers when reading, and scrolls a page elsewhere', () => {
    expect(padAction('reading', 'lt')).toBe('turn-page');
    expect(padAction('lists', 'rt')).toBe('scroll-page');
    expect(padAction('menus', 'rt')).toBe('scroll-page');
  });

  it('marks found in a card, and the next step in a list', () => {
    expect(padAction('card', 'x')).toBe('mark-found');
    expect(padAction('card', 'a')).toBe('press');
    expect(padAction('lists', 'x')).toBe('step-done');
    expect(padAction('reading', 'x')).toBeNull();
  });

  it('switches sections, goes back and opens the guide and settings everywhere', () => {
    for (const context of PAD_CONTEXTS) {
      expect(padAction(context, 'lb')).toBe('sections');
      expect(padAction(context, 'rb')).toBe('sections');
      expect(padAction(context, 'b')).toBe('back');
      expect(padAction(context, 'view')).toBe('keys-guide');
      expect(padAction(context, 'menu')).toBe('menu');
    }
  });
});

describe('keyAction', () => {
  it('gives the map its keys only on the map', () => {
    expect(keyAction('map', 'w')).toBe('pan');
    expect(keyAction('map', 'D')).toBe('pan');
    expect(keyAction('map', '=')).toBe('zoom');
    expect(keyAction('map', 'Enter')).toBe('open-location');
    expect(keyAction('map', '0')).toBe('reset-view');
    expect(keyAction('menus', 'w')).toBeNull();
    expect(keyAction('menus', 'Enter')).toBe('press');
    expect(keyAction('reading', 'q')).toBe('sections');
    expect(keyAction('reading', ']')).toBe('turn-page');
  });
});

describe('hintsFor', () => {
  it('shows four to six actions that work there, each with its buttons and a name', () => {
    for (const context of PAD_CONTEXTS) {
      const hints = hintsFor(context, { lists: 'Lists' });
      expect(hints.length).toBeGreaterThanOrEqual(4);
      expect(hints.length).toBeLessThanOrEqual(6);
      for (const hint of hints) {
        expect(hint.label, hint.id).not.toBe('');
        expect(hint.pad.length, hint.id).toBeGreaterThan(0);
        // The bar never shows a button that does something else there.
        expect(padAction(context, hint.pad[0]!), `${hint.id} in ${context}`).toBe(hint.id);
      }
    }
  });

  it('shows the map what it needs most first', () => {
    expect(HINTS.map.slice(0, 3)).toEqual(['pan', 'zoom', 'open-location']);
    expect(hintsFor('map', { lists: null }).map((hint) => hint.pad)).toEqual([
      ['ls'],
      ['lt', 'rt'],
      ['a'],
      ['x'],
      ['y'],
      ['lb', 'rb'],
    ]);
    expect(hintsFor('card', { lists: null }).map((hint) => hint.pad[0])).toEqual([
      'dpad',
      'a',
      'x',
      'b',
      'lb',
    ]);
  });
});
