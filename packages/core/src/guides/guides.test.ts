import { makeFixturePack, makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import { indexPack } from '../pack/loadedPack';
import { GuideContents, sortGuides } from './contents';
import { GuideSearch, guidePlainText } from './guideText';

const BASE = new URL('https://packs.example.test/pages/');

describe('GuideContents', () => {
  it('browses sections into sections and pages, in the source order', () => {
    const contents = new GuideContents(indexPack(makeGuidesFixturePack(), BASE));
    expect(contents.browsable).toBe(true);
    expect(contents.hasContents).toBe(true);
    expect(
      contents.top().map((e) => (e.kind === 'section' ? [e.section.id, e.pages] : e.guide.id)),
    ).toEqual([['pages:section:basics', 2]]);
    expect(contents.items('pages:section:basics').map((e) => e.kind)).toEqual(['page', 'section']);
    expect(contents.pathTo('pages:guide:bells').map((s) => s.title)).toEqual(['Basics', 'More']);
    expect(contents.pathTo('pages:section:more').map((s) => s.title)).toEqual(['Basics']);
    expect(contents.pages().map((g) => g.id)).toEqual(['pages:guide:start', 'pages:guide:bells']);
    expect(contents.isPage('pages:guide:bells')).toBe(true);
  });

  it('browses only the guides its contents lists', () => {
    const pack = makeGuidesFixturePack();
    pack.sections = [{ id: 'pages:section:more', title: 'More', items: ['pages:guide:bells'] }];
    const contents = new GuideContents(indexPack(pack, BASE));
    expect(contents.pages().map((g) => g.id)).toEqual(['pages:guide:bells']);
    expect(contents.isPage('pages:guide:start')).toBe(false);
  });

  it('lists every guide of a game with no map and no contents', () => {
    const pack = makeGuidesFixturePack();
    delete pack.sections;
    const contents = new GuideContents(indexPack(pack, BASE));
    expect(contents.browsable).toBe(true);
    expect(contents.hasContents).toBe(false);
    expect(contents.top().map((e) => e.kind)).toEqual(['page', 'page']);
    expect(contents.isPage('pages:guide:start')).toBe(true);
  });

  it('has nothing to browse on a map without contents, and keeps other guides out', () => {
    const pack = makeFixturePack();
    expect(new GuideContents(indexPack(pack, BASE)).browsable).toBe(false);
    pack.guides.push({ id: 'demo:guide:walk', title: 'Walk', body: 'x', locationIds: [] });
    pack.guides.push({ id: 'demo:guide:read', title: 'Read', body: 'x', locationIds: [] });
    pack.sections = [{ id: 'demo:section:a', title: 'A', items: ['demo:guide:read'] }];
    const contents = new GuideContents(indexPack(pack, BASE));
    expect(contents.browsable).toBe(true);
    expect(contents.pages().map((g) => g.id)).toEqual(['demo:guide:read']);
    expect(contents.isPage('demo:guide:walk')).toBe(false);
  });

  it('sorts guides by order, then by title', () => {
    const guide = (id: string, title: string, order?: number) => ({
      id: `pages:guide:${id}`,
      title,
      body: '',
      locationIds: [],
      ...(order === undefined ? {} : { order }),
    });
    expect(
      sortGuides([
        guide('c', 'Page 10'),
        guide('a', 'Z', 1),
        guide('b', 'Page 2'),
        guide('d', 'A', 0),
      ]).map((g) => g.title),
    ).toEqual(['A', 'Z', 'Page 2', 'Page 10']);
  });
});

describe('guidePlainText', () => {
  it('keeps the words and drops Markdown marks, targets and hidden text', () => {
    expect(
      guidePlainText(
        '## The tower\n\nClimb **the stairs** to [the top](pages:guide:top), see ![a bell](pages:picture:bell).\n\n| Bell | Where |\n| --- | :-: |\n| First | ||under the bridge|| |\n\n- one\n- two `a||b`',
      ),
    ).toBe('The tower Climb the stairs to the top, see a bell. Bell Where First one two a||b');
  });

  it('pairs bars left to right and keeps a last bar without a partner', () => {
    // Bars that are not marks show as spaces, as table cells do.
    expect(guidePlainText('a ||b|| c ||d|| e || f')).toBe('a c e f');
    expect(guidePlainText('a \\|| b ||c||')).toBe('a | b');
    expect(guidePlainText('Over\n\n||two\n\nparagraphs||\n\nend')).toBe('Over end');
  });

  it('cuts a text with bars and code blocks at its first bar', () => {
    expect(guidePlainText('Start\n\n    code ||\n\n||secret|| after')).toBe('Start code');
    expect(guidePlainText('Start\n\n~~~\n||\n~~~\n\n||secret||')).toBe('Start');
  });
});

describe('GuideSearch', () => {
  const pack = makeGuidesFixturePack();
  pack.guides.push({
    id: 'pages:guide:tower',
    title: 'The tower',
    body: `${'Long words before. '.repeat(10)}The bell of the tower rings at noon. ${'More words after. '.repeat(20)}`,
    locationIds: [],
  });
  const search = new GuideSearch(pack.guides);

  it('finds pages by title first, then by their text', () => {
    expect(search.search('bells').map((hit) => [hit.guide.title, hit.inTitle])).toEqual([
      ['Bells', true],
      ['Getting started', false],
    ]);
    expect(search.search('bell').map((hit) => hit.guide.title)).toEqual([
      'Bells',
      'Getting started',
      'The tower',
    ]);
    expect(search.search('tower first').map((hit) => hit.guide.title)).toEqual(['Bells']);
    expect(search.search('')).toEqual([]);
  });

  it('quotes a line around the match, with the words marked', () => {
    const [hit] = search.search('noon');
    expect(hit!.snippet.startsWith('… ')).toBe(true);
    expect(hit!.snippet.endsWith(' …')).toBe(true);
    expect(hit!.snippet).toContain('The bell of the tower rings at noon.');
    const [start, end] = hit!.marks[0]!;
    expect(hit!.snippet.slice(start, end)).toBe('noon');
  });

  it('never finds or quotes hidden text', () => {
    expect(search.search('bridge')).toEqual([]);
    for (const hit of search.search('last')) expect(hit.snippet).not.toContain('bridge');
    const hit = search.search('last')[0]!;
    expect(hit.snippet).toBe('Bell Where First Tower The last one is .');
  });

  it('matches without accents or case', () => {
    const accents = new GuideSearch([
      { id: 'pages:guide:c', title: 'Café', body: 'Crème brûlée', locationIds: [] },
    ]);
    expect(accents.search('CAFE')).toHaveLength(1);
    const [hit] = accents.search('brulee');
    expect(hit!.snippet.slice(...hit!.marks[0]!)).toBe('brûlée');
  });

  it('reads the text with the reading it is given', () => {
    const own = new GuideSearch(pack.guides, () => 'nothing to see');
    expect(own.search('nothing').length).toBe(pack.guides.length);
  });
});
