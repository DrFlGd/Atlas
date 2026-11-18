import { describe, expect, it } from 'vitest';
import {
  checkSiteRules,
  type AtlasImporter,
  type SiteRules,
  type SiteTrial,
  type SiteTrialLayout,
  type SiteTrialRequest,
} from '@atlas/importer-api';
import {
  httpsAddress,
  layoutInWords,
  pageWidthInWords,
  readByInWords,
  SAVED_PAGE_LAYOUT_NOTE,
  trialInWords,
  trialRead,
  trierFor,
  tryRulesOn,
  consoleLineOf,
} from './siteRules';

const trial = (fields: Partial<SiteTrial>): SiteTrial => ({
  part: 0,
  headings: 0,
  pictures: 0,
  fullPictures: 0,
  tables: 0,
  chapters: 0,
  problems: [],
  ...fields,
});

describe('the address of a saved page', () => {
  it('takes a whole https address, without its fragment', () => {
    expect(httpsAddress(' https://guide.example.org/cove/one#top ')).toBe(
      'https://guide.example.org/cove/one',
    );
    // An address the person gives keeps it: on a list page of maps it names the game.
    expect(httpsAddress('https://maps.example.org/atlas/saltbox/index.html#Emberfall', true)).toBe(
      'https://maps.example.org/atlas/saltbox/index.html#Emberfall',
    );
    expect(httpsAddress('http://guide.example.org/cove/one')).toBeNull();
    expect(httpsAddress('/cove/one')).toBeNull();
    expect(httpsAddress('')).toBeNull();
  });
});

