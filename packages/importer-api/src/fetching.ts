/**
 * Reading pages without opening them: for an importer whose site offers
 * its text to programs (an API, a feed, plain pages), the app fetches the
 * addresses the importer names itself, and the importer never sees a
 * browser. This is the polite way to read many pages of a site:
 *
 * - The app asks only when the person asked for the pages, one page at a
 *   time, with a pause between requests ({@link FETCH_PAUSE_MS}) and
 *   between pages. A go reads the pages the person ticked (a section, or
 *   a whole wiki), and the pages they link to when the person chose that,
 *   with no page limit: the person watches the count and stops it.
 * - Every request names the app (`Atlas/<version>`) and carries no cookies
 *   and no sign-in; the app never pretends to be a browser.
 * - The site's `robots.txt` is read first, once per site in a go, and an
 *   address it does not allow for `Atlas` is never asked for.
 * - An answer that refuses (see {@link refusalOf}) stops the whole go at
 *   once: nothing is tried again or around it. An importer that sees a
 *   page asking to confirm the reader is a person does the same, with a
 *   failure that has `stop: true`.
 *
 * Only an app that downloads map images can fetch pages; an importer that
 * reads this way fails plainly in one that cannot.
 */

/** Addresses one page may need at most. */
export const MAX_PAGE_FETCHES = 4;
/** The pause before each request after the first, and between pages. */
export const FETCH_PAUSE_MS = 2000;
/** Text longer than this is cut off by the app. */
export const MAX_FETCHED_CHARS = 8 * 1024 * 1024;
/** The product token robots.txt rules are matched against. */
export const ROBOTS_AGENT = 'Atlas';

/** How an importer has its pages fetched. */
export interface PageFetch {
  /**
   * The addresses to fetch for the page at `url`, in order: the page
   * itself, or the site's API for it. At most {@link MAX_PAGE_FETCHES}, each
   * a web address on the same site. An empty list means the importer cannot
   * read that page. Must not throw.
   */
  addresses(url: string): string[];
  /**
   * Optional: whether the page at `url` is opened in a window of the app
   * instead, though the importer has its other pages fetched. For a site
   * that asks its readers to confirm they are a person: only the person can
   * do that, in the window, and the app never does it for them. The page is
   * then read there by the `pageReader` beside this `fetch` (which must
   * give what `convert` expects, {@link FetchedPages}), under the limits of
   * pages opened in a window. Must not throw.
   */
  inWindow?(url: string): boolean;
}

/**
 * How the pages of a site are read, as the person chose for it among the
 * ways its importer offers (see `SiteInfo` in the contract):
 *
 * - `fetch`, "By itself": the app fetches the addresses `fetch.addresses`
 *   names, as described above.
 * - `window`, "In a window of this app": each page is opened in the app's
 *   visible window, kept for a go, and read there by the importer's
 *   `pageReader`, for a site that shows its pages only to a person.
 */
export type ReadingWay = 'fetch' | 'window';

/** Every way of reading, in the order the app offers them. */
export const READING_WAYS: readonly ReadingWay[] = ['fetch', 'window'];

export const isReadingWay = (value: unknown): value is ReadingWay =>
  typeof value === 'string' && (READING_WAYS as readonly string[]).includes(value);

/** Whether a part of an importer that fetches its pages has the page at `url` opened in a window instead. */
export function readsInWindow(fetch: PageFetch | undefined, url: string): boolean {
  if (!fetch?.inWindow) return false;
  try {
    return fetch.inWindow(url);
  } catch {
    return false;
  }
}

/** One answer, as the app hands it to `convert`. */
export interface FetchedPage {
  /** The address asked for. */
  url: string;
  /** Where the answer came from, after redirects on the same site. */
  finalUrl: string;
  status: number;
  /** The `Content-Type`, lowercase, without parameters; empty when absent. */
  contentType: string;
  /** The body as text (UTF-8), cut at {@link MAX_FETCHED_CHARS}. */
  text: string;
}

/** The page data of a page read by fetching: every answer, in order. */
export interface FetchedPages {
  fetched: FetchedPage[];
}

