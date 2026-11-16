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
 * - Each wiki can also be read as the person browses it ("As I browse",
 *   `browseReader`). The wikis of a made-up wiki farm whose terms allow no
 *   programs (`<name>.reading-room.example`) are read only that way: the
 *   app never fetches them or reads them in a go. A page read as the person
 *   browsed may come with the pictures it showed (`shown`: each `{ "alt",
 *   "type", "data" }`, its bytes in base64, as the page loaded them), which
 *   become the page's pictures with their files (`pictureFiles`).
 * - A page answers `{ "title", "body", "links", "licence" }` as the Example
 *   Wiki's do (`example-wiki-importer.js`), with `licence` the address of a
 *   Creative Commons deed when the page states one. A page that states none
 *   asks the person for the wiki's licence (`askLicence`); with what they
 *   answered (`ImportContext.confirmedLicence`) it is read, and its guide
 *   says where the licence came from: confirmed by the person, filled in by
 *   them (`licenseBasis: 'permission'`, the words as the licence's name),
 *   or none recorded (`licenseBasis: 'none'`).
 * - What it offers for a site comes from site rules files (`sites`, see
 *   `../src/siteRules.ts` and the guide in `../site-rules/`): the defaults
 *   of its one reader, `other-wiki`, and a file for one made-up wiki, the
 *   Harbour Wiki, which it comes with, and any the person adds for that
 *   reader. A file can offer fewer ways, a longer pause, its own notice
 *   and an answer for the wiki's licence; the farm read only as the person
 *   browses stays so in code, whatever a file says.
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
  'This app does not know this wiki: it reads its pages as it reads the wikis it knows, and asks you for the wiki’s licence when its pages do not state one.';

/** The made-up wiki farm whose terms allow no programs: read only as the person browses. */
const BROWSE_ONLY = /\.reading-room\.example$/;
const BROWSE_NOTICE =
  'The terms of this wiki farm do not allow programs to read its wikis, so this app keeps only the pages you open yourself as you browse; pictures it cannot take from the page stay words.';

/** Its one built-in reader, as site rules files name it. */
const READER = 'other-wiki';
/** @typedef {import('../src/index').SiteRules} SiteRules */
/** @typedef {import('../src/index').SiteRulesLicence} SiteRulesLicence */
/** @typedef {import('../src/index').SiteRulesProblem} SiteRulesProblem */
/** @typedef {import('../src/index').AppliedSiteRules} AppliedSiteRules */
/** @typedef {import('../src/index').ReadingWay} ReadingWay */

/** The site rules files it comes with. */
const BUILT_IN_SITES = [
  {
    name: `${READER}.reader.atlas-site.json`,
    rules: {
      format: 'atlas-site-rules',
      version: 1,
      readerDefaults: {
        reader: READER,
        reading: { ways: ['fetch', 'window', 'browse'] },
        notice: NOTICE,
        licence: { ask: true },
      },
    },
  },
  {
    name: 'harbour-wiki.atlas-site.json',
    rules: {
      format: 'atlas-site-rules',
      version: 1,
      site: {
        id: 'harbour-wiki',
        name: 'Harbour Wiki',
        game: 'Harbour',
        hosts: ['harbour.example.net'],
        notice: 'The Harbour Wiki asks readers to leave five seconds between pages.',
      },
      parts: [{ type: 'wiki', reader: READER, reading: { ways: ['fetch', 'browse'], pause: 5 } }],
    },
  },
];

/** The files it reads by: those the app handed it last, else those it comes with. */
let applied = /** @type {AppliedSiteRules[]} */ (
  BUILT_IN_SITES.map((file) => ({
    ...file,
    own: false,
    rules: /** @type {SiteRules} */ (file.rules),
  }))
);

/** The problems of one file for this importer, given the files that count before it. */
function problemsOf(/** @type {SiteRules} */ rules, /** @type {SiteRules[]} */ before) {
  if (!('site' in rules)) return [];
  /** @type {SiteRulesProblem[]} */
  const problems = [];
  const named = new Set(before.flatMap((other) => ('site' in other ? other.site.hosts : [])));
  rules.site.hosts.forEach((host, index) => {
    if (BROWSE_ONLY.test(host)) {
      problems.push({
        field: `site.hosts[${index}]`,
        message:
          'is a wiki of a farm whose terms allow no programs: it is read only as you browse, whatever a file says',
      });
    } else if (named.has(host)) {
      problems.push({
        field: `site.hosts[${index}]`,
        message: 'is named by another file switched on, which counts for it',
      });
    }
  });
  return problems;
}

/**
 * What the files say of a host: the first site file with a part for its
 * reader that names it, else the reader's defaults; null when none does.
 */
function rulesOf(/** @type {string} */ host) {
  const defaults = applied.find(
    (file) => 'readerDefaults' in file.rules && file.rules.readerDefaults.reader === READER,
  );
  for (const file of applied) {
    const rules = file.rules;
    if (!('site' in rules) || !rules.site.hosts.includes(host)) continue;
    const part = rules.parts.find((p) => p.reader === READER);
    if (!part) continue;
    const base =
      defaults && 'readerDefaults' in defaults.rules ? defaults.rules.readerDefaults : null;
    const reading = 'reading' in part && part.reading ? part.reading : base?.reading;
    return {
      file: file.name,
      ways: reading?.ways ?? ['fetch', 'window', 'browse'],
      pause: reading?.pause,
      notice: rules.site.notice ?? base?.notice,
      licence: part.licence ?? rules.site.licence ?? base?.licence,
    };
  }
  if (!defaults || !('readerDefaults' in defaults.rules)) return null;
  const base = defaults.rules.readerDefaults;
  return {
    file: defaults.name,
    ways: base.reading.ways,
    pause: base.reading.pause,
    notice: base.notice,
    licence: base.licence,
  };
}

/** The answer for a wiki's licence its file gives: a known licence, words, or none recorded. */
function answerOfBlock(/** @type {SiteRulesLicence | undefined} */ block) {
  if (!block) return undefined;
  if ('known' in block) {
    const deed = Object.keys(LICENCES).find(
      (url) => LICENCES[/** @type {keyof typeof LICENCES} */ (url)] === block.known,
    );
    return deed ? { name: block.known, url: deed } : undefined;
  }
  if ('permission' in block) {
    return {
      basis: /** @type {const} */ ('permission'),
      name: block.permission,
      ...(block.address ? { url: block.address } : {}),
      ...(block.from ? { givenBy: block.from } : {}),
      ...(block.on ? { givenOn: block.on } : {}),
      ...(block.note ? { note: block.note } : {}),
    };
  }
  if ('blank' in block)
    return { basis: /** @type {const} */ ('none'), name: 'No licence recorded' };
  return undefined;
}

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

/** The pictures a page read as the person browsed showed: `shown` of its data. */
function shownPictures(/** @type {unknown} */ pageData) {
  const shown = /** @type {{ shown?: unknown }} */ (pageData)?.shown;
  if (!Array.isArray(shown)) return [];
  return shown.flatMap((entry) => {
    const { alt, type, data } = /** @type {{ alt?: unknown, type?: unknown, data?: unknown }} */ (
      entry ?? {}
    );
    return typeof alt === 'string' &&
      (type === 'image/png' || type === 'image/jpeg') &&
      typeof data === 'string'
      ? [{ alt, type, data }]
      : [];
  });
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
    if (!parts) return null;
    if (BROWSE_ONLY.test(parts.host)) {
      return { key: parts.host, ways: ['browse'], notice: BROWSE_NOTICE };
    }
    const found = rulesOf(parts.host);
    if (!found) return { key: parts.host, ways: ['fetch', 'window', 'browse'], notice: NOTICE };
    const answer = answerOfBlock(found.licence);
    return {
      key: parts.host,
      ways: found.ways,
      ...(found.notice ? { notice: found.notice } : {}),
      ...(found.pause ? { pause: found.pause } : {}),
      rulesFile: found.file,
      ...(answer ? { rulesLicence: answer } : {}),
    };
  },
  sites: {
    files: BUILT_IN_SITES,
    readers: [READER],
    check: (rules) => problemsOf(rules, []),
    apply(files) {
      applied = [...files];
      return files.map((file, index) =>
        problemsOf(
          file.rules,
          files.slice(0, index).map((other) => other.rules),
        ),
      );
    },
    guide: [
      '## Readers of the importer “Other wikis”',
      '',
      `- \`${READER}\`: a wiki whose pages are at \`https://<host>/wiki/<page>\`, with its contents at \`/wiki/Contents\`. By itself, in a window, as I browse.`,
    ].join('\n'),
  },
  fetch: { addresses: (url) => (isPage(url) ? [url.trim()] : []) },
  // A window shows the page itself; the tests' shell hands over what the site answers.
  pageReader: '() => null',
  browseReader: '() => null',

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
    // What the person answered for the wiki, else what its site rules file answers,
    // used only for a page that states no licence.
    const given = stated
      ? undefined
      : (context.confirmedLicence ?? answerOfBlock(rulesOf(parts.host)?.licence));
    const confirmed =
      given && given.basis !== 'permission' && given.basis !== 'none' && given.url in LICENCES
        ? given.url
        : null;
    const filledIn = given && given.basis === 'permission' ? given : null;
    const none = given && given.basis === 'none' ? given : null;
    const deed = stated ?? confirmed;
    if (!deed && !filledIn && !none) {
      return {
        ok: false,
        message:
          'This page does not say which licence its wiki is under, so nothing was added until you answer for it.',
        askLicence: true,
      };
    }
    /** @type {{ name: string, url?: string }} */
    const licence = deed
      ? { name: LICENCES[/** @type {keyof typeof LICENCES} */ (deed)], url: deed }
      : filledIn
        ? { name: filledIn.name, ...(filledIn.url ? { url: filledIn.url } : {}) }
        : { name: /** @type {NonNullable<typeof none>} */ (none).name };
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
        ...(filledIn
          ? {
              licenseBasis: /** @type {const} */ ('permission'),
              ...(filledIn.givenBy ? { licenseGivenBy: filledIn.givenBy } : {}),
              ...(filledIn.givenOn ? { licenseGivenOn: filledIn.givenOn } : {}),
              ...(filledIn.note ? { licenseNote: filledIn.note } : {}),
            }
          : {}),
        ...(none ? { licenseBasis: /** @type {const} */ ('none') } : {}),
      },
    };
    // The pictures the page showed as the person browsed it, with their files.
    const shown = context.reading === 'browse' ? shownPictures(pageData) : [];
    /** @type {{ id: string, file: string, alt: string, data: string }[]} */
    const pictures = shown.map((picture, index) => ({
      id: `${packId}:picture:${local(parts.slug)}-${index + 1}`,
      file: `pictures/${local(parts.slug)}-${index + 1}.${picture.type === 'image/jpeg' ? 'jpg' : 'png'}`,
      alt: picture.alt,
      data: picture.data,
    }));
    if (pictures.length > 0) {
      guide.body += `\n\n${pictures.map((p) => `![${p.alt}](${p.id})`).join('\n\n')}`;
    }
    const existing = await context.existingPack(packId);
    const { pack, refreshed } = withPage(parts.host, existing, guide, licence.name);
    const others = (pack.pictures ?? []).filter((p) => !pictures.some((q) => q.id === p.id));
    if (pictures.length > 0 || pack.pictures) {
      pack.pictures = [
        ...others,
        ...pictures.map((p) => ({ id: p.id, file: p.file, caption: p.alt, shareable: true })),
      ];
    }
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
      ...(pictures.length > 0
        ? { pictureFiles: pictures.map((p) => ({ file: p.file, data: p.data })) }
        : {}),
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
