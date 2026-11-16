import {
  SITE_ID_PATTERN,
  hostProblem,
  isReaderDefaults,
  isRefusal,
  readByRules,
  type SiteRules,
} from '@atlas/importer-api';

/**
 * "Start from a copy of …" in the rules file editor: a new file made from
 * any file the Sites screen lists, a shipped file or one of the person's,
 * for another site. The copy gets the new site's id, name and host where
 * the format holds them, so it never has the id of the file it was copied
 * from unless the person gives it that id. A reader's defaults, which
 * count for every site the reader reads, become a site file for the one
 * site. Pure: nothing is read or kept here.
 */

/** What the person gives for the new site. */
export interface NewSite {
  /** The site's name, as Atlas shows it. */
  name: string;
  /** The site's host, such as wiki.example.org. */
  host: string;
  /** The file's id: its key and the name it is saved under. */
  id: string;
  /** The game's name, if the person gives one. */
  game?: string;
}

/** What a file reads and how, in one plain sentence, for the list of files to copy. */
export function readsInWords(rules: SiteRules): string {
  if (isRefusal(rules)) {
    return `It names ${listOf(rules.refusal.domains)} as sites that are not read at all.`;
  }
  if (isReaderDefaults(rules)) {
    return `It holds the settings of the reader “${rules.readerDefaults.reader}” for every site that reader reads. A copy is a file for one site.`;
  }
  const hosts = listOf(rules.site.hosts);
  const parts = rules.parts.map((part) => {
    const type = part.type === 'map' ? 'a map' : part.type === 'guide' ? 'a guide' : 'a wiki';
    return readByRules(part)
      ? `${type} read by the selectors it gives (the reader “rules”)`
      : `${type} read by the reader “${part.reader}”`;
  });
  return `It reads ${listOf(parts)} on ${hosts}.`;
}

/** A list of words in one sentence: "a, b and c". */
const listOf = (items: readonly string[]) =>
  items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/**
 * An id for a site, from its name: lower case letters, digits and dashes,
 * 3 to 40 of them, as the format allows. Empty when the name gives none.
 */
export function idFromName(name: string): string {
  const id = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 40)
    .replace(/-+$/u, '');
  if (!id) return '';
  return id.length >= 3 ? id : `${id}-site`;
}

/** Why `id` cannot be a file's id, in a sentence; null when it can. */
export function idProblem(id: string): string | null {
  return SITE_ID_PATTERN.test(id)
    ? null
    : 'The id must be 3 to 40 lower case letters, digits and dashes, starting and ending with a letter or digit.';
}

/**
 * The host of what the person typed: a host, or an address on it (its
 * `https://`, path and `www.` taken away). The reason in a sentence when
 * it gives none.
 */
export function hostOf(text: string): { host: string } | { problem: string } {
  let typed = text.trim().toLowerCase();
  if (!typed) return { problem: 'Give the site’s address or host, such as wiki.example.org.' };
  if (/^[a-z]+:\/\//u.test(typed)) {
    try {
      typed = new URL(typed).hostname;
    } catch {
      return { problem: 'That is not an address. Give one such as https://wiki.example.org/.' };
    }
  }
  typed = typed.replace(/\/.*$/u, '').replace(/^www\./u, '');
  const why = hostProblem(typed);
  return why ? { problem: `The host ${why}.` } : { host: typed };
}

/** The host of a full https address, or null. */
function hostOfAddress(text: string): string | null {
  if (!/^https:\/\//iu.test(text)) return null;
  try {
    return new URL(text).hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
}

/**
 * A value with every full address on one of `hosts` moved to `host`, and
 * every host name in it that is one of `hosts` made `host`: the copy reads
 * the new site where the file read the old one.
 */
function moved(value: unknown, hosts: ReadonlySet<string>, host: string): unknown {
  if (typeof value === 'string') {
    if (hosts.has(value)) return host;
    const on = hostOfAddress(value);
    if (on && hosts.has(on)) {
      const url = new URL(value);
      url.hostname = host;
      return url.href;
    }
    return value;
  }
  if (Array.isArray(value)) return [...new Set(value.map((item) => moved(item, hosts, host)))];
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, moved(item, hosts, host)]),
    );
  }
  return value;
}

/** The notes of a copy: where it came from, and what to do next. */
const copyNotes = (from: string) =>
  `Started from a copy of ${from}. Try it on pages saved from the site, and change what the site does differently.`;

/**
 * A copy of `rules` for another site, as the JSON value of a new file.
 * `from` is the name of the file it is copied from, for its notes;
 * `partType` is the type of part a reader's pages are (a wiki, else).
 *
 * - A site file keeps its parts, with each address and host of the old
 *   site moved to the new host; its `about` (who checked it, and when)
 *   and its notice (what it says of the old site) are left out, a part's
 *   pack of the old id takes the new id, and a pack of another id is left
 *   out, as it names a game of the old site.
 * - A reader's defaults become a site file for the one site, with one part
 *   of that reader holding the defaults' settings.
 * - A refusal names the new host in place of its domains.
 */
export function copyForSite(
  rules: SiteRules,
  site: NewSite,
  from: string,
  partType: (reader: string) => 'wiki' | 'guide' | 'map' = () => 'wiki',
): Record<string, unknown> {
  const game = site.game?.trim();
  const head = { format: rules.format, version: rules.version };
  if (isRefusal(rules)) {
    return {
      ...head,
      refusal: { ...rules.refusal, id: site.id, name: site.name, domains: [site.host] },
      notes: copyNotes(from),
    };
  }
  if (isReaderDefaults(rules)) {
    const { reader, reading, notice, pictures, licence, layout } = rules.readerDefaults;
    return {
      ...head,
      site: {
        id: site.id,
        name: site.name,
        ...(game ? { game } : {}),
        hosts: [site.host],
        ...(notice ? { notice } : {}),
      },
      parts: [
        {
          type: partType(reader),
          reader,
          start: '/',
          reading,
          ...(pictures ? { pictures } : {}),
          ...(licence ? { licence } : {}),
          ...(layout ? { layout } : {}),
        },
      ],
      notes: copyNotes(from),
    };
  }
  const oldHosts = new Set(rules.site.hosts.map((host) => host.replace(/^www\./u, '')));
  const { about: _about, notice: _notice, game: _game, ...kept } = rules.site;
  const parts = rules.parts.map((part) => {
    const { pack, ...rest } = moved(part, oldHosts, site.host) as Record<string, unknown>;
    // A pack of the old site's id is the new site's; another pack is the old site's own game.
    return pack === rules.site.id ? { ...rest, pack: site.id } : rest;
  });
  return {
    ...head,
    site: {
      ...kept,
      id: site.id,
      name: site.name,
      ...(game ? { game } : {}),
      hosts: [site.host],
    },
    parts,
    notes: copyNotes(from),
  };
}
