import { describe, expect, it } from 'vitest';
import type { PackDetails } from '../desktop';
import { holdsText, statusLine, type GameFacts } from './gameFacts';

const facts = (
  contents: { maps: number; locations: number; guides: number },
  layers: { downloadable: boolean }[] = [],
): GameFacts => ({
  details: { contents, layers, detail: null } as unknown as PackDetails,
  error: null,
  photos: null,
  images: null,
});
const noJobs = { images: null, photos: null };

describe('the status line of a game in the Library', () => {
  it('says what the game holds, in the plain colour, when nothing needs the person', () => {
    const demo = facts({ maps: 2, locations: 4, guides: 0 });
    for (const downloads of [true, false]) {
      expect(statusLine({ kind: 'maps', facts: demo, jobs: noJobs, downloads })).toEqual({
        text: '2 maps, 4 locations',
        tone: 'plain',
      });
    }
    expect(
      statusLine({
        kind: 'own',
        facts: facts({ maps: 1, locations: 1, guides: 0 }),
        jobs: noJobs,
        downloads: true,
      }),
    ).toEqual({ text: '1 map, 1 location', tone: 'plain' });
  });

  it('never says "Nothing to download" or "Everything downloaded"', () => {
    const lines = [true, false].flatMap((downloads) =>
      (['maps', 'own'] as const).map(
        (kind) =>
          statusLine({
            kind,
            facts: facts({ maps: 1, locations: 3, guides: 0 }),
            jobs: noJobs,
            downloads,
          }).text,
      ),
    );
    for (const text of lines) expect(text).not.toMatch(/download/i);
  });

  it('counts the pages read of a wiki, in the plain colour', () => {
    const wiki = facts({ maps: 0, locations: 0, guides: 5 });
    expect(
      statusLine({
        kind: 'wiki',
        facts: wiki,
        jobs: noJobs,
        downloads: true,
        wikiPages: { read: 5, listed: 6 },
      }),
    ).toEqual({ text: '5 of 6 pages read', tone: 'plain' });
    expect(
      statusLine({
        kind: 'wiki',
        facts: wiki,
        jobs: noJobs,
        downloads: true,
        wikiPages: { read: 6, listed: 6 },
      }).tone,
    ).toBe('plain');
  });

  it('has a colour when something waits to be downloaded', () => {
    const line = statusLine({
      kind: 'maps',
      facts: facts({ maps: 1, locations: 2, guides: 0 }, [{ downloadable: true }]),
      jobs: noJobs,
      downloads: true,
    });
    expect(line).toEqual({ text: '1 thing to do', tone: 'todo' });
  });

  it('names pages for a game without a map', () => {
    expect(holdsText({ maps: 0, locations: 0, guides: 1 })).toBe('1 page');
    expect(holdsText({ maps: 3, locations: 1200, guides: 2 })).toBe('3 maps, 1,200 locations');
  });
});
