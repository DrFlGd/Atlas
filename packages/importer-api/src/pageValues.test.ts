import { describe, expect, it } from 'vitest';
import demo from '../demo/demo-importer.js';
import {
  MAX_PAGE_VALUE_TEXT,
  MAX_READER_CHARS,
  PAGE_VALUES_FILE_NAME,
  asImporter,
  checkSiteRules,
  ownPageReaderOf,
  pageValuesConsoleLine,
  pageValuesOf,
  pageValuesReader,
  pageValuesOfElements,
  pageValuesSpec,
  valuesAreElements,
  type RulesMapPart,
} from './index';

/** A made-up map part whose data is values of its page. */
const PART = {
  type: 'map',
  reader: 'rules',
  start: '/maps/{map}',
  data: {
    from: 'values',
    values: {
      board: 'boardData.current',
      state: { store: 'appStore', path: 'atlas' },
    },
  },
  maps: {
    path: 'board.map',
    id: 'key',
    name: 'title',
    picture: {
      base: 'https://tiles.example.net/sets/',
      tile: 256,
      sets: { path: 'board.sets[*]', pattern: 'pattern', maxZoom: 'high' },
    },
  },
  types: { path: 'state.kinds[*]', id: 'id', name: 'label' },
  locations: {
    path: 'state.spots[*]',
    pictures: { path: 'shots[*]', address: 'href' },
    fields: { id: 'id', type: 'kind', x: 'lng', y: 'lat' },
  },
  position: { units: 'degrees', area: 'located' },
  pictures: { hosts: ['tiles.example.net'] },
  reading: { ways: ['window'] },
};

