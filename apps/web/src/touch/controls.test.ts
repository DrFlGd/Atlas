import { describe, expect, it } from 'vitest';
import {
  afterPress,
  deckScreen,
  inputFor,
  MOUSE_PRESSES,
  MOUSE_WHILE_MS,
  nowSentence,
  parseControls,
  startingControls,
  type AutoControls,
  type ScreenFacts,
} from './controls';

const computer: ScreenFacts = {
  coarse: false,
  linux: false,
  width: 1920,
  height: 1080,
  touchPoints: 0,
};
const deck: ScreenFacts = { coarse: false, linux: true, width: 1280, height: 800, touchPoints: 10 };

/** Presses of the mouse at the times given. */
const mouseAt = (state: AutoControls, times: number[]) =>
  times.reduce((now, time) => afterPress(now, 'mouse', time), state);

describe('Automatic controls', () => {
  it('starts as the screen says', () => {
    expect(startingControls(computer, 0)).toMatchObject({ input: 'mouse', reason: 'mouse' });
    expect(startingControls({ ...computer, coarse: true }, 0)).toMatchObject({
      input: 'touch',
      reason: 'touch-screen',
      stays: true,
    });
    expect(startingControls(deck, 0)).toMatchObject({
      input: 'touch',
      reason: 'steam-deck',
      stays: true,
    });
  });

  it('knows a Steam Deck by Linux, a touch screen and 1280 by 800 either way round', () => {
    expect(deckScreen(deck)).toBe(true);
    expect(deckScreen({ ...deck, width: 800, height: 1280 })).toBe(true);
    expect(deckScreen({ ...deck, touchPoints: 0 })).toBe(false);
    expect(deckScreen({ ...deck, linux: false })).toBe(false);
    expect(deckScreen({ ...deck, width: 1920, height: 1080 })).toBe(false);
    expect(deckScreen({ ...deck, height: 720 })).toBe(false);
  });

  it('changes to fingers at a touch, and keeps them while the mouse is used now and then', () => {
    const touched = afterPress(startingControls(computer, 0), 'touch', 1000);
    expect(touched).toMatchObject({ input: 'touch', reason: 'touched', stays: false });
    // A pen, or presses of the mouse soon after the touch, change nothing.
    expect(afterPress(touched, 'pen', 2000)).toBe(touched);
    const soon = mouseAt(touched, [2000, 3000, 4000, 5000, 6000, 7000]);
    expect(soon.input).toBe('touch');
    // A touch in between starts the count again.
    const again = afterPress(soon, 'touch', MOUSE_WHILE_MS);
    const later = mouseAt(again, [MOUSE_WHILE_MS + 1000, 2 * MOUSE_WHILE_MS]);
    expect(later).toMatchObject({ input: 'touch', mousePresses: 2 });
  });

  it('goes back to a mouse once the mouse alone is used for a while', () => {
    const touched = afterPress(startingControls(computer, 0), 'touch', 0);
    const presses = Array.from({ length: MOUSE_PRESSES - 1 }, (_, n) => 1000 * (n + 1));
    const four = mouseAt(touched, presses);
    expect(four.input).toBe('touch');
    // Enough presses, but too soon after the touch: still fingers.
    expect(afterPress(four, 'mouse', MOUSE_WHILE_MS - 1).input).toBe('touch');
    // Enough presses, and long enough.
    expect(afterPress(four, 'mouse', MOUSE_WHILE_MS)).toMatchObject({
      input: 'mouse',
      reason: 'mouse-used',
      mousePresses: 0,
    });
    // Long enough, but too few presses.
    expect(afterPress(touched, 'mouse', 10 * MOUSE_WHILE_MS).input).toBe('touch');
  });

  it('stays for fingers on a phone, a tablet or a Steam Deck', () => {
    for (const start of [
      startingControls(deck, 0),
      startingControls({ ...computer, coarse: true }, 0),
    ]) {
      const used = mouseAt(
        start,
        Array.from({ length: 20 }, (_, n) => n * MOUSE_WHILE_MS),
      );
      expect(used.input).toBe('touch');
      expect(
        mouseAt(afterPress(start, 'touch', 1), [
          2 * MOUSE_WHILE_MS,
          3 * MOUSE_WHILE_MS,
          4 * MOUSE_WHILE_MS,
          5 * MOUSE_WHILE_MS,
          6 * MOUSE_WHILE_MS,
        ]).input,
      ).toBe('touch');
    }
  });

  it('follows the setting, and reads it leniently', () => {
    expect(inputFor('auto', 'touch')).toBe('touch');
    expect(inputFor('mouse', 'touch')).toBe('mouse');
    expect(inputFor('touch', 'mouse')).toBe('touch');
    expect(parseControls('touch')).toBe('touch');
    expect(parseControls('mouse')).toBe('mouse');
    expect(parseControls('auto')).toBe('auto');
    expect(parseControls(undefined)).toBe('auto');
    expect(parseControls(3)).toBe('auto');
  });

  it('says why in one sentence', () => {
    expect(nowSentence({ input: 'touch', reason: 'touched' })).toBe(
      'Now: for fingers, because the screen was touched.',
    );
    expect(nowSentence({ input: 'mouse', reason: 'mouse' })).toBe(
      'Now: for a mouse, because the screen has not been touched.',
    );
  });
});
