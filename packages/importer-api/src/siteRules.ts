/**
 * Site rules files: one JSON file per site that tells an importer which
 * addresses are the site's pages, how they may be read and which licence
 * to record, so that a site can be added without a new release of the
 * software. The format and the guide for writing one are public
 * (`site-rules/atlas-site-rules.md` in this package, with the JSON Schema
 * `site-rules/atlas-site-rules.schema.json` made from the schemas here);
 * the readers that read the pages, and every real site's file, belong to
 * the importers.
 *
 * A file is data only: no field holds a script, a sign-in, a cookie, a
 * token or a request header. It is checked strictly ({@link checkSiteRules}):
 * a field this format does not name, a value of the wrong form or a version
 * this app does not know refuses the whole file, with each problem in plain
 * words naming its field. Nothing is guessed and nothing is half used.
 *
 * Three shapes share the format:
 *
 * - a site file, `<site id>.atlas-site.json`: `site` and its `parts` (one
 *   map, wiki or guide each), each read by a built-in reader of an importer
 *   or by `rules`, the general reader that follows the file;
 * - a reader's defaults, `<reader>.reader.atlas-site.json`: the ways, the
 *   pause, the notice, the picture hosts and the licence form of every site
 *   that reader recognises by its address when no site file says otherwise.
 *
 * - a refusal, `<id>.refused.atlas-site.json`: a site that is not read at
 *   all, by a domain and every host under it.
 *
 * A file states a site's limits, and the person checks every file by hand
 * before switching it on: a file of theirs may widen what a file an
 * importer comes with says of the same site, and the importer says what it
 * widens (`ImporterSites.widens`, with what every file widens in its
 * `reading` section, {@link readingWidenings}). What is no site's to decide
 * has no field: there is none for a shorter pause than the app's own,
 * another identity, reading past a refusal, or answering a check that asks
 * whether the reader is a person. A file may keep the app off addresses
 * (`reading.keepOff`), and a file of the person's may record the site's
 * own permission to read some addresses by itself where `robots.txt` does
 * not allow them (`reading.permission`); nothing else reads past it.
 */

import {
  GAME_ID_PATTERN,
  MAP_LINK_ID_MARK,
  MAP_LINK_QUERY_PATTERN,
  PAGE_WIDTHS,
  hasIdMark,
} from '@atlas/schema';
import { z } from 'zod';
import {
  MAX_ADDRESS_BEGINNINGS,
  addressBeginningProblem,
  addressBegins,
  beginningsOverlap,
  dataPathProblem,
  dataPathSteps,
  pagePathProblem,
  patternProblem,
  piecesOf,
  selectorProblem,
} from './sitePatterns';
import { READING_WAYS, type ReadingWay } from './fetching';
import { CONFIRMABLE_LICENCES, MAX_NOTICE_CHARS, rulesLicenceOf, type RulesLicence } from './sites';
import type { SiteRulesWidening } from './siteTrial';

/** The value of `format` in every site rules file. */
export const SITE_RULES_FORMAT = 'atlas-site-rules';
/** The one version of the format this app reads. */
export const SITE_RULES_VERSION = 1;
/** A site rules file larger than this (as UTF-8) is refused. */
export const MAX_SITE_RULES_BYTES = 64 * 1024;
/** The end of every site rules file's name. */
export const SITE_RULES_SUFFIX = '.atlas-site.json';
/** The end of the name of a reader's defaults file. */
export const READER_DEFAULTS_SUFFIX = `.reader${SITE_RULES_SUFFIX}`;
/** The end of the name of a refusal file. */
export const REFUSAL_SUFFIX = `.refused${SITE_RULES_SUFFIX}`;

/** The `reader` of a part read by the general reader, which follows the file. */
export const RULES_READER = 'rules';
/** Parts one site file holds at most. */
export const MAX_SITE_PARTS = 6;
/** Problems of one file reported at most. */
export const MAX_SITE_RULES_PROBLEMS = 50;
/** The longest address a file may hold. */
export const MAX_SITE_ADDRESS_CHARS = 2048;

/** A site id: 3 to 40 of `a-z`, `0-9` and `-`, starting and ending with a letter or digit. */
export const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/u;
/** A reader's name: lowercase letters, digits and inner dashes, at most 40 characters. */
export const READER_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
/**
 * A host name as a file writes it: lowercase labels of letters, digits and
 * inner hyphens, at least two, the last starting with a letter; no scheme,
 * path, port, wildcard or leading `www.`.
 */
const HOST_PATTERN =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** The words of a licence `known` may name: the licences the app offers to confirm. */
export const KNOWN_LICENCE_NAMES: readonly string[] = CONFIRMABLE_LICENCES.map((l) => l.name);

// ---------------------------------------------------------------------------
// The forms of single fields

/** Adds the problem a check finds in a text, if any. */
const checked =
  (problem: (text: string) => string | null) => (text: string, ctx: z.RefinementCtx) => {
    const found = problem(text);
    if (found) ctx.addIssue({ code: 'custom', message: found, input: text });
  };

const text = (max: number) => z.string().min(1).max(max);

/** Whether `text` is a date such as `2026-11-16` that is in the calendar. */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(text);
}

/** Why `text` cannot be a host name of a file, or null. */
export function hostProblem(text: string): string | null {
  if (/^[a-z]+:\/\//iu.test(text)) return 'must be a host name only, without https://';
  if (/[/:?#@*\s]/u.test(text)) {
    return 'must be a host name only, without a path, port, wildcard or spaces, such as wiki.example.org';
  }
  if (text !== text.toLowerCase()) return 'must be written in lower case';
  if (text.startsWith('www.'))
    return 'must be written without www. (the same host with www. is included)';
  if (!HOST_PATTERN.test(text)) return 'must be a host name such as wiki.example.org';
  return null;
}

const date = z
  .string()
  .superRefine(
    checked((value) =>
      isCalendarDate(value) ? null : 'must be a date written as YYYY-MM-DD, such as 2026-11-16',
    ),
  );
const host = z.string().superRefine(checked(hostProblem));
const selector = z.string().superRefine(checked(selectorProblem));
const pattern = z.string().superRefine(checked(patternProblem));
const dataPath = z.string().superRefine(checked(dataPathProblem));
const pagePath = z.string().superRefine(checked((value) => pagePathProblem(value)));
const storePath = z.string().superRefine(checked((value) => pagePathProblem(value, true)));
/** An address: a full `https://` address on one of the site's hosts, or a path beginning with `/` (checked against the hosts once the whole file is read). */
const address = z.string().min(1).max(MAX_SITE_ADDRESS_CHARS);
const termsAddress = z
  .string()
  .max(MAX_SITE_ADDRESS_CHARS)
  .superRefine(
    checked((value) =>
      /^https:\/\/[^\s/?#@]+(?:[/?#]\S*)?$/iu.test(value)
        ? null
        : 'must be a full https:// address, without spaces',
    ),
  );

/** A list in which each entry is there once. */
function once<T extends z.ZodType>(entry: T, what: string) {
  return z.array(entry).superRefine((list, ctx) => {
    list.forEach((item, index) => {
      if (list.indexOf(item) !== index) {
        ctx.addIssue({
          code: 'custom',
          message: `${JSON.stringify(item)} is listed twice; list each ${what} once`,
          path: [index],
          input: item,
        });
      }
    });
  });
}

const reader = z
  .string()
  .max(40)
  .regex(READER_NAME_PATTERN, 'must be the name of a reader: lowercase letters, digits and dashes');

const builtInReader = reader.refine((name) => name !== RULES_READER, {
  message: `must be the name of a built-in reader; ${RULES_READER} has no defaults of its own`,
});

// ---------------------------------------------------------------------------
// Blocks every part may have

/** The pause between pages a file may give (`reading.pause`), in seconds. */
export const READING_PAUSE_SECONDS = { min: 1, max: 60 } as const;

/** A list of beginnings of addresses of the site (see `addressBeginningProblem`), each once. */
const addressBeginnings = once(
  z.string().superRefine(checked(addressBeginningProblem)),
  'address',
).max(MAX_ADDRESS_BEGINNINGS);

/**
 * `reading.permission`: the record of a site's own permission for this app
 * to read some of its addresses by itself (the way `fetch`) where its
 * `robots.txt` does not allow them: who gave it (`from`, in the person's
 * own words), the day it was given (`on`) and the beginnings of the
 * addresses it covers (`allows`, matched as `keepOff` is). It lifts the
 * live `robots.txt` for those addresses only, and nothing else: `keepOff`
 * wins over it, and the app's identity, its pause, stopping at the first
 * refusal, never answering a person check and never reusing a window's
 * cookies stay as they are. Only a file of the person's carries one: a
 * shipped file with a permission is refused ({@link checkShippedSiteRules}),
 * and a reader's defaults have no field for it.
 */
const permissionSchema = z.strictObject({
  from: text(200),
  on: date,
  allows: addressBeginnings.min(1),
});

export type SitePermission = z.infer<typeof permissionSchema>;

/**
 * The `reading` section of a reader's defaults: no permission, which only
 * one site can give.
 *
 * `keepOff` lists the beginnings of addresses of the site this app never
 * opens on its own (see `addressBegins`): neither when it reads the site
 * by itself (`fetch`) nor when it steers its window (`window`). What the
 * person opens as they browse is theirs, and is kept as any page they
 * open. It adds to the site's live `robots.txt` and never loosens it, and
 * no permission lifts it. A part's list takes the place of its reader's
 * defaults' list; an empty one keeps the app off no address.
 */
const readingDefaultsSchema = z.strictObject({
  ways: once(z.enum(READING_WAYS as readonly [ReadingWay, ...ReadingWay[]]), 'way')
    .min(1)
    .max(READING_WAYS.length),
  pause: z.number().min(READING_PAUSE_SECONDS.min).max(READING_PAUSE_SECONDS.max).optional(),
  keepOff: addressBeginnings.optional(),
});

/** The `reading` section of a part of a site file. */
const readingSchema = z.strictObject({
  ...readingDefaultsSchema.shape,
  permission: permissionSchema.optional(),
});

/** `pictures` of a part with a built-in reader, and of a reader's defaults: its hosts only. */
const pictureHostsSchema = z.strictObject({
  hosts: once(host, 'host').max(10).optional(),
});

const attributeName = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,40}$/u, 'must be an attribute name, such as src');

/** `pictures` of a part read by `rules`. */
const rulesPicturesSchema = z.strictObject({
  hosts: once(host, 'host').max(10).optional(),
  source: z.array(attributeName).min(1).max(5).optional(),
  full: z.enum(['same', 'link', 'srcset', 'attribute']).optional(),
  fullAttribute: attributeName.optional(),
  skip: z.array(selector).max(20).optional(),
});

const credit = text(120).optional();

/** The five forms of a licence block, by the field that names each. */
const licenceForms = {
  ask: z.strictObject({ ask: z.literal(true), stated: selector.optional(), credit }),
  stated: z.strictObject({ ask: z.literal(false), credit }),
  known: z.strictObject({ known: z.enum(KNOWN_LICENCE_NAMES as [string, ...string[]]), credit }),
  permission: z.strictObject({
    permission: text(200),
    from: text(200).optional(),
    on: date.optional(),
    address: termsAddress.optional(),
    note: text(1000).optional(),
    credit,
  }),
  blank: z.strictObject({ blank: z.literal(true), credit }),
};

/** A form of a licence block: `ask`, `stated` (`{ "ask": false }`), `known`, `permission` or `blank`. */
export type LicenceBlockForm = keyof typeof licenceForms;
/** The five forms of a licence block, in the order the guide lists them. */
export const LICENCE_FORMS = Object.keys(licenceForms) as readonly LicenceBlockForm[];

const licenceSchema = z.union([
  licenceForms.ask,
  licenceForms.stated,
  licenceForms.known,
  licenceForms.permission,
  licenceForms.blank,
]);

/** The form of a licence block: one of {@link LICENCE_FORMS}, `several` when it names more than one, or null when it names none. */
export function licenceFormOf(value: unknown): LicenceBlockForm | 'several' | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const named = (['ask', 'known', 'permission', 'blank'] as const).filter((key) =>
    Object.hasOwn(value, key),
  );
  if (named.length > 1) return 'several';
  const key = named[0];
  if (key === 'ask') return (value as { ask: unknown }).ask === false ? 'stated' : 'ask';
  return key ?? null;
}

