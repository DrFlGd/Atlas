import { describe, expect, it } from 'vitest';
import { installAndroidBars, parseInsets } from './androidBars';

describe('Android system bars', () => {
  it('reads the insets the activity hands over', () => {
    expect(parseInsets('24,0,48,0')).toEqual({ top: 24, right: 0, bottom: 48, left: 0 });
    expect(parseInsets(' 31.5, 12 ,0, 12 ')).toEqual({ top: 31.5, right: 12, bottom: 0, left: 12 });
    for (const bad of [null, undefined, 24, '', '24,0,48', '24,0,48,0,1', 'a,b,c,d', '-1,0,0,0']) {
      expect(parseInsets(bad)).toBeNull();
    }
    expect(parseInsets('4000,0,0,0')).toBeNull();
  });

  it('does nothing outside the Android app', () => {
    // A window with no bridge and no document: it is not touched.
    const stop = installAndroidBars({} as Window);
    expect(typeof stop).toBe('function');
    stop();
  });
});
