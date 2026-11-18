import { describe, expect, it } from 'vitest';
import { keptOffMessage, robotsStopMessage } from './siteLimits';

describe('why the app did not open an address on its own', () => {
  const address = 'https://wiki.example.org/private/notes';

  it('says the site’s rules file keeps it off the address', () => {
    expect(keptOffMessage(address)).toBe(
      "The site's rules file keeps this app off https://wiki.example.org/private/notes, so it did not open that address and did not read the page.",
    );
  });

  it('says robots.txt does not allow it, and that a permission recorded does not cover it', () => {
    expect(robotsStopMessage(address, {})).toBe(
      "The site's robots.txt does not allow this app to read https://wiki.example.org/private/notes, so it stopped and read no more pages.",
    );
    const permission = { from: 'the editors', on: '2026-11-02', allows: ['/private/maps/'] };
    expect(robotsStopMessage(address, { permission })).toBe(
      "The site's robots.txt does not allow this app to read https://wiki.example.org/private/notes, and the permission from the editors recorded in the site's rules file does not cover that address, so it stopped and read no more pages.",
    );
  });
});
