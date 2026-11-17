import { checkSiteRules, parseSiteRules } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import { formatJson, lineAndColumnOf, scanJson, spotOfField } from './jsonText';
import { checkEditorText, fieldSpot } from './rulesEditor';
import { RULES_TEMPLATES, examplesLeft, rulesTemplate } from './rulesTemplates';

/** A made-up file for a made-up site, laid out as the editor lays files out. */
const FILE = `${JSON.stringify(
  {
    format: 'atlas-site-rules',
    version: 1,
    site: { id: 'cove-guide', name: 'Cove Guide', game: 'Cove', hosts: ['guide.example.org'] },
    parts: [
      {
        type: 'guide',
        reader: 'rules',
        start: '/cove',
        reading: { ways: ['browse'] },
        pages: { include: ['/cove/*'] },
        contents: { from: 'menu', links: 'nav.menu a' },
        article: { content: 'main .text', remove: ['.notice', '.promo'] },
        order: { from: 'next', next: 'a.next-page' },
      },
    ],
  },
  null,
  2,
)}\n`;

const noNotes = () => [];

describe('where each field stands in the text of a file', () => {
  it('finds names, values and entries of lists, as the checker names fields', () => {
    const scan = scanJson(FILE);
    if (!scan.ok) throw new Error(scan.message);
    const spot = scan.spots.get('parts[0].article.remove[1]')!;
    expect(FILE.slice(spot.valueStart, spot.valueEnd)).toBe('".promo"');
    const title = scan.spots.get('site.name')!;
    expect(FILE.slice(title.start, title.valueEnd)).toBe('"name": "Cove Guide"');
    expect(scan.spots.get('')).toMatchObject({ valueStart: 0, valueEnd: FILE.length - 1 });
    // A field that is not there: the nearest field around it that is.
    expect(spotOfField(scan.spots, 'parts[0].article.title')).toBe(
      scan.spots.get('parts[0].article'),
    );
    expect(spotOfField(scan.spots, 'nothing.at.all')).toBe(scan.spots.get(''));
  });

  it('says where a text stops being JSON, and why, as JSON.parse reads it', () => {
    const cases: [string, number, string][] = [
      ['{"a": 1,}', 8, 'a comma cannot stand after the last entry'],
      ['{"a": 1 "b": 2}', 8, 'a , or } is expected here'],
      ["{'a': 1}", 1, 'a name in double quotation marks is expected here'],
      ['{"a": // note\n1}', 6, 'JSON has no comments'],
      ['{"a": [1, 2', 11, 'the text ends too soon'],
      ['{"a": "line\nbreak"}', 11, 'text in quotation marks cannot hold a line break'],
      ['{"a": "\\x"}', 8, 'a \\ in text must be followed by'],
      ['{"a": 01}', 7, 'a , or } is expected here'],
      ['{} {}', 3, 'there is more after the end'],
      ['{"a": tru}', 6, 'a value is expected here'],
    ];
    for (const [text, at, message] of cases) {
      const scan = scanJson(text);
      expect(scan.ok, text).toBe(false);
      expect(() => {
        JSON.parse(text);
      }, text).toThrow();
      if (!scan.ok) {
        expect(scan.at, text).toBe(at);
        expect(scan.message, text).toContain(message);
      }
    }
    for (const text of ['﻿{"a": [1, -2.5e3, true, null, "\\u00e9\\n"]}', '  []  ', '"x"']) {
      expect(scanJson(text).ok, text).toBe(true);
    }
    expect(lineAndColumnOf('{\n  "a": 1,\n}', 12)).toEqual({ line: 3, column: 1 });
  });

  it('lays out JSON with two spaces, and leaves what is not JSON alone', () => {
    expect(formatJson('{"a":[1,{"b":true}]}')).toBe(
      '{\n  "a": [\n    1,\n    {\n      "b": true\n    }\n  ]\n}\n',
    );
    expect(formatJson('{"a":')).toBeNull();
  });
});

