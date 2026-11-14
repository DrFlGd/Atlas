import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_STYLE_SHEETS,
  MAX_STYLE_SHEET_BYTES,
  asImporter,
  pageStylesOf,
  utf8Bytes,
  type AtlasImporter,
} from './index';

const importer: AtlasImporter = {
  apiVersion: 1,
  id: 'wikis',
  title: 'Wikis',
  description: 'Reads made-up wikis.',
  version: '1.0.0',
  matches: () => true,
  fetch: { addresses: (url) => [url] },
  pageReader: '() => null',
  convert: () => ({ ok: false, message: 'no' }),
};

describe('the style sheets a page hands over', () => {
  it('are taken in their shape, within the limits, and anything else is left out', () => {
    expect(
      pageStylesOf({
        sheets: [
          {
            address: 'https://wiki.example.org/load.css',
            readable: true,
            chars: 22,
            mark: '22-a',
            text: '.box { float: right; }',
          },
          { readable: true, chars: 7, mark: '7-b', text: '.hide{}' },
          // Kept already: its mark alone.
          { address: 'https://wiki.example.org/skin.css', readable: true, chars: 9, mark: '9-c' },
          { address: 'https://files.example.net/a.css', readable: false, text: 'ignored' },
          // A block of the page the page could not read: nothing to know it by.
          { readable: false },
          { address: 'javascript:alert(1)', readable: true, chars: 1, mark: 'x', text: 'x' },
          { address: 'http://wiki.example.org/plain.css', readable: false },
          { readable: true, chars: 1, mark: '', text: 'x' },
          { readable: true, chars: 1, mark: 'm'.repeat(201), text: 'x' },
          { readable: true, chars: -1, mark: 'x', text: 'x' },
          { readable: 'yes', mark: 'x', chars: 1 },
          null,
          'sheet',
        ],
      }),
    ).toEqual({
      sheets: [
        {
          address: 'https://wiki.example.org/load.css',
          readable: true,
          chars: 22,
          mark: '22-a',
          text: '.box { float: right; }',
        },
        { readable: true, chars: 7, mark: '7-b', text: '.hide{}' },
        { address: 'https://wiki.example.org/skin.css', readable: true, chars: 9, mark: '9-c' },
        { address: 'https://files.example.net/a.css', readable: false },
      ],
    });
    for (const odd of [null, 'sheets', {}, { sheets: 'all' }]) expect(pageStylesOf(odd)).toBeNull();
  });

  it('never take a text larger than one sheet may be, nor more sheets than a page may have', () => {
    const big = 'a'.repeat(MAX_STYLE_SHEET_BYTES + 1);
    expect(
      pageStylesOf({ sheets: [{ readable: true, chars: big.length, mark: 'big', text: big }] }),
    ).toEqual({ sheets: [{ readable: true, chars: big.length, mark: 'big' }] });
    const many = Array.from({ length: MAX_PAGE_STYLE_SHEETS + 5 }, (_, n) => ({
      readable: true,
      chars: 2,
      mark: `m${n}`,
      text: '{}',
    }));
    expect(pageStylesOf({ sheets: many })!.sheets).toHaveLength(MAX_PAGE_STYLE_SHEETS);
    expect(utf8Bytes('aé€\u{1f600}')).toBe(1 + 2 + 3 + 4);
  });

  it('come from an importer’s style reader, which an importer may leave out', () => {
    expect(asImporter({ ...importer, styleReader: '(marks) => null' }).styleReader).toBe(
      '(marks) => null',
    );
    expect(asImporter(importer).styleReader).toBeUndefined();
    expect(() => asImporter({ ...importer, styleReader: '' })).toThrow(/styleReader/);
    expect(() => asImporter({ ...importer, styleReader: 'x'.repeat(64 * 1024 + 1) })).toThrow(
      /styleReader/,
    );
  });
});
