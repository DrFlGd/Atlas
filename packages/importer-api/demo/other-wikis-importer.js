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
 *   browses stays so in code, whatever a file says. It also comes with a
 *   refusal file for a made-up wiki farm it never reads
 *   (`<name>.quiet-archive.example`), which a file of the person's that
 *   names one of its hosts overrides, and it says what a file of the
 *   person's widens (`sites.widens`): a way it adds for a host, or a refusal
 *   it overrides.
 * - It lists the general reader, `rules`, only to try a file on a page the
 *   person saved (`sites.tryPage`), with the browser's own HTML parser, or
 *   a map part on a data file the person saved (`request.data`); it does
 *   not read a site by such a file, and says so of each part.
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
/** @typedef {import('../src/index').SiteRulesWidening} SiteRulesWidening */
/** @typedef {import('../src/index').SiteTrial} SiteTrial */
/** @typedef {import('../src/index').SiteTrialRequest} SiteTrialRequest */

/** The general reader, as site rules files name it. */
const RULES = 'rules';

/** The ways of reading, as the Sites screen names them. */
const WAY_NAMES = { fetch: 'By itself', window: 'In a window', browse: 'As I browse' };

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
  {
    name: 'quiet-archive.refused.atlas-site.json',
    rules: {
      format: 'atlas-site-rules',
      version: 1,
      refusal: {
        id: 'quiet-archive',
        name: 'Quiet Archive wikis',
        domains: ['quiet-archive.example'],
        notice: 'This app does not read the Quiet Archive’s wikis, so nothing was opened or added.',
      },
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
  rules.parts.forEach((part, index) => {
    if (part.reader !== RULES) return;
    problems.push({
      field: `parts[${index}]`,
      message:
        part.type === 'map'
          ? 'is a map part read by rules, which this importer only tries on a saved data file: it does not read the map by it'
          : 'is read by rules, which this importer only tries on a saved page: it does not read the site by it',
    });
  });
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

/** A site file's hosts, with whether the file is the person's. */
const siteFiles = () =>
  applied.flatMap((file) => ('site' in file.rules ? [{ ...file, rules: file.rules }] : []));

/** Whether a refusal covers a host: the host is one of its domains, or under one. */
const covers = (/** @type {{ domains: string[] }} */ refusal, /** @type {string} */ host) =>
  refusal.domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * The refusal a host stays under, from the files it reads by: none when a
 * file of the person's names the host itself and no refusal of theirs
 * covers it.
 */
function refusalOf(/** @type {string} */ host) {
  const refusals = applied.flatMap((file) =>
    'refusal' in file.rules ? [{ own: file.own, ...file.rules.refusal }] : [],
  );
  const refusal = refusals.find((r) => covers(r, host));
  if (!refusal) return null;
  const overridden =
    !refusal.own && siteFiles().some((file) => file.own && file.rules.site.hosts.includes(host));
  return overridden ? null : refusal;
}

/** The ways a file offers for a host of its site, for this importer's reader. */
function waysOf(/** @type {SiteRules} */ rules) {
  if ('readerDefaults' in rules) return rules.readerDefaults.reading.ways;
  if (!('site' in rules)) return [];
  const part = rules.parts.find((p) => p.reader === READER);
  return part?.reading?.ways ?? null;
}

/** What a file of the person's widens against the files this importer comes with. */
function wideningsOf(/** @type {SiteRules} */ rules) {
  /** @type {SiteRulesWidening[]} */
  const widens = [];
  const builtIn = /** @type {SiteRules[]} */ (BUILT_IN_SITES.map((file) => file.rules));
  const defaults = builtIn.find((r) => 'readerDefaults' in r);
  const defaultWays = defaults ? (waysOf(defaults) ?? []) : [];
  if ('readerDefaults' in rules) {
    if (rules.readerDefaults.reader !== READER) return [];
    for (const way of rules.readerDefaults.reading.ways) {
      if (!defaultWays.includes(way)) {
        widens.push({
          field: 'readerDefaults.reading.ways',
          message: `adds ${WAY_NAMES[way]} for every site the reader “${READER}” reads`,
        });
      }
    }
    return widens;
  }
  if (!('site' in rules)) return [];
  const partIndex = rules.parts.findIndex((p) => p.reader === READER);
  rules.site.hosts.forEach((host, index) => {
    for (const file of BUILT_IN_SITES) {
      const refusal = 'refusal' in file.rules ? file.rules.refusal : null;
      if (refusal && covers(refusal, host)) {
        widens.push({
          field: `site.hosts[${index}]`,
          message: `reads ${host}, which the file “${file.name}” of the importer refuses: ${refusal.notice}`,
        });
      }
    }
    if (partIndex < 0) return;
    const shipped = builtIn.find((r) => 'site' in r && r.site.hosts.includes(host));
    const before = (shipped && waysOf(shipped)) ?? defaultWays;
    const after = waysOf(rules) ?? defaultWays;
    for (const way of after) {
      if (!before.includes(way)) {
        widens.push({
          field: `parts[${partIndex}].reading.ways`,
          message: `adds ${WAY_NAMES[way]} for ${host}`,
        });
      }
    }
  });
  return widens;
}

/** The words of an element, spaces folded. */
const wordsOf = (/** @type {Element | null} */ element) =>
  (element?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * Tries a file's first wiki or guide part read by rules on one saved page,
 * with the browser's HTML parser: nothing of the page is run or fetched.
 */
function tryPage(/** @type {SiteTrialRequest} */ request) {
  const { rules, url, html } = request;
  if (typeof request.data === 'string') return tryMapData(rules, request.data);
  /** @type {SiteTrial} */
  const trial = {
    part: null,
    headings: 0,
    pictures: 0,
    fullPictures: 0,
    tables: 0,
    chapters: 0,
    problems: [],
  };
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // An address that is not one is answered below.
  }
  const index = rules.parts.findIndex((p) => p.reader === RULES && p.type !== 'map');
  const part = rules.parts[index];
  if (!part || !('article' in part)) {
    trial.problems.push('The file has no wiki or guide part read by rules to try.');
    return trial;
  }
  if (!rules.site.hosts.includes(host)) {
    trial.problems.push(`The address ${url} is not on a host the file names.`);
    return trial;
  }
  const doc = new globalThis.DOMParser().parseFromString(html, 'text/html');
  const missing = (/** @type {string} */ field, /** @type {string} */ selector) =>
    trial.problems.push(`“${field}” (${selector}) matched nothing on this page.`);
  const selectors = Array.isArray(part.article.content)
    ? part.article.content
    : [part.article.content];
  const content = selectors.map((s) => doc.querySelector(s)).find((e) => e) ?? null;
  trial.part = index;
  trial.type = part.type === 'guide' ? 'guide' : 'wiki';
  if (!content) {
    missing('article.content', selectors.join(', '));
    return trial;
  }
  for (const selector of part.article.remove ?? []) {
    const found = content.querySelectorAll(selector);
    if (found.length === 0) missing('article.remove', selector);
    found.forEach((element) => element.remove());
  }
  const title = part.article.title ? doc.querySelector(part.article.title) : null;
  if (part.article.title && !title) missing('article.title', part.article.title);
  let titleText = title ? wordsOf(title) : wordsOf(doc.querySelector('title'));
  const end = part.article.titleEnd;
  if (end && titleText.endsWith(end)) titleText = titleText.slice(0, -end.length).trim();
  if (titleText) trial.title = titleText;
  if (part.game) {
    const name = doc.querySelector(part.game.name);
    if (name) trial.game = wordsOf(name);
    else missing('game.name', part.game.name);
  } else if (rules.site.game) {
    trial.game = rules.site.game;
  }
  trial.headings = content.querySelectorAll('h1, h2, h3, h4, h5, h6').length;
  const pictures = [...content.querySelectorAll('img')];
  trial.pictures = pictures.length;
  const fullAttribute = part.pictures?.full === 'attribute' ? part.pictures.fullAttribute : null;
  trial.fullPictures = fullAttribute
    ? pictures.filter((img) => img.getAttribute(fullAttribute)).length
    : 0;
  trial.tables = content.querySelectorAll('table').length;
  if (part.article.chapters) {
    trial.chapters = content.querySelectorAll(part.article.chapters).length;
    if (trial.chapters === 0) missing('article.chapters', part.article.chapters);
  }
  if (part.article.credit) {
    const credit = doc.querySelector(part.article.credit);
    if (credit) trial.credit = wordsOf(credit);
    else missing('article.credit', part.article.credit);
  }
  if (part.contents.links) {
    const links = [...doc.querySelectorAll(part.contents.links)];
    if (links.length === 0) missing('contents.links', part.contents.links);
    const groups = part.contents.groups
      ? [...doc.querySelectorAll(part.contents.groups)].map(wordsOf).filter(Boolean)
      : [];
    if (part.contents.groups && groups.length === 0) {
      missing('contents.groups', part.contents.groups);
    }
    if (links.length > 0) {
      trial.contents = {
        count: links.length,
        groups,
        first: links.slice(0, 5).map((link) => ({ title: wordsOf(link) })),
      };
    }
  }
  if ('order' in part && part.order.next) {
    const next = doc.querySelector(part.order.next)?.getAttribute('href');
    if (next) {
      try {
        trial.next = new URL(next, url).href;
      } catch {
        // A link that is not an address is no next page.
      }
    } else missing('order.next', part.order.next);
  }
  const block = part.licence ?? rules.site.licence;
  trial.licence =
    block && 'known' in block
      ? `${block.known}, as the file says.`
      : block && 'permission' in block
        ? `“${block.permission}”, as the file says.`
        : block && 'blank' in block
          ? 'None recorded, as the file says.'
          : 'The page states none, so you would be asked for one.';
  trial.text = wordsOf(content).slice(0, 600);
  return trial;
}

/**
 * Every value a data path (`markers[*].at[0]`) names in `data`: a short
 * reader of the format's data paths, as this module may import nothing.
 */
function valuesAt(/** @type {unknown} */ data, /** @type {string} */ path) {
  /** @type {unknown[]} */
  let values = [data];
  for (const step of path.match(/[^.[\]]+|\[(?:\*|\d+)\]/g) ?? []) {
    values = values.flatMap((value) => {
      if (step === '[*]') return Array.isArray(value) ? value : [];
      if (step.startsWith('[')) {
        const at = Number(step.slice(1, -1));
        return Array.isArray(value) && at < value.length ? [value[at]] : [];
      }
      return value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.hasOwn(value, step)
        ? [/** @type {Record<string, unknown>} */ (value)[step]]
        : [];
    });
  }
  return values;
}

/**
 * A map part tried on a saved data file: its maps, types and locations, in
 * pixels from the top left only (this demo reads no other units), and each
 * data path that matched nothing. Nothing is fetched.
 */
function tryMapData(/** @type {SiteRules} */ rules, /** @type {string} */ text) {
  /** @type {SiteTrial} */
  const trial = {
    part: null,
    headings: 0,
    pictures: 0,
    fullPictures: 0,
    tables: 0,
    chapters: 0,
    problems: [],
  };
  if (!('site' in rules)) return trial;
  const index = rules.parts.findIndex((p) => p.reader === RULES && p.type === 'map');
  const part = rules.parts[index];
  if (!part || !('maps' in part)) {
    trial.problems.push('The file has no map part read by rules to try on a data file.');
    return trial;
  }
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    trial.problems.push('The file chosen is not JSON, so it is not a data file of the map.');
    return trial;
  }
  trial.part = index;
  trial.type = 'map';
  if (rules.site.game) trial.game = rules.site.game;
  const used = new Set();
  const read = (
    /** @type {string} */ field,
    /** @type {string} */ path,
    /** @type {unknown} */ at,
  ) => {
    const found = valuesAt(at, path);
    if (found.length > 0) used.add(field);
    return found;
  };
  const one = (
    /** @type {string} */ field,
    /** @type {unknown} */ given,
    /** @type {unknown} */ entry,
  ) => (part.maps.path && typeof given === 'string' ? read(field, given, entry)[0] : given);
  const entries = part.maps.path ? read('maps.path', part.maps.path, data) : [{}];
  const origin = `https://${rules.site.hosts[0]}`;
  const maps = entries.map((entry) => {
    const id = String(one('maps.id', part.maps.id, entry) ?? '');
    const size = one('maps.size', part.maps.size, entry);
    const [width, height] = Array.isArray(size) ? size.map(Number) : [Number(size), Number(size)];
    const group = part.maps.group ? read('maps.group', part.maps.group, entry)[0] : undefined;
    const floor = part.maps.floor ? read('maps.floor', part.maps.floor, entry)[0] : undefined;
    const name = String(one('maps.name', part.maps.name, entry) ?? id);
    const images = part.maps.picture.images;
    return {
      id,
      name: floor && !name.includes(String(floor)) ? `${name}, ${floor}` : name,
      width,
      height,
      ...(group ? { group: String(group), ...(floor ? { floor: String(floor) } : {}) } : {}),
      locations: 0,
      described: 0,
      linked: 0,
      pictured: 0,
      outside: 0,
      ...(images
        ? {
            image: new URL(
              images
                .replaceAll('{map}', id)
                .replace('{z}', '0')
                .replace('{x}', '0')
                .replace(/\{-?y\}/, '0'),
              origin,
            ).href,
          }
        : {}),
    };
  });
  const fields = part.locations.fields;
  /** @type {string[]} */
  const types = [];
  /** @type {{ name: string, map: string, type: string, x: number, y: number }[]} */
  const first = [];
  let count = 0;
  for (const entry of read('locations.path', part.locations.path, data)) {
    const value = (/** @type {string} */ key) => {
      const path = /** @type {Record<string, string | undefined>} */ (fields)[key];
      return path ? read(`locations.fields.${key}`, path, entry)[0] : undefined;
    };
    const map = fields.map ? maps.find((m) => m.id === String(value('map'))) : maps[0];
    const type = value('type');
    const x = Number(value('x'));
    const y = Number(value('y'));
    if (!map || type === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const typeName = String(('names' in part.types && part.types.names?.[String(type)]) || type);
    if (!types.includes(typeName)) types.push(typeName);
    if (x < 0 || y < 0 || x > map.width || y > map.height) {
      map.outside += 1;
      continue;
    }
    count += 1;
    map.locations += 1;
    if (value('description')) map.described += 1;
    if (value('page')) map.linked += 1;
    if (value('picture')) map.pictured += 1;
    if (first.length < 5)
      first.push({ name: String(value('name') ?? typeName), map: map.name, type: typeName, x, y });
  }
  trial.map = {
    maps: { count: maps.length, listed: maps },
    types: { count: types.length, first: types.slice(0, 8) },
    locations: { count, first },
  };
  const outside = maps.reduce((sum, map) => sum + map.outside, 0);
  if (outside > 0) {
    trial.problems.push(
      `${outside} ${outside === 1 ? 'location falls outside its map' : 'locations fall outside their map'}, so ${outside === 1 ? 'it would be' : 'they would be'} left out: x and y may be the other way round, or counted at another zoom.`,
    );
  }
  /** @type {[string, unknown][]} */
  const paths = [
    ['maps.path', part.maps.path],
    ...(part.maps.path
      ? /** @type {[string, unknown][]} */ ([
          ['maps.id', part.maps.id],
          ['maps.name', part.maps.name],
          ['maps.size', part.maps.size],
          ['maps.group', part.maps.group],
          ['maps.floor', part.maps.floor],
        ])
      : []),
    ['locations.path', part.locations.path],
    ...Object.entries(fields).map(
      ([key, path]) => /** @type {[string, unknown]} */ ([`locations.fields.${key}`, path]),
    ),
  ];
  for (const [field, path] of paths) {
    if (typeof path === 'string' && !used.has(field)) {
      trial.problems.push(`“${field}” (${path}) matched nothing in the data.`);
    }
  }
  return trial;
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
  refuses(url) {
    try {
      const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, '');
      return refusalOf(host)?.notice ?? null;
    } catch {
      return null;
    }
  },
  siteInfo(url) {
    const parts = partsOf(url);
    if (!parts || refusalOf(parts.host)) return null;
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
    readers: [READER, RULES],
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
      `- \`${RULES}\`: tried on a saved page only.`,
    ].join('\n'),
    widens: wideningsOf,
    tryPage,
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
