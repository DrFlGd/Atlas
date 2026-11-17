import { parseSiteRules } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import {
  compareWithShipped,
  licenceInForm,
  licenceWith,
  ownNameOfKey,
  problemIsFor,
  putBackText,
  readRulesForm,
  sameValue,
  setInText,
  valueInWords,
  waysWith,
  type FormGroup,
  type Setting,
} from './rulesForm';
import { WAY_NAMES } from './siteRules';

/** A made-up shipped file for a made-up wiki read by a made-up built-in reader. */
const SHIPPED = {
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'saltmarsh-wiki',
    name: 'Saltmarsh Wiki',
    game: 'Saltmarsh',
    hosts: ['wiki.example.org'],
    notice: 'The made-up wiki asks for five seconds between pages.',
  },
  parts: [
    {
      type: 'wiki',
      reader: 'example-engine',
      reading: { ways: ['fetch', 'browse'], pause: 5 },
      options: { '20': 'a number-like key', api: '/made-up/api' },
      layout: { leaveOut: ['div.made-up-box'], pageWidth: 'wide' },
    },
  ],
  notes: 'Made up for a test.',
};

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const SHIPPED_TEXT = text(SHIPPED);

/** A made-up reader's defaults. */
const DEFAULTS = {
  format: 'atlas-site-rules',
  version: 1,
  readerDefaults: {
    reader: 'example-engine',
    reading: { ways: ['fetch', 'window', 'browse'] },
    licence: { ask: true },
  },
};

function read(of: string) {
  const form = readRulesForm(of);
  if (!form.ok) throw new Error(form.why);
  return form;
}

const settingOf = (of: string, field: string): { group: FormGroup; setting: Setting } => {
  for (const group of read(of).groups) {
    const setting = group.settings.find((one) => one.field === field);
    if (setting) return { group, setting };
  }
  throw new Error(`No setting ${field}`);
};

describe('reading a file into settings', () => {
  it('reads a site file into the site, each part and the file, with their values', () => {
    const form = read(SHIPPED_TEXT);
    expect(form.shape).toBe('site');
    expect(form.key).toBe('site:saltmarsh-wiki');
    expect(form.groups.map((group) => group.title)).toEqual([
      'The site',
      'Part 1: a wiki, read by the reader “example-engine”',
      'The file',
    ]);
    const values = Object.fromEntries(
      form.groups.flatMap((group) => group.settings.map((s) => [s.field, s.value])),
    );
    expect(values['site.name']).toBe('Saltmarsh Wiki');
    expect(values['parts[0].reading.ways']).toEqual(['fetch', 'browse']);
    expect(values['parts[0].reading.pause']).toBe(5);
    expect(values['parts[0].layout.pageWidth']).toBe('wide');
    expect(values['parts[0].menu.from']).toBeUndefined();
    expect(values.notes).toBe('Made up for a test.');
    // What only the JSON view shows, in words.
    expect(form.groups[0]!.also).toEqual(['the site’s id', 'the game', 'the site’s hosts']);
    expect(form.groups[1]!.also).toEqual([
      'settings only its reader understands',
      'which blocks are laid out how',
    ]);
  });

  it('takes the allowed values of each choice from the format', () => {
    const { setting } = settingOf(SHIPPED_TEXT, 'parts[0].menu.from');
    expect(
      setting.control.type === 'choice' && setting.control.options.map((o) => o.value),
    ).toEqual(['both', 'main', 'side']);
    const width = settingOf(SHIPPED_TEXT, 'parts[0].layout.pageWidth').setting;
    expect(width.control.type === 'choice' && width.control.options.map((o) => o.value)).toEqual([
      'reading',
      'wide',
      'full',
    ]);
    const pause = settingOf(SHIPPED_TEXT, 'parts[0].reading.pause').setting;
    expect(pause.control).toEqual({ type: 'pause', min: 1, max: 60 });
  });

  it('reads a reader’s defaults into one group, and says why it cannot read other texts', () => {
    const form = read(text(DEFAULTS));
    expect(form.shape).toBe('defaults');
    expect(form.key).toBe('reader:example-engine');
    expect(form.groups.map((group) => group.title)).toEqual([
      'The defaults of the reader “example-engine”',
      'The file',
    ]);
    expect(readRulesForm('{"format": ')).toMatchObject({ ok: false });
    const refusal = readRulesForm(
      text({ format: 'atlas-site-rules', version: 1, refusal: { id: 'quiet-farm' } }),
    );
    expect(refusal.ok).toBe(false);
    expect(!refusal.ok && refusal.why).toMatch(/refusal file .* JSON view/u);
    expect(readRulesForm('[1, 2]')).toMatchObject({ ok: false });
  });
});

