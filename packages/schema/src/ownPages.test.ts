import { describe, expect, it } from 'vitest';
import {
  NO_OWN_PAGES,
  OWN_PAGES_FORMAT,
  noOwnPages,
  ownPageReadSchemas,
  readOwnPagesFile,
  writeOwnPagesFile,
  type OwnPages,
} from './index';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const T = NOW.toISOString();

const own = (): OwnPages => ({
  pages: [
    { id: 'demo:guide:own.notes', title: 'My notes', body: '# Notes\n\nMine.\n', updatedAt: T },
    {
      id: 'demo:guide:wiki-travel',
      body: 'Changed.',
      basedOn: 'The wiki text.',
      whenWikiChanges: 'take',
      updatedAt: T,
    },
    { id: 'demo:guide:wiki-wolves', hidden: true, updatedAt: T },
    { id: 'demo:guide:wiki-regions', title: 'Areas', updatedAt: T },
  ],
  sections: [
    { id: 'demo:section:own.mine', title: 'Mine' },
    { id: 'demo:section:wiki-basics', title: 'First steps' },
  ],
  contents: {
    top: ['demo:section:own.mine', 'demo:section:wiki-basics'],
    sections: {
      'demo:section:own.mine': ['demo:guide:own.notes'],
      'demo:section:wiki-basics': ['demo:guide:wiki-travel'],
      // A page put under another page.
      'demo:guide:wiki-travel': ['demo:guide:wiki-regions'],
    },
  },
  pictures: [
    {
      id: 'demo:picture:own.abc123',
      file: 'pictures/own.abc123.png',
      shareable: true,
      width: 20,
      height: 10,
    },
  ],
});

