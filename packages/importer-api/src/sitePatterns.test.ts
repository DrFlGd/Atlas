import { describe, expect, it } from 'vitest';
import {
  dataPathProblem,
  fillPieces,
  piecesIn,
  piecesOf,
  patternMatches,
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
});