/** The part as the checker passes it, in a made-up file. */
function checked(part: unknown = PART): RulesMapPart {
  const result = checkSiteRules({
    format: 'atlas-site-rules',
    version: 1,
    site: { id: 'cove-maps', name: 'Cove Maps', game: 'Cove', hosts: ['maps.example.net'] },
    parts: [part],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return (result.rules as { parts: RulesMapPart[] }).parts[0]!;
}

/** The values of a made-up loaded map page, with fields the file never names. */
function page(spots: unknown[] = [{ id: 1, kind: 'a', lng: 1, lat: 2, shots: [{ href: 'x' }] }]) {
  return {
    boardData: {
      current: {
        map: { key: 'cove', title: 'Cove', owner: 'never taken' },
        sets: [{ pattern: 'cove/{z}/{x}/{y}.png', high: 5, secret: 'never taken' }],
      },
    },
    appStore: {
      calls: 0,
      getState() {
        this.calls++;
        return {
          atlas: { kinds: { a: { id: 'a', label: 'Shrine' } }, spots, person: 'never taken' },
          session: 'never taken',
        };
      },
    },
  };
}

/** Runs a reader of no arguments in a made-up window, as the app's window would. */
function run(reader: string, window: Record<string, unknown>, readyState = 'complete'): unknown {
  const win = { document: { readyState, querySelector: () => null }, ...window };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const read = new Function('window', `return (${reader})();`) as (w: unknown) => unknown;
  return read(win);
}

describe('the values of a map page, read in the window', () => {
  it('are taken by a spec made from the checked paths only', () => {
    const spec = pageValuesSpec(checked())!;
    expect(spec.values).toEqual([
      { name: 'board', from: ['boardData', 'current'] },
      { name: 'state', from: ['appStore'], call: 'store', inside: ['atlas'] },
    ]);
    expect(spec.keep).toEqual({
      board: {
        map: { key: 1, title: 1 },
        sets: { '*': { pattern: 1, high: 1 } },
      },
      state: {
        kinds: { '*': { id: 1, label: 1 } },
        spots: { '*': { id: 1, kind: 1, lng: 1, lat: 1, shots: { '*': { href: 1 } } } },
      },
    });
    expect(spec.wait).toEqual([
      { name: 'board', steps: ['map'] },
      { name: 'board', steps: ['sets'] },
      { name: 'state', steps: ['kinds'] },
      { name: 'state', steps: ['spots'] },
    ]);
    // A part whose data is a file has no values to read in a window.
    expect(
      pageValuesSpec({ ...checked(), data: { from: 'file', address: '/map.json' } }),
    ).toBeNull();
  });

  it('take the icon of each type and its part of a sheet only where the file reads them', () => {
    const part = checked({
      ...PART,
      types: {
        ...PART.types,
        picture: {
          address: 'badge.src',
          cut: { x: 'badge.left', y: 'badge.top', width: 'w', height: 'h' },
        },
      },
    });
    expect(pageValuesSpec(part)!.keep.state).toMatchObject({
      kinds: { '*': { id: 1, label: 1, badge: { src: 1, left: 1, top: 1 }, w: 1, h: 1 } },
    });
    expect((pageValuesSpec(checked())!.keep.state as { kinds: unknown }).kinds).toEqual({
      '*': { id: 1, label: 1 },
    });
  });

  it('copy only the named fields, call only getState, and run no getter', () => {
    const reader = pageValuesReader(checked())!;
    expect(reader.length).toBeLessThan(MAX_READER_CHARS);
    const values = page();
    const got = run(reader, values);
    expect(got).toEqual({
      atlasPageValues: 1,
      values: {
        board: {
          map: { key: 'cove', title: 'Cove' },
          sets: [{ pattern: 'cove/{z}/{x}/{y}.png', high: 5 }],
        },
        state: {
          kinds: { a: { id: 'a', label: 'Shrine' } },
          spots: [{ id: 1, kind: 'a', lng: 1, lat: 2, shots: [{ href: 'x' }] }],
        },
      },
    });
    expect(values.appStore.calls).toBe(1);
    expect(JSON.stringify(got)).not.toContain('never taken');
    // Behind a getter, inherited, or in an object of a class: not taken, so the reader waits.
    let ran = false;
    const getter = {
      ...page(),
      boardData: {
        get current() {
          ran = true;
          return page().boardData.current;
        },
      },
    };
    expect(run(reader, getter)).toBeNull();
    expect(ran).toBe(false);
    const inherited = { ...page(), boardData: Object.create(page().boardData) as object };
    expect(run(reader, inherited)).toBeNull();
    class Board {
      map = { key: 'cove', title: 'Cove' };
      sets = [];
    }
    const classy = { ...page(), boardData: { current: new Board() } };
    expect(run(reader, classy)).toBeNull();
  });

  it('take the facts every map shares, and nothing else of their object', () => {
    const part = checked({
      ...PART,
      maps: {
        path: 'board.sheet.layers[*]',
        id: 'key',
        name: 'label',
        shared: {
          path: 'board.sheet',
          id: 'number',
          size: ['width', 'height'],
          maxZoom: 'top',
          minZoom: 'low',
        },
        picture: { images: '/pictures/{shared}/{map}/{z}/{x}-{y}.png', tile: 256 },
      },
      locations: { ...PART.locations, fields: { ...PART.locations.fields, map: 'on[*]' } },
      position: { units: 'pixels' },
    });
    const spec = pageValuesSpec(part)!;
    expect(spec.keep.board).toEqual({
      sheet: {
        layers: { '*': { key: 1, label: 1 } },
        number: 1,
        width: 1,
        height: 1,
        top: 1,
        low: 1,
      },
    });
    expect(spec.wait).toContainEqual({ name: 'board', steps: ['sheet'] });
    expect((spec.keep.state as { spots: { '*': object } }).spots['*']).toMatchObject({
      on: { '*': 1 },
    });
    const sheet = {
      number: 31,
      width: 12_000,
      height: 9_000,
      top: 16,
      low: 10,
      owner: 'never taken',
      layers: [{ key: 4, label: 'Harbour', secret: 'never taken' }],
    };
    const got = run(pageValuesReader(part)!, {
      ...page([{ id: 1, kind: 'a', lng: 1, lat: 2, on: [4, 5] }]),
      boardData: { current: { sheet } },
    }) as { values: { board: unknown; state: { spots: unknown[] } } };
    expect(got.values.board).toEqual({
      sheet: {
        number: 31,
        width: 12_000,
        height: 9_000,
        top: 16,
        low: 10,
        layers: [{ key: 4, label: 'Harbour' }],
      },
    });
    expect(got.values.state.spots).toEqual([{ id: 1, kind: 'a', lng: 1, lat: 2, on: [4, 5] }]);
  });

  it('wait until the values are there and the lists hold something', () => {
    const reader = pageValuesReader(checked())!;
    expect(run(reader, page(), 'loading')).toBeNull();
    expect(run(reader, { appStore: page().appStore })).toBeNull();
    expect(run(reader, { ...page(), appStore: {} })).toBeNull();
    const empty = page([]);
    expect(run(reader, empty, 'interactive')).toBeNull();
    expect(run(reader, { ...empty, performance: { now: () => 1_000 } })).toBeNull();
    expect(run(reader, { ...empty, performance: { now: () => 16_000 } })).not.toBeNull();
  });

  it('take the routes when the page has them, and read a map without them as well', () => {
    const part = checked({
      ...PART,
      data: { from: 'values', values: { ...PART.data.values, trails: 'trailBox.list' } },
      routes: {
        path: 'trails[*]',
        id: 'key',
        title: 'name',
        type: 'kind',
        steps: { path: 'stops[*]', title: 'label', text: 'tip', location: 'spot' },
      },
    });
    expect(pageValuesSpec(part)!.values.find((v) => v.name === 'trails')?.optional).toBe(true);
    expect(pageValuesSpec(part)!.values.find((v) => v.name === 'board')?.optional).toBeUndefined();
    const reader = pageValuesReader(part)!;
    const trails = [
      {
        key: 't',
        name: 'Shore walk',
        kind: 'walkthrough',
        secret: 'never taken',
        stops: [{ label: 'Pier', tip: 'Go', spot: 1, colour: 'never taken' }],
      },
    ];
    const got = run(reader, { ...page(), trailBox: { list: trails } }) as {
      values: { trails: unknown };
    };
    expect(got.values.trails).toEqual([
      {
        key: 't',
        name: 'Shore walk',
        kind: 'walkthrough',
        stops: [{ label: 'Pier', tip: 'Go', spot: 1 }],
      },
    ]);
    // Without routes, and with none yet: the map is read, without them.
    const without = run(reader, page()) as { values: Record<string, unknown> };
    expect(without.values.trails).toBeUndefined();
    expect(without.values.board).toBeDefined();
    expect(run(reader, { ...page(), trailBox: { list: [] } })).not.toBeNull();
  });

  it('leave out a text that is too long, and say so', () => {
    const reader = pageValuesReader(checked())!;
    const long = page([{ id: 'x'.repeat(MAX_PAGE_VALUE_TEXT + 1), kind: 'a', lng: 1, lat: 2 }]);
    const got = run(reader, long) as { cut?: number; values: { state: { spots: object[] } } };
    expect(got.cut).toBe(1);
    expect(got.values.state.spots[0]).toEqual({ kind: 'a', lng: 1, lat: 2 });
  });

  it('read the JSON of an element of the page', () => {
    const part = checked({
      ...PART,
      data: {
        from: 'values',
        values: { board: { element: 'script#board' }, state: PART.data.values.state },
      },
      maps: { ...PART.maps, path: 'board.map' },
    });
    const reader = pageValuesReader(part)!;
    const json = JSON.stringify(page().boardData.current);
    const document = {
      readyState: 'complete',
      querySelector: (selector: string) =>
        selector === 'script#board' ? { textContent: json } : null,
    };
    const got = run(reader, { ...page(), document }) as { values: Record<string, unknown> };
    expect(got.values.board).toEqual({
      map: { key: 'cove', title: 'Cove' },
      sets: [{ pattern: 'cove/{z}/{x}/{y}.png', high: 5 }],
    });
    const broken = { readyState: 'complete', querySelector: () => ({ textContent: '{nope' }) };
    expect(run(reader, { ...page(), document: broken })).toBeNull();
  });

  it('are handed over as one checked shape', () => {
    expect(pageValuesOf({ atlasPageValues: 1, values: { a: 1 } })).toEqual({
      atlasPageValues: 1,
      values: { a: 1 },
    });
    expect(pageValuesOf({ atlasPageValues: 1, values: { a: 1 }, cut: 2.5 })).toMatchObject({
      cut: 2,
    });
    expect(pageValuesOf({ atlasPageValues: 2, values: {} })).toBeNull();
    expect(pageValuesOf({ fetched: [] })).toBeNull();
    expect(pageValuesOf([])).toBeNull();
  });
});

describe('the values of a map page that are all elements, read from a saved page', () => {
  /** A made-up part whose two values are both the JSON of elements of its page. */
  const elements = {
    ...PART,
    data: {
      from: 'values',
      values: {
        board: { element: 'script#board' },
        state: { element: 'script#state', path: 'props.atlas' },
      },
    },
  };
  const texts: Record<string, string> = {
    'script#board': JSON.stringify(page().boardData.current),
    'script#state': JSON.stringify({
      props: {
        atlas: {
          kinds: { a: { id: 'a', label: 'Shrine' } },
          spots: [{ id: 1, kind: 'a', lng: 1, lat: 2, shots: [{ href: 'x' }] }],
          person: 'never taken',
        },
      },
    }),
  };
  const textOf = (selector: string) => texts[selector] ?? null;

  it('take what the window reader would take from the same elements', () => {
    const part = checked(elements);
    expect(valuesAreElements(part)).toBe(true);
    const saved = pageValuesOfElements(part, textOf);
    const document = {
      readyState: 'complete',
      querySelector: (selector: string) =>
        texts[selector] === undefined ? null : { textContent: texts[selector] },
    };
    const inWindow = run(pageValuesReader(part)!, { document, performance: { now: () => 60_000 } });
    expect(saved).toEqual(inWindow);
    expect(saved).toEqual({
      atlasPageValues: 1,
      values: {
        board: {
          map: { key: 'cove', title: 'Cove' },
          sets: [{ pattern: 'cove/{z}/{x}/{y}.png', high: 5 }],
        },
        state: {
          kinds: { a: { id: 'a', label: 'Shrine' } },
          spots: [{ id: 1, kind: 'a', lng: 1, lat: 2, shots: [{ href: 'x' }] }],
        },
      },
    });
  });

  it('say plainly which value is missing, and leave a long text out as the window reader does', () => {
    const part = checked(elements);
    expect(
      pageValuesOfElements(part, (selector) =>
        selector === 'script#board' ? textOf(selector) : null,
      ),
    ).toEqual({
      problem: 'The saved page has no element script#state (data.values.state).',
    });
    expect(
      pageValuesOfElements(part, (selector) =>
        selector === 'script#state' ? '{nope' : textOf(selector),
      ),
    ).toEqual({
      problem: 'The text of the element script#state (data.values.state) is not JSON.',
    });
    expect(
      pageValuesOfElements(part, (selector) =>
        selector === 'script#state' ? '{"props":{}}' : textOf(selector),
      ),
    ).toEqual({
      problem:
        'The path of data.values.state found nothing in the JSON of the element script#state.',
    });
    const long = JSON.stringify({
      props: {
        atlas: {
          kinds: {},
          spots: [{ id: 'x'.repeat(MAX_PAGE_VALUE_TEXT + 1), kind: 'a', lng: 1, lat: 2 }],
        },
      },
    });
    const got = pageValuesOfElements(part, (selector) =>
      selector === 'script#state' ? long : textOf(selector),
    );
    expect(got).toMatchObject({
      cut: 1,
      values: { state: { spots: [{ kind: 'a', lng: 1, lat: 2 }] } },
    });
  });

  it('are not for a part with a value of another form', () => {
    expect(valuesAreElements(checked())).toBe(false);
    expect(pageValuesOfElements(checked(), textOf)).toBeNull();
    const mixed = checked({
      ...elements,
      data: {
        from: 'values',
        values: { board: { element: 'script#board' }, state: PART.data.values.state },
      },
    });
    expect(valuesAreElements(mixed)).toBe(false);
    expect(pageValuesOfElements(mixed, textOf)).toBeNull();
  });
});

describe('the console line', () => {
  it('is one line that saves what the window reader would hand over', () => {
    const line = pageValuesConsoleLine(checked())!;
    expect(line).not.toContain('\n');
    expect(line).toContain(PAGE_VALUES_FILE_NAME);
    let saved: { name: string; text: string } | null = null;
    const logged: string[] = [];
    class FakeBlob {
      constructor(readonly parts: string[]) {}
    }
    const fake = (values: object) => ({
      document: {
        readyState: 'complete',
        querySelector: () => null,
        createElement: () => {
          const link = {
            href: '',
            download: '',
            click: () => {
              saved = { name: link.download, text: link.href };
            },
          };
          return link;
        },
      },
      ...values,
    });
    const urls = { createObjectURL: (blob: FakeBlob) => blob.parts.join('') };
    const console = { log: (text: string) => logged.push(text) };
    const runLine = (window: object) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function('window', 'document', 'URL', 'Blob', 'console', line) as (
        ...a: unknown[]
      ) => void;
      fn(window, (window as { document: unknown }).document, urls, FakeBlob, console);
    };
    runLine(fake({ appStore: page().appStore }));
    expect(saved).toBeNull();
    expect(logged).toEqual([
      'The map’s values are not there yet. Wait until the map has loaded, then paste the line again.',
    ]);
    runLine(fake(page()));
    expect(saved!.name).toBe(PAGE_VALUES_FILE_NAME);
    expect(JSON.parse(saved!.text)).toEqual(run(pageValuesReader(checked())!, page()));
  });
});

describe('an importer’s reader of its own for an address', () => {
  const base = demo as object;

  it('is the reader it gives, or none', () => {
    expect(ownPageReaderOf(asImporter(base), 'https://maps.example.net/x')).toBeNull();
    const own = asImporter({
      ...base,
      pageReaderFor: (url: string) => (url.endsWith('/cove') ? '() => 1' : null),
    });
    expect(ownPageReaderOf(own, 'https://maps.example.net/maps/cove')).toBe('() => 1');
    expect(ownPageReaderOf(own, 'https://maps.example.net/other')).toBeNull();
    const throws = asImporter({
      ...base,
      pageReaderFor: () => {
        throw new Error('no');
      },
    });
    expect(ownPageReaderOf(throws, 'https://maps.example.net/maps/cove')).toBeNull();
    const long = asImporter({ ...base, pageReaderFor: () => 'x'.repeat(MAX_READER_CHARS + 1) });
    expect(ownPageReaderOf(long, 'https://maps.example.net/maps/cove')).toBeNull();
  });
});
