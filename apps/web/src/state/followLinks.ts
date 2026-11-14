import { canAddPage, pageKey, refusalFor, type AtlasImporter } from '@atlas/importer-api';

/**
 * Following links during a go: when a page of a wiki is read and its
 * importer gives the pages it links to (`links` of the outcome), the go
 * can read those pages too. The person chooses how far, per importer, where
 * they start reading pages; the choice is kept with the wiki's notes
 * (`wikiNotes.ts`). Nothing here talks to the shell: `importing.ts` adds the
 * pages this module picks to the go that is running, which reads them one
 * at a time with the pause, as any other page of the go.
 *
 * Links are only followed inside a go the person started, and only to
 * pages of the same importer that are not left out, not read before, not
 * in the go already (so a page that could not be read is not tried again).
 * A go has no page limit: "And every page those lead to" goes on until no
 * new page is found or the person stops it. Pages found and not reached
 * stay listed on the wiki's screen as "Found on <page>, not read".
 */

/** How far a go follows links: not at all, one step from the pages ticked, or as far as they lead. */
export type FollowLinks = 'ticked' | 'linked' | 'all';

export const DEFAULT_FOLLOW: FollowLinks = 'linked';

/** The choice, in the order shown, with what each does. */
export const FOLLOW_CHOICES: readonly { id: FollowLinks; label: string; sentence: string }[] = [
  {
    id: 'ticked',
    label: 'Only the pages ticked',
    sentence:
      'Reads the pages you ticked and nothing else. The pages they link to are listed here afterwards, to tick.',
  },
  {
    id: 'linked',
    label: 'And the pages they link to',
    sentence:
      'Also reads the wiki’s pages that the ticked pages link to, in the same session, but not the pages those link to.',
  },
  {
    id: 'all',
    label: 'And every page those lead to',
    sentence:
      'Keeps following the links of every page read, until no new page is found or you stop the session.',
  },
];

export const isFollowLinks = (value: unknown): value is FollowLinks =>
  value === 'ticked' || value === 'linked' || value === 'all';

/** The page keys of the addresses pages asked under other names were read from. */
const arrivedKeys = (otherNames: Readonly<Record<string, string>>) =>
  new Set(Object.values(otherNames).map(pageKey));

/** Whether the links of a page read at `depth` (0 for a page ticked) are followed. */
export function followsFrom(follow: FollowLinks, depth: number): boolean {
  return follow === 'all' || (follow === 'linked' && depth === 0);
}

/**
 * The pages a go adds when a page it read at `depth` links to `links`:
 * each a page the importer reads and does not refuse, not left out, not
 * read before and not in the go already, each once, in the order linked.
 */
export function pagesToFollow(options: {
  follow: FollowLinks;
  depth: number;
  links: readonly string[];
  importer: Pick<AtlasImporter, 'matches' | 'refuses'>;
  /** Page keys of every page of the go, read or still to read. */
  inGo: ReadonlySet<string>;
  /** Page keys of the pages read before (in the game). */
  read: ReadonlySet<string>;
  leftOut: ReadonlySet<string>;
  /**
   * Other names of pages read (`wikiNotes.ts`): the page key asked, with
   * the address the page was read from. A link to either name of a page
   * read is to a page read.
   */
  otherNames?: Readonly<Record<string, string>>;
}): { add: string[] } {
  const { importer, inGo, read, leftOut, otherNames = {} } = options;
  if (!followsFrom(options.follow, options.depth)) return { add: [] };
  const seen = new Set<string>();
  const add: string[] = [];
  let arrived: Set<string> | undefined;
  for (const url of options.links) {
    const key = pageKey(url);
    // Another name of a page read, or the name a page asked under another was read from.
    if (otherNames[key] !== undefined || (arrived ??= arrivedKeys(otherNames)).has(key)) continue;
    if (seen.has(key) || inGo.has(key) || read.has(key) || leftOut.has(key)) continue;
    seen.add(key);
    if (!canAddPage(importer, url) || refusalFor([importer], url) !== null) continue;
    add.push(url);
  }
  return { add };
}
