// @ts-check
/**
 * A made-up importer that reads wikis it does not know, for tests and as an
 * example of a general reader (`general`, see `../src/index.ts`) and of what
 * an importer says about a site (`siteInfo`, see `../src/sites.ts`): any
 * address `https://<host>/wiki/<page>` that no other importer knows is a
 * page of the wiki of `<host>`, and `https://<host>/wiki/Contents` its
 * contents. The tests answer its addresses themselves: no site is asked
 * for anything.
 *
 * - Each wiki is a site of its own (its host is its key), read by the app
 *   ("By itself") or in a window of the app, as the person chooses; a
 *   notice says the importer does not know the site.
 * - A page answers `{ "title", "body", "links", "licence" }` as the Example
 *   Wiki's do (`example-wiki-importer.js`), with `licence` the address of a
 *   Creative Commons deed when the page states one. A page that states none
 *   asks the person to confirm the wiki's licence (`askLicence`); with the
 *   licence they confirmed (`ImportContext.confirmedLicence`) it is read,
 *   and its guide says the licence was confirmed by the person.
 *
 * It is a single plain ES module with no imports, as every importer module
 * must be.
 */

/** @typedef {import('../src/index').AtlasImporter} AtlasImporter */
/** @typedef {import('../src/index').FetchedPage} FetchedPage */
/** @typedef {import('@atlas/schema').PackData} PackData */
/** @typedef {import('@atlas/schema').GuideEntry} GuideEntry */

/** The licences this importer knows by their deeds. */
const LICENCES = {
  'https://creativecommons.org/licenses/by-sa/4.0/': 'CC BY-SA 4.0',
  'https://creativecommons.org/licenses/by-sa/3.0/': 'CC BY-SA 3.0',
  'https://creativecommons.org/licenses/by-nc-sa/4.0/': 'CC BY-NC-SA 4.0',
  'https://creativecommons.org/licenses/by-nc-sa/3.0/': 'CC BY-NC-SA 3.0',
  'https://creativecommons.org/licenses/by/4.0/': 'CC BY 4.0',
  'https://creativecommons.org/licenses/by/3.0/': 'CC BY 3.0',
  'https://creativecommons.org/licenses/by-nc/4.0/': 'CC BY-NC 4.0',
  'https://creativecommons.org/publicdomain/zero/1.0/': 'CC0 1.0',
};

const NOTICE =
  'This app does not know this wiki: it reads its pages as it reads the wikis it knows, and asks you to confirm the wiki’s licence when its pages do not state one.';

/** The host and slug of a wiki page address, or null. */
function partsOf(/** @type {string} */ text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const match = /^\/wiki\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.port || url.username || !match) return null;
  return { host: url.hostname.toLowerCase(), slug: match[1] ?? '' };
}

const isContents = (/** @type {string} */ text) => partsOf(text)?.slug === 'Contents';
const isPage = (/** @type {string} */ text) => {
  const parts = partsOf(text);
  return parts !== null && parts.slug !== 'Contents';
};

