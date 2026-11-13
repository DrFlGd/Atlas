import { describe, expect, it } from 'vitest';
import {
  NO_OWN_PAGES,
  OWN_PAGES_FORMAT,
  noOwnPages,
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
