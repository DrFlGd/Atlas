import { z } from 'zod';

/**
 * Links to a location of a map in a game's pages (the manifest's
 * `mapLinks`): which web links in the text of the game's pages name a
 * location of a map by the id its site gives the location, and where that
 * id is in the link. A site rules file states them for a wiki or guide part
 * (its `mapLinks`, see `atlas-site-rules.md` in `@atlas/importer-api`), and
 * an importer writes them into the pack it builds, with their hosts.
 *
 * The text of a page keeps such a link as the web link it is, so nothing
 * is lost where no map is at hand. When a page is shown, the app looks up
 * a link that fits an entry among the locations of the game and of the
 * games shown under one title with it (see `mapLinks.ts` in `@atlas/core`):
 * a link that finds its location is shown as a link inside the app, and
 * one that finds none stays the web link.
 *
 * Each entry has:
 *
 * - `hosts`: the hosts such links are on, lower case, without `www.` (the
 *   same host with `www.` counts too);
 * - `address`: the path of such a link, an address pattern as a site rules
 *   file writes one (`*` for any run of characters without `/`, `**` for
 *   any run with them), in which `{id}` may stand for the one part of the
 *   path, between two `/`, that is the location's id;
 * - `query`: the parameter after `?` whose value is the location's id, for
 *   an address without `{id}`.
 *
 * An entry names the id in exactly one of the two ways.
 */

/** The mark that stands for the part of a link's path that is the location's id. */
export const MAP_LINK_ID_MARK = '{id}';
/** Entries a manifest's `mapLinks` holds at most. */
export const MAX_MAP_LINKS = 20;
/** Hosts one entry names at most. */
export const MAX_MAP_LINK_HOSTS = 10;
/** The longest address pattern of an entry. */
export const MAX_MAP_LINK_ADDRESS = 300;

/** A host as an entry names it: lower case, at least two labels, no `www.` before it. */
const HOST =
  /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** The name of a parameter after `?`. */
export const MAP_LINK_QUERY_PATTERN = /^[A-Za-z0-9_.-]{1,50}$/u;

/**
 * Why `text` cannot be the address of an entry of `mapLinks`, or null: a
 * path from `/`, at most {@link MAX_MAP_LINK_ADDRESS} characters, with no
 * `?`, `#`, space or backslash, no run of three `*`, and `{` and `}` only
 * as `{id}`, once, as a whole part of the path.
 */
export function mapLinkAddressProblem(text: string): string | null {
  if (!text.startsWith('/')) return 'must begin with /';
  if (text.length > MAX_MAP_LINK_ADDRESS) {
    return `must be at most ${MAX_MAP_LINK_ADDRESS} characters`;
  }
  if (/[?#\s\\]/u.test(text)) return 'must be a path only, without ?, #, spaces or backslashes';
  if (text.includes('***')) return 'may hold * or **, but not three * in a row';
  const marked = text.split('/').filter((part) => /[{}]/u.test(part));
  if (marked.some((part) => part !== MAP_LINK_ID_MARK)) {
    return 'may hold { and } only as {id}, a whole part of the path between two /';
  }
  if (marked.length > 1) return 'holds {id} twice; the id is one part of the path';
  return null;
}

/** Whether an entry's address holds {@link MAP_LINK_ID_MARK}. */
export const hasIdMark = (address: string): boolean =>
  address.split('/').includes(MAP_LINK_ID_MARK);

/**
 * The schema of one entry: strict when a pack is written, tolerant when
 * it is read (unknown fields are dropped), and in both an entry must name
 * the id in exactly one way.
 */
export function mapLinkEntrySchema(reading: boolean) {
  const shape = {
    hosts: z
      .array(
        z
          .string()
          .regex(HOST, 'must be a host name in lower case')
          .refine((host) => !host.startsWith('www.'), 'must be written without www.'),
      )
      .min(1)
      .max(MAX_MAP_LINK_HOSTS),
    address: z.string().superRefine((text, ctx) => {
      const problem = mapLinkAddressProblem(text);
      if (problem) ctx.addIssue({ code: 'custom', message: problem, input: text });
    }),
    query: z
      .string()
      .regex(MAP_LINK_QUERY_PATTERN, 'must be the name of a parameter, such as spot')
      .optional(),
  };
  const entry = reading ? z.object(shape) : z.strictObject(shape);
  return entry.refine((link) => hasIdMark(link.address) !== (link.query !== undefined), {
    message: 'must name where the id is in exactly one way: {id} in address, or query',
  });
}

/** One entry of a manifest's `mapLinks`. */
export type MapLink = z.infer<ReturnType<typeof mapLinkEntrySchema>>;

/** The manifest's `mapLinks` as a pack is written: 1 to {@link MAX_MAP_LINKS} entries. */
export const mapLinksWriteSchema = z.array(mapLinkEntrySchema(false)).min(1).max(MAX_MAP_LINKS);

/**
 * The manifest's `mapLinks` as a pack is read: an entry that cannot be
 * read is left out, and a value that is no list reads as none.
 */
export const mapLinksReadSchema = z
  .array(z.unknown())
  .transform((list) =>
    list.slice(0, MAX_MAP_LINKS).flatMap((value) => {
      const link = mapLinkEntrySchema(true).safeParse(value);
      return link.success ? [link.data] : [];
    }),
  )
  .optional()
  .catch(undefined) as unknown as z.ZodOptional<typeof mapLinksWriteSchema>;