/** Whether `value` has the shape of {@link FetchedPages}. */
export function isFetchedPages(value: unknown): value is FetchedPages {
  if (typeof value !== 'object' || value === null) return false;
  const fetched = (value as { fetched?: unknown }).fetched;
  return (
    Array.isArray(fetched) &&
    fetched.every(
      (page: unknown) =>
        typeof page === 'object' &&
        page !== null &&
        typeof (page as FetchedPage).url === 'string' &&
        typeof (page as FetchedPage).finalUrl === 'string' &&
        typeof (page as FetchedPage).status === 'number' &&
        typeof (page as FetchedPage).contentType === 'string' &&
        typeof (page as FetchedPage).text === 'string',
    )
  );
}

/**
 * Why an answer stops the go, or null when it does not: the site said no
 * (401, 403, 451), asked the reader to slow down (429, or a `Retry-After`),
 * or is not serving (503). A missing page (404, 410) does not stop it.
 */
export function refusalOf(status: number, retryAfter: string | null = null): string | null {
  if (status === 401 || status === 407) return 'The site asked to sign in.';
  if (status === 403 || status === 451) return 'The site refused to serve the page.';
  if (status === 429 || retryAfter) return 'The site asked to slow down.';
  if (status === 503) return 'The site is not serving pages just now.';
  return null;
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309)

interface Group {
  agents: string[];
  rules: Rule[];
  crawlDelay: number | null;
}

interface Rule {
  allow: boolean;
  /** The path pattern, with `*` and a final `$`. */
  path: string;
}

/** The rules of a robots.txt that apply to one agent. */
export interface RobotsRules {
  rules: Rule[];
  /** The site's `Crawl-delay` for the agent, in seconds, if it gives one. */
  crawlDelay: number | null;
}

/** Nothing disallowed: no robots.txt, or one that says nothing to this agent. */
export const ALLOW_ALL: RobotsRules = { rules: [], crawlDelay: null };
/** Everything disallowed. */
export const DISALLOW_ALL: RobotsRules = {
  rules: [{ allow: false, path: '/' }],
  crawlDelay: null,
};

/**
 * The rules of a robots.txt for `agent` (case-insensitive): the groups that
 * name it, or else the `*` groups. Groups that name the agent are merged.
 */
export function robotsRules(text: string, agent: string = ROBOTS_AGENT): RobotsRules {
  const wanted = agent.toLowerCase();
  const groups: Group[] = [];
  let current: Group | null = null;
  let inRules = false;
  for (const raw of text.split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim();
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!current || inRules) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
        inRules = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (current && (key === 'allow' || key === 'disallow')) {
      inRules = true;
      // An empty Disallow allows everything; it adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', path: value });
    } else if (current && key === 'crawl-delay') {
      inRules = true;
      const delay = Number(value);
      if (Number.isFinite(delay) && delay >= 0) current.crawlDelay = delay;
    }
  }
  const named = groups.filter((g) => g.agents.includes(wanted));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.reduce<number | null>(
      (most, g) => (g.crawlDelay === null ? most : Math.max(most ?? 0, g.crawlDelay)),
      null,
    ),
  };
}

const patternMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&'))
    .join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`, 'u').test(path);
};

/**
 * Whether the rules allow `url`: the longest matching rule wins, and Allow
 * wins a tie. The path is matched with its query, as the RFC says.
 */
export function robotsAllows(rules: RobotsRules, url: string): boolean {
  let path: string;
  try {
    const parsed = new URL(url);
    path = `${parsed.pathname}${parsed.search}`;
  } catch {
    return false;
  }
  if (path === '/robots.txt') return true;
  let best: Rule | null = null;
  for (const rule of rules.rules) {
    if (!patternMatches(rule.path, path)) continue;
    if (
      !best ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}

/**
 * The rules to follow after asking for a site's robots.txt: its rules when
 * it answered, none when it has none (404, 410 and other 4xx answers, as
 * the RFC says), and everything disallowed when it could not be read (5xx,
 * or no answer). A refusal ({@link refusalOf}) stops the go before that.
 */
export function rulesFromAnswer(
  answer: { status: number; text: string } | null,
  agent: string = ROBOTS_AGENT,
): RobotsRules {
  if (!answer || answer.status >= 500) return DISALLOW_ALL;
  if (answer.status >= 400) return ALLOW_ALL;
  if (answer.status >= 200 && answer.status < 300) return robotsRules(answer.text, agent);
  return DISALLOW_ALL;
}