// ---------------------------------------------------------------------------
// The layout of a wiki's or a guide's pages

/**
 * How a page's layout is kept (`layout.read`): as the browser shows it,
 * style sheets included (`seen`, from the notes of a page read in the
 * app's window or laid out by the app, see `ImportContext.layOut`); only as
 * its HTML states it (`stated`); or not at all, one column in reading order
 * (`off`). With `stated` and `off`, an importer asks the app to lay out no
 * page of the site and reads no notes on its pages.
 */
export const LAYOUT_READS = ['seen', 'stated', 'off'] as const;
export type LayoutRead = (typeof LAYOUT_READS)[number];
/** Blocks the browser does not show (`layout.hidden`): left out by the general rule, or all kept. */
export const LAYOUT_HIDDEN = ['leaveOut', 'keep'] as const;
/** Which pictures of a home page are kept (`layout.pictures`). */
export const LAYOUT_PICTURES = ['linked', 'all', 'none'] as const;
export type LayoutPictures = (typeof LAYOUT_PICTURES)[number];
/** How more than four blocks on one line are set (`layout.longLines`): in even lines, or in fours. */
export const LAYOUT_LONG_LINES = ['even', 'fours'] as const;
/** Selectors one list of the layout section holds at most; `leaveOut` holds more. */
export const MAX_LAYOUT_SELECTORS = 20;
export const MAX_LAYOUT_LEAVE_OUT = 40;

const layoutSelectors = (max: number) => once(selector, 'selector').min(1).max(max);
/** A size of words against the page's text, such as 1.2. */
const sizeOfText = z.number().min(1).max(4);

/**
 * The `layout` section of a wiki or guide part, and of a reader's
 * defaults: what one site needs said about the layout of its pages, and
 * the owner's choices for them. Every entry may be left out, and the
 * general rules then hold.
 */
const layoutSchema = z.strictObject({
  read: z.enum(LAYOUT_READS).optional(),
  cards: z
    .strictObject({
      select: selector.optional(),
      title: selector.optional(),
      framed: z.boolean().optional(),
      titleSize: sizeOfText.optional(),
    })
    .optional(),
  sideBySide: layoutSelectors(MAX_LAYOUT_SELECTORS).optional(),
  oneColumn: layoutSelectors(MAX_LAYOUT_SELECTORS).optional(),
  row: layoutSelectors(MAX_LAYOUT_SELECTORS).optional(),
  leaveOut: layoutSelectors(MAX_LAYOUT_LEAVE_OUT).optional(),
  hidden: z.union([z.enum(LAYOUT_HIDDEN), layoutSelectors(MAX_LAYOUT_SELECTORS)]).optional(),
  headings: z
    .strictObject({
      lines: z.boolean().optional(),
      size: sizeOfText.optional(),
      length: z.int().min(10).max(200).optional(),
    })
    .optional(),
  longLines: z.enum(LAYOUT_LONG_LINES).optional(),
  pictures: z.enum(LAYOUT_PICTURES).optional(),
  pageWidth: z.enum(PAGE_WIDTHS).optional(),
});

export type SiteLayout = z.infer<typeof layoutSchema>;

/** The problems of a layout section that its fields' forms alone do not show. */
function layoutProblems(layout: SiteLayout | undefined, at: Path): SiteRulesProblem[] {
  if (!layout) return [];
  const problems: SiteRulesProblem[] = [];
  const add = (path: Path, message: string) => {
    problems.push({ field: fieldPath([...at, ...path]), message });
  };
  if (layout.cards?.title !== undefined && layout.cards.select === undefined) {
    add(
      ['cards', 'title'],
      'is only for cards.select: the title is looked for inside the blocks it names',
    );
  }
  if (layout.headings?.lines === false) {
    for (const key of ['size', 'length'] as const) {
      if (layout.headings[key] !== undefined) {
        add(
          ['headings', key],
          'is only for lines made headings, which "lines": false switches off',
        );
      }
    }
  }
  if (layout.read === 'off') {
    for (const key of ['cards', 'sideBySide', 'oneColumn', 'row', 'longLines'] as const) {
      if (layout[key] !== undefined) {
        add(
          [key],
          'is never used with "read": "off", which keeps every page in one column; leave it out or choose another read',
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The menu (contents) of a wiki

/**
 * Where a wiki's menu (its contents) comes from (`menu.from`): the main
 * part of its home page and its side menu after it (`both`), or only one
 * of them.
 */
export const MENU_FROM = ['both', 'main', 'side'] as const;
export type MenuFrom = (typeof MENU_FROM)[number];
/** Headings one list of the menu section holds at most. */
export const MAX_MENU_HEADINGS = 40;

const menuHeadings = once(text(200), 'heading').min(1).max(MAX_MENU_HEADINGS);

/**
 * The `menu` section of a wiki or guide part, and of a reader's defaults:
 * where the wiki's menu comes from, and what is left out of it. Every
 * entry may be left out, and the general rules then hold: the side menu's
 * groups (a guide's own table of contents), without the groups about the
 * wiki itself. Atlas shows the site's own menu, and makes none by reading
 * pages.
 *
 * - `from`: `side` (the default), or with the headed blocks of the home
 *   page's main part before the side menu (`both`) or alone (`main`),
 *   without the blocks of news.
 * - `headings`: the elements of the home page's main part that are the
 *   titles of its blocks, where the page marks them with no heading of
 *   its own (a box's title): each is a heading of the home page's text,
 *   and starts a block of the menu where the main part gives one.
 * - `leaveOut`: blocks and groups left out, by their heading's words.
 * - `keep`: blocks and groups kept whatever the general rules say (a
 *   block of dated items that is no news), by their heading's words.
 */
const menuSchema = z.strictObject({
  from: z.enum(MENU_FROM).optional(),
  headings: selector.optional(),
  leaveOut: menuHeadings.optional(),
  keep: menuHeadings.optional(),
});

export type SiteMenu = z.infer<typeof menuSchema>;

/** The problems of a menu section that its fields' forms alone do not show. */
function menuProblems(menu: SiteMenu | undefined, at: Path): SiteRulesProblem[] {
  if (!menu) return [];
  const problems: SiteRulesProblem[] = [];
  const kept = new Set((menu.keep ?? []).map((words) => words.trim().toLowerCase()));
  (menu.leaveOut ?? []).forEach((words, i) => {
    if (kept.has(words.trim().toLowerCase())) {
      problems.push({
        field: fieldPath([...at, 'leaveOut', i]),
        message: `is also in "keep": a heading is either left out or kept`,
      });
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Links to a location of a map, in a wiki's or a guide's pages

/** Entries the `mapLinks` of one part hold at most. */
export const MAX_MAP_LINK_RULES = 10;

/**
 * Why `text` cannot be the address of an entry of `mapLinks`, or null: an
 * address pattern (see {@link patternProblem}) that may also hold `{id}`,
 * once, as a whole part of the path: the part that is the location's id.
 * Whether its `{game}` and `{guide}` are the part's own is checked with the
 * whole file.
 */
export function mapLinkRuleAddressProblem(text: string): string | null {
  const marked = text.split('/').filter((part) => /[{}]/u.test(part));
  if (marked.some((part) => !['{id}', '{game}', '{guide}'].includes(part))) {
    return "may hold { and } only as {id}, and as {game} and {guide} where the part's start holds them, each a whole part of the path between two /";
  }
  if (marked.filter((part) => part === MAP_LINK_ID_MARK).length > 1) {
    return 'holds {id} twice; the id is one part of the path';
  }
  return patternProblem(text.replaceAll(MAP_LINK_ID_MARK, 'id'));
}

/**
 * The `mapLinks` of a wiki or guide part: which links of its pages lead to
 * a location of a map and where the location's id is in them, as data.
 * The importer hands them to Atlas with the game (the manifest's
 * `mapLinks`), with `hosts` filled in from `site.hosts` where an entry has
 * none, and `{game}` and `{guide}` from the address of the game's pages.
 */
const mapLinkRuleSchema = z.strictObject({
  address: z.string().superRefine(checked(mapLinkRuleAddressProblem)),
  query: z
    .string()
    .regex(MAP_LINK_QUERY_PATTERN, 'must be the name of a parameter, such as spot')
    .optional(),
  hosts: once(host, 'host').min(1).max(5).optional(),
});

const mapLinkRulesSchema = z.array(mapLinkRuleSchema).min(1).max(MAX_MAP_LINK_RULES);

export type MapLinkRule = z.infer<typeof mapLinkRuleSchema>;

const aboutSchema = z.strictObject({
  by: text(120).optional(),
  on: date.optional(),
  checked: text(200).optional(),
});

// ---------------------------------------------------------------------------
// Parts

const partType = z.enum(['wiki', 'guide', 'map']);

/** The fields every part has, with the licence block as `licence` checks it. */
function commonFields<L extends z.ZodType>(licence: L) {
  return {
    type: partType,
    start: address,
    name: text(80).optional(),
    licence: licence.optional(),
    notes: text(2000).optional(),
  };
}

function builtInPartSchema<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    ...commonFields(licence),
    reader: builtInReader,
    start: address.optional(),
    reading: readingSchema.optional(),
    pictures: pictureHostsSchema.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
    layout: layoutSchema.optional(),
    menu: menuSchema.optional(),
    pagesInOrder: z.boolean().optional(),
    mapLinks: mapLinkRulesSchema.optional(),
    pack: z
      .string()
      .max(64)
      .regex(GAME_ID_PATTERN, 'must be a game id: lowercase letters, digits and dashes')
      .optional(),
  });
}

const pagesSchema = z.strictObject({
  include: z.array(pattern).min(1).max(20),
  exclude: z.array(pattern).max(50).optional(),
  query: once(
    z.string().regex(/^[A-Za-z0-9_.-]{1,50}$/u, 'must be the name of a parameter, such as page'),
    'parameter',
  )
    .max(20)
    .optional(),
});

const contentsSchema = z.strictObject({
  from: z.enum(['sitemap', 'menu', 'links']),
  address: address.optional(),
  links: selector.optional(),
  groups: selector.optional(),
  sections: selector.optional(),
  follow: z.boolean().optional(),
});

const articleSchema = z.strictObject({
  content: z.union([selector, z.array(selector).min(1).max(5)]),
  title: selector.optional(),
  titleEnd: text(120).optional(),
  remove: z.array(selector).max(40).optional(),
  path: selector.optional(),
  categories: selector.optional(),
  facts: selector.optional(),
  missing: selector.optional(),
  credit: selector.optional(),
  chapters: selector.optional(),
});

/** How the name of the game is read from a page, for a part whose `start` holds `{game}`. */
const gameNameSchema = z.strictObject({
  name: selector,
  nameEnd: text(120).optional(),
});

const orderSchema = z.strictObject({
  from: z.enum(['menu', 'sitemap', 'next']),
  next: selector.optional(),
});

function rulesFields<L extends z.ZodType>(licence: L) {
  return {
    ...commonFields(licence),
    reader: z.literal(RULES_READER),
    reading: readingSchema,
    pictures: rulesPicturesSchema.optional(),
    game: gameNameSchema.optional(),
  };
}

function rulesWikiPartSchema<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    ...rulesFields(licence),
    type: z.literal('wiki'),
    pages: pagesSchema,
    contents: contentsSchema,
    article: articleSchema,
    layout: layoutSchema.optional(),
    menu: menuSchema.optional(),
    pagesInOrder: z.boolean().optional(),
    mapLinks: mapLinkRulesSchema.optional(),
  });
}

function rulesGuidePartSchema<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    ...rulesFields(licence),
    type: z.literal('guide'),
    pages: pagesSchema,
    contents: contentsSchema,
    article: articleSchema,
    order: orderSchema,
    layout: layoutSchema.optional(),
    menu: menuSchema.optional(),
    pagesInOrder: z.boolean().optional(),
    mapLinks: mapLinkRulesSchema.optional(),
  });
}