describe('writing one setting back into the text', () => {
  it('changes only that field, keeping every other field, its order and its layout', () => {
    const changed = setInText(SHIPPED_TEXT, ['parts', 0, 'reading', 'pause'], 8, 2);
    expect(changed).toBe(SHIPPED_TEXT.replace('"pause": 5', '"pause": 8'));
    // A key that looks like a number keeps its place, as it would not through JSON.parse.
    expect(changed.indexOf('"20"')).toBeGreaterThan(changed.indexOf('"options"'));
    expect(changed.indexOf('"20"')).toBeLessThan(changed.indexOf('"api"'));
    expect(parseSiteRules(changed).ok).toBe(true);
  });

  it('adds a field at the end of its object, and makes the objects around it, as the editor lays files out', () => {
    const added = setInText(SHIPPED_TEXT, ['parts', 0, 'menu', 'from'], 'both', 2);
    const value = JSON.parse(added) as typeof SHIPPED & { parts: { menu: unknown }[] };
    expect(value.parts[0]!.menu).toEqual({ from: 'both' });
    expect(Object.keys(value.parts[0]!)).toEqual([
      'type',
      'reader',
      'reading',
      'options',
      'layout',
      'menu',
    ]);
    expect(added).toContain(
      '      "layout": {\n        "leaveOut": [\n          "div.made-up-box"\n        ],\n        "pageWidth": "wide"\n      },\n      "menu": {\n        "from": "both"\n      }\n    }\n  ],',
    );
    expect(added).toBe(text(value));
  });

  it('takes a field out with its comma, and an object it leaves empty, but never the group', () => {
    const withMenu = setInText(SHIPPED_TEXT, ['parts', 0, 'menu', 'from'], 'both', 2);
    expect(setInText(withMenu, ['parts', 0, 'menu', 'from'], undefined, 2)).toBe(SHIPPED_TEXT);
    const noWidth = setInText(SHIPPED_TEXT, ['parts', 0, 'layout', 'pageWidth'], undefined, 2);
    expect(JSON.parse(noWidth)).toMatchObject({
      parts: [{ layout: { leaveOut: ['div.made-up-box'] } }],
    });
    const noNotes = setInText(SHIPPED_TEXT, ['notes'], undefined, 0);
    expect(noNotes).toBe(text({ ...SHIPPED, notes: undefined }));
    // The first field of an object, and the only one.
    const one = '{\n  "a": {\n    "b": 1\n  },\n  "c": 2\n}\n';
    expect(setInText(one, ['a', 'b'], undefined, 1)).toBe('{\n  "a": {},\n  "c": 2\n}\n');
    expect(setInText(one, ['a', 'b'], undefined, 0)).toBe('{\n  "c": 2\n}\n');
  });

  it('keeps a file written on one line on one line, and leaves a text that is not JSON as it is', () => {
    const line = JSON.stringify(DEFAULTS);
    const changed = setInText(line, ['readerDefaults', 'reading', 'pause'], 3, 1);
    expect(changed).not.toContain('\n');
    expect(JSON.parse(changed)).toMatchObject({
      readerDefaults: { reading: { ways: ['fetch', 'window', 'browse'], pause: 3 } },
    });
    expect(setInText('{"a": ', ['a'], 1)).toBe('{"a": ');
  });

  it('ticks and unticks ways in the order the file gives them', () => {
    expect(waysWith(['browse', 'fetch'], 'window', true)).toEqual(['browse', 'fetch', 'window']);
    expect(waysWith(['browse', 'fetch'], 'browse', false)).toEqual(['fetch']);
    expect(waysWith(['fetch'], 'fetch', true)).toEqual(['fetch']);
  });

  it('changes the form of a licence block, keeping what the new form takes', () => {
    expect(
      licenceInForm({ ask: true, stated: '.made-up-licence', credit: 'A. Writer' }, 'blank'),
    ).toEqual({
      blank: true,
      credit: 'A. Writer',
    });
    expect(licenceInForm({ blank: true }, 'known')).toEqual({ known: '' });
    expect(licenceInForm({ permission: 'Asked by mail', from: 'A. Owner' }, 'permission')).toEqual({
      permission: 'Asked by mail',
      from: 'A. Owner',
    });
    expect(licenceInForm({ ask: true }, null)).toBeUndefined();
    expect(licenceWith({ permission: 'Asked', note: 'n' }, 'note', '')).toEqual({
      permission: 'Asked',
    });
    expect(licenceWith({ permission: 'Asked' }, 'permission', '')).toEqual({ permission: '' });
  });
});

