import { describe, expect, it } from 'vitest';
import type { DesktopInfo } from '../desktop';
import { exitOffered } from './exit';

const app = (over: Partial<DesktopInfo>): { app: DesktopInfo } => ({
  app: { name: 'Atlas', version: '1.0.0', platform: 'linux', downloads: false, ...over },
});

describe('Exit Atlas', () => {
  it('is offered on Linux in every desktop app, whatever the settings', () => {
    expect(exitOffered(app({ exit: true }), undefined)).toBe(true);
    expect(exitOffered(app({ exit: true, downloads: true }), false)).toBe(true);
  });

  it('is offered on Windows only in the app without downloads, and only while Atlas keeps running when its window is closed', () => {
    const windows = app({ platform: 'windows', background: true });
    // Only the app without downloads keeps running; the tests are built as the app with them.
    expect(exitOffered(windows, true)).toBe(!__ATLAS_DOWNLOADS__);
    expect(exitOffered(windows, false)).toBe(false);
    expect(exitOffered(windows, undefined)).toBe(false);
  });

  it('is not offered in a browser, the Android app or where the shell does not say so', () => {
    expect(exitOffered({ app: null }, true)).toBe(false);
    expect(exitOffered(app({ platform: 'android', exit: true }), true)).toBe(false);
    expect(exitOffered(app({ platform: 'windows' }), true)).toBe(false);
    expect(exitOffered(app({ platform: 'macos' }), undefined)).toBe(false);
  });
});