/** A map's own id, as a file gives it for a site with one map: it stands for `{map}` in an address. */
export const MAP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u;
/**
 * The marks an address of a map's images may hold, in its path only:
 * `{shared}` stands for the id `maps.shared.id` reads, the same for every map.
 */
export const MAP_IMAGE_MARKS = ['{map}', '{shared}', '{z}', '{x}', '{y}', '{-y}'] as const;

/** A number of a map, as a data path in each entry or as a plain number for a site with one map. */
const pathOrInt = (max: number) => z.union([dataPath, z.int().min(0).max(max)]);
const pixels = z.int().min(1).max(10_000_000);

/**
 * The image sets of a map in its data (`maps.picture.sets`): where each set's
 * address pattern, zooms and bounds are, so that the address of a map's
 * images comes from the data and not from a fixed address in the file.
 */
const imageSetsSchema = z.strictObject({
  path: dataPath,
  map: dataPath.optional(),
  pattern: dataPath,
  extension: dataPath.optional(),
  minZoom: dataPath.optional(),
  maxZoom: dataPath,
  bounds: dataPath.optional(),
});

/**
 * Facts every map of the part shares, read from one object of the data
 * (`maps.shared`): an id the address of the images holds as `{shared}`,
 * and the size and zooms when the data gives them once, beside the list of
 * maps rather than in each entry.
 */
const sharedMapsSchema = z.strictObject({
  path: dataPath,
  id: dataPath.optional(),
  size: z.union([dataPath, z.tuple([dataPath, dataPath])]).optional(),
  maxZoom: dataPath.optional(),
  minZoom: dataPath.optional(),
});

/** The facts of a map `maps.shared` may give instead of `maps`: each in one of the two, never both. */
export const SHARED_MAP_FACTS = ['size', 'maxZoom', 'minZoom'] as const;

const mapsSchema = z.strictObject({
  path: dataPath.optional(),
  id: text(200),
  name: text(200),
  size: z.union([dataPath, z.tuple([pixels, pixels]), z.tuple([dataPath, dataPath])]).optional(),
  maxZoom: pathOrInt(24).optional(),
  minZoom: pathOrInt(24).optional(),
  shared: sharedMapsSchema.optional(),
  group: dataPath.optional(),
  floor: dataPath.optional(),
  picture: z.strictObject({
    image: address.optional(),
    images: address.optional(),
    sets: imageSetsSchema.optional(),
    base: address.optional(),
    tile: z.int().min(64).max(1024).optional(),
  }),
});

/** A value's name in `data.values`: what the part's other data paths begin with. */
export const PAGE_VALUE_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/u;
/** Values one `data.values` names at most. */
export const MAX_PAGE_VALUES = 12;

/**
 * One value of a map page that `data.values` names: a page path to a value
 * the page's scripts set on its window; a store, a value of the page that
 * has a `getState` function, with the data path inside what it gives; or an
 * element of the page whose text is JSON, with the data path inside it.
 * `getState` is the only function the reader ever calls, and only for the
 * value that names it.
 */
const pageValueSchema = z.union([
  pagePath,
  z.strictObject({ store: pagePath, path: storePath.optional() }),
  z.strictObject({ element: selector, path: storePath.optional() }),
]);

/** The forms of a value of `data.values`, by the field that names each. */
export const PAGE_VALUE_FORMS = ['store', 'element'] as const;

/** Type values one `types.found` list names at most. */
export const MAX_FOUND_TYPES = 200;

/**
 * Which types of location can be ticked as found: every type (`all`), none
 * (`none`), or exactly the types whose values are listed. Without it the
 * reader chooses from each type's name.
 */
const foundSchema = z.union([
  once(text(200), 'type').min(1).max(MAX_FOUND_TYPES),
  z.enum(['all', 'none']),
]);

const mapPartFields = {
  data: z.strictObject({
    from: z.enum(['file', 'page', 'values']),
    address: address.optional(),
    element: selector.optional(),
    values: z
      .record(
        z
          .string()
          .regex(
            PAGE_VALUE_NAME_PATTERN,
            'must be a name of letters and digits that begins with a small letter, such as board',
          ),
        pageValueSchema,
      )
      .optional(),
  }),
  /** For a map part whose start holds `{game}`: where the game's name is in the data. */
  game: z.strictObject({ name: dataPath }).optional(),
  maps: mapsSchema,
  types: z.strictObject({
    from: z.literal('locations').optional(),
    names: z.record(z.string().min(1).max(200), text(80)).optional(),
    path: dataPath.optional(),
    id: dataPath.optional(),
    name: dataPath.optional(),
    group: dataPath.optional(),
    icon: dataPath.optional(),
    order: dataPath.optional(),
    groups: z
      .strictObject({
        path: dataPath,
        id: dataPath,
        name: dataPath,
        order: dataPath.optional(),
      })
      .optional(),
    found: foundSchema.optional(),
  }),
  locations: z.strictObject({
    path: dataPath,
    markup: z.enum(['html', 'markdown']).optional(),
    pictures: z
      .strictObject({
        path: dataPath,
        address: dataPath,
        hidden: dataPath.optional(),
      })
      .optional(),
    fields: z.strictObject({
      id: dataPath.optional(),
      map: dataPath.optional(),
      type: dataPath,
      name: dataPath.optional(),
      x: dataPath,
      y: dataPath,
      description: dataPath.optional(),
      picture: dataPath.optional(),
      page: dataPath.optional(),
      count: dataPath.optional(),
      hidden: dataPath.optional(),
      icon: dataPath.optional(),
    }),
  }),
  position: z.strictObject({
    units: z.enum(['pixels', 'fraction', 'degrees']),
    origin: z.enum(['top-left', 'bottom-left']).optional(),
    zoom: z.int().min(0).max(24).optional(),
    area: z.enum(['world', 'located']).optional(),
  }),
};

function rulesMapPartSchema<L extends z.ZodType>(licence: L) {
  return z.strictObject({ ...rulesFields(licence), type: z.literal('map'), ...mapPartFields });
}

/**
 * The second form of a map part read by `rules` (`list`): a game whose maps
 * are whole pictures, each linked from a row of a list on one page (a
 * table, say), rather than a set of images and a list of locations. The
 * page at `start` is read once; the game's block is the element `block`
 * names around the game's anchor (the element whose `id`, or the link whose
 * `name`, is the fragment `{game}` of the address), each element `rows`
 * finds in it a map, and in each row `picture` finds the link to the
 * picture, `name` the map's name (or a group and a map, one name "Group:
 * Map"), `size` its size in pixels and `credit` who made it. Each picture
 * becomes one map of its own, with no locations, types or areas. All
 * selectors of a row are tried inside the row, those of the block inside
 * the block, each seeing only what that element holds; `system` is read
 * from the whole page.
 */
const pictureListSchema = z.strictObject({
  block: selector,
  rows: selector,
  picture: selector,
  name: z.union([selector, z.tuple([selector, selector])]),
  size: selector.optional(),
  credit: selector.optional(),
  notice: selector.optional(),
  system: z.union([text(80), gameNameSchema]).optional(),
});

export type PictureList = z.infer<typeof pictureListSchema>;

function rulesPictureMapPartSchema<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    ...rulesFields(licence),
    type: z.literal('map'),
    list: pictureListSchema,
  });
}

/** The forms of a part: by its reader, and for `rules` its type (and for a map, its form). */
type PartForm = 'builtIn' | 'wiki' | 'guide' | 'map' | 'pictures';

/** Which of the five forms of a part a value is meant to be: by its reader, and for `rules` its type. */
function partFormOf(value: unknown): PartForm {
  const record = (typeof value === 'object' && value !== null ? value : {}) as {
    reader?: unknown;
    type?: unknown;
  };
  const { reader: name, type } = record;
  if (name !== RULES_READER) return 'builtIn';
  if (type === 'map') return Object.hasOwn(record, 'list') ? 'pictures' : 'map';
  return type === 'guide' ? 'guide' : 'wiki';
}

