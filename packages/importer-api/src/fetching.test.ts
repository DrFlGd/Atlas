import { makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import exampleWiki from '../demo/example-wiki-importer.js';
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  MAX_PAGE_FETCHES,
  MAX_PAGE_LINKS,
  MAX_WRITTEN_AGAIN,
  asImporter,
  checkOutcome,
  fetchAddresses,
  isFetchedPages,
  readsInWindow,
  refusalFor,
  refusalOf,
  robotsAllows,
  robotsRules,
  rulesFromAnswer,
} from './index';

const ROBOTS = `
# A made-up site's rules
User-agent: *
Disallow: /private/
Disallow: /*action=edit
Allow: /private/open$
Crawl-delay: 5

User-agent: SomeOtherBot
Disallow: /

User-agent: Atlas
User-agent: AnotherAgent
Disallow: /special/
Allow: /special/ok
`;

describe('robots.txt', () => {
  it('follows the group that names the agent, else the * group', () => {
    const atlas = robotsRules(ROBOTS, 'Atlas');
    expect(robotsAllows(atlas, 'https://example.org/special/page')).toBe(false);
    expect(robotsAllows(atlas, 'https://example.org/special/ok')).toBe(true);
    // The * group does not apply to an agent with a group of its own.
    expect(robotsAllows(atlas, 'https://example.org/private/x')).toBe(true);
    const other = robotsRules(ROBOTS, 'Unknown');
    expect(robotsAllows(other, 'https://example.org/private/x')).toBe(false);
    expect(other.crawlDelay).toBe(5);
    expect(robotsAllows(robotsRules(ROBOTS, 'someotherbot'), 'https://example.org/')).toBe(false);
  });

  it('matches wildcards, a final $, queries, and lets the longest rule win', () => {
    const rules = robotsRules(ROBOTS, 'Unknown');
    expect(robotsAllows(rules, 'https://example.org/w/index.php?title=A&action=edit')).toBe(false);
    expect(robotsAllows(rules, 'https://example.org/w/index.php?title=A')).toBe(true);
    expect(robotsAllows(rules, 'https://example.org/private/open')).toBe(true);
    expect(robotsAllows(rules, 'https://example.org/private/open/more')).toBe(false);
    expect(robotsAllows(rules, 'https://example.org/robots.txt')).toBe(true);
  });

  it('allows all without rules, and disallows all when robots.txt cannot be read', () => {
    expect(rulesFromAnswer({ status: 404, text: '' })).toEqual(ALLOW_ALL);
    expect(rulesFromAnswer({ status: 500, text: '' })).toEqual(DISALLOW_ALL);
    expect(rulesFromAnswer(null)).toEqual(DISALLOW_ALL);
    expect(robotsAllows(DISALLOW_ALL, 'https://example.org/anything')).toBe(false);
    const empty = rulesFromAnswer({ status: 200, text: 'User-agent: *\nDisallow:\n' });
    expect(robotsAllows(empty, 'https://example.org/anything')).toBe(true);
  });
});

describe('answers that stop a go', () => {
  it('stops on a refusal, a request to slow down or a site not serving', () => {
    for (const status of [401, 403, 407, 429, 451, 503]) expect(refusalOf(status)).not.toBeNull();
    expect(refusalOf(200, '120')).toMatch(/slow down/);
    for (const status of [200, 301, 404, 410, 500]) expect(refusalOf(status)).toBeNull();
  });
});

const fetching = {
  apiVersion: 1,
  id: 'pages',
  title: 'Pages',
  description: 'Reads pages of a made-up site.',
  version: '1.0.0',
  matches: (url: string) => url.startsWith('https://wiki.example.org/'),
  refuses: (url: string) => (url.includes('refused.example') ? 'That site is not read.' : null),
  fetch: {
    addresses: (url: string) => [`${url}?format=json`],
  },
  convert: () => ({ ok: false, message: 'Not used here.' }),
};