/** A lowercase id part from any text. */
const local = (/** @type {string} */ text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'page';

/** `wiki.example.net` → `Wiki Example`: the name of a wiki this importer does not know. */
const nameOf = (/** @type {string} */ host) =>
  host
    .split('.')
    .slice(0, -1)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const packOf = (/** @type {string} */ host) => `${local(host)}-wiki`;

/** The first answer, or null. */
function answerOf(/** @type {unknown} */ pageData) {
  const fetched = /** @type {{ fetched?: FetchedPage[] }} */ (pageData)?.fetched;
  return Array.isArray(fetched) ? (fetched[0] ?? null) : null;
}

/** @returns {unknown} */
function json(/** @type {string} */ text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The pack of a wiki with one page added or read again. */
function withPage(
  /** @type {string} */ host,
  /** @type {PackData | null} */ existing,
  /** @type {GuideEntry} */ guide,
  /** @type {string} */ licence,
) {
  /** @type {PackData} */
  const pack = existing
    ? structuredClone(existing)
    : {
        manifest: {
          schemaVersion: 2,
          gameId: packOf(host),
          title: `${nameOf(host)} Wiki`,
          packVersion: '1.0.0',
          gamePatch: 'wiki',
          attribution: [
            { name: `${nameOf(host)} Wiki`, url: `https://${host}/`, license: licence },
          ],
          idMigrations: {},
        },
        maps: [],
        layers: [],
        regions: [],
        categoryGroups: [],
        categories: [],
        locations: [],
        entities: [],
        checklists: [],
        checklistItems: [],
        guides: [],
        links: [],
        presets: [],
      };
  const at = pack.guides.findIndex((g) => g.id === guide.id);
  if (at >= 0) pack.guides[at] = { ...guide, order: pack.guides[at]?.order ?? at };
  else pack.guides.push({ ...guide, order: pack.guides.length });
  return { pack, refreshed: at >= 0 };
}

/** @type {AtlasImporter} */
const importer = {
  apiVersion: 1,
  id: 'other-wikis',
  title: 'Other wikis',
  description: 'Reads pages of made-up wikis this app does not know, for tests.',
  version: '1.0.0',
  example: 'https://wiki.example.net/wiki/Welcome',
  matches: isPage,
  // Every address it reads is one it does not know: other importers come first.
  general: () => true,
  siteInfo(url) {
    const parts = partsOf(url);
    return parts ? { key: parts.host, ways: ['fetch', 'window'], notice: NOTICE } : null;
  },
  fetch: { addresses: (url) => (isPage(url) ? [url.trim()] : []) },
  // A window shows the page itself; the tests' shell hands over what the site answers.
  pageReader: '() => null',

  async convert(pageData, context) {
    const answer = answerOf(pageData);
    const parts = partsOf(context.url);
    if (!answer || !parts) return { ok: false, message: 'The page provided no data.' };
    if (answer.status === 404) return { ok: false, message: 'The wiki has no such page.' };
    const page =
      /** @type {{ title?: unknown, body?: unknown, links?: unknown, licence?: unknown }} */ (
        json(answer.text) ?? {}
      );
    if (typeof page.title !== 'string' || typeof page.body !== 'string') {
      return { ok: false, message: 'The page did not hold a wiki page in the expected shape.' };
    }
    const stated =
      typeof page.licence === 'string' && page.licence in LICENCES ? page.licence : null;
    const confirmed =
      !stated && context.confirmedLicence && context.confirmedLicence.url in LICENCES
        ? context.confirmedLicence.url
        : null;
    const deed = stated ?? confirmed;
    if (!deed) {
      return {
        ok: false,
        message:
          'This page does not say which licence its wiki is under, so nothing was added until you confirm one.',
        askLicence: true,
      };
    }
    const licence = { name: LICENCES[/** @type {keyof typeof LICENCES} */ (deed)], url: deed };
    const packId = packOf(parts.host);
    const guide = {
      id: `${packId}:guide:${local(parts.slug)}`,
      title: page.title,
      body: page.body,
      locationIds: [],
      source: {
        url: `https://${parts.host}/wiki/${parts.slug}`,
        site: `${nameOf(parts.host)} Wiki`,
        license: licence,
        readAt: context.importedAt,
        adapted: true,
        ...(confirmed ? { licenseConfirmed: true } : {}),
      },
    };
    const existing = await context.existingPack(packId);
    const { pack, refreshed } = withPage(parts.host, existing, guide, licence.name);
    const links = Array.isArray(page.links)
      ? page.links
          .filter((link) => typeof link === 'string')
          .map((link) => `https://${parts.host}/wiki/${link}`)
      : [];
    return {
      ok: true,
      packId,
      sourceKey: local(parts.slug),
      guideId: guide.id,
      links,
      pack,
      summary: {
        game: `${nameOf(parts.host)} Wiki`,
        map: page.title,
        maps: 0,
        locations: 0,
        mapLocations: 0,
        categories: 0,
        refreshed,
      },
    };
  },

  games: {
    matches: isContents,
    fetch: { addresses: (url) => (isContents(url) ? [url.trim()] : []) },
    convert(pageData, context) {
      const answer = answerOf(pageData);
      const host = partsOf(context.url)?.host ?? '';
      const contents =
        /** @type {{ headings?: { title: string, pages: { slug: string, title: string }[] }[] }} */ (
          answer ? (json(answer.text) ?? {}) : {}
        );
      if (!host || !Array.isArray(contents.headings)) {
        return { ok: false, message: 'The wiki’s contents were not in the expected shape.' };
      }
      return {
        ok: true,
        game: `${nameOf(host)} Wiki`,
        pages: contents.headings.flatMap((heading) =>
          heading.pages.map((page) => ({
            url: `https://${host}/wiki/${page.slug}`,
            title: page.title,
            kind: 'page',
            group: heading.title,
          })),
        ),
      };
    },
    gameAddress: (url) => {
      const parts = partsOf(url);
      return parts ? `https://${parts.host}/wiki/Contents` : null;
    },
  },
};

export default importer;