function partSchemas<L extends z.ZodType>(licence: L) {
  return {
    builtIn: builtInPartSchema(licence),
    wiki: rulesWikiPartSchema(licence),
    guide: rulesGuidePartSchema(licence),
    map: rulesMapPartSchema(licence),
    pictures: rulesPictureMapPartSchema(licence),
  };
}

// ---------------------------------------------------------------------------
// Files

function siteSchemaWith<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    id: z
      .string()
      .regex(
        SITE_ID_PATTERN,
        'must be 3 to 40 of a-z, 0-9 and -, starting and ending with a letter or digit',
      ),
    name: text(80),
    game: text(80).optional(),
    hosts: once(host, 'host').min(1).max(5),
    notice: text(MAX_NOTICE_CHARS).optional(),
    licence: licence.optional(),
    about: aboutSchema.optional(),
  });
}

function siteFileSchemaWith<L extends z.ZodType, P extends z.ZodType>(licence: L, part: P) {
  return z.strictObject({
    format: z.literal(SITE_RULES_FORMAT),
    version: z.literal(SITE_RULES_VERSION),
    site: siteSchemaWith(licence),
    parts: z.array(part).min(1).max(MAX_SITE_PARTS),
    notes: text(2000).optional(),
  });
}

function readerDefaultsFileSchemaWith<L extends z.ZodType>(licence: L) {
  return z.strictObject({
    format: z.literal(SITE_RULES_FORMAT),
    version: z.literal(SITE_RULES_VERSION),
    readerDefaults: z.strictObject({
      reader: builtInReader,
      reading: readingDefaultsSchema,
      notice: text(MAX_NOTICE_CHARS).optional(),
      pictures: pictureHostsSchema.optional(),
      licence: licence.optional(),
      layout: layoutSchema.optional(),
      menu: menuSchema.optional(),
      pagesInOrder: z.boolean().optional(),
    }),
    notes: text(2000).optional(),
  });
}

/** A refusal: a site that is not read at all, by a domain and every host under it. */
const refusalFileSchema = z.strictObject({
  format: z.literal(SITE_RULES_FORMAT),
  version: z.literal(SITE_RULES_VERSION),
  refusal: z.strictObject({
    id: z
      .string()
      .regex(
        SITE_ID_PATTERN,
        'must be 3 to 40 of a-z, 0-9 and -, starting and ending with a letter or digit',
      ),
    name: text(80),
    domains: once(host, 'domain').min(1).max(10),
    notice: text(MAX_NOTICE_CHARS),
  }),
  notes: text(2000).optional(),
});

const fullParts = partSchemas(licenceSchema);
const partSchema = z.union([
  fullParts.builtIn,
  fullParts.wiki,
  fullParts.guide,
  fullParts.map,
  fullParts.pictures,
]);

/** A site file, as the JSON Schema describes it. */
export const siteFileSchema = siteFileSchemaWith(licenceSchema, partSchema);
/** A reader's defaults file, as the JSON Schema describes it. */
export const readerDefaultsFileSchema = readerDefaultsFileSchemaWith(licenceSchema);
/** A refusal file, as the JSON Schema describes it. */
export { refusalFileSchema };
/** Any shape of a site rules file: the schema `atlas-site-rules.schema.json` is made from. */
export const siteRulesSchema = z.union([
  siteFileSchema,
  readerDefaultsFileSchema,
  refusalFileSchema,
]);

export type SiteRulesLicence = z.infer<typeof licenceSchema>;
export type SiteReading = z.infer<typeof readingSchema>;
export type BuiltInPart = z.infer<typeof fullParts.builtIn>;
export type RulesWikiPart = z.infer<typeof fullParts.wiki>;
export type RulesGuidePart = z.infer<typeof fullParts.guide>;
export type RulesMapPart = z.infer<typeof fullParts.map>;
/** A map part read by `rules` whose maps are whole pictures listed on a page (`list`). */
export type RulesPictureMapPart = z.infer<typeof fullParts.pictures>;
export type SitePart = z.infer<typeof partSchema>;
export type SiteFile = z.infer<typeof siteFileSchema>;
export type ReaderDefaultsFile = z.infer<typeof readerDefaultsFileSchema>;
export type ReaderDefaults = ReaderDefaultsFile['readerDefaults'];
export type RefusalFile = z.infer<typeof refusalFileSchema>;
export type SiteRefusal = RefusalFile['refusal'];
/** A site rules file of any shape, checked. */
export type SiteRules = SiteFile | ReaderDefaultsFile | RefusalFile;

/** Whether a checked file is a reader's defaults. */
export const isReaderDefaults = (rules: SiteRules): rules is ReaderDefaultsFile =>
  'readerDefaults' in rules;

/** Whether a checked file is a refusal. */
export const isRefusal = (rules: SiteRules): rules is RefusalFile => 'refusal' in rules;

/** Whether a checked file describes a site (`site` and `parts`). */
export const isSiteFile = (rules: SiteRules): rules is SiteFile => 'site' in rules;

/**
 * Whether a refusal's domain covers `host` (lower case, with or without
 * `www.`): the domain itself and every host under it. The one place where
 * a whole domain is matched; reading always names exact hosts.
 */
export function refusalCovers(refusal: SiteRefusal, host: string): boolean {
  const name = host.toLowerCase().replace(/^www\./u, '');
  return refusal.domains.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/** Whether a part is read by `rules`, the general reader. */
export const readByRules = (
  part: SitePart,
): part is RulesWikiPart | RulesGuidePart | RulesMapPart | RulesPictureMapPart =>
  part.reader === RULES_READER;

/** Whether a part is a map part read by `rules` whose maps are whole pictures listed on a page. */
export const isPictureMapPart = (part: SitePart): part is RulesPictureMapPart =>
  part.reader === RULES_READER && part.type === 'map' && 'list' in part;

/** Whether a part is a map part read by `rules` from its data (`data`, `maps`, `locations`…). */
export const isDataMapPart = (part: SitePart): part is RulesMapPart =>
  part.reader === RULES_READER && part.type === 'map' && 'data' in part;

/**
 * The JSON Schema of the format, made from the schemas here: what
 * `site-rules/atlas-site-rules.schema.json` holds (a test keeps the two the
 * same). Checks that need the whole file (addresses on the site's hosts,
 * fields one part form needs) and the wording of problems are the
 * checker's; the schema tells any other checker the fields and their forms.
 */
export function siteRulesJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(siteRulesSchema, { target: 'draft-2020-12', io: 'input' });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'atlas-site-rules.schema.json',
    title: 'Atlas site rules file',
    description:
      'One site (site and parts), the defaults of one reader (readerDefaults) or a site that is not read (refusal), format version 1. See atlas-site-rules.md.',
    ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$schema')),
  };
}

// ---------------------------------------------------------------------------
// Checking a file, with problems in plain words

/** One thing wrong with a file: the field, and what is wrong with it. */
export interface SiteRulesProblem {
  /** The field, as a path such as `parts[0].reading.ways`; empty for the whole file. */
  field: string;
  /** What is wrong, in plain words, without the field's name. */
  message: string;
}

export type SiteRulesCheck =
  { ok: true; rules: SiteRules } | { ok: false; problems: SiteRulesProblem[] };

type Path = readonly PropertyKey[];

/** A field's path as text: `parts[0].reading.ways`. */
export function fieldPath(path: Path): string {
  return path
    .map((key, index) =>
      typeof key === 'number' ? `[${key}]` : `${index === 0 ? '' : '.'}${String(key)}`,
    )
    .join('');
}

/**
 * A field's path in words for the person: `Part 1, reading.ways`,
 * `site.hosts, entry 2`, or "The file" for the whole file.
 */
export function fieldInWords(field: string): string {
  if (field === '') return 'The file';
  const part = /^parts\[(\d+)\](?:\.(.*))?$/u.exec(field);
  const words = (rest: string) =>
    rest.replace(/\[(\d+)\]/gu, (_, n: string) => `, entry ${Number(n) + 1}`);
  if (part) {
    const number = Number(part[1]) + 1;
    return part[2] ? `Part ${number}, ${words(part[2])}` : `Part ${number}`;
  }
  return words(field);
}

/** A problem as one sentence for the person. */
export function problemText(problem: SiteRulesProblem): string {
  const sentence = problem.message.charAt(0).toUpperCase() + problem.message.slice(1);
  const end = /[.!?]$/u.test(sentence) ? '' : '.';
  if (problem.field === '') return `${sentence}${end}`;
  return `${fieldInWords(problem.field)}: ${problem.message}${end}`;
}

/** Fields of other part forms, with the parts they belong to, for a clearer problem. */
const FIELDS_ELSEWHERE: Record<string, string> = {
  pages: 'a wiki or guide part read by rules',
  contents: 'a wiki or guide part read by rules',
  article: 'a wiki or guide part read by rules',
  order: 'a guide part read by rules',
  data: 'a map part read by rules from its data',
  maps: 'a map part read by rules from its data',
  types: 'a map part read by rules from its data',
  locations: 'a map part read by rules from its data',
  position: 'a map part read by rules from its data',
  list: 'a map part read by rules whose maps are pictures listed on a page',
  options: 'a part with a built-in reader',
  pack: 'a part with a built-in reader',
  layout: 'a wiki or guide part',
  menu: 'a wiki or guide part',
  pagesInOrder: 'a wiki or guide part',
  mapLinks: 'a wiki or guide part',
};

const describeValue = (value: unknown): string =>
  value === undefined
    ? 'nothing'
    : value === null
      ? 'null'
      : Array.isArray(value)
        ? 'a list'
        : typeof value === 'object'
          ? 'an object'
          : typeof value === 'string'
            ? 'text'
            : typeof value;

const EXPECTED: Record<string, string> = {
  string: 'text',
  number: 'a number',
  int: 'a whole number',
  boolean: 'true or false',
  array: 'a list',
  tuple: 'a list',
  object: 'an object',
  record: 'an object',
};

/** What a missing field needs, by the end of its path, where more than "it is needed" helps. */
const MISSING_WORDS: Record<string, string> = {
  'reading.permission.from':
    'is missing: a permission names who gave it, in your own words, such as the editors of the site',
  'reading.permission.on':
    'is missing: a permission names the day it was given, written as YYYY-MM-DD, such as 2026-11-16',
  'reading.permission.allows':
    'is missing: a permission names the beginnings of the addresses it covers, such as /archive/',
};

