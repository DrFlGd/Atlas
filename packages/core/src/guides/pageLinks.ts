import type { GuideEntry } from '@atlas/schema';

/**
 * The links between a pack's pages, read from their Markdown: a guide's
 * text links to another guide of the pack by its id
 * (`[Knight Armor](game:guide:knight-armor)`), so the pack alone says which
 * pages link to which. Guides names the pages that link to the page shown
 * ("Linked from"); nothing here files a page under another.
 */

/** A guide id in a Markdown link: `](game:guide:local`, with or without `<`. */
const GUIDE_LINK = /\]\(\s*<?([a-z0-9][a-z0-9-]*:guide:[A-Za-z0-9][A-Za-z0-9_.-]*)/g;

/** The guide ids a guide's Markdown links to, in order, each once, never itself. */
export function guideLinksIn(body: string, self?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!body.includes(':guide:')) return out;
  GUIDE_LINK.lastIndex = 0;
  for (let match = GUIDE_LINK.exec(body); match; match = GUIDE_LINK.exec(body)) {
    const id = match[1]!;
    if (id !== self && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** The links of each guide object, read once: a guide is never changed in place. */
const linksOfGuide = new WeakMap<GuideEntry, readonly string[]>();

/** The guide ids a guide links to (see {@link guideLinksIn}), read once per guide. */
export function guideLinks(guide: GuideEntry): readonly string[] {
  let links = linksOfGuide.get(guide);
  if (!links) {
    links = guideLinksIn(guide.body, guide.id);
    linksOfGuide.set(guide, links);
  }
  return links;
}
