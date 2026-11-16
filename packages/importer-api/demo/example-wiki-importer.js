// @ts-check
/* global DOMParser */
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
 * - A page asked for under one name and answered from another address of
 *   the wiki (`finalUrl`: the wiki forwarded it) is the page it was
 *   answered as: its guide is kept under that name, the address is given
 *   back as `pageAddress`, and the name asked is kept as another name of it
 *   (the manifest's `idMigrations`), so a link to that name opens it.
 * - A page may instead answer HTML (`text/html`): its title is its `h1`,
 *   its text the paragraphs and list items of its article (`#content`),
 *   its links those to other pages of the wiki. Where the app lays pages
 *   out (`context.layOut`), it is laid out first, and what that shows hidden
 *   is left out; notes of layout the page came with are not the app's and
 *   are not read.
 * - Built again from its saved pages (`rebuild`), every page kept is
 *   written again from its data, and one the pack lacks is added back.
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

/** @typedef {{ title?: unknown, body?: unknown, links?: unknown }} WikiPage */

/**
 * A page the wiki answered as HTML, read as a page in JSON is: laid out by
 * the app first when it can, so that a block it shows hidden is left out.
 * @returns {Promise<WikiPage>}
 */
async function htmlPageOf(/** @type {FetchedPage} */ answer, /** @type {ImportContext} */ context) {
  if (typeof DOMParser !== 'function') return {};
  const url = answer.finalUrl || answer.url;
  // Only notes the app wrote count: the page's own say nothing.
  const laidOut = context.layOut
    ? await context.layOut({ html: answer.text, url, article: ['#content'] })
    : null;
  const doc = new DOMParser().parseFromString(laidOut ?? answer.text, 'text/html');
  const article = doc.querySelector('#content');
  if (!article) return {};
  const shown = (/** @type {Element} */ el) => !laidOut || !el.closest('[data-atlas-hidden]');
  const words = (/** @type {Element} */ el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const links = Array.from(article.querySelectorAll('a[href]')).flatMap((a) => {
    let to;
    try {
      to = new URL(a.getAttribute('href') ?? '', url).href;
    } catch {
      return [];
    }
    const slug = slugOf(to);
    return slug && slug !== 'Contents' ? [slug] : [];
  });
  return {
    title: words(article.querySelector('h1') ?? doc.createElement('h1')) || undefined,
    body: Array.from(article.querySelectorAll('p, li'))
      .filter(shown)
      .map(words)
      .filter(Boolean)
      .join('\n\n'),
    links,
  };
}

/** What a page of the wiki answered: in JSON, or in HTML. */
async function pageOf(/** @type {FetchedPage} */ answer, /** @type {ImportContext} */ context) {
  if (answer.status !== 200) return {};
  return answer.contentType === 'text/html'
    ? htmlPageOf(answer, context)
    : /** @type {WikiPage} */ (json(answer.text) ?? {});
}

/**
 * The guide a page's answer becomes, with the pages it links to, and its
 * other name when it was asked for under another address than it came from.
 * @returns {{ problem: string } | { guide: GuideEntry, links: string[], other: string | null, pageAddress?: string }}
 */
function guideOf(
  /** @type {FetchedPage} */ answer,
  /** @type {WikiPage} */ page,
  /** @type {string} */ asked,
  /** @type {string} */ importedAt,
) {
  if (answer.status === 404) return { problem: 'The wiki has no such page.' };
  const askedSlug = slugOf(asked);
  const slug = slugOf(answer.finalUrl || asked);
  if (!askedSlug || !slug || slug === 'Contents') {
    return { problem: 'The page did not hold a wiki page in the expected shape.' };
  }
  if (typeof page.title !== 'string' || typeof page.body !== 'string') {
    return { problem: 'The page did not hold a wiki page in the expected shape.' };
  }
  const address = `${SITE}/wiki/${slug}`;
  /** @type {GuideEntry} */
  const guide = {
    id: `${PACK}:guide:${local(slug)}`,
    title: page.title,
    body: page.body,
    locationIds: [],
    source: { url: address, site: NAME, license: LICENSE, readAt: importedAt, adapted: true },
  };
  const links = Array.isArray(page.links)
    ? page.links.filter((link) => typeof link === 'string').map((link) => `${SITE}/wiki/${link}`)
    : [];
  const other = askedSlug === slug ? null : `${PACK}:guide:${local(askedSlug)}`;
  return { guide, links, other, ...(other ? { pageAddress: address } : {}) };
}

/** The pack with `name` kept as another name of the guide `id`, unless it is a page of its own. */
function withOtherName(
  /** @type {PackData} */ pack,
  /** @type {string | null} */ name,
  /** @type {string} */ id,
) {
  const migrations = { ...pack.manifest.idMigrations };
  // The page is a page of its own: no name of it leads elsewhere.
  delete migrations[id];
  if (name && !pack.guides.some((g) => g.id === name)) migrations[name] = id;
  for (const [from, to] of Object.entries(migrations)) if (to === name) migrations[from] = id;
  pack.manifest.idMigrations = migrations;
  return pack;
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
    const read = guideOf(answer, await pageOf(answer, context), context.url, context.importedAt);
    if ('problem' in read) return { ok: false, message: read.problem };
    const { guide, links, other } = read;
    const sourceKey = local(slugOf(context.url) ?? guide.id);
    let existing = await context.existingPack(PACK);
    /** @type {{ url: string, links: string[], pageAddress?: string }[]} */
    const writtenAgain = [];
    // Built again from the saved pages: each written again from its data, nothing fetched.
    if (context.rebuild && existing && context.savedPages && context.savedSource) {
      const keptPages = await context.savedPages(PACK);
      let done = 0;
      for (const kept of keptPages) {
        // How far it is, for the app to show.
        context.progress?.({ done: done++, total: keptPages.length });
        if (kept.key === sourceKey) continue;
        const source = await context.savedSource(PACK, kept.key);
        const keptAnswer = source ? answerOf(source.data) : null;
        if (!source || !keptAnswer) continue;
        const again = guideOf(
          keptAnswer,
          await pageOf(keptAnswer, context),
          source.url,
          source.importedAt,
        );
        if ('problem' in again) continue;
        existing = withOtherName(
          withPage(existing, again.guide, undefined).pack,
          again.other,
          again.guide.id,
        );
        writtenAgain.push({
          url: source.url,
          links: again.links,
          ...(again.pageAddress ? { pageAddress: again.pageAddress } : {}),
        });
      }
      context.progress?.({ done: keptPages.length, total: keptPages.length });
    }
    const { pack: added, refreshed } = withPage(existing, guide, context.listed?.group);
    const pack = withOtherName(added, other, guide.id);
    return {
      ok: true,
      packId: PACK,
      sourceKey,
      guideId: guide.id,
      links,
      ...(read.pageAddress ? { pageAddress: read.pageAddress } : {}),
      ...(writtenAgain.length > 0 ? { writtenAgain } : {}),
      pack,
      summary: {
        game: NAME,
        map: guide.title,
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