describe('importers that read by fetching', () => {
  it('need a page reader or addresses to fetch', () => {
    expect(asImporter(fetching).fetch).toBeDefined();
    const { fetch: _, ...neither } = fetching;
    expect(() => asImporter(neither)).toThrow(/pageReader or fetch/);
  });

  it('may have some pages opened in a window instead, with a reader for them', () => {
    const inWindow = (url: string) => url.startsWith('https://wiki.example.org/checked/');
    const mixed = {
      ...fetching,
      fetch: { ...fetching.fetch, inWindow },
      pageReader: '() => null',
    };
    const checked = asImporter(mixed);
    expect(readsInWindow(checked.fetch, 'https://wiki.example.org/checked/Page')).toBe(true);
    expect(readsInWindow(checked.fetch, 'https://wiki.example.org/open/Page')).toBe(false);
    // An importer that fetches every page, or none, opens nothing in a window this way.
    expect(readsInWindow(fetching.fetch, 'https://wiki.example.org/checked/Page')).toBe(false);
    expect(readsInWindow(undefined, 'https://wiki.example.org/checked/Page')).toBe(false);
    // One that throws is taken as fetching.
    const throwing = {
      addresses: fetching.fetch.addresses,
      inWindow: () => {
        throw new Error('broken');
      },
    };
    expect(readsInWindow(throwing, 'https://wiki.example.org/x')).toBe(false);
    // Without a reader there is nothing to read the window with.
    const { pageReader: _, ...noReader } = mixed;
    expect(() => asImporter(noReader)).toThrow(/pageReader for the pages/);
    expect(() => asImporter({ ...mixed, fetch: { ...fetching.fetch, inWindow: 'yes' } })).toThrow();
  });

  it('name at most a few addresses, all on the site of the page', () => {
    const url = 'https://wiki.example.org/wiki/Start';
    expect(fetchAddresses(fetching.fetch, url)).toEqual({
      ok: true,
      addresses: [`${url}?format=json`],
    });
    const elsewhere = { addresses: () => ['https://elsewhere.example.com/x'] };
    expect(fetchAddresses(elsewhere, url).ok).toBe(false);
    const many = {
      addresses: () => Array.from({ length: MAX_PAGE_FETCHES + 1 }, (_, i) => `${url}?p=${i}`),
    };
    expect(fetchAddresses(many, url).ok).toBe(false);
    const throws = {
      addresses: () => {
        throw new Error('no');
      },
    };
    expect(fetchAddresses(throws, url)).toEqual({
      ok: false,
      message: 'The importer cannot read this page.',
    });
  });

  it('may refuse addresses outright', () => {
    expect(refusalFor([fetching], 'https://refused.example/x')).toBe('That site is not read.');
    expect(refusalFor([fetching], 'https://wiki.example.org/x')).toBeNull();
  });

  it('hand convert the answers in one shape', () => {
    expect(
      isFetchedPages({
        fetched: [{ url: 'u', finalUrl: 'u', status: 200, contentType: 'text/html', text: '' }],
      }),
    ).toBe(true);
    expect(isFetchedPages({ fetched: [{ url: 'u' }] })).toBe(false);
  });
});