describe('against the shipped file', () => {
  const COPY = setInText(
    setInText(SHIPPED_TEXT, ['parts', 0, 'reading', 'pause'], 8, 2),
    ['parts', 0, 'reading', 'ways'],
    ['browse'],
    2,
  );

  it('marks each setting that differs, with the shipped value in words', () => {
    const form = read(COPY);
    const compared = compareWithShipped(form, SHIPPED);
    const changed = [...compared].filter(([, one]) => one.changed).map(([field]) => field);
    expect(changed).toEqual(['parts[0].reading.ways', 'parts[0].reading.pause']);
    expect(compared.get('parts[0].reading.pause')!.shipped).toBe(5);
    const { setting: ways } = settingOf(COPY, 'parts[0].reading.ways');
    expect(valueInWords(ways, compared.get(ways.field)!.shipped, WAY_NAMES)).toBe(
      'By itself, As I browse',
    );
    const { setting: pause } = settingOf(COPY, 'parts[0].reading.pause');
    expect(valueInWords(pause, 5, WAY_NAMES)).toBe('5 seconds');
    expect(valueInWords(pause, undefined, WAY_NAMES)).toBe('The app’s own minimum');
    const { setting: from } = settingOf(COPY, 'parts[0].menu.from');
    expect(valueInWords(from, undefined, WAY_NAMES)).toBe('not set (the side menu only)');
    // A file of another shape has nothing to compare.
    expect(compareWithShipped(form, DEFAULTS).size).toBe(0);
  });

  it('puts one setting back, and only that one', () => {
    const form = read(COPY);
    const compared = compareWithShipped(form, SHIPPED);
    const { group, setting } = settingOf(COPY, 'parts[0].reading.pause');
    const back = putBackText(COPY, group, setting, compared.get(setting.field)!);
    expect(JSON.parse(back)).toMatchObject({
      parts: [{ reading: { ways: ['browse'], pause: 5 } }],
    });
    const again = compareWithShipped(read(back), SHIPPED);
    expect([...again].filter(([, one]) => one.changed).map(([field]) => field)).toEqual([
      'parts[0].reading.ways',
    ]);
    // A setting the shipped file does not have is taken out, with the object it leaves empty.
    const withMenu = setInText(back, ['parts', 0, 'menu', 'from'], 'main', 2);
    const menu = settingOf(withMenu, 'parts[0].menu.from');
    const shipped = compareWithShipped(read(withMenu), SHIPPED).get('parts[0].menu.from')!;
    expect(shipped).toEqual({ shipped: undefined, changed: true });
    expect(putBackText(withMenu, menu.group, menu.setting, shipped)).toBe(back);
  });

  it('finds each part of a copy in the shipped file by its type and reader', () => {
    const two = {
      ...SHIPPED,
      parts: [
        { type: 'map', reader: 'example-maps', reading: { ways: ['browse'] } },
        { ...SHIPPED.parts[0], reading: { ways: ['fetch', 'browse'], pause: 5 } },
      ],
    };
    const compared = compareWithShipped(read(text(two)), SHIPPED);
    expect(compared.has('parts[0].reading.ways')).toBe(false);
    expect(compared.get('parts[1].reading.pause')).toEqual({ shipped: 5, changed: false });
  });

  it('counts the order of an object’s fields as no change, and the order of a list as one', () => {
    expect(sameValue({ ask: true, credit: 'A' }, { credit: 'A', ask: true })).toBe(true);
    expect(sameValue(['fetch', 'browse'], ['browse', 'fetch'])).toBe(false);
    expect(sameValue(undefined, undefined)).toBe(true);
  });

  it('names the file of the person’s a key is kept under, and puts each problem beside its setting', () => {
    expect(ownNameOfKey('site:saltmarsh-wiki')).toBe('saltmarsh-wiki.atlas-site.json');
    expect(ownNameOfKey('reader:example-engine')).toBe('example-engine.reader.atlas-site.json');
    expect(ownNameOfKey('refused:quiet-farm')).toBeNull();
    const { setting } = settingOf(COPY, 'parts[0].reading.ways');
    expect(problemIsFor(setting, 'parts[0].reading.ways[1]')).toBe(true);
    expect(problemIsFor(setting, 'parts[0].reading')).toBe(true);
    expect(problemIsFor(setting, 'parts[0].reading.pause')).toBe(false);
    expect(problemIsFor(setting, null)).toBe(false);
  });
});