describe('what the reader understood of a saved page, in words', () => {
  it('says which part read it, what it found and what it would record', () => {
    expect(
      trialInWords(
        trial({
          part: 1,
          type: 'guide',
          title: 'The Old Quay',
          game: 'Cove',
          headings: 5,
          pictures: 7,
          fullPictures: 7,
          tables: 1,
          chapters: 3,
          contents: {
            count: 12,
            groups: ['Start', 'End'],
            first: [{ title: 'Arrival', group: 'Start' }, { title: 'The Old Quay' }],
          },
          next: 'https://guide.example.org/cove/two',
          credit: 'By A. Writer, 2026',
          licence: 'None recorded, as the file says.',
        }),
      ),
    ).toEqual([
      'Part 2 of the file read it, as a page of a guide.',
      'Its title is “The Old Quay”.',
      'The game is “Cove”.',
      'It has 5 headings, 7 pictures and 1 table.',
      'Every picture has the address of its full-size file.',
      'It is split into 3 chapters.',
      'The contents it shows list 12 pages in 2 groups.',
      'The first: Arrival (Start), The Old Quay.',
      'The next page is https://guide.example.org/cove/two.',
      'The credit line reads “By A. Writer, 2026”.',
      'Licence: None recorded, as the file says.',
    ]);
  });

  it('says how many pictures lack a full-size file, and that a guide page has no next page', () => {
    expect(trialInWords(trial({ type: 'guide', pictures: 3, fullPictures: 1 }))).toEqual([
      'Part 1 of the file read it, as a page of a guide.',
      'It has 0 headings, 3 pictures and 0 tables.',
      '1 picture of 3 has the address of a full-size file.',
      'No next page was found.',
    ]);
  });

  it('says what a map part found in a saved data file, map by map', () => {
    expect(
      trialInWords(
        trial({
          part: 1,
          type: 'map',
          game: 'Reed Isle',
          map: {
            maps: {
              count: 3,
              listed: [
                {
                  name: 'Harbour',
                  width: 4096,
                  height: 3072,
                  locations: 12,
                  described: 4,
                  linked: 1,
                  pictured: 0,
                  outside: 0,
                  image: 'https://maps.example.org/tiles/harbour/0/0/0.png',
                },
                {
                  name: 'Old Tower, Ground floor',
                  width: 1024,
                  height: 1024,
                  group: 'old-tower',
                  floor: 'Ground floor',
                  locations: 1,
                  described: 0,
                  linked: 0,
                  pictured: 1,
                  outside: 2,
                },
              ],
            },
            types: {
              count: 2,
              first: ['Key items', 'Chests'],
              found: { can: ['Key items'], cannot: ['Chests'], byName: false },
            },
            locations: {
              count: 13,
              first: [{ name: 'Rusty key', map: 'Harbour', type: 'Key items', x: 1200.5, y: 2210 }],
            },
          },
        }),
      ),
    ).toEqual([
      'Part 2 of the file read it, as the data of a map.',
      'The game is “Reed Isle”.',
      'It has 3 maps, 2 types of location and 13 locations.',
      '“Harbour”, 4,096 × 3,072 pixels: 12 locations, with 4 descriptions, 1 link, 0 pictures.',
      'One image of “Harbour”: https://maps.example.org/tiles/harbour/0/0/0.png',
      '“Old Tower, Ground floor”, 1,024 × 1,024 pixels: 1 location, with 0 descriptions, 0 links, 1 picture. It is a floor of “old-tower”. 2 locations fall outside it.',
      '1 other map is not listed here.',
      'The first types: Key items, Chests.',
      'Can be ticked as found: Key items. Cannot: Chests.',
      'The first locations: Rusty key (Key items) on “Harbour” at 1,200.5, 2,210.',
      'Not every position falls inside its map: the maps above say how many fall outside.',
    ]);
  });

  it('says in one line which types can be ticked as found, and when the reader chose by name', () => {
    const foundLine = (found: { can: string[]; cannot: string[]; byName: boolean } | undefined) =>
      trialInWords(
        trial({
          part: 0,
          type: 'map',
          map: {
            maps: { count: 0, listed: [] },
            types: { count: 3, first: [], ...(found ? { found } : {}) },
            locations: { count: 0, first: [] },
          },
        }),
      ).find((line) => line.includes('ticked'));
    expect(foundLine({ can: ['Treasure', 'Chests'], cannot: ['Enemies'], byName: false })).toBe(
      'Can be ticked as found: Treasure, Chests. Cannot: Enemies.',
    );
    expect(foundLine({ can: ['Treasure', 'Chests'], cannot: [], byName: false })).toBe(
      'Every type can be ticked as found: Treasure, Chests.',
    );
    expect(foundLine({ can: [], cannot: ['Enemies'], byName: false })).toBe(
      'None of the types can be ticked as found: Enemies.',
    );
    expect(foundLine({ can: ['Bosses'], cannot: ['Treasure'], byName: true })).toBe(
      'Can be ticked as found: Bosses. Cannot: Treasure. The file does not say which (types.found), so the reader chose from each type’s name.',
    );
    expect(foundLine({ can: [], cannot: [], byName: true })).toBeUndefined();
    expect(foundLine(undefined)).toBeUndefined();
  });

  it('says what a list page of maps that are whole pictures holds, and what would be left out', () => {
    expect(
      trialInWords(
        trial({
          part: 0,
          type: 'map',
          game: 'Emberfall',
          map: {
            wholePictures: true,
            maps: {
              count: 3,
              listed: [
                {
                  name: 'Harbour',
                  width: 4096,
                  height: 1200,
                  locations: 0,
                  described: 0,
                  linked: 0,
                  pictured: 0,
                  outside: 0,
                  image: 'https://maps.example.org/atlas/saltbox/Emberfall-Harbour.png',
                  credit: 'Ana',
                },
                {
                  name: 'Saltmarsh (Past): North',
                  width: 0,
                  height: 0,
                  locations: 0,
                  described: 0,
                  linked: 0,
                  pictured: 0,
                  outside: 0,
                  leftOut: 'It would be left out: its picture is a GIF, which this app cannot cut.',
                },
              ],
            },
            types: { count: 0, first: [] },
            locations: { count: 0, first: [] },
          },
        }),
      ),
    ).toEqual([
      'Part 1 of the file read it, as a list of maps that are whole pictures.',
      'The game is “Emberfall”.',
      'It lists 3 maps. 1 map below would be left out, as it says.',
      '“Harbour”, 4,096 × 1,200 pixels, by Ana.',
      'Its picture: https://maps.example.org/atlas/saltbox/Emberfall-Harbour.png',
      '“Saltmarsh (Past): North”, its size not given. It would be left out: its picture is a GIF, which this app cannot cut.',
      '1 other map is not listed here.',
      'No picture was asked for: each is asked for when the game is read.',
    ]);
  });

  it('says nothing when no part read the page: its problems say why', () => {
    expect(trialInWords(trial({ part: null, problems: ['Not a page of the file.'] }))).toEqual([]);
  });
});

