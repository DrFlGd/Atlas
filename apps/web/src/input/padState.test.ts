import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAD_SETTINGS,
  glyphStyle,
  hintsShown,
  parsePadSettings,
  reticleShown,
} from './padState';

describe('parsePadSettings', () => {
  it('reads what was stored, and the default for what is missing or wrong', () => {
    expect(parsePadSettings(undefined)).toEqual(DEFAULT_PAD_SETTINGS);
    expect(
      parsePadSettings({ hints: 'never', glyphs: 'shapes', speed: 'fast', invertY: true }),
    ).toEqual({
      hints: 'never',
      glyphs: 'shapes',
      speed: 'fast',
      invertY: true,
    });
    expect(parsePadSettings({ hints: 'sometimes', speed: 3, invertY: 'yes' })).toEqual(
      DEFAULT_PAD_SETTINGS,
    );
  });
});

describe('hintsShown', () => {
  it('shows after the controller, by the setting, only with one connected', () => {
    const pad = 'Gamepad';
    expect(hintsShown({ hints: 'auto', padId: pad, source: 'pad' })).toBe(true);
    expect(hintsShown({ hints: 'auto', padId: pad, source: 'pointer' })).toBe(false);
    expect(hintsShown({ hints: 'auto', padId: pad, source: 'keys' })).toBe(false);
    expect(hintsShown({ hints: 'always', padId: pad, source: 'pointer' })).toBe(true);
    expect(hintsShown({ hints: 'never', padId: pad, source: 'pad' })).toBe(false);
    expect(hintsShown({ hints: 'always', padId: null, source: 'pad' })).toBe(false);
  });
});

describe('glyphStyle', () => {
  it('follows the controller unless chosen', () => {
    const sony = 'Wireless Controller (Vendor: 054c Product: 09cc)';
    expect(glyphStyle({ glyphs: 'auto', padId: sony })).toBe('shapes');
    expect(glyphStyle({ glyphs: 'letters', padId: sony })).toBe('letters');
    expect(glyphStyle({ glyphs: 'shapes', padId: null })).toBe('shapes');
    expect(glyphStyle({ glyphs: 'auto', padId: null })).toBe('letters');
  });
});

describe('reticleShown', () => {
  it('shows on the map and its card while the controller or the map keys are used', () => {
    const pad = { padId: 'Gamepad', source: 'pad' as const, mapKeys: false };
    expect(reticleShown({ ...pad, context: 'map' })).toBe(true);
    expect(reticleShown({ ...pad, context: 'card' })).toBe(true);
    expect(reticleShown({ ...pad, context: 'menus' })).toBe(false);
    expect(reticleShown({ ...pad, source: 'pointer', context: 'map' })).toBe(false);
    expect(reticleShown({ padId: null, source: 'keys', mapKeys: true, context: 'map' })).toBe(true);
  });
});
