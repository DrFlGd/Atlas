import { describe, expect, it } from 'vitest';
import {
  MAX_ADDRESS_BEGINNING_CHARS,
  addressBeginningProblem,
  addressBegins,
  beginningsOverlap,
  dataPathProblem,
  fillPieces,
  piecesIn,
  piecesOf,
  patternMatches,
  patternPieces,
  patternProblem,
  readDataPath,
  selectorProblem,
} from './index';

describe('address patterns', () => {
  it('match as the guide’s table says', () => {
    const cases: [string, string[], string[]][] = [
      ['/**', ['/', '/a', '/wiki/Items/Rings'], []],
      ['/wiki/**', ['/wiki/Swords', '/wiki/Items/Rings'], ['/forum/1']],
      ['/guides/*', ['/guides/chapter-1'], ['/guides/chapter-1/part-2']],
      ['/map', ['/map', '/map/'], ['/map/world', '/maps']],
      ['/**/edit', ['/wiki/Swords/edit'], ['/wiki/Editing']],
    ];
    for (const [pattern, yes, no] of cases) {
      for (const path of yes)
        expect(patternMatches(pattern, path), `${pattern} ${path}`).toBe(true);
      for (const path of no)
        expect(patternMatches(pattern, path), `${pattern} ${path}`).toBe(false);
    }
  });

  it('count upper and lower case, take every other sign as itself, and refuse other forms', () => {
    expect(patternMatches('/Wiki/*', '/wiki/A')).toBe(false);
    expect(patternMatches('/a.b/(c)', '/a.b/(c)')).toBe(true);
    expect(patternMatches('/a.b', '/axb')).toBe(false);
    expect(patternMatches('/guides/*-part', '/guides/one-part')).toBe(true);
    expect(patternProblem('wiki/**')).toMatch(/begin with \//u);
    expect(patternProblem('/a?b=1')).toMatch(/without \?/u);
    expect(patternProblem('/a/***')).toMatch(/three/u);
    expect(patternMatches('wiki/**', '/wiki/a')).toBe(false);
  });
});

describe('data paths', () => {
  const data = {
    props: { pageProps: { map: { markers: [{ at: [1, 2] }, { at: [3, 4] }] } } },
    markers: [{ id: 'a' }, { id: 'b' }, { name: 'no id' }],
    position: { x: 5 },
  };

  it('name one value, every entry of a list, or one entry', () => {
    expect(readDataPath(data, 'markers[*]')).toHaveLength(3);
    expect(readDataPath(data, 'markers[*].id')).toEqual(['a', 'b']);
    expect(readDataPath(data, 'props.pageProps.map.markers[*].at[0]')).toEqual([1, 3]);
    expect(readDataPath(data, 'position.x')).toEqual([5]);
    expect(readDataPath(data, 'markers[7]')).toEqual([]);
    expect(readDataPath([[1], [2]], '[*][0]')).toEqual([1, 2]);
  });

  it('read only a JSON object’s own fields, and refuse other forms', () => {
    expect(readDataPath({}, 'constructor')).toEqual([]);
    expect(readDataPath({ a: 1 }, 'toString')).toEqual([]);
    expect(dataPathProblem('a..b')).not.toBeNull();
    expect(dataPathProblem('a[x]')).not.toBeNull();
    expect(dataPathProblem('a.b[*].c')).toBeNull();
    expect(dataPathProblem('__proto__.x')).not.toBeNull();
    expect(readDataPath(data, 'a + b')).toEqual([]);
  });
});

describe('selectors', () => {
  it('are stored as written when their form is usable, and refused otherwise', () => {
    for (const ok of [
      'main article',
      "nav[aria-label='Breadcrumb'] a",
      'a[rel="next"]',
      '.x > p',
    ]) {
      expect(selectorProblem(ok), ok).toBeNull();
    }
    expect(selectorProblem('a:hover')).toMatch(/state/u);
    expect(selectorProblem('p::before')).toMatch(/state/u);
    expect(selectorProblem('a[href')).toMatch(/not closed/u);
    expect(selectorProblem("a[title='x]")).toMatch(/quotation/u);
    expect(selectorProblem('a { color: red }')).toMatch(/braces/u);
    expect(selectorProblem('')).toMatch(/empty/u);
    expect(selectorProblem('a'.repeat(201))).toMatch(/200/u);
  });
});

describe('named pieces', () => {
  it('stand for one whole part of a path, and fill the other patterns', () => {
    expect(piecesOf('/{game}/notes/{guide}')).toEqual({ pieces: ['game', 'guide'], problem: null });
    expect(piecesOf('https://guides.example.org/{game}/a').pieces).toEqual(['game']);
    for (const bad of ['/x{game}', '/{game}/{game}', '/{level}', '/{game', '/a}']) {
      expect(piecesOf(bad).problem, bad).not.toBeNull();
    }
    expect(piecesIn('/{game}/walkthrough', '/lantern-quest/walkthrough/')).toEqual({
      game: 'lantern-quest',
    });
    expect(piecesIn('/{game}/walkthrough', '/a/b/walkthrough')).toBeNull();
    expect(fillPieces('/{game}/notes/{guide}', { game: 'lantern' })).toBe('/lantern/notes/{guide}');
    expect(patternMatches('/{game}/*', '/lantern/Chapter_One')).toBe(true);
    expect(patternMatches('/{game}/*', '/lantern')).toBe(false);
    expect(patternProblem('/x{game}')).not.toBeNull();
  });

  it('take {system}, and {game} as the fragment of a list page', () => {
    expect(piecesOf('/atlas/{system}/index.html#{game}')).toEqual({
      pieces: ['system', 'game'],
      problem: null,
    });
    expect(piecesIn('/atlas/{system}/index.html', '/atlas/saltbox/index.html')).toEqual({
      system: 'saltbox',
    });
    expect(fillPieces('/atlas/{system}/index.html#{game}', { system: 'saltbox' })).toBe(
      '/atlas/saltbox/index.html#{game}',
    );
  });

  it('give their values in the path a pattern matches', () => {
    expect(patternPieces('/{game}/notes/{guide}', '/lantern/notes/42-tide.html')).toEqual({
      game: 'lantern',
      guide: '42-tide.html',
    });
    expect(patternPieces('/{game}/*', '/lantern/Chapter_One/')).toEqual({ game: 'lantern' });
    expect(patternPieces('/wiki/**', '/wiki/A/B')).toEqual({});
    expect(patternPieces('/{game}/*', '/lantern')).toBeNull();
    expect(patternPieces('/a.b', '/aXb')).toBeNull();
  });
});

describe('beginnings of addresses (reading.keepOff and reading.permission.allows)', () => {
  it('are written as a Disallow line of a robots.txt without its special signs', () => {
    for (const good of ['/', '/private/', '/tools/list.php', '/wiki/Page?part=2']) {
      expect(addressBeginningProblem(good), good).toBeNull();
    }
    for (const bad of [
      'private/',
      '//other.example.org/',
      '/a*b',
      '/a$',
      '/a?',
      '/a b',
      '/a#b',
      '/a\\b',
      `/${'a'.repeat(MAX_ADDRESS_BEGINNING_CHARS)}`,
    ]) {
      expect(addressBeginningProblem(bad), bad).not.toBeNull();
    }
  });

  it('cover an address whose path and query begin with one, upper and lower case counting', () => {
    const list = ['/private/', '/tools/list.php'];
    expect(addressBegins(list, 'https://wiki.example.org/private/notes')).toBe(true);
    expect(addressBegins(list, 'https://wiki.example.org/tools/list.php?from=B')).toBe(true);
    expect(addressBegins(list, 'https://wiki.example.org/Private/notes')).toBe(false);
    expect(addressBegins(list, 'https://wiki.example.org/wiki/Private')).toBe(false);
    // A query counts as a Disallow line counts it; the fragment does not.
    expect(addressBegins(['/wiki/Page?part='], 'https://wiki.example.org/wiki/Page?part=2')).toBe(
      true,
    );
    expect(addressBegins(['/wiki/Page?part='], 'https://wiki.example.org/wiki/Page#part=2')).toBe(
      false,
    );
    // Written as the address parser writes them: an accent and its escaped form are the same.
    expect(addressBegins(['/wiki/Café'], 'https://wiki.example.org/wiki/Caf%C3%A9_menu')).toBe(
      true,
    );
    expect(addressBegins(['/'], 'https://wiki.example.org/anything')).toBe(true);
    // An entry with a problem covers nothing.
    expect(addressBegins(['/a*'], 'https://wiki.example.org/a*b')).toBe(false);
  });

  it('overlap when one begins the other', () => {
    expect(beginningsOverlap('/private/', '/private/drafts/')).toBe(true);
    expect(beginningsOverlap('/private/drafts/', '/private/')).toBe(true);
    expect(beginningsOverlap('/private/', '/public/')).toBe(false);
  });
});
