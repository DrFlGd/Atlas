// @ts-check
/**
 * A made-up importer of a made-up wiki, "Example Wiki"
 * (`https://wiki.example.org/wiki/<page>`), for tests and as an example of
 * an importer that reads pages by fetching them (`fetch`, see
 * `../src/fetching.ts`). The tests answer its addresses themselves: no
 * site is asked for anything.
 *
 * - The contents (`/wiki/Contents`) answer `{ "headings": [{ "title",
 *   "pages": [{ "slug", "title" }] }] }`: every page under its heading.
 * - A page (`/wiki/<slug>`) answers `{ "title", "body", "links" }`: its text
 *   in Markdown and the slugs of the pages it links to. It becomes a guide
 *   of the wiki's pack, filed under its heading, and its links are given
 *   back as `links` (see `ImportSuccess.links`). An answer of 404 is a page
 *   the wiki does not have.
 *
 * It is a single plain ES module with no imports, as every importer module
 * must be.
 */

/** @typedef {import('../src/index').AtlasImporter} AtlasImporter */
/** @typedef {import('../src/index').ImportContext} ImportContext */
/** @typedef {import('../src/index').ImportOutcome} ImportOutcome */
/** @typedef {import('../src/index').FetchedPage} FetchedPage */
/** @typedef {import('@atlas/schema').PackData} PackData */
/** @typedef {import('@atlas/schema').GuideEntry} GuideEntry */

const SITE = 'https://wiki.example.org';
const PACK = 'example-wiki';
const NAME = 'Example Wiki';
const LICENSE = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' };

/** The page's slug, or null for an address that is not a page of the wiki. */
function slugOf(/** @type {string} */ text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const match = /^\/wiki\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
  return url.origin === SITE && match ? (match[1] ?? null) : null;
}

const isContents = (/** @type {string} */ text) => slugOf(text) === 'Contents';
const isPage = (/** @type {string} */ text) => {
  const slug = slugOf(text);
  return slug !== null && slug !== 'Contents';
};

/** A lowercase id part from any text. */
const local = (/** @type {string} */ text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'page';

/** The first answer the app fetched, or null. */
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

/** The pack with one page added or read again, filed under its heading. */
function withPage(
  /** @type {PackData | null} */ existing,
  /** @type {GuideEntry} */ guide,
  /** @type {string | undefined} */ group,
) {
  /** @type {PackData} */
  const pack = existing
    ? structuredClone(existing)
    : {
        manifest: {
          schemaVersion: 2,
          gameId: PACK,
          title: NAME,
          packVersion: '1.0.0',
          gamePatch: 'wiki',
          attribution: [{ name: NAME, url: `${SITE}/`, license: LICENSE.name }],
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
        sections: [],
      };
  const at = pack.guides.findIndex((g) => g.id === guide.id);
  if (at >= 0) pack.guides[at] = { ...guide, order: pack.guides[at]?.order ?? at };
  else pack.guides.push({ ...guide, order: pack.guides.length });
  const sections = (pack.sections ??= []);
  const filed = sections.some((section) => section.items.includes(guide.id));
  if (!filed) {
    const title = group ?? 'Other pages';
    const id = `${PACK}:section:${local(title)}`;
    const section = sections.find((s) => s.id === id);
    if (section) section.items.push(guide.id);
    else sections.push({ id, title, items: [guide.id] });
  }
  return { pack, refreshed: at >= 0 };
}

/** @type {AtlasImporter} */
const importer = {
  apiVersion: 1,
  id: 'example-wiki',
  title: NAME,
  description: 'Reads pages of the made-up Example Wiki as guides, for tests.',
  version: '1.0.0',
  example: `${SITE}/wiki/Welcome`,
  matches: isPage,
  fetch: {
    addresses: (url) => (isPage(url) ? [url.trim()] : []),
  },

  async convert(pageData, context) {
    const answer = answerOf(pageData);
    if (!answer) return { ok: false, message: 'The page provided no data.' };
    if (answer.status === 404) return { ok: false, message: 'The wiki has no such page.' };
    const page = /** @type {{ title?: unknown, body?: unknown, links?: unknown }} */ (
      json(answer.text) ?? {}
    );
    const slug = slugOf(context.url);
    if (!slug || typeof page.title !== 'string' || typeof page.body !== 'string') {
      return { ok: false, message: 'The page did not hold a wiki page in the expected shape.' };
    }
    const guide = {
      id: `${PACK}:guide:${local(slug)}`,
      title: page.title,
      body: page.body,
      locationIds: [],
      source: {
        url: `${SITE}/wiki/${slug}`,
        site: NAME,
        license: LICENSE,
        readAt: context.importedAt,
        adapted: true,
      },
    };
    const existing = await context.existingPack(PACK);
    const { pack, refreshed } = withPage(existing, guide, context.listed?.group);
    const links = Array.isArray(page.links)
      ? page.links.filter((link) => typeof link === 'string').map((link) => `${SITE}/wiki/${link}`)
      : [];
    return {
      ok: true,
      packId: PACK,
      sourceKey: local(slug),
      guideId: guide.id,
      links,
      pack,
      summary: {
        game: NAME,
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
    convert(pageData) {
      const answer = answerOf(pageData);
      const contents =
        /** @type {{ headings?: { title: string, pages: { slug: string, title: string }[] }[] }} */ (
          answer ? (json(answer.text) ?? {}) : {}
        );
      if (!Array.isArray(contents.headings)) {
        return { ok: false, message: 'The wiki’s contents were not in the expected shape.' };
      }
      return {
        ok: true,
        game: NAME,
        pages: contents.headings.flatMap((heading) =>
          heading.pages.map((page) => ({
            url: `${SITE}/wiki/${page.slug}`,
            title: page.title,
            kind: 'page',
            group: heading.title,
          })),
        ),
      };
    },
    gameAddress: () => `${SITE}/wiki/Contents`,
  },
};

export default importer;
