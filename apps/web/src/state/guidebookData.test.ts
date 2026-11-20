import { describe, expect, it } from 'vitest';
import type { ListedPack } from '../desktop';
import {
  guidebookFacts,
  guidebookPacksOf,
  isPagePicture,
  joinable,
  joinGuidebooks,
  naturalOrder,
  parseGuidebookList,
  parseGuidebookText,
  searchGuidebooks,
  sizeWords,
  titleKey,
  type Guidebook,
} from './guidebookData';

const pack = (id: string, title: string, more: Partial<ListedPack> = {}): ListedPack =>
  ({ id, title, url: `http://atlas-pack.localhost/${id}/`, ...more }) as ListedPack;

const group = (id: string, title: string, members: string[]) => ({
  id,
  title,
  members: members.map((gameId) => ({ gameId })),
});

describe('titleKey', () => {
  it('compares titles without case, space and punctuation', () => {
    expect(titleKey(' Hollow-Marsh! ')).toBe('hollow marsh');
    expect(titleKey('Hollow Marsh')).toBe(titleKey('hollow  marsh'));
    expect(titleKey('Ölfen Moor 2')).toBe('ölfen moor 2');
    expect(titleKey('!!!')).toBe('');
  });
});

describe('joinGuidebooks', () => {
  it('joins a pack of guidebooks to the games of its title', () => {
    const packs = [
      pack('hollow-marsh', 'Hollow Marsh'),
      pack('hollow-marsh-wiki', 'Hollow Marsh Wiki', { gameTitle: 'hollow marsh' }),
      pack('guidebooks-hollow-marsh', 'Hollow Marsh', { guidebooks: true }),
      pack('fen', 'Fen'),
    ];
    const joined = joinGuidebooks(packs, []);
    expect(joined.get('guidebooks-hollow-marsh')).toEqual(['hollow-marsh', 'hollow-marsh-wiki']);
    expect(guidebookPacksOf('hollow-marsh', packs, joined).map((p) => p.id)).toEqual([
      'guidebooks-hollow-marsh',
    ]);
    expect(guidebookPacksOf('fen', packs, joined)).toEqual([]);
  });

  it('joins the games the person put under one title with it', () => {
    const packs = [
      pack('marsh-maps', 'Marsh Maps'),
      pack('guidebooks-x', 'The Hollow Marsh', { guidebooks: true }),
      pack('other', 'Other'),
    ];
    const byMember = joinGuidebooks(packs, [
      group('g1', 'Anything', ['marsh-maps', 'guidebooks-x']),
    ]);
    expect(byMember.get('guidebooks-x')).toEqual(['marsh-maps']);
    // A game shown under the title of the guidebooks' game.
    const byTitle = joinGuidebooks(packs, [group('g2', 'The Hollow Marsh', ['other'])]);
    expect(byTitle.get('guidebooks-x')).toEqual(['other']);
  });

  it('leaves a pack of guidebooks of no game here as an entry of its own', () => {
    const packs = [
      pack('guidebooks-a', 'Hollow Marsh', { guidebooks: true }),
      pack('guidebooks-b', 'hollow marsh', { guidebooks: true }),
      pack('guidebooks-c', 'Fen', { guidebooks: true }),
    ];
    const joined = joinGuidebooks(packs, []);
    expect(joined.has('guidebooks-a')).toBe(false);
    expect(joined.has('guidebooks-c')).toBe(false);
    // The same game's guidebooks from two apps are one entry.
    expect(joined.get('guidebooks-b')).toEqual(['guidebooks-a']);
    expect(guidebookPacksOf('guidebooks-a', packs, joined).map((p) => p.id)).toEqual([
      'guidebooks-a',
      'guidebooks-b',
    ]);
  });

  it('joins games that come with the app', () => {
    const packs = [pack('guidebooks-demo', 'Demo Isles', { guidebooks: true })];
    const joined = joinGuidebooks(joinable(packs, [{ id: 'demo', title: 'Demo Isles' }]), []);
    expect(joined.get('guidebooks-demo')).toEqual(['demo']);
  });
});

const listText = (guidebooks: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    format: 'atlas-guidebooks',
    version: 1,
    game: { title: 'Hollow Marsh' },
    guidebooks,
    ...extra,
  });

