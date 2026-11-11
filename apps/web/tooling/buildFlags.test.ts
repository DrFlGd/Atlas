import { describe, expect, it } from 'vitest';
import { downloadsEnabled } from './buildFlags.ts';

describe('downloadsEnabled', () => {
  it('is off unless set to 1', () => {
    expect(downloadsEnabled(undefined)).toBe(false);
    expect(downloadsEnabled('')).toBe(false);
    expect(downloadsEnabled('0')).toBe(false);
    expect(downloadsEnabled(' 1 ')).toBe(true);
  });

  it('refuses anything else', () => {
    expect(() => downloadsEnabled('yes')).toThrow(/must be 1, 0 or unset/);
    expect(() => downloadsEnabled('true')).toThrow(/must be 1, 0 or unset/);
  });
});