/** Why a reader's defaults hold no permission. */
const PERMISSION_IN_DEFAULTS =
  'is only for a site file of your own: a permission is given by one site, so the defaults of a reader cannot hold one';

/**
 * Fields of several forms, by the end of their path, with those forms in
 * words: said whole for a value that is not a list. A list is checked
 * entry by entry, as any list is.
 */
const FORMS_IN_WORDS: Record<string, string> = {
  'types.found': '"all", "none" or a list of type values',
  'layout.hidden': '"leaveOut", "keep" or a list of selectors',
};

/** One zod issue as problems in plain words, with the path it is under. */
function problemsOf(issue: z.core.$ZodIssue, at: Path, part: boolean): SiteRulesProblem[] {
  const path = [...at, ...issue.path];
  const field = fieldPath(path);
  const problem = (message: string, where = field): SiteRulesProblem => ({
    field: where,
    message,
  });
  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined) {
        const said = Object.entries(MISSING_WORDS).find(([end]) => field.endsWith(end))?.[1];
        return [problem(said ?? 'is missing, and it is needed')];
      }
      const expected = EXPECTED[issue.expected] ?? issue.expected;
      return [problem(`must be ${expected}, not ${describeValue(issue.input)}`)];
    }
    case 'unrecognized_keys':
      return issue.keys.map((key) => {
        const elsewhere = part ? FIELDS_ELSEWHERE[key] : undefined;
        const permission = key === 'permission' && path.at(-1) === 'reading' && !part;
        return problem(
          permission
            ? PERMISSION_IN_DEFAULTS
            : elsewhere
              ? `is a field of ${elsewhere}, not of this part`
              : 'is not a field of this format; a file holds only the fields the guide names',
          fieldPath([...path, key]),
        );
      });
    case 'too_small': {
      const n = Number(issue.minimum);
      if (issue.origin === 'string') {
        return [problem(n <= 1 ? 'must not be empty' : `must be at least ${n} characters`)];
      }
      if (issue.origin === 'array' || issue.origin === 'set') {
        return [problem(`must hold at least ${n} ${n === 1 ? 'entry' : 'entries'}`)];
      }
      return [problem(`must be at least ${n}`)];
    }
    case 'too_big': {
      const n = Number(issue.maximum);
      if (issue.origin === 'string') return [problem(`must be at most ${n} characters`)];
      if (issue.origin === 'array' || issue.origin === 'set') {
        return [problem(`must hold at most ${n} ${n === 1 ? 'entry' : 'entries'}`)];
      }
      return [problem(`must be at most ${n}`)];
    }
    case 'invalid_value': {
      const values = issue.values.map((value) => JSON.stringify(value));
      return [
        problem(
          values.length === 1
            ? `must be ${values[0]!}`
            : `must be one of ${values.slice(0, -1).join(', ')} or ${values.at(-1)!}`,
        ),
      ];
    }
    case 'invalid_union': {
      if (issue.input === undefined) return [problem('is missing, and it is needed')];
      const forms = Object.entries(FORMS_IN_WORDS).find(([end]) => field.endsWith(end))?.[1];
      if (forms && !Array.isArray(issue.input)) {
        const given =
          typeof issue.input === 'string'
            ? JSON.stringify(issue.input.slice(0, 40))
            : describeValue(issue.input);
        return [problem(`must be ${forms}, not ${given}`)];
      }
      // A value that fits none of the forms: the form of its first branch that fits its type.
      const branch = issue.errors.find((errors) =>
        errors.every((error) => error.code !== 'invalid_type' || error.path.length > 0),
      );
      return branch
        ? branch.flatMap((inner) => problemsOf(inner, path, part))
        : [problem(`is not in a form this field takes (${describeValue(issue.input)})`)];
    }
    default:
      return [problem(issue.message)];
  }
}

/** The problems of `value` against `schema`, under `at`; the parsed value when there are none. */
function checkAgainst<T>(
  schema: z.ZodType<T>,
  value: unknown,
  at: Path,
  part = false,
): { value: T; problems: [] } | { value: null; problems: SiteRulesProblem[] } {
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return { value: result.data, problems: [] };
  return { value: null, problems: result.error.issues.flatMap((i) => problemsOf(i, at, part)) };
}

const looseParts = partSchemas(z.unknown());
const looseSiteFile = siteFileSchemaWith(z.unknown(), z.unknown());
const looseReaderDefaults = readerDefaultsFileSchemaWith(z.unknown());

/** The problems of a licence block, by its form. */
function licenceProblems(value: unknown, at: Path, inRulesPart: boolean): SiteRulesProblem[] {
  if (value === undefined) return [];
  const form = licenceFormOf(value);
  if (form === 'several') {
    return [
      {
        field: fieldPath(at),
        message:
          'holds more than one form; a licence block has exactly one of ask, known, permission or blank',
      },
    ];
  }
  if (form === null) {
    return [
      {
        field: fieldPath(at),
        message:
          'must be one of the forms of a licence block: { "ask": true }, { "ask": false }, { "known": "…" }, { "permission": "…" } or { "blank": true }',
      },
    ];
  }
  const problems: SiteRulesProblem[] = [
    ...checkAgainst(licenceForms[form] as z.ZodType, value, at).problems,
  ];
  if (
    !inRulesPart &&
    form === 'ask' &&
    Object.hasOwn(value as object, 'stated') &&
    problems.length === 0
  ) {
    problems.push({
      field: fieldPath([...at, 'stated']),
      message: 'is only for a part read by rules, which looks for the licence a page states',
    });
  }
  return problems;
}