describe('a page that became a guide', () => {
  const pack = makeGuidesFixturePack();
  const success = {
    ok: true,
    packId: 'pages',
    sourceKey: 'start',
    pack,
    summary: {
      game: 'Pages',
      map: 'Start',
      maps: 0,
      locations: 0,
      mapLocations: 0,
      categories: 0,
      refreshed: false,
    },
  };

  it('names the guide, which must be in the pack', () => {
    expect(checkOutcome({ ...success, guideId: 'pages:guide:start' }).ok).toBe(true);
    const missing = checkOutcome({ ...success, guideId: 'pages:guide:nope' });
    expect(missing.ok ? '' : missing.message).toMatch(/guide that is not in its pack/);
    expect(checkOutcome(success).ok).toBe(false);
    expect(
      checkOutcome({
        ...success,
        guideId: 'pages:guide:start',
        checklistId: 'pages:checklist:bells',
      }).ok,
    ).toBe(false);
  });

  it('keeps the links to other pages of the same site, each once, without fragments', () => {
    const page = 'https://wiki.example.org/wiki/Start';
    const outcome = checkOutcome(
      {
        ...success,
        guideId: 'pages:guide:start',
        links: [
          'https://wiki.example.org/wiki/Bells#Where',
          'https://wiki.example.org/wiki/Bells/',
          'https://www.wiki.example.org/wiki/Gates',
          'https://wiki.example.org/wiki/Start#Top',
          'https://elsewhere.example.com/wiki/Bells',
          'http://wiki.example.org/wiki/Plain',
          'not an address',
        ],
      },
      page,
    );
    expect(outcome.ok && outcome.links).toEqual([
      'https://wiki.example.org/wiki/Bells',
      'https://www.wiki.example.org/wiki/Gates',
    ]);
    // Without the page's address, or with no links left, the outcome has none.
    const unplaced = checkOutcome({
      ...success,
      guideId: 'pages:guide:start',
      links: ['https://wiki.example.org/wiki/Bells'],
    });
    expect(unplaced.ok && 'links' in unplaced).toBe(false);
    const none = checkOutcome(
      { ...success, guideId: 'pages:guide:start', links: ['https://elsewhere.example.com/x'] },
      page,
    );
    expect(none.ok && 'links' in none).toBe(false);
    // Kept up to the cap.
    const many = Array.from({ length: MAX_PAGE_LINKS + 5 }, (_, i) => `${page}-${i}`);
    const capped = checkOutcome({ ...success, guideId: 'pages:guide:start', links: many }, page);
    expect(capped.ok && capped.links?.length).toBe(MAX_PAGE_LINKS);
    // Not a list of text: refused, as any wrong shape is.
    expect(checkOutcome({ ...success, guideId: 'pages:guide:start', links: [1] }, page).ok).toBe(
      false,
    );
  });

  it('keeps the links of the other pages it wrote again, entry by entry', () => {
    const page = 'https://wiki.example.org/wiki/Start';
    const outcome = checkOutcome(
      {
        ...success,
        guideId: 'pages:guide:start',
        writtenAgain: [
          {
            url: 'https://wiki.example.org/wiki/Bells#Top',
            links: [
              'https://wiki.example.org/wiki/Gates#Where',
              'https://wiki.example.org/wiki/Bells',
              'https://elsewhere.example.com/wiki/Gates',
              7,
            ],
          },
          // The same page again, the page read, another site, and entries out of shape: left out.
          { url: 'https://wiki.example.org/wiki/Bells/', links: ['https://wiki.example.org/x'] },
          { url: page, links: ['https://wiki.example.org/wiki/Bells'] },
          { url: 'https://elsewhere.example.com/wiki/Bells', links: [] },
          { url: 'not an address', links: [] },
          { url: 'https://wiki.example.org/wiki/Gates' },
          'https://wiki.example.org/wiki/Gates',
          null,
          // A page that links to nothing is kept, so its links are known to be none.
          { url: 'https://wiki.example.org/wiki/Gates', links: [] },
        ],
      },
      page,
    );
    expect(outcome.ok && outcome.writtenAgain).toEqual([
      {
        url: 'https://wiki.example.org/wiki/Bells',
        links: ['https://wiki.example.org/wiki/Gates'],
      },
      { url: 'https://wiki.example.org/wiki/Gates', links: [] },
    ]);
    // Not a list, nothing in shape, or no page address: none, and the page is still added.
    for (const writtenAgain of ['Bells', [{ url: 3 }]]) {
      const odd = checkOutcome({ ...success, guideId: 'pages:guide:start', writtenAgain }, page);
      expect(odd.ok && 'writtenAgain' in odd).toBe(false);
      expect(odd.ok).toBe(true);
    }
    const unplaced = checkOutcome({
      ...success,
      guideId: 'pages:guide:start',
      writtenAgain: [{ url: 'https://wiki.example.org/wiki/Bells', links: [] }],
    });
    expect(unplaced.ok && 'writtenAgain' in unplaced).toBe(false);
    // Kept up to the cap.
    const many = Array.from({ length: MAX_WRITTEN_AGAIN + 5 }, (_, i) => ({
      url: `${page}-${i}`,
      links: [page],
    }));
    const capped = checkOutcome(
      { ...success, guideId: 'pages:guide:start', writtenAgain: many },
      page,
    );
    expect(capped.ok && capped.writtenAgain?.length).toBe(MAX_WRITTEN_AGAIN);
    expect(capped.ok && capped.writtenAgain?.[0]).toEqual({ url: `${page}-0`, links: [page] });
  });

  it('keeps the address a page was read from when it is another name of it, on the same site', () => {
    const asked = 'https://wiki.example.org/wiki/Old-name';
    const outcome = checkOutcome(
      {
        ...success,
        guideId: 'pages:guide:start',
        pageAddress: 'https://wiki.example.org/wiki/New-name#Top',
        links: ['https://wiki.example.org/wiki/Gates', 'https://wiki.example.org/wiki/New-name'],
        writtenAgain: [
          {
            url: 'https://wiki.example.org/wiki/Bells',
            pageAddress: 'https://wiki.example.org/wiki/Bell',
            links: ['https://wiki.example.org/wiki/Bell'],
          },
          {
            url: 'https://wiki.example.org/wiki/Gates',
            pageAddress: 'https://elsewhere.example.com/wiki/Gates',
            links: [],
          },
        ],
      },
      asked,
    );
    expect(outcome.ok && outcome.pageAddress).toBe('https://wiki.example.org/wiki/New-name');
    // Its links are the links of the page where it is: never itself.
    expect(outcome.ok && outcome.links).toEqual(['https://wiki.example.org/wiki/Gates']);
    expect(outcome.ok && outcome.writtenAgain).toEqual([
      {
        url: 'https://wiki.example.org/wiki/Bells',
        pageAddress: 'https://wiki.example.org/wiki/Bell',
        links: [],
      },
      // Another site is not another name of a page.
      { url: 'https://wiki.example.org/wiki/Gates', links: [] },
    ]);
    // Another site, the same page, or not an address: left out.
    for (const pageAddress of [
      'https://elsewhere.example.com/wiki/New-name',
      `${asked}/`,
      'http://wiki.example.org/wiki/New-name',
      7,
    ]) {
      const odd = checkOutcome({ ...success, guideId: 'pages:guide:start', pageAddress }, asked);
      expect(odd.ok && 'pageAddress' in odd).toBe(false);
    }
  });

  it('may stop the go when the page asked to confirm the reader is a person', () => {
    expect(checkOutcome({ ok: false, message: 'Asked to confirm.', stop: true })).toEqual({
      ok: false,
      message: 'Asked to confirm.',
      stop: true,
    });
  });
});