describe('parseGuidebookList', () => {
  const listed = pack('guidebooks-hollow-marsh', 'Hollow Marsh', {
    guidebooks: true,
    guidebooksByAtlas: true,
  });

  it('reads each guidebook and where its file and text are', () => {
    const [book] = parseGuidebookList(
      listText([
        {
          file: 'guidebooks/field-guide.pdf',
          title: 'Field Guide',
          pages: 12,
          bytes: 3456,
          text: 'guidebooks/field-guide.text.json',
        },
      ]),
      listed,
    );
    expect(book).toEqual({
      key: 'guidebooks-hollow-marsh/guidebooks/field-guide.pdf',
      packId: 'guidebooks-hollow-marsh',
      file: 'guidebooks/field-guide.pdf',
      url: 'http://atlas-pack.localhost/guidebooks-hollow-marsh/guidebooks/field-guide.pdf',
      title: 'Field Guide',
      pages: 12,
      bytes: 3456,
      type: 'pdf',
      textUrl:
        'http://atlas-pack.localhost/guidebooks-hollow-marsh/guidebooks/field-guide.text.json',
      byAtlas: true,
    });
  });

  it('leaves out guidebooks that do not fit', () => {
    const good = { file: 'guidebooks/a.cbz', title: 'A', pages: 3, bytes: 10 };
    const books = parseGuidebookList(
      listText([
        good,
        { ...good },
        { ...good, file: '../escape.pdf' },
        { ...good, file: 'guidebooks/b.exe' },
        { ...good, file: 'guidebooks/Upper.pdf' },
        { ...good, file: 'guidebooks/c.pdf', pages: 0 },
        { ...good, file: 'guidebooks/d.pdf', title: ' ' },
        { ...good, file: 'guidebooks/e.pdf', title: 'x'.repeat(201) },
        { ...good, file: 'guidebooks/f.pdf', text: 'guidebooks/other.text.json' },
        { ...good, file: 'guidebooks/g.pdf', bytes: 17 * 1024 ** 3 },
        'nonsense',
      ]),
      listed,
    );
    expect(books.map((b) => b.file)).toEqual(['guidebooks/a.cbz']);
    expect(books[0]?.textUrl).toBeNull();
  });

  it('refuses a list that cannot be read', () => {
    expect(() => parseGuidebookList('{', listed)).toThrow('cannot be read');
    expect(() => parseGuidebookList(listText([], { format: 'other' }), listed)).toThrow(
      'cannot be read',
    );
    const many = Array.from({ length: 101 }, (_, i) => ({
      file: `guidebooks/b${i}.pdf`,
      title: 'B',
      pages: 1,
      bytes: 1,
    }));
    expect(() => parseGuidebookList(listText(many), listed)).toThrow('cannot be read');
  });
});

const textOf = (pages: unknown[], version = 1) =>
  JSON.stringify({ format: 'atlas-guidebook-text', version, pages });

describe('parseGuidebookText', () => {
  it('puts each page’s text in its place, and empty pages between', () => {
    expect(
      parseGuidebookText(
        textOf([
          { page: 1, text: 'One' },
          { page: 3, text: 'Three' },
        ]),
        4,
      ),
    ).toEqual(['One', '', 'Three', '']);
  });

  it('refuses text out of order, past the last page, or of a newer format', () => {
    const two = [
      { page: 2, text: 'b' },
      { page: 1, text: 'a' },
    ];
    expect(() => parseGuidebookText(textOf(two), 3)).toThrow('cannot be read');
    expect(() => parseGuidebookText(textOf([{ page: 5, text: 'x' }]), 3)).toThrow();
    expect(() => parseGuidebookText(textOf([], 2), 3)).toThrow('newer format');
    expect(() => parseGuidebookText('nope', 3)).toThrow('cannot be read');
  });
});

describe('searchGuidebooks', () => {
  const book = (key: string, title: string): Guidebook => ({
    key,
    packId: 'p',
    file: `guidebooks/${key}.pdf`,
    url: '',
    title,
    pages: 3,
    bytes: 1,
    type: 'pdf',
    textUrl: null,
    byAtlas: false,
  });

  it('finds the pages with every word, by guidebook and page', () => {
    const first = book('a', 'First');
    const second = book('b', 'Second');
    const texts = new Map([
      ['a', ['The heron nests in the reeds.', 'Nothing here.', 'A heron by the reeds again.']],
      ['b', ['Reeds only.', '', 'Heron and reeds.']],
    ]);
    const hits = searchGuidebooks([first, second], texts, 'heron reeds');
    expect(hits.map((h) => [h.guidebook.key, h.page])).toEqual([
      ['a', 1],
      ['a', 3],
      ['b', 3],
    ]);
    expect(hits[0]?.snippet).toContain('heron');
    expect(hits[0]?.marks.length).toBeGreaterThan(0);
    expect(searchGuidebooks([first, second], texts, 'heron', 2)).toHaveLength(2);
    expect(searchGuidebooks([first], texts, '   ')).toEqual([]);
    // A guidebook whose text is not known has no hits.
    expect(searchGuidebooks([book('c', 'Third')], texts, 'heron')).toEqual([]);
  });
});

describe('words for people', () => {
  it('says sizes and facts', () => {
    expect(sizeWords(1)).toBe('1 byte');
    expect(sizeWords(999)).toBe('999 bytes');
    expect(sizeWords(148_000_000)).toBe('148 MB');
    expect(sizeWords(2_500_000_000)).toBe('2.5 GB');
    expect(guidebookFacts({ type: 'pdf', pages: 212, bytes: 148_000_000 })).toBe(
      'PDF, 212 pages, 148 MB',
    );
    expect(guidebookFacts({ type: 'cbz', pages: 1, bytes: 1500 })).toBe('CBZ, 1 page, 1.5 KB');
  });
});

describe('pictures of a CBZ', () => {
  it('orders pages by their numbers', () => {
    expect(naturalOrder(['p10.jpg', 'p2.jpg', 'p1.jpg', 'a/p3.png'])).toEqual([
      'a/p3.png',
      'p1.jpg',
      'p2.jpg',
      'p10.jpg',
    ]);
  });

  it('counts pictures as the pack code does', () => {
    expect(isPagePicture('pages/001.JPG')).toBe(true);
    expect(isPagePicture('001.webp')).toBe(true);
    expect(isPagePicture('__MACOSX/001.jpg')).toBe(false);
    expect(isPagePicture('pages/.hidden.jpg')).toBe(false);
    expect(isPagePicture('notes.txt')).toBe(false);
    expect(isPagePicture('pages/')).toBe(false);
  });
});