describe('the layout a trial found, in words', () => {
  const layout = (fields: Partial<SiteTrialLayout>): SiteTrialLayout => ({
    read: 'seen',
    notes: true,
    sideBySide: 0,
    cards: 0,
    cardTitles: [],
    rows: 0,
    columns: 0,
    centred: 0,
    headings: 0,
    hidden: 0,
    leftOut: 0,
    ...fields,
  });

  it('counts each form found, the titles of the cards and what was left out', () => {
    expect(
      layoutInWords(
        layout({
          sideBySide: 2,
          cards: 3,
          cardTitles: ['Tides', 'Lanterns', 'Nets'],
          rows: 1,
          columns: 1,
          centred: 2,
          headings: 4,
          hidden: 1,
          leftOut: 3,
        }),
      ),
    ).toEqual([
      'The layout is read as the browser shows it.',
      'Layout found: 2 rows of blocks side by side, 3 cards, 1 list set in a row, 1 list in columns, 2 centred blocks and 4 lines made headings.',
      'The cards are titled: Tides, Lanterns, Nets.',
      '1 block the browser does not show was left out.',
      '3 blocks named in layout.leaveOut were left out.',
    ]);
  });

  it('says that a page saved from a browser does not show the layout of a style sheet', () => {
    expect(layoutInWords(layout({ notes: false }))).toEqual([
      'The layout is read as the browser shows it.',
      'No layout was found: the page is kept in one column.',
      SAVED_PAGE_LAYOUT_NOTE,
    ]);
    expect(layoutInWords(layout({ notes: false, read: 'stated' }))).toEqual([
      'The layout is read only as the page’s HTML states it.',
      'No layout was found: the page is kept in one column.',
    ]);
  });

  it('says when the layout is not read at all', () => {
    expect(layoutInWords(layout({ read: 'off', notes: false }))).toEqual([
      'The layout is not read: the page is kept in one column, in reading order.',
    ]);
  });

  it('comes after the rest of what the reader understood', () => {
    const lines = trialInWords(trial({ type: 'wiki', layout: layout({ cards: 1 }) }));
    expect(lines.at(-1)).toBe('Layout found: 1 card.');
  });
});

describe('which part or reader read a saved page, in words', () => {
  it('names the part, the reader of a part of its own, or the reader of a file of defaults', () => {
    expect(readByInWords(trial({ part: 1, type: 'guide' }))).toBe(
      'Part 2 of the file read it, as a page of a guide.',
    );
    expect(readByInWords(trial({ part: 0, reader: 'rules' }))).toBe(
      'Part 1 of the file read it, as a page of a wiki.',
    );
    expect(readByInWords(trial({ part: 0, reader: 'lantern-pages' }))).toBe(
      'Part 1 of the file read it with the reader “lantern-pages”, as a page of a wiki.',
    );
    const defaults = trial({
      part: null,
      reader: 'lantern-pages',
      notes: ['Read under its heading.'],
    });
    expect(trialRead(defaults)).toBe(true);
    expect(trialInWords(defaults).slice(0, 2)).toEqual([
      'The reader “lantern-pages” read it with this file’s settings, as a page of a wiki.',
      'Read under its heading.',
    ]);
    expect(trialRead(trial({ part: null }))).toBe(false);
    expect(readByInWords(trial({ part: null }))).toBeNull();
  });
});

describe('how a trial laid the page out, in words', () => {
  const seen: SiteTrialLayout = {
    read: 'seen',
    notes: false,
    sideBySide: 0,
    cards: 0,
    cardTitles: [],
    rows: 0,
    columns: 0,
    centred: 0,
    headings: 0,
    hidden: 0,
    leftOut: 0,
  };

  it('says which of the two ways the layout was read, in place of the note on saved pages', () => {
    const laidOut = layoutInWords({ ...seen, notes: true, sideBySide: 1 }, 'laid-out');
    expect(laidOut[0]).toMatch(/^The app laid the page out with the style sheets saved inside it/u);
    expect(laidOut).not.toContain(SAVED_PAGE_LAYOUT_NOTE);
    const linked = layoutInWords(seen, 'linked-sheets');
    expect(linked[0]).toMatch(/^The saved page links to style sheets it does not hold/u);
    expect(linked).not.toContain(SAVED_PAGE_LAYOUT_NOTE);
    // A file that reads the layout as stated is not laid out: no sentence on how.
    expect(layoutInWords({ ...seen, read: 'stated' }, 'laid-out')[0]).toBe(
      'The layout is read only as the page’s HTML states it.',
    );
  });

  it('says how wide the game’s pages are shown', () => {
    expect(layoutInWords({ ...seen, pageWidth: 'wide' }, 'laid-out')).toContain(
      'The game’s pages are shown wide, about 1,000 pixels, as the file says (layout.pageWidth).',
    );
    expect(pageWidthInWords('full')).toBe(
      'The game’s pages are shown as wide as the window, as the file says (layout.pageWidth).',
    );
  });
});