describe('the made-up Example Wiki importer', () => {
  const answer = (url: string, status: number, body: unknown) => ({
    fetched: [
      { url, finalUrl: url, status, contentType: 'application/json', text: JSON.stringify(body) },
    ],
  });
  const page = 'https://wiki.example.org/wiki/Bells';

  it('is an importer that fetches its pages, and lists its contents by heading', async () => {
    const importer = asImporter(exampleWiki);
    expect(importer.fetch?.addresses(page)).toEqual([page]);
    expect(importer.matches('https://wiki.example.org/wiki/Contents')).toBe(false);
    const contents = 'https://wiki.example.org/wiki/Contents';
    const listed = await importer.games!.convert(
      answer(contents, 200, {
        headings: [{ title: 'Basics', pages: [{ slug: 'Bells', title: 'Bells' }] }],
      }),
      { url: contents, app: { name: 'Atlas', version: '1.0.0' } },
    );
    expect(listed).toEqual({
      ok: true,
      game: 'Example Wiki',
      pages: [{ url: page, title: 'Bells', kind: 'page', group: 'Basics' }],
    });
  });

  it('turns a page into a guide under its heading, with the pages it links to', async () => {
    const outcome = checkOutcome(
      await exampleWiki.convert(
        answer(page, 200, { title: 'Bells', body: 'Ring them.', links: ['Gates', 'Bells'] }),
        {
          url: page,
          importedAt: '2026-11-13T10:00:00Z',
          app: { name: 'Atlas', version: '1.0.0' },
          listed: { title: 'Bells', group: 'Basics' },
          savedSources: () => Promise.resolve([]),
          existingPack: () => Promise.resolve(null),
          isBundled: () => false,
        },
      ),
      page,
    );
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.guideId).toBe('example-wiki:guide:bells');
    expect(outcome.links).toEqual(['https://wiki.example.org/wiki/Gates']);
    expect(outcome.pack.sections).toEqual([
      { id: 'example-wiki:section:basics', title: 'Basics', items: ['example-wiki:guide:bells'] },
    ]);
  });
});