describe('own pages file', () => {
  it('is written strictly with its header and read back whole', () => {
    const text = writeOwnPagesFile('demo', own(), NOW);
    const value = JSON.parse(text) as Record<string, unknown>;
    expect(value).toMatchObject({
      format: OWN_PAGES_FORMAT,
      version: 1,
      gameId: 'demo',
      updatedAt: T,
    });
    const read = readOwnPagesFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.skipped).toBe(0);
    expect(read.file.own).toEqual(own());
  });

  it('keeps a text exactly as it is, spaces and line ends included', () => {
    const body = '  Lead.\r\n\r\n| a |\n| - |\n|  b  |\n\n\n';
    const pages: OwnPages = {
      ...NO_OWN_PAGES,
      pages: [{ id: 'demo:guide:own.x', title: 'X', body, updatedAt: T }],
    };
    const read = readOwnPagesFile(JSON.parse(writeOwnPagesFile('demo', pages, NOW)));
    expect(read.ok && read.file.own.pages[0]?.body).toBe(body);
  });

  it('refuses what is not valid when writing', () => {
    const write =
      (pages: OwnPages, game = 'demo') =>
      () =>
        writeOwnPagesFile(game, pages, NOW);
    // An own page without a text, a changed text without what it was changed from.
    expect(
      write({ ...NO_OWN_PAGES, pages: [{ id: 'demo:guide:own.x', title: 'X', updatedAt: T }] }),
    ).toThrow();
    expect(
      write({
        ...NO_OWN_PAGES,
        pages: [{ id: 'demo:guide:wiki-travel', body: 'x', updatedAt: T }],
      }),
    ).toThrow();
    // Another game's page, a page named twice, an own page hidden.
    expect(write(own(), 'other')).toThrow();
    const twice = own();
    twice.pages.push(twice.pages[0]!);
    expect(write(twice)).toThrow();
    expect(
      write({
        ...NO_OWN_PAGES,
        pages: [{ id: 'demo:guide:own.x', title: 'X', body: '', hidden: true, updatedAt: T }],
      }),
    ).toThrow();
    // A picture that is not an own picture.
    expect(
      write({
        ...NO_OWN_PAGES,
        pictures: [{ id: 'demo:picture:gate', file: 'pictures/gate.png', shareable: true }],
      }),
    ).toThrow();
  });

  it('reads tolerantly: what cannot be read is left out and counted', () => {
    const value = JSON.parse(writeOwnPagesFile('demo', own(), NOW)) as {
      pages: unknown[];
      sections: unknown[];
      contents: { top: unknown[] };
      later?: unknown;
    };
    value.pages.push({ id: 'other:guide:x', body: 'x', basedOn: 'y' }, { id: 7 });
    value.pages.push({ ...(value.pages[0] as object) });
    value.sections.push({ id: 'demo:section:own.mine', title: 'Again' });
    value.contents.top.push('not an id', 'other:section:x');
    value.later = 'something a newer app writes';
    const read = readOwnPagesFile(value);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.file.skipped).toBe(4);
    expect(read.file.own.pages.map((page) => page.id)).toEqual(own().pages.map((p) => p.id));
    expect(read.file.own.contents?.top).toEqual(own().contents!.top);
    expect(read.file.own.sections).toHaveLength(2);
  });

  it('keeps the person’s say on list pages, and reads it tolerantly', () => {
    const says = {
      ...own(),
      listPages: { 'demo:guide:wiki-travel': true, 'demo:guide:wiki-wolves': false },
    };
    const text = writeOwnPagesFile('demo', says, NOW);
    const read = readOwnPagesFile(JSON.parse(text));
    expect(read.ok && read.file.own.listPages).toEqual(says.listPages);
    expect(read.ok && read.file.skipped).toBe(0);
    // None said: no field.
    expect(
      JSON.parse(writeOwnPagesFile('demo', { ...own(), listPages: {} }, NOW)),
    ).not.toHaveProperty('listPages');
    expect(noOwnPages({ ...NO_OWN_PAGES, listPages: { 'demo:guide:wiki-travel': true } })).toBe(
      false,
    );
    // Written strictly: a page of the game, and yes or no.
    expect(() =>
      writeOwnPagesFile('demo', { ...NO_OWN_PAGES, listPages: { 'other:guide:x': true } }, NOW),
    ).toThrow();
    expect(() =>
      writeOwnPagesFile('demo', { ...NO_OWN_PAGES, listPages: { 'demo:section:x': true } }, NOW),
    ).toThrow();
    // Read tolerantly: a say that cannot be read is left out and counted.
    const value = JSON.parse(text) as { listPages: Record<string, unknown> };
    value.listPages['demo:guide:wiki-regions'] = 'yes';
    value.listPages['other:guide:x'] = true;
    const tolerant = readOwnPagesFile(value);
    expect(tolerant.ok && tolerant.file.own.listPages).toEqual(says.listPages);
    expect(tolerant.ok && tolerant.file.skipped).toBe(2);
    const odd = readOwnPagesFile({ ...value, listPages: 'all' });
    expect(odd.ok && odd.file.own.listPages).toBeUndefined();
  });

  it('with says on list pages, is read by Atlas 0.11.0 as before', () => {
    // The file as Atlas 0.11.0 reads it: the same fields, and none for the says.
    const before = ownPageReadSchemas.ownPagesFileSchema.omit({ listPages: true });
    const says = { ...own(), listPages: { 'demo:guide:wiki-travel': true } };
    const value = JSON.parse(writeOwnPagesFile('demo', says, NOW)) as Record<string, unknown>;
    expect(before.safeParse(value).success).toBe(true);
    expect(Object.keys(before.parse(value))).not.toContain('listPages');
    // What it reads of the rest is what it read before the says were written.
    const { listPages: _, ...rest } = value;
    const read = readOwnPagesFile(rest);
    const plain = readOwnPagesFile(JSON.parse(writeOwnPagesFile('demo', own(), NOW)));
    expect(read.ok && plain.ok && read.file.own).toEqual(plain.ok && plain.file.own);
    expect(read.ok && read.file.skipped).toBe(0);
  });

  it('keeps the width the person shows the pages at, and reads it tolerantly', () => {
    const chosen: OwnPages = { ...own(), pageWidth: 'full' };
    const text = writeOwnPagesFile('demo', chosen, NOW);
    expect(JSON.parse(text)).toMatchObject({ pageWidth: 'full' });
    const read = readOwnPagesFile(JSON.parse(text));
    expect(read.ok && read.file.own.pageWidth).toBe('full');
    expect(read.ok && read.file.skipped).toBe(0);
    expect(JSON.parse(writeOwnPagesFile('demo', own(), NOW))).not.toHaveProperty('pageWidth');
    // A width alone is something to keep.
    expect(noOwnPages({ ...NO_OWN_PAGES, pageWidth: 'reading' })).toBe(false);
    // Written strictly, read tolerantly: a width that cannot be read is left out.
    expect(() =>
      writeOwnPagesFile('demo', { ...own(), pageWidth: 'huge' as never }, NOW),
    ).toThrow();
    const odd = readOwnPagesFile({ ...(JSON.parse(text) as object), pageWidth: 1000 });
    expect(odd.ok && odd.file.own.pageWidth).toBeUndefined();
    expect(odd.ok && odd.file.own.pages).toEqual(read.ok && read.file.own.pages);
  });

  it('with a width, is read by an Atlas before it as before', () => {
    const before = ownPageReadSchemas.ownPagesFileSchema.omit({ pageWidth: true });
    const value = JSON.parse(
      writeOwnPagesFile('demo', { ...own(), pageWidth: 'wide' }, NOW),
    ) as Record<string, unknown>;
    expect(before.safeParse(value).success).toBe(true);
    expect(Object.keys(before.parse(value))).not.toContain('pageWidth');
  });

  it('says what is not a pages file', () => {
    expect(readOwnPagesFile({ format: 'atlas-own-lists', version: 1, gameId: 'demo' }).ok).toBe(
      false,
    );
    expect(readOwnPagesFile('text').ok).toBe(false);
    const newer = readOwnPagesFile({ format: OWN_PAGES_FORMAT, version: 3, gameId: 'demo' });
    expect(newer.ok && newer.file.version).toBe(3);
  });

  it('knows when there is nothing', () => {
    expect(noOwnPages(NO_OWN_PAGES)).toBe(true);
    expect(noOwnPages(own())).toBe(false);
  });
});
