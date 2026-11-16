import { checkSiteRules, type SiteRules } from '@atlas/importer-api';
import { describe, expect, it } from 'vitest';
import { copyForSite, hostOf, idFromName, idProblem, readsInWords } from './rulesCopy';

const rulesOf = (value: unknown): SiteRules => {
  const checked = checkSiteRules(value);
  if (!checked.ok) throw new Error(JSON.stringify(checked.problems));
  return checked.rules;
};

const SITE = rulesOf({
  format: 'atlas-site-rules',
  version: 1,
  site: {
    id: 'reed-wiki',
    name: 'Reed Wiki',
    game: 'Reeds',
    hosts: ['wiki.reed.example', 'reed.example'],
    notice: 'The keepers of the reed wiki ask to be named.',
    licence: { ask: true },
    about: { by: 'Someone', on: '2026-01-02' },
  },
  parts: [
    {
      type: 'wiki',
      reader: 'lantern-pages',
      start: 'https://wiki.reed.example/wiki/Start',
      pack: 'reed-wiki',
      pictures: { hosts: ['wiki.reed.example', 'pictures.other.example'] },
    },
    {
      type: 'wiki',
      reader: 'rules',
      start: '/wiki/Main',
      reading: { ways: ['fetch'] },
      pages: { include: ['/wiki/*'] },
      contents: { from: 'sitemap', address: 'https://reed.example/sitemap.xml' },
      article: { content: 'main .text' },
    },
  ],
  notes: 'What the reed wiki does.',
});

const DEFAULTS = rulesOf({
  format: 'atlas-site-rules',
  version: 1,
  readerDefaults: {
    reader: 'lantern-pages',
    reading: { ways: ['window', 'browse'] },
    pictures: { hosts: ['pictures.lantern.example'] },
    licence: { ask: false },
    notice: 'Every lantern wiki asks this.',
    layout: { pageWidth: 'wide' },
  },
});

const REFUSAL = rulesOf({
  format: 'atlas-site-rules',
  version: 1,
  refusal: {
    id: 'tide-guides',
    name: 'Tide Guides',
    domains: ['tide.example'],
    notice: 'Not read: its terms forbid it.',
  },
});

const NEW = { name: 'Marsh Wiki', host: 'wiki.marsh.example', id: 'marsh-wiki' };

describe('a copy of a file for another site', () => {
  it('of a site file keeps its parts, moved to the new host, without what it said of its own site', () => {
    const copy = copyForSite(SITE, { ...NEW, game: 'Marsh' }, 'reed-wiki.atlas-site.json');
    const checked = rulesOf(copy);
    if (!('site' in checked)) throw new Error('Not a site file.');
    expect(checked.site).toEqual({
      id: 'marsh-wiki',
      name: 'Marsh Wiki',
      game: 'Marsh',
      hosts: ['wiki.marsh.example'],
      licence: { ask: true },
    });
    expect(checked.parts[0]).toMatchObject({
      start: 'https://wiki.marsh.example/wiki/Start',
      pack: 'marsh-wiki',
      pictures: { hosts: ['wiki.marsh.example', 'pictures.other.example'] },
    });
    expect(checked.parts[1]).toMatchObject({
      start: '/wiki/Main',
      contents: { address: 'https://wiki.marsh.example/sitemap.xml' },
    });
    expect(checked.notes).toMatch(/^Started from a copy of reed-wiki\.atlas-site\.json\./u);
    // No game given: none is kept from the old site, and a part read by rules needs one.
    const plain = checkSiteRules(copyForSite(SITE, NEW, 'reed-wiki.atlas-site.json'));
    expect(plain.ok ? [] : plain.problems.map((problem) => problem.field)).toEqual(['site.game']);
  });

  it('of a reader’s defaults is a site file for the one site, with a part of that reader', () => {
    const copy = rulesOf(
      copyForSite(DEFAULTS, NEW, 'lantern-pages.reader.atlas-site.json', () => 'guide'),
    );
    expect(copy).toEqual({
      format: 'atlas-site-rules',
      version: 1,
      site: {
        id: 'marsh-wiki',
        name: 'Marsh Wiki',
        hosts: ['wiki.marsh.example'],
        notice: 'Every lantern wiki asks this.',
      },
      parts: [
        {
          type: 'guide',
          reader: 'lantern-pages',
          start: '/',
          reading: { ways: ['window', 'browse'] },
          pictures: { hosts: ['pictures.lantern.example'] },
          licence: { ask: false },
          layout: { pageWidth: 'wide' },
        },
      ],
      notes: expect.stringMatching(/^Started from a copy of lantern-pages/u) as unknown,
    });
  });

  it('of a refusal names the new host', () => {
    const copy = rulesOf(copyForSite(REFUSAL, { ...NEW, id: 'marsh-guides' }, 'tide.refused'));
    expect(copy).toMatchObject({
      refusal: {
        id: 'marsh-guides',
        name: 'Marsh Wiki',
        domains: ['wiki.marsh.example'],
        notice: 'Not read: its terms forbid it.',
      },
    });
  });
});

describe('what a file reads, in one sentence', () => {
  it('names its parts, its readers and its hosts', () => {
    expect(readsInWords(SITE)).toBe(
      'It reads a wiki read by the reader “lantern-pages” and a wiki read by the selectors it gives (the reader “rules”) on wiki.reed.example and reed.example.',
    );
    expect(readsInWords(DEFAULTS)).toBe(
      'It holds the settings of the reader “lantern-pages” for every site that reader reads. A copy is a file for one site.',
    );
    expect(readsInWords(REFUSAL)).toBe('It names tide.example as sites that are not read at all.');
  });
});

describe('the new site’s id and host', () => {
  it('make an id of the name, as the format allows', () => {
    expect(idFromName('Marsh Wiki')).toBe('marsh-wiki');
    expect(idFromName('  Café & Reeds: the Guide! ')).toBe('cafe-reeds-the-guide');
    expect(idFromName('Ox')).toBe('ox-site');
    expect(idFromName('!!!')).toBe('');
    expect(idFromName('x'.repeat(60))).toHaveLength(40);
    expect(idProblem('marsh-wiki')).toBeNull();
    expect(idProblem('-marsh')).toMatch(/^The id must be 3 to 40/u);
  });

  it('take the host of an address, without its www.', () => {
    expect(hostOf('https://www.wiki.marsh.example/wiki/Start')).toEqual({
      host: 'wiki.marsh.example',
    });
    expect(hostOf(' Wiki.Marsh.example ')).toEqual({ host: 'wiki.marsh.example' });
    expect(hostOf('wiki.marsh.example/wiki/Start')).toEqual({ host: 'wiki.marsh.example' });
    expect(hostOf('')).toEqual({
      problem: 'Give the site’s address or host, such as wiki.example.org.',
    });
    expect('problem' in hostOf('not a host')).toBe(true);
  });
});
