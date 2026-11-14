import { describe, expect, it } from 'vitest';
import {
  PageNameIndex,
  lettersApart,
  letterSlack,
  nameTokens,
  otherNameOfId,
  withMentions,
  type NamedPage,
} from './nameMatch';

/** Made-up pages of a made-up wiki. */
const page = (id: string, title: string, otherNames?: string[]): NamedPage => ({
  id: `isle:guide:${id}`,
  title,
  ...(otherNames ? { otherNames } : {}),
});

const PAGES: NamedPage[] = [
  page('wolves', 'Wolves'),
  page('wolf-den', 'Wolf Den'),
  page('stone-warden', 'Stone Warden (enemy)'),
  page('greatsword', 'Greatsword'),
  page('great-hall', 'The Great Hall'),
  page('ironbound', 'Ironbound chests'),
  page('frost-wyrm', 'Frost wyrm'),
  page('frost', 'Frost'),
  page('frost-bolt', 'Frost bolt'),
  page('frost-ward', 'Frost ward'),
  page('lady', 'Lady of the Lake'),
  page('cafe', 'Café Noir'),
  page('act-2', 'Act 2'),
  page('act-3', 'Act 3'),
  page('hollow', 'Hollow king', ['the-crownless-one']),
  page('moonpetal', 'Moonpetal'),
];

const index = () => new PageNameIndex(PAGES);
const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id.split(':').at(-1));
const first = (name: string) => ids(index().find(name))[0];

describe('words and letters', () => {
  it('tidies a name as linking does, without a number or a note at its end', () => {
    expect(nameTokens('The Stone Wardens 12').words).toEqual(['ston', 'warden']);
    expect(nameTokens('Wolf den (north)').words).toEqual(['wolf', 'den']);
    expect(nameTokens("Hunters' camp #3").words).toEqual(['hunter', 'camp']);
    expect(nameTokens('Lady of the Lake').words).toEqual(['lady', 'lak']);
    // Only small words: they are kept.
    expect(nameTokens('Of the').words).toEqual(['of', 'the']);
    expect(nameTokens('Café').words).toEqual(['caf']);
  });

  it('allows no letter in short words, one up to 7 letters, two from 8', () => {
    expect(['den', 'wolf', 'warden', 'stonewall', 'room1234'].map((w) => letterSlack(w))).toEqual([
      0, 1, 1, 2, 0,
    ]);
    // Two words written together go by the shorter one.
    expect(letterSlack('wolfden', 3)).toBe(0);
    expect(letterSlack('greatsword', 5)).toBe(1);
  });

  it('counts letters changed, added, left out, and two swapped as one', () => {
    expect(lettersApart('warden', 'warden')).toBe(0);
    expect(lettersApart('warden', 'wardan')).toBe(1);
    expect(lettersApart('warden', 'wraden')).toBe(1);
    expect(lettersApart('warden', 'wardn')).toBe(1);
    expect(lettersApart('warden', 'warrden')).toBe(1);
    expect(lettersApart('greatsword', 'graetsowrd')).toBe(2);
    expect(lettersApart('abcdef', 'uvwxyz', 2)).toBe(3);
  });

  it('reads another name of a page from its id', () => {
    expect(otherNameOfId('isle:guide:the-crownless_one')).toBe('the crownless one');
    expect(otherNameOfId('not an id')).toBeNull();
  });
});

