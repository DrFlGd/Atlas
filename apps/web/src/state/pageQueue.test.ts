import type { ListedPage } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import {
  choiceGame,
  chosenToRead,
  newChoice,
  overCap,
  goRoom,
  splitChosen,
  tickFrom,
  toggleGroup,
} from './gameChoice';
import {
  MAX_FETCHED_RUN_PAGES,
  MAX_RUN_ADDRESSES,
  checkAddresses,
  newRun,
  settlePage,
  stopReasonText,
} from './importRun';

/**
 * Reading a made-up wiki's pages: an importer that fetches pages keeps
 * those that do not fit in one go, and a refusal stops the go at once.
 */

const SITE = 'https://wiki.example.org';
const wiki = {
  id: 'example-wiki',
  title: 'Example wiki',
  matches: (url: string) => url.startsWith(`${SITE}/wiki/`),
  refuses: (url: string) => (url.includes('refused.example') ? 'That site is not read.' : null),
};
const page = (n: number, group: string): ListedPage => ({
  url: `${SITE}/wiki/Page_${n}`,
  kind: 'page',
  title: `Page ${n}`,
  group,
});
const pages = Array.from({ length: 40 }, (_, i) => page(i, i < 30 ? 'Areas' : 'People'));

const choice = () =>
  newChoice(
    'add',
    [
      choiceGame({
        key: `${SITE}/wiki/Contents`,
        title: 'Example wiki',
        importer: wiki,
        packId: null,
        listed: pages,
        recorded: [],
        queues: true,
      }),
    ],
    1,
  );

describe('choosing the pages of a wiki', () => {
  it('ticks nothing at first, then a section, or a page and every page after it', () => {
    let chosen = choice();
    expect(chosenToRead(chosen)).toEqual([]);
    chosen = toggleGroup(chosen, `${SITE}/wiki/Contents`, 'People');
    expect(chosenToRead(chosen).map((p) => p.title)).toEqual(pages.slice(30).map((p) => p.title));
    expect(chosenToRead(chosen)[0]).toMatchObject({ group: 'People', queues: true });
    chosen = toggleGroup(chosen, `${SITE}/wiki/Contents`, 'People');
    expect(chosenToRead(chosen)).toEqual([]);
    chosen = tickFrom(chosen, `${SITE}/wiki/Contents`, pages[5]!.url);
    expect(chosenToRead(chosen)).toHaveLength(35);
  });

  it('reads every page ticked in one go, since the app fetches them with no window', () => {
    const chosen = tickFrom(choice(), `${SITE}/wiki/Contents`, pages[0]!.url);
    expect(overCap(chosen)).toBeNull();
    expect(pages.length).toBeGreaterThan(MAX_RUN_ADDRESSES);
    expect(goRoom(chosen)).toBe(MAX_FETCHED_RUN_PAGES);
    const { now, later } = splitChosen(chosen);
    expect(now.map((p) => p.url)).toEqual(pages.map((p) => p.url));
    expect(later).toEqual([]);
  });
});

describe('pages their site shows only to a person', () => {
  const windowed = () =>
    newChoice(
      'add',
      [
        choiceGame({
          key: `${SITE}/wiki/Contents`,
          title: 'Example wiki',
          importer: wiki,
          packId: null,
          listed: pages,
          recorded: [],
          queues: true,
          inWindow: true,
        }),
      ],
      1,
    );

  it('open in a window, as many as one go opens, and the rest are kept for later', () => {
    const chosen = tickFrom(windowed(), `${SITE}/wiki/Contents`, pages[0]!.url);
    // More may be ticked than one go opens: nothing has to be unticked.
    expect(overCap(chosen)).toBeNull();
    // The list of pages was opened in a window too, and counts.
    expect(goRoom(chosen)).toBe(MAX_RUN_ADDRESSES - 1);
    const { now, later } = splitChosen(chosen);
    expect(now).toHaveLength(MAX_RUN_ADDRESSES - 1);
    expect(now.every((p) => p.inWindow === true)).toBe(true);
    expect(later.map((p) => p.url)).toEqual(pages.slice(MAX_RUN_ADDRESSES - 1).map((p) => p.url));
  });
});

describe('a go that a site refuses', () => {
  it('stops at once, and says so', () => {
    let run = newRun(pages.slice(0, 3).map((p) => p.url));
    run = settlePage(run, 0, { kind: 'refused', message: 'The site asked to slow down.' });
    expect(run.status).toBe('stopped');
    expect(run.stopReason).toBe('refused');
    expect(run.pages.slice(1).map((p) => p.state.kind)).toEqual(['not-started', 'not-started']);
    expect(stopReasonText('refused')).toMatch(/stopped at once/);
  });

  it('never opens an address an importer refuses', () => {
    const [checked] = checkAddresses(['https://refused.example/wiki/A'], [wiki]);
    expect(checked).toEqual({
      url: 'https://refused.example/wiki/A',
      importer: null,
      problem: 'That site is not read.',
    });
  });
});
