import { makeGuidesFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import {
  ALLOW_ALL,
  DISALLOW_ALL,
  MAX_PAGE_FETCHES,
  asImporter,
  checkOutcome,
  fetchAddresses,
  isFetchedPages,
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

  it('may stop the go when the page asked to confirm the reader is a person', () => {
    expect(checkOutcome({ ok: false, message: 'Asked to confirm.', stop: true })).toEqual({
      ok: false,
      message: 'Asked to confirm.',
      stop: true,
    });
  });
});