describe('the importer that tries a file', () => {
  const rulesOf = (value: unknown): SiteRules => {
    const checked = checkSiteRules(value);
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    return checked.rules;
  };
  const READER_FILE = rulesOf({
    format: 'atlas-site-rules',
    version: 1,
    site: { id: 'reed-wiki', name: 'Reed Wiki', game: 'Reeds', hosts: ['wiki.reed.example'] },
    parts: [{ type: 'wiki', reader: 'lantern-pages', start: '/' }],
  });
  const REFUSAL = rulesOf({
    format: 'atlas-site-rules',
    version: 1,
    refusal: {
      id: 'tide-guides',
      name: 'Tide Guides',
      domains: ['tide.example'],
      notice: 'Not read.',
    },
  });
  const asked: SiteTrialRequest[] = [];
  const importer = (cannotTry?: (rules: SiteRules) => string | null) =>
    ({
      id: 'reeds',
      sites: {
        readers: ['lantern-pages'],
        files: [],
        ...(cannotTry ? { cannotTry } : {}),
        tryPage: async (request: SiteTrialRequest) => {
          asked.push(request);
          const html = request.layOut
            ? await request.layOut({ html: request.html, url: request.url })
            : null;
          return { part: 0, reader: 'lantern-pages', headings: html ? 1 : 0, problems: [] };
        },
      },
    }) as unknown as AtlasImporter;

  it('is the first that says it can, else why none can, in a full sentence', () => {
    expect(trierFor(READER_FILE, [])).toEqual({
      problem: 'No importer of this app can try a file on a saved page.',
    });
    expect(trierFor(null, [importer(() => null)])).toEqual({
      problem: 'The file has problems, so it cannot be tried. Once its form is right, it can be.',
    });
    expect('importer' in trierFor(READER_FILE, [importer(() => null)])).toBe(true);
    expect(trierFor(READER_FILE, [importer(() => 'It reads no saved pages.')])).toEqual({
      problem: 'It reads no saved pages.',
    });
    // An importer that does not say tries parts read by rules only.
    expect(trierFor(READER_FILE, [importer()])).toEqual({
      problem: 'This importer can try only a part read by rules on a saved page.',
    });
    expect(trierFor(REFUSAL, [importer()])).toEqual({
      problem: 'This importer can try only a part read by rules on a saved page.',
    });
    const other = rulesOf({
      ...READER_FILE,
      parts: [{ type: 'wiki', reader: 'marsh-pages', start: '/' }],
    });
    expect('importer' in trierFor(other, [importer(() => null)])).toBe(true);
    expect(trierFor(other, [importer(() => 'No.')])).toEqual({
      problem:
        'No importer of this app has the reader “marsh-pages”, so this file cannot be tried. Check the name of the reader in the file against the guide to writing a file.',
    });
  });

  it('lays the page out in a frame of its own when the importer asks, and closes it', async () => {
    const frame = { opened: 0, closed: 0 };
    const openFrame = () => {
      frame.opened++;
      return Promise.resolve({
        layOut: () => Promise.resolve({ kind: 'noted' as const, html: '<main></main>' }),
        close: () => {
          frame.closed++;
        },
      });
    };
    const tried = await tryRulesOn(
      READER_FILE,
      { html: '<main></main>', address: 'https://wiki.reed.example/wiki/Reeds' },
      [importer(() => null)],
      openFrame,
    );
    expect(tried).toMatchObject({
      result: { reader: 'lantern-pages', headings: 1 },
      layout: 'laid-out',
    });
    expect(asked.at(-1)?.url).toBe('https://wiki.reed.example/wiki/Reeds');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(frame).toEqual({ opened: 1, closed: 1 });
    expect(
      await tryRulesOn(READER_FILE, { html: '<main></main>', address: null }, [
        importer(() => null),
      ]),
    ).toEqual({ problem: 'Give the address the page was saved from first.' });
  });
});

describe('the console line of a map read in the window', () => {
  /** A made-up file with a map part whose data is values of its page. */
  const file = (data: unknown, ways: string[] = ['window']) => {
    const checked = checkSiteRules({
      format: 'atlas-site-rules',
      version: 1,
      site: { id: 'cove-maps', name: 'Cove Maps', game: 'Cove', hosts: ['maps.example.net'] },
      parts: [
        {
          type: 'map',
          reader: 'rules',
          start: '/map',
          data,
          maps: {
            id: 'cove',
            name: 'Cove',
            size: [1024, 1024],
            maxZoom: 2,
            picture: { images: '/tiles/{z}/{x}/{y}.png', tile: 256 },
          },
          types: { from: 'locations' },
          locations: { path: 'board.spots[*]', fields: { type: 'kind', x: 'x', y: 'y' } },
          position: { units: 'pixels' },
          reading: { ways },
        },
      ],
    });
    if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
    return checked.rules;
  };

  it('is offered for values of the page, and for an element read in the window', () => {
    const line = consoleLineOf(file({ from: 'values', values: { board: 'coveData.board' } }))!;
    expect(line).toContain('"coveData"');
    expect(line).toContain('map-values.json');
    expect(line).not.toContain('\n');
    expect(
      consoleLineOf(file({ from: 'page', element: 'script#board' }, ['window', 'fetch'])),
    ).not.toBeNull();
    expect(consoleLineOf(file({ from: 'page', element: 'script#board' }, ['fetch']))).toBeNull();
    expect(consoleLineOf(null)).toBeNull();
  });
});
