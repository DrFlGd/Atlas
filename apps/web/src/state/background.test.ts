import { describe, expect, it } from 'vitest';
import { heldText, isModifierCode } from './background';

describe('pressing the keys of the hotkey', () => {
  it('shows the modifiers held, in the order the shell writes them', () => {
    expect(heldText({ ctrl: false, alt: false, shift: false, win: false })).toBe('');
    expect(heldText({ ctrl: true, alt: true, shift: false, win: false })).toBe('Ctrl+Alt+');
    expect(heldText({ ctrl: true, alt: true, shift: true, win: true })).toBe('Ctrl+Alt+Shift+Win+');
  });

  it('waits while only modifiers are pressed', () => {
    for (const code of ['ControlLeft', 'AltRight', 'ShiftLeft', 'MetaLeft', 'OSRight']) {
      expect(isModifierCode(code)).toBe(true);
    }
    for (const code of ['KeyM', 'F8', 'Escape', 'Control']) {
      expect(isModifierCode(code)).toBe(false);
    }
  });
});