/** The host of an address, without `www.`, when it is a full `https://` address; null otherwise. */
function hostOfAddress(text: string): string | null {
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    return url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/** Why an address of a file is not usable, or null: a path from `/`, or a full address on `hosts`. */
export function addressProblem(text: string, hosts: readonly string[]): string | null {
  if (/\s|\\/u.test(text)) return 'must be an address without spaces or backslashes';
  if (text.startsWith('/')) {
    return text.startsWith('//') ? 'must begin with a single / or with https://' : null;
  }
  if (!text.startsWith('https://')) {
    return 'must be a full https:// address, or a path that begins with /';
  }
  const at = hostOfAddress(text);
  if (at === null) return 'must be a full https:// address without a name, password or port';
  return hosts.includes(at)
    ? null
    : `is on ${at}, which is not one of the hosts this field may use (${hosts.join(', ')})`;
}

/**
 * Why the address of a map's images is not one, or null: on `hosts`, with
 * `{z}`, `{x}` and one of `{y}` and `{-y}` in its path, `{map}` there when
 * it is needed, no other mark, and nothing marked in its query.
 */
export function mapImagesProblem(text: string, hosts: readonly string[]): string | null {
  const wrong = addressProblem(text, hosts);
  if (wrong) return wrong;
  const cut = text.search(/[?#]/u);
  const path = cut < 0 ? text : text.slice(0, cut);
  const rest = cut < 0 ? '' : text.slice(cut);
  if (/[{}]/u.test(rest)) {
    return 'may hold its marks in its path only: what follows ? is sent as it is written';
  }
  const marks: string[] = path.match(/\{[^{}]*\}/gu) ?? [];
  const other = marks.find((mark) => !(MAP_IMAGE_MARKS as readonly string[]).includes(mark));
  if (other || /[{}]/u.test(path.replace(/\{[^{}]*\}/gu, ''))) {
    return `may hold only the marks ${MAP_IMAGE_MARKS.join(', ')}${other ? `, not ${other}` : ''}`;
  }
  const rows = marks.filter((mark) => mark === '{y}' || mark === '{-y}').length;
  if (!marks.includes('{z}') || !marks.includes('{x}') || rows !== 1) {
    return 'must hold {z}, {x} and either {y} or {-y} (rows counted from the bottom)';
  }
  return null;
}

/** Whether a data path has `[*]`: it names every entry of a list, not one value. */
const namesEvery = (path: string | undefined): boolean =>
  path !== undefined && (dataPathSteps(path) ?? []).some((step) => 'every' in step);

/**
 * The data paths of a map part read from its data's top, by field: those a
 * part with `"from": "values"` must begin with a name of `data.values`.
 */
export function mapTopPaths(part: RulesMapPart): { field: string[]; path: string }[] {
  const found: { field: string[]; path: string }[] = [];
  const add = (field: string[], path: string | undefined) => {
    if (path !== undefined) found.push({ field, path });
  };
  add(['game', 'name'], part.game?.name);
  add(['maps', 'path'], part.maps.path);
  add(['maps', 'shared', 'path'], part.maps.shared?.path);
  add(['maps', 'picture', 'sets', 'path'], part.maps.picture.sets?.path);
  add(['types', 'path'], part.types.path);
  add(['types', 'groups', 'path'], part.types.groups?.path);
  add(['locations', 'path'], part.locations.path);
  return found;
}

/** The problems of a map part read by `rules` that its fields' forms alone do not show. */
function mapPartProblems(
  part: RulesMapPart,
  at: Path,
  hosts: readonly string[],
): SiteRulesProblem[] {
  const problems: SiteRulesProblem[] = [];
  const add = (path: Path, message: string | null) => {
    if (message) problems.push({ field: fieldPath([...at, ...path]), message });
  };
  const pictureHosts = [...hosts, ...(part.pictures?.hosts ?? [])];
  const { data, maps, types, locations, position } = part;
  if (data.from === 'file') {
    if (data.address === undefined) add(['data', 'address'], 'is needed with "from": "file"');
    else {
      add(
        ['data', 'address'],
        addressProblem(data.address, hosts) ??
          (/[{}]/u.test(data.address) ? 'must be one address, without { or }' : null),
      );
    }
    if (data.element !== undefined) add(['data', 'element'], 'is only for "from": "page"');
  } else if (data.from === 'page') {
    if (data.element === undefined) add(['data', 'element'], 'is needed with "from": "page"');
    if (data.address !== undefined) add(['data', 'address'], 'is only for "from": "file"');
  } else {
    for (const key of ['address', 'element'] as const) {
      if (data[key] !== undefined) {
        add(['data', key], `is only for "from": "${key === 'address' ? 'file' : 'page'}"`);
      }
    }
    const names = Object.keys(data.values ?? {});
    if (names.length === 0) add(['data', 'values'], 'is needed with "from": "values"');
    if (names.length > MAX_PAGE_VALUES) {
      add(['data', 'values'], `must name at most ${MAX_PAGE_VALUES} values`);
    }
    for (const { field, path } of mapTopPaths(part)) {
      const first = dataPathSteps(path)?.[0];
      const name = first && 'field' in first ? first.field : null;
      if (name === null || !names.includes(name)) {
        add(
          field,
          `must begin with the name of one of data.values (${names.join(', ') || 'none named'}): the data of a map read in the window is those values, by their names`,
        );
      }
    }
    const read = new Set(
      mapTopPaths(part).map(({ path }) => {
        const first = dataPathSteps(path)?.[0];
        return first && 'field' in first ? first.field : '';
      }),
    );
    for (const name of names) {
      if (!read.has(name)) {
        add(
          ['data', 'values', name],
          'is named by no data path of the part: the reader takes only the values the part reads, so leave it out',
        );
      }
    }
    const left = part.reading.ways.filter((way) => way !== 'window');
    if (left.length > 0) {
      add(
        ['reading', 'ways'],
        `may offer only "window" with "from": "values": the values of a map page are there only once the page's scripts have run in the app's window, so ${left.map((way) => JSON.stringify(way)).join(' and ')} cannot read them`,
      );
    }
  }
  if (data.from !== 'values' && data.values !== undefined) {
    add(['data', 'values'], 'is only for "from": "values"');
  }
  const picture = maps.picture;
  const forms = [picture.image, picture.images, picture.sets].filter((f) => f !== undefined);
  if (forms.length !== 1) {
    add(['maps', 'picture'], 'must hold exactly one of image, images and sets');
  }
  if (picture.image !== undefined) {
    add(
      ['maps', 'picture', 'image'],
      addressProblem(picture.image, pictureHosts) ??
        (/[{}]/u.test(picture.image) ? 'must be one address, without { or }' : null),
    );
    if (picture.tile !== undefined && picture.images === undefined && picture.sets === undefined) {
      add(['maps', 'picture', 'tile'], 'is only for images and sets');
    }
  }
  if (picture.images !== undefined) {
    add(['maps', 'picture', 'images'], mapImagesProblem(picture.images, pictureHosts));
  }
  if (picture.images !== undefined || picture.sets !== undefined) {
    if (picture.tile === undefined)
      add(['maps', 'picture', 'tile'], 'is needed with images and sets');
    else if ((picture.tile & (picture.tile - 1)) !== 0) {
      add(['maps', 'picture', 'tile'], 'must be a power of two, such as 256 or 512');
    }
  }
  if (picture.base !== undefined) {
    if (picture.sets === undefined) add(['maps', 'picture', 'base'], 'is only for sets');
    else {
      add(
        ['maps', 'picture', 'base'],
        addressProblem(picture.base, pictureHosts) ??
          (/[{}?#]/u.test(picture.base)
            ? 'must be one address, without {, }, ? or #: the pattern of each set is written after it'
            : picture.base.endsWith('/')
              ? null
              : 'must end with /: the pattern of each set is written after it'),
      );
    }
  }
  const sets = picture.sets;
  const shared = maps.shared;
  const severalMaps = namesEvery(maps.path);
  if (sets !== undefined) {
    if (sets.map === undefined && severalMaps) {
      add(
        ['maps', 'picture', 'sets', 'map'],
        'is needed when maps.path names several maps: it says which map each set is of',
      );
    }
    for (const key of ['maxZoom', 'minZoom'] as const) {
      if (maps[key] !== undefined) {
        add(['maps', key], 'comes from picture.sets: leave it out, and name it in sets');
      }
      if (shared?.[key] !== undefined) {
        add(['maps', 'shared', key], 'comes from picture.sets: leave it out, and name it in sets');
      }
    }
  } else if (maps.maxZoom === undefined && shared?.maxZoom === undefined) {
    add(['maps', 'maxZoom'], 'is needed, unless picture.sets names the zooms of each set');
  }
  const located = position.area === 'located';
  if (located && maps.size !== undefined) {
    add(['maps', 'size'], 'is worked out from the locations with "area": "located": leave it out');
  }
  if (located && shared?.size !== undefined) {
    add(
      ['maps', 'shared', 'size'],
      'is worked out from the locations with "area": "located": leave it out',
    );
  }
  if (!located && maps.size === undefined && shared?.size === undefined) {
    add(['maps', 'size'], 'is needed, unless position.area is "located"');
  }
  if (shared !== undefined) {
    if (shared.id === undefined && SHARED_MAP_FACTS.every((key) => shared[key] === undefined)) {
      add(['maps', 'shared'], 'must name at least one of id, size, maxZoom and minZoom');
    }
    if (namesEvery(shared.path)) {
      add(
        ['maps', 'shared', 'path'],
        'must name one object of the data, the same for every map, not every entry of a list: write it without [*]',
      );
    }
    for (const key of SHARED_MAP_FACTS) {
      if (shared[key] !== undefined && maps[key] !== undefined) {
        add(
          ['maps', 'shared', key],
          `is given in maps.${key} as well: give it in one of the two places only`,
        );
      }
    }
  }
  const sharedMark = picture.images?.includes('{shared}') === true;
  if (sharedMark && shared?.id === undefined) {
    add(
      ['maps', 'picture', 'images'],
      'holds {shared}, which stands for the id maps.shared.id reads: name that id, or leave {shared} out',
    );
  }
  if (shared?.id !== undefined && !sharedMark) {
    add(
      ['maps', 'shared', 'id'],
      'is only for an address of images (picture.images) that holds {shared}, which it stands for',
    );
  }
  const oneMap = maps.path === undefined;
  if (oneMap) {
    add(
      ['maps', 'id'],
      MAP_ID_PATTERN.test(maps.id)
        ? null
        : "must be the map's id when maps has no path: letters, digits, _, . and -",
    );
    if (maps.size !== undefined && typeof maps.size[0] !== 'number') {
      add(['maps', 'size'], 'must be [width, height] in pixels when maps has no path');
    }
    if (typeof maps.maxZoom === 'string') {
      add(['maps', 'maxZoom'], 'must be a number when maps has no path');
    }
    if (typeof maps.minZoom === 'string') {
      add(['maps', 'minZoom'], 'must be a number when maps has no path');
    }
    for (const key of ['group', 'floor'] as const) {
      if (maps[key] !== undefined) add(['maps', key], 'is only for maps with a path');
    }
  } else {
    for (const key of ['id', 'name'] as const) {
      add(['maps', key], dataPathProblem(maps[key]));
    }
    if (severalMaps && locations.fields.map === undefined) {
      add(['locations', 'fields', 'map'], 'is needed when maps.path names several maps');
    }
    if (maps.floor !== undefined && maps.group === undefined) {
      add(['maps', 'floor'], 'is only for maps with a group');
    }
  }
  if (
    typeof maps.minZoom === 'number' &&
    typeof maps.maxZoom === 'number' &&
    maps.minZoom > maps.maxZoom
  ) {
    add(['maps', 'minZoom'], 'must not be above maxZoom');
  }
  const fromLocations = types.from === 'locations';
  if (fromLocations === (types.path !== undefined)) {
    add(['types'], 'must hold either "from": "locations" or path, not both and not neither');
  } else if (fromLocations) {
    for (const key of ['id', 'name', 'group', 'icon', 'order', 'groups'] as const) {
      if (types[key] !== undefined) add(['types', key], 'is only for types with a path');
    }
  } else {
    if (types.names !== undefined) add(['types', 'names'], 'is only for "from": "locations"');
    if (types.id === undefined) add(['types', 'id'], 'is needed with a path');
    if (types.name === undefined) add(['types', 'name'], 'is needed with a path');
    if (types.groups !== undefined && types.group === undefined) {
      add(['types', 'group'], 'is needed with groups: it is the id of the group of each type');
    }
  }
  if (position.units === 'degrees' && position.origin !== undefined) {
    add(
      ['position', 'origin'],
      'is only for pixels and fraction: degrees are longitude and latitude',
    );
  }
  if (position.units !== 'pixels' && position.zoom !== undefined) {
    add(['position', 'zoom'], 'is only for "units": "pixels"');
  }
  if (position.units !== 'degrees' && position.area !== undefined) {
    add(['position', 'area'], 'is only for "units": "degrees"');
  }
  if (located && picture.image !== undefined) {
    add(['position', 'area'], 'is only for a picture of images, by images or sets');
  }
  return problems;
}

/**
 * The problems of a map part of pictures listed on a page (`list`) that
 * its fields' forms alone do not show: it is read by the app by itself,
 * the list page and then each picture, and a fixed name of the system is
 * for a part whose start does not hold `{system}`.
 */
function pictureMapProblems(part: RulesPictureMapPart, at: Path): SiteRulesProblem[] {
  const problems: SiteRulesProblem[] = [];
  const add = (path: Path, message: string) => {
    problems.push({ field: fieldPath([...at, ...path]), message });
  };
  const left = part.reading.ways.filter((way) => way !== 'fetch');
  if (left.length > 0) {
    add(
      ['reading', 'ways'],
      `may offer only "fetch" for a map part of pictures listed on a page: the app reads the list page and then each picture by itself, so ${left.map((way) => JSON.stringify(way)).join(' and ')} cannot read it`,
    );
  }
  const system = part.list.system;
  if (typeof system === 'string' && piecesOf(part.start).pieces.includes('system')) {
    add(
      ['list', 'system'],
      'is one name for every system, and the start holds {system}: read the name from the page with { "name": "<selector>" }, or leave it out to use the words of {system}',
    );
  }
  return problems;
}

/**
 * The problems of the `mapLinks` of a part that their fields' forms alone
 * do not show: each entry names where the id is in exactly one way, and
 * holds only the named pieces the part's start holds.
 */
function mapLinkProblems(
  rules: readonly MapLinkRule[],
  at: Path,
  onlyStartPieces: (path: Path, text: string) => void,
): SiteRulesProblem[] {
  const problems: SiteRulesProblem[] = [];
  rules.forEach((rule, index) => {
    const marked = hasIdMark(rule.address);
    if (marked && rule.query !== undefined) {
      problems.push({
        field: fieldPath([...at, index, 'query']),
        message: 'is not needed: address holds {id}, so the id is a part of the path',
      });
    } else if (!marked && rule.query === undefined) {
      problems.push({
        field: fieldPath([...at, index]),
        message:
          'must say where the id is: query for a parameter of the address, or {id} in address for a part of its path',
      });
    }
    onlyStartPieces([...at, index, 'address'], rule.address);
  });
  return problems;
}

/**
 * The problems of a part's `reading` that its fields' forms alone do not
 * show: an entry of `permission.allows` that overlaps an entry of
 * `keepOff`, where the one covers an address the other covers too. The
 * app never opens a kept-off address on its own, whatever a permission
 * says, so such an entry says two things of one address.
 */
function readingProblems(reading: SiteReading | undefined, at: Path): SiteRulesProblem[] {
  const keepOff = reading?.keepOff ?? [];
  const allows = reading?.permission?.allows ?? [];
  const problems: SiteRulesProblem[] = [];
  allows.forEach((allowed, index) => {
    const kept = keepOff.find((entry) => beginningsOverlap(entry, allowed));
    if (kept !== undefined) {
      problems.push({
        field: fieldPath([...at, 'permission', 'allows', index]),
        message: `overlaps ${JSON.stringify(kept)} of keepOff: this app never opens an address it is kept off on its own, whatever a permission says, so leave the address out of one of the two lists`,
      });
    }
  });
  return problems;
}

/** The problems of a whole site file that its fields' forms alone do not show. */
function siteFileProblems(file: SiteFile): SiteRulesProblem[] {
  const problems: SiteRulesProblem[] = [];
  const hosts = file.site.hosts;
  const add = (path: Path, message: string | null) => {
    if (message) problems.push({ field: fieldPath(path), message });
  };
  const startPieces = (part: SitePart) =>
    part.start === undefined ? [] : piecesOf(part.start).pieces;
  const rulesParts = file.parts.filter(readByRules);
  if (rulesParts.some((part) => !startPieces(part).includes('game')) && !file.site.game) {
    add(['site', 'game'], 'is missing; it is needed when a part is read by rules');
  }
  if (rulesParts.some((part) => startPieces(part).includes('game')) && file.site.game) {
    add(
      ['site', 'game'],
      'must be left out when the start of a part holds {game}: the game is then found from each address',
    );
  }
  file.parts.forEach((part, index) => {
    const at = ['parts', index] as const;
    problems.push(...readingProblems(part.reading, [...at, 'reading']));
    if (part.start !== undefined) {
      const pieces = piecesOf(part.start);
      add([...at, 'start'], pieces.problem ?? addressProblem(part.start, hosts));
      const listed = isPictureMapPart(part);
      if (pieces.pieces.length > 0 && !readByRules(part)) {
        add([...at, 'start'], 'may hold {game}, {guide} and {map} only in a part read by rules');
      } else if (listed && (pieces.pieces.includes('guide') || pieces.pieces.includes('map'))) {
        add(
          [...at, 'start'],
          'may hold {system} and {game} in a map part of pictures listed on a page, not {guide} or {map}',
        );
      } else if (!listed && pieces.pieces.includes('system')) {
        add([...at, 'start'], 'may hold {system} only in a map part of pictures listed on a page');
      } else if (part.type === 'map' && pieces.pieces.includes('guide')) {
        add([...at, 'start'], 'may hold {game} and {map} in a map part, not {guide}');
      } else if (part.type !== 'map' && pieces.pieces.includes('map')) {
        add([...at, 'start'], 'may hold {game} and {guide} in a wiki or guide part, not {map}');
      }
      const hash = part.start.indexOf('#');
      const fragment = hash < 0 ? '' : part.start.slice(hash);
      if (/[{}]/u.test(fragment)) {
        add(
          [...at, 'start'],
          !listed
            ? 'may hold a piece after # only in a map part of pictures listed on a page'
            : fragment !== '#{game}'
              ? 'may hold after # only #{game}, the anchor of the game on the list page'
              : null,
        );
      }
    }
    if (part.type !== 'map') {
      problems.push(...layoutProblems(part.layout, [...at, 'layout']));
      problems.push(...menuProblems('menu' in part ? part.menu : undefined, [...at, 'menu']));
    } else {
      if (!readByRules(part) && part.layout !== undefined) {
        add([...at, 'layout'], 'is only for a wiki or guide part');
      }
      if ('menu' in part && part.menu !== undefined) {
        add([...at, 'menu'], 'is only for a wiki or guide part');
      }
      if ('pagesInOrder' in part && part.pagesInOrder !== undefined) {
        add([...at, 'pagesInOrder'], 'is only for a wiki or guide part');
      }
    }
    const pieces = startPieces(part);
    const onlyStartPieces = (path: Path, text: string) => {
      for (const piece of piecesOf(text.replaceAll(MAP_LINK_ID_MARK, 'id')).pieces) {
        if (!pieces.includes(piece)) {
          add(path, `holds {${piece}}, which the part's start does not hold`);
        }
      }
    };
    if ('mapLinks' in part && part.mapLinks !== undefined) {
      if (part.type === 'map') add([...at, 'mapLinks'], 'is only for a wiki or guide part');
      problems.push(...mapLinkProblems(part.mapLinks, [...at, 'mapLinks'], onlyStartPieces));
    }
    if (!readByRules(part)) return;
    if (part.game !== undefined && !pieces.includes('game')) {
      add([...at, 'game'], 'is only for a part whose start holds {game}');
    }
    const pictures = part.pictures;
    if (pictures?.full === 'attribute' && pictures.fullAttribute === undefined) {
      add([...at, 'pictures', 'fullAttribute'], 'is needed with "full": "attribute"');
    }
    if (pictures?.full !== 'attribute' && pictures?.fullAttribute !== undefined) {
      add([...at, 'pictures', 'fullAttribute'], 'is only for "full": "attribute"');
    }
    if (isPictureMapPart(part)) {
      problems.push(...pictureMapProblems(part, at));
      return;
    }
    if (part.type === 'map') {
      problems.push(...mapPartProblems(part, at, hosts));
      return;
    }
    const { contents, pages, article } = part;
    pages.include.forEach((pattern, n) => {
      onlyStartPieces([...at, 'pages', 'include', n], pattern);
    });
    (pages.exclude ?? []).forEach((pattern, n) => {
      onlyStartPieces([...at, 'pages', 'exclude', n], pattern);
    });
    if (contents.address !== undefined) {
      const found = piecesOf(contents.address);
      add([...at, 'contents', 'address'], found.problem ?? addressProblem(contents.address, hosts));
      onlyStartPieces([...at, 'contents', 'address'], contents.address);
    }
    if (contents.from !== 'menu' && contents.groups !== undefined) {
      add([...at, 'contents', 'groups'], 'is only for "from": "menu"');
    }
    if (part.type !== 'guide' && article.chapters !== undefined) {
      add([...at, 'article', 'chapters'], 'is only for a guide part');
    }
    if (contents.from === 'menu' && contents.links === undefined) {
      add([...at, 'contents', 'links'], 'is needed with "from": "menu"');
    }
    if (contents.from !== 'menu' && contents.links !== undefined) {
      add([...at, 'contents', 'links'], 'is only for "from": "menu"');
    }
    if (part.type === 'guide') {
      if (part.order.from === 'next' && part.order.next === undefined) {
        add([...at, 'order', 'next'], 'is needed with "from": "next"');
      }
      if (part.order.from !== 'next' && part.order.next !== undefined) {
        add([...at, 'order', 'next'], 'is only for "from": "next"');
      }
    }
  });
  return problems;
}

/** The problems of a file whose format and version are not this app's, or null. */
function formatProblem(value: Record<string, unknown>): SiteRulesProblem | null {
  if (value.format !== SITE_RULES_FORMAT) {
    return {
      field: 'format',
      message: `must be "${SITE_RULES_FORMAT}": without it this is not an Atlas site rules file`,
    };
  }
  if (value.version !== SITE_RULES_VERSION) {
    return {
      field: 'version',
      message:
        typeof value.version === 'number'
          ? `is ${value.version}, and this app reads version ${SITE_RULES_VERSION} of the format only`
          : `must be the number ${SITE_RULES_VERSION}`,
    };
  }
  return null;
}

/**
 * Checks a value as a site rules file, strictly: its shape (either a site
 * file or a reader's defaults), every field's form, the licence block's
 * form, and what only the whole file shows (addresses on the site's hosts,
 * the fields one form of a part needs). The checked file, or every problem
 * found (at most {@link MAX_SITE_RULES_PROBLEMS}), each naming its field in
 * plain words. Never throws.
 */
export function checkSiteRules(value: unknown): SiteRulesCheck {
  const fail = (problems: SiteRulesProblem[]): SiteRulesCheck => ({
    ok: false,
    problems: problems.slice(0, MAX_SITE_RULES_PROBLEMS),
  });
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail([{ field: '', message: 'must be one JSON object, written between { and }' }]);
  }
  const record = value as Record<string, unknown>;
  const wrongFormat = formatProblem(record);
  if (wrongFormat) return fail([wrongFormat]);

  if (Object.hasOwn(record, 'refusal')) {
    const full = checkAgainst(refusalFileSchema, value, []);
    return full.value ? { ok: true, rules: full.value } : fail(full.problems);
  }

  if (Object.hasOwn(record, 'readerDefaults')) {
    const shape = checkAgainst(looseReaderDefaults, value, []);
    const problems = [
      ...shape.problems,
      ...licenceProblems(
        (record.readerDefaults as { licence?: unknown } | null)?.licence,
        ['readerDefaults', 'licence'],
        false,
      ),
    ];
    if (problems.length > 0) return fail(problems);
    const full = checkAgainst(readerDefaultsFileSchema, value, []);
    if (!full.value) return fail(full.problems);
    const whole = [
      ...layoutProblems(full.value.readerDefaults.layout, ['readerDefaults', 'layout']),
      ...menuProblems(full.value.readerDefaults.menu, ['readerDefaults', 'menu']),
    ];
    return whole.length > 0 ? fail(whole) : { ok: true, rules: full.value };
  }

  const shape = checkAgainst(looseSiteFile, value, []);
  const problems: SiteRulesProblem[] = [...shape.problems];
  const site = record.site as { licence?: unknown } | null | undefined;
  if (typeof site === 'object' && site !== null) {
    problems.push(...licenceProblems(site.licence, ['site', 'licence'], false));
  }
  if (Array.isArray(record.parts)) {
    (record.parts as unknown[]).slice(0, MAX_SITE_PARTS).forEach((part, index) => {
      const form = partFormOf(part);
      const type = (part as { type?: unknown } | null)?.type;
      if (form !== 'builtIn' && !partType.safeParse(type).success) {
        // A part read by rules whose type is none of the three: its fields depend on it.
        problems.push(...checkAgainst(partType, type, ['parts', index, 'type']).problems);
        return;
      }
      problems.push(
        ...checkAgainst(looseParts[form] as z.ZodType, part, ['parts', index], true).problems,
      );
      const licence = (part as { licence?: unknown } | null)?.licence;
      problems.push(...licenceProblems(licence, ['parts', index, 'licence'], form !== 'builtIn'));
    });
  }
  if (problems.length > 0) return fail(problems);
  const full = checkAgainst(siteFileSchema, value, []);
  if (!full.value) return fail(full.problems);
  const whole = siteFileProblems(full.value);
  return whole.length > 0 ? fail(whole) : { ok: true, rules: full.value };
}

/**
 * The problems of a file an importer comes with (a shipped file) besides
 * those of {@link checkSiteRules}: a shipped file carries no permission
 * (`reading.permission`), which only a file of the person's records. The
 * app checks every shipped file so, and reads by none that has a problem.
 */
export function shippedFileProblems(rules: SiteRules): SiteRulesProblem[] {
  if (!isSiteFile(rules)) return [];
  return rules.parts.flatMap((part, index) =>
    part.reading?.permission
      ? [
          {
            field: `parts[${index}].reading.permission`,
            message:
              'is in a shipped file, and no shipped file carries a permission: only a file of your own records one',
          },
        ]
      : [],
  );
}

/** Checks a shipped file: {@link checkSiteRules}, then {@link shippedFileProblems}. */
export function checkShippedSiteRules(value: unknown): SiteRulesCheck {
  const checked = checkSiteRules(value);
  if (!checked.ok) return checked;
  const problems = shippedFileProblems(checked.rules);
  return problems.length > 0 ? { ok: false, problems } : checked;
}

/** A position in a text as "line L, column C", for a JSON syntax problem. */
function lineAndColumn(text: string, index: number): string {
  const before = text.slice(0, index).split('\n');
  return `line ${before.length}, column ${before.at(-1)!.length + 1}`;
}

/**
 * Reads the text of a site rules file and checks it ({@link checkSiteRules}):
 * at most {@link MAX_SITE_RULES_BYTES} as UTF-8, plain JSON (a byte order
 * mark at its start is allowed). A text that is not JSON gets one problem
 * that says where it stops being JSON, when the parser says.
 */
export function parseSiteRules(text: string): SiteRulesCheck {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_SITE_RULES_BYTES) {
    return {
      ok: false,
      problems: [
        {
          field: '',
          message: `is ${Math.ceil(bytes / 1024)} KB, and a site rules file may be at most ${MAX_SITE_RULES_BYTES / 1024} KB`,
        },
      ],
    };
  }
  const body = text.replace(/^\uFEFF/u, '');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (error) {
    const at = /position (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
    return {
      ok: false,
      problems: [
        {
          field: '',
          message: `is not plain JSON${at ? ` (it stops being JSON at ${lineAndColumn(body, Number(at))})` : ''}: no comments, no commas after the last entry, and every name in double quotation marks`,
        },
      ],
    };
  }
  return checkSiteRules(value);
}

// ---------------------------------------------------------------------------
// What a checked file names

/**
 * The key a file is known by: `site:<id>` for a site file, `reader:<name>`
 * for a reader's defaults. A file of the person's with the key of one that
 * comes with an importer takes that file's place.
 */
export const siteRulesKey = (rules: SiteRules): string =>
  isReaderDefaults(rules)
    ? `reader:${rules.readerDefaults.reader}`
    : isRefusal(rules)
      ? `refused:${rules.refusal.id}`
      : `site:${rules.site.id}`;

/**
 * The name a file is kept under: `<site id>.atlas-site.json`,
 * `<reader>.reader.atlas-site.json` or `<id>.refused.atlas-site.json`.
 */
export const siteRulesFileName = (rules: SiteRules): string =>
  isReaderDefaults(rules)
    ? `${rules.readerDefaults.reader}${READER_DEFAULTS_SUFFIX}`
    : isRefusal(rules)
      ? `${rules.refusal.id}${REFUSAL_SUFFIX}`
      : `${rules.site.id}${SITE_RULES_SUFFIX}`;

/** Whether `name` is the name of a site rules file as the app keeps one. */
export const isSiteRulesFileName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9](?:\.reader|\.refused)?\.atlas-site\.json$/u.test(name);

/** The licence block that counts for a part: its own, else the site's. */
export const partLicence = (file: SiteFile, part: SitePart): SiteRulesLicence | undefined =>
  part.licence ?? file.site.licence;

/**
 * Every host a file names, each once, in the order it names them: the
 * site's hosts, then the hosts of pictures. The person sees these before
 * a file of theirs is switched on.
 */
export function siteRulesHosts(rules: SiteRules): string[] {
  const hosts = isReaderDefaults(rules)
    ? (rules.readerDefaults.pictures?.hosts ?? [])
    : isRefusal(rules)
      ? rules.refusal.domains
      : [...rules.site.hosts, ...rules.parts.flatMap((part) => part.pictures?.hosts ?? [])];
  return [...new Set(hosts)];
}

/**
 * The licence answer a file's licence block gives, as an importer hands it
 * to the app (`SiteInfo.rulesLicence`): a known licence with its deed,
 * words filled in, or none recorded. Null for `ask` (the page's licence,
 * else the person is asked) and `{ "ask": false }` (the page's licence
 * only), which answer nothing for the site.
 */
export function rulesLicenceOfBlock(block: SiteRulesLicence | undefined): RulesLicence | null {
  if (!block) return null;
  if ('known' in block) {
    const known = CONFIRMABLE_LICENCES.find((licence) => licence.name === block.known);
    return known ? rulesLicenceOf({ basis: 'confirmed', name: known.name, url: known.url }) : null;
  }
  if ('permission' in block) {
    return rulesLicenceOf({
      basis: 'permission',
      name: block.permission,
      ...(block.address ? { url: block.address } : {}),
      ...(block.from ? { givenBy: block.from } : {}),
      ...(block.on ? { givenOn: block.on } : {}),
      ...(block.note ? { note: block.note } : {}),
    });
  }
  if ('blank' in block) return rulesLicenceOf({ basis: 'none' });
  return null;
}

// ---------------------------------------------------------------------------
// What a file of the person's widens in its reading section

/** Entries of a list in words: "/a", "/a or /b", "/a, /b or /c", the rest counted after a few. */
function beginningsInWords(entries: readonly string[]): string {
  const shown = entries.slice(0, 5);
  const more = entries.length - shown.length;
  const words = more > 0 ? [...shown, `${more} more`] : shown;
  return words.length < 2
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)!}`;
}

/**
 * The widening of a list of addresses kept off (`reading.keepOff`) against
 * the list of a shipped file: the entries of `shipped` that `kept` no
 * longer covers (it covers an entry when one of its own begins it), so
 * that this app would open such addresses on its own. Null when it keeps
 * every one. `what` says for which sites, such as "wiki.example.org".
 */
export function keptOffWidening(
  field: string,
  kept: readonly string[] | undefined,
  shipped: readonly string[] | undefined,
  file: string,
  what: string,
): SiteRulesWidening | null {
  const lost = (shipped ?? []).filter((entry) => !addressBegins(kept ?? [], entry));
  if (lost.length === 0) return null;
  return {
    field,
    message: `lets this app open addresses that begin with ${beginningsInWords(lost)} on its own for ${what}, which the shipped file “${file}” keeps it off`,
  };
}

/**
 * The widening a recorded permission (`reading.permission`) makes: who
 * gave it, when, and which addresses it lets this app read by itself
 * where the site's `robots.txt` does not allow them.
 */
export function permissionWidening(field: string, permission: SitePermission): SiteRulesWidening {
  return {
    field,
    message: `records a permission from ${permission.from}, given on ${permission.on}, for this app to read addresses that begin with ${beginningsInWords(permission.allows)} by itself, even where the site’s robots.txt does not allow them`,
  };
}

/** The list a part keeps the app off: its own, else its reader's defaults' among `files`. */
function keptOffOf(part: SitePart, files: readonly SiteRules[]): readonly string[] | undefined {
  if (part.reading?.keepOff !== undefined) return part.reading.keepOff;
  if (readByRules(part)) return undefined;
  return files.find(
    (rules): rules is ReaderDefaultsFile =>
      isReaderDefaults(rules) && rules.readerDefaults.reader === part.reader,
  )?.readerDefaults.reading.keepOff;
}

/**
 * What a file of the person's widens in its `reading` sections against the
 * files an importer comes with (`shipped`), whatever its readers: every
 * permission it records (with who gave it, when, and the addresses), and
 * each address a shipped file keeps this app off that it no longer does.
 * A reader's defaults are compared with the shipped defaults of the same
 * reader; a part of a site file with the part of the same reader of a
 * shipped site file of the same id or of one of its hosts, else (for a
 * built-in reader) with that reader's shipped defaults. A part that names
 * no list of its own keeps its reader's. The app shows these with what
 * the importer says (`ImporterSites.widens`); an importer may say more,
 * such as for a part read by `rules` on a host one of its readers reads.
 */
export function readingWidenings(
  rules: SiteRules,
  shipped: readonly { name: string; rules: SiteRules }[],
): SiteRulesWidening[] {
  const files = shipped.map((file) => file.rules);
  const defaultsFile = (reader: string) =>
    shipped.find(
      (file) => isReaderDefaults(file.rules) && file.rules.readerDefaults.reader === reader,
    );
  if (isReaderDefaults(rules)) {
    const reader = rules.readerDefaults.reader;
    const base = defaultsFile(reader);
    if (!base || !isReaderDefaults(base.rules)) return [];
    const kept = rules.readerDefaults.reading.keepOff;
    const found = keptOffWidening(
      kept === undefined ? 'readerDefaults.reading' : 'readerDefaults.reading.keepOff',
      kept,
      base.rules.readerDefaults.reading.keepOff,
      base.name,
      `every site the reader “${reader}” reads`,
    );
    return found ? [found] : [];
  }
  if (!isSiteFile(rules)) return [];
  const sameSite = shipped.filter(
    (file) =>
      isSiteFile(file.rules) &&
      (file.rules.site.id === rules.site.id ||
        file.rules.site.hosts.some((host) => rules.site.hosts.includes(host))),
  );
  const out: SiteRulesWidening[] = [];
  rules.parts.forEach((part, index) => {
    const at = `parts[${index}]`;
    const permission = part.reading?.permission;
    if (permission) out.push(permissionWidening(`${at}.reading.permission`, permission));
    const field =
      part.reading?.keepOff !== undefined
        ? `${at}.reading.keepOff`
        : part.reading
          ? `${at}.reading`
          : at;
    const kept = keptOffOf(part, files);
    const what = rules.site.hosts.join(', ');
    let compared = false;
    for (const file of sameSite) {
      if (!isSiteFile(file.rules)) continue;
      const like =
        file.rules.parts.find((p) => p.reader === part.reader && p.type === part.type) ??
        file.rules.parts.find((p) => p.reader === part.reader);
      if (!like) continue;
      compared = true;
      const found = keptOffWidening(field, kept, keptOffOf(like, files), file.name, what);
      if (found) out.push(found);
    }
    if (compared || readByRules(part)) return;
    const base = defaultsFile(part.reader);
    if (!base || !isReaderDefaults(base.rules)) return;
    const found = keptOffWidening(
      field,
      kept,
      base.rules.readerDefaults.reading.keepOff,
      base.name,
      what,
    );
    if (found) out.push(found);
  });
  return out;
}