describe('checking the text in the editor', () => {
  it('passes a file whose form is right, with what the importers say of it at its line', () => {
    const check = checkEditorText(FILE, () => [
      { field: 'parts[0]', message: 'is read by rules, which this importer only tries' },
    ]);
    expect(check.problems).toEqual([]);
    expect(check.rules).not.toBeNull();
    expect(check.notes).toEqual([
      expect.objectContaining({
        field: 'parts[0]',
        words: 'Part 1: is read by rules, which this importer only tries.',
        line: 13,
      }),
    ]);
  });

  it('places each problem of the checker at its field, and a missing field at its object', () => {
    const text = FILE.replace('"Cove Guide"', '""').replace('"content": "main .text",\n', '');
    const check = checkEditorText(text, noNotes);
    expect(check.rules).toBeNull();
    expect(check.problems.map((p) => [p.words, p.line])).toEqual([
      ['site.name: must not be empty.', 6],
      ['Part 1, article.content: is missing, and it is needed.', 31],
    ]);
    const empty = check.problems[0]!;
    expect(text.slice(empty.at, empty.end)).toBe('"name": ""');
    const missing = check.problems[1]!;
    expect(text.slice(missing.at, missing.at + 10)).toBe('"article":');
    expect(missing.end).toBe(missing.at);
  });

  it('says where a text that is not JSON stops being JSON', () => {
    const text = FILE.replace('"version": 1,', '"version": 1,,');
    const check = checkEditorText(text, noNotes);
    expect(check.problems).toEqual([
      {
        field: null,
        words:
          'The text is not plain JSON: at line 3, column 16, a name in double quotation marks is expected here.',
        at: text.indexOf(',,') + 1,
        end: text.indexOf(',,') + 1,
        line: 3,
      },
    ]);
  });

  it('finds a field of a trial to go to', () => {
    const spot = fieldSpot(FILE, 'parts[0].article.remove[1]')!;
    expect(FILE.slice(spot.at, spot.end)).toBe('".promo"');
    expect(fieldSpot('{', 'site')).toBeNull();
  });
});

describe('the templates of a new file', () => {
  it('pass the check of the format, each on a made-up host, one per type', () => {
    expect(RULES_TEMPLATES.map((t) => t.type)).toEqual(['wiki', 'guide', 'map']);
    for (const { type } of RULES_TEMPLATES) {
      const text = rulesTemplate(type);
      const checked = parseSiteRules(text);
      expect(checked.ok ? [] : checked.problems, type).toEqual([]);
      const rules = JSON.parse(text) as { site: { hosts: string[] }; parts: { type: string }[] };
      expect(rules.parts[0]!.type).toBe(type);
      expect(rules.site.hosts.every((host) => host.endsWith('example.org'))).toBe(true);
      expect(checkSiteRules(rules).ok).toBe(true);
      expect(checkEditorText(text, noNotes).problems).toEqual([]);
    }
  });

  it('say what must change before a saved page shows, and which fields are still the example’s', () => {
    for (const { type, change } of RULES_TEMPLATES) {
      expect(change, type).toMatch(/^Before a saved (page|data file) shows here, change the host/u);
      expect(change, type).toContain('simpler to start from a copy of that reader’s file instead');
      expect(change, type).not.toMatch(/—/u);
    }
    const wiki = JSON.parse(rulesTemplate('wiki')) as {
      site: { hosts: string[] };
      parts: { start: string; article: { content: string; title: string } }[];
    };
    expect(examplesLeft('wiki', wiki)).toEqual([
      'site.hosts',
      'parts[0].start',
      'parts[0].pages.include',
      'parts[0].article.content',
      'parts[0].article.title',
    ]);
    wiki.site.hosts = ['wiki.lanterns.example'];
    wiki.parts[0]!.start = '/';
    wiki.parts[0]!.article.content = '#body .text';
    expect(examplesLeft('wiki', wiki)).toEqual([
      'parts[0].pages.include',
      'parts[0].article.title',
    ]);
    const map = JSON.parse(rulesTemplate('map')) as object;
    expect(examplesLeft('map', map)).toEqual([
      'site.hosts',
      'parts[0].start',
      'parts[0].data.address',
      'parts[0].locations.path',
      'parts[0].locations.fields',
    ]);
  });
});
