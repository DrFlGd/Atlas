import { describe, expect, it } from 'vitest';
import type { SteamStatus } from '../desktop';
import { foundText, restartLabel, restartText, stateText, userName } from './steamShortcut';

const base: SteamStatus = {
  folder: 'C:\\Program Files (x86)\\Steam',
  running: false,
  gameMode: false,
  users: [
    { id: '22202', name: 'Someone', recent: true },
    { id: '1234', name: '', recent: false },
  ],
  user: '22202',
  refused: null,
  wanted: false,
  waiting: false,
  inSteam: false,
  byHand: false,
  kept: [],
};

/** Every sentence the group shows: plain, with Press and no dashes between parts. */
function sentences(status: SteamStatus): string[] {
  return [foundText(status), stateText(status) ?? '', restartText(status), restartLabel(status)];
}

describe('Atlas in Steam', () => {
  it('says what Steam and user it found', () => {
    expect(foundText(base)).toBe(
      'Steam is in C:\\Program Files (x86)\\Steam. Atlas uses the Steam user Someone.',
    );
    expect(foundText({ ...base, user: '1234' })).toBe(
      'Steam is in C:\\Program Files (x86)\\Steam. Atlas uses the Steam user 1234.',
    );
    expect(foundText({ ...base, users: [], user: null })).toMatch(/nobody has signed in/);
    expect(foundText({ ...base, folder: null, users: [], user: null })).toBe(
      "Steam isn't on this computer.",
    );
    expect(userName({ id: '7', name: '  ', recent: false })).toBe('7');
  });

  it('says where Atlas is', () => {
    expect(stateText(base)).toBeNull();
    expect(stateText({ ...base, wanted: true, inSteam: true })).toBe(
      'Atlas is in Steam with its artwork.',
    );
    expect(stateText({ ...base, wanted: true, inSteam: true, byHand: true })).toBe(
      'Atlas was in Steam already, so Atlas added its artwork to it.',
    );
    expect(
      stateText({ ...base, wanted: true, inSteam: true, byHand: true, kept: ['grid'] }),
    ).toMatch(/kept the pictures you set yourself/);
    expect(stateText({ ...base, wanted: true, waiting: true, running: true })).toBe(
      'Waiting for Steam to close.',
    );
    expect(stateText({ ...base, wanted: false, waiting: true, running: true })).toBe(
      'Waiting for Steam to close.',
    );
  });

  it('says what restarting Steam does, in Game Mode too', () => {
    const waiting = { ...base, wanted: true, waiting: true, running: true };
    expect(restartLabel(waiting)).toBe('Restart Steam and add it');
    expect(restartText(waiting)).toBe(
      'Steam has to be closed for this. Press Restart Steam and add it, and Steam closes, Atlas adds itself, and Steam starts again.',
    );
    expect(restartText({ ...waiting, gameMode: true })).toBe(
      'Steam has to be closed for this. Press Restart Steam and add it, and Steam closes, Atlas adds itself, and Steam comes back by itself. Atlas closes with Steam.',
    );
    expect(restartLabel({ ...waiting, wanted: false })).toBe('Restart Steam and take it out');
    for (const status of [waiting, { ...waiting, gameMode: true }, { ...waiting, wanted: false }]) {
      for (const text of sentences(status)) {
        expect(text).not.toMatch(/\u2014|\bTap\b|\bClick\b/);
      }
    }
  });
});