describe('finding pages by name', () => {
  it('finds the same name first, whatever its case, accents, punctuation and plural', () => {
    expect(first('Stone warden 12')).toBe('stone-warden');
    expect(first('stone-wardens')).toBe('stone-warden');
    expect(first('STONE WARDEN')).toBe('stone-warden');
    expect(first('Cafe noir')).toBe('cafe');
    expect(first('Moonpetal 3')).toBe('moonpetal');
    const hit = index().find('Stone warden 12')[0]!;
    expect(hit).toMatchObject({
      exact: true,
      score: 1,
      via: 'title',
      name: 'Stone Warden (enemy)',
    });
  });

  it('takes words in any order', () => {
    expect(first('Warden Stone')).toBe('stone-warden');
    expect(first('Lake lady')).toBe('lady');
  });

  it('allows a misspelt word, by one letter up to 7 letters and two from 8', () => {
    expect(first('Stone wraden')).toBe('stone-warden');
    expect(first('Stoen warden')).toBe('stone-warden');
    expect(first('Graetsowrd')).toBe('greatsword');
    expect(first('Moonpetel')).toBe('moonpetal');
    // A misspelling fits a little less than the right spelling.
    const [right] = index().find('Stone warden');
    const [wrong] = index().find('Stone wardan');
    expect(wrong!.score).toBeLessThan(right!.score);
    expect(wrong!.exact).toBe(false);
    // Three letters off is too many (the page still fits by "stone" alone, less well);
    // short words and numbers must be spelt right.
    expect(index().find('Stone wxyzen')[0]).toMatchObject({ exact: false });
    expect(index().find('Stone wxyzen')[0]!.score).toBeLessThan(0.7);
    // "den" is short, so "dun" is not it, not even written with "wolf".
    expect(first('Wolf dun')).toBe('wolves');
    expect(first('Wolfdun')).not.toBe('wolf-den');
    // A number at the end does not count: "Act 2" and "Act 3" are both "Act".
    expect(ids(index().find('Act 2')).sort()).toEqual(['act-2', 'act-3']);
  });

  it('takes words written together or apart as the same', () => {
    expect(first('Great sword')).toBe('greatsword');
    expect(index().find('Great sword')[0]).toMatchObject({ exact: true });
    expect(first('Iron-bound chest 3')).toBe('ironbound');
    expect(first('Iron bound chest')).toBe('ironbound');
    expect(first('Moon petal')).toBe('moonpetal');
    expect(first('Wolfden')).toBe('wolf-den');
  });

  it('weighs rare words more than common ones', () => {
    // "Frost" is in four titles, "wyrm" in one: a frost wyrm is the wyrm's page.
    expect(first('Frost wyrm')).toBe('frost-wyrm');
    expect(ids(index().find('Wyrm of frost')).slice(0, 2)).toEqual(['frost-wyrm', 'frost']);
    // A page of one common word fits less than a page of the rare one.
    const hits = index().find('Ice wyrm');
    expect(ids(hits)[0]).toBe('frost-wyrm');
  });

  it('finds a page whose title holds part of the name, the closest first', () => {
    // "Wolf den" itself first, then the page of wolves.
    expect(ids(index().find('Wolf den 3')).slice(0, 2)).toEqual(['wolf-den', 'wolves']);
    expect(first('Wolf')).toBe('wolves');
    expect(first('Great hall of the north')).toBe('great-hall');
  });

  it('counts a page’s other names as its name', () => {
    const [hit] = index().find('The Crownless One');
    expect(hit).toMatchObject({ id: 'isle:guide:hollow', via: 'other-name', exact: true });
    expect(first('Hollow kings')).toBe('hollow');
  });

  it('finds nothing for a name with nothing in common, or no words', () => {
    expect(index().find('Copper coin')).toEqual([]);
    expect(index().find('  ')).toEqual([]);
    expect(new PageNameIndex([]).find('Wolf')).toEqual([]);
  });

  it('puts pages that only mention the name after every title, each page once', () => {
    const hits = index().find('Wolf den');
    const all = withMentions(hits, [
      { id: 'isle:guide:wolves', title: 'Wolves' },
      { id: 'isle:guide:regions', title: 'Regions' },
    ]);
    expect(ids(all).slice(-1)).toEqual(['regions']);
    expect(all.at(-1)).toMatchObject({ via: 'text', score: 0, name: 'Regions' });
    expect(ids(all).filter((id) => id === 'wolves')).toHaveLength(1);
    expect(withMentions(hits, [{ id: 'isle:guide:regions', title: 'Regions' }], 1)).toHaveLength(1);
  });

  it('stays quick on a wiki of thousands of pages and a map of thousands of names', () => {
    // Made-up words from a seeded generator, as varied as a wiki's.
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const letters = 'aabcdeeefghiijklmnoopqrsstuuvwy';
    const word = () =>
      Array.from(
        { length: 3 + Math.floor(next() * 8) },
        () => letters[Math.floor(next() * letters.length)]!,
      ).join('');
    const vocabulary = Array.from({ length: 4000 }, word);
    const pick = () => vocabulary[Math.floor(next() * vocabulary.length)]!;
    const pages = Array.from({ length: 6000 }, (_, n) =>
      page(`p${n}`, [pick(), pick(), ...(n % 3 === 0 ? [pick()] : [])].join(' '), [
        `${pick()}-${pick()}`,
      ]),
    );
    const started = performance.now();
    const big = new PageNameIndex(pages);
    const built = performance.now() - started;
    const names = Array.from({ length: 4000 }, (_, n) => `${pick()} ${pick()} ${n % 50}`);
    const searching = performance.now();
    for (const name of names) big.find(name, 10);
    const perName = (performance.now() - searching) / names.length;
    // Generous bounds for a slow machine; it is far quicker in practice.
    expect(built).toBeLessThan(3000);
    expect(perName).toBeLessThan(3);
    // And it still finds a page by a misspelt title among them.
    const target = pages.find((p) => p.title.split(' ').every((w) => w.length >= 5))!;
    const misspelt = target.title.replace(/^(\w)(\w)/u, '$2$1');
    expect(big.find(misspelt, 5).map((hit) => hit.id)).toContain(target.id);
  }, 30_000);
});
