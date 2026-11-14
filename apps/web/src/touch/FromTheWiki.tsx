import type { GuideSource } from '@atlas/schema';
import { UiIcon } from '../components/icons';
import { guideSearchText } from '../markdown';
import { useGuideLinks } from '../state/guideLinks';
import { pagesAt, type LocationPage } from '../state/guideMatches';
import type { LoadedGame } from '../state/store';
import { openPlace } from './reader';
import { showSection } from './state';

/** About how much of a page's text the card shows. */
const EXCERPT_CHARS = 260;

/**
 * The first lines of a page as plain text: no pictures, no marks, and no
 * hidden text (read with the renderer, so what is hidden stays hidden).
 */
function pageExcerpt(body: string, chars = EXCERPT_CHARS): string {
  // The lead: the text before the first heading or table, when there is one.
  const lines = body.replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ').split('\n');
  const end = lines.findIndex((line, i) => i > 0 && /^\s*(#{1,6}\s|\|)/u.test(line));
  const lead = guideSearchText((end > 0 ? lines.slice(0, end) : lines).join('\n')).trim();
  const text = (lead || guideSearchText(lines.join('\n'))).replace(/\s+/gu, ' ').trim();
  if (text.length <= chars) return text;
  const cut = text.lastIndexOf(' ', chars);
  return `${text.slice(0, cut > chars / 2 ? cut : chars).replace(/[\s,;:.]+$/u, '')}…`;
}

/** Opens a page in the Guides section. */
function readPage(guideId: string): void {
  openPlace({ kind: 'page', guideId });
  showSection('guides');
}

/**
 * "From the wiki" on a location's card: the page linked to the location
 * that is most about it (its own name, then its type, then its region),
 * with its first lines, its credit and a way to the full page; and the
 * other pages linked to it, each a way to its page.
 */
export function FromTheWiki({ game, locationId }: { game: LoadedGame; locationId: string }) {
  // The links and the pages of other games change what is linked here.
  useGuideLinks((s) => s.links.choices);
  useGuideLinks((s) => s.others);
  const pages = pagesAt(game, locationId);
  const first = pages[0];
  if (!first) return null;
  const rest = pages.slice(1);
  const excerpt = pageExcerpt(first.guide.body);
  return (
    <section className="place-wiki" aria-labelledby="place-wiki-title" data-testid="from-the-wiki">
      <h3 className="place-wiki-heading" id="place-wiki-title">
        From the wiki
      </h3>
      <p className="place-wiki-title">
        <strong>{first.guide.title}</strong>
        <span className="muted small-text"> · {about(first)}</span>
      </p>
      {excerpt ? <p className="place-wiki-text">{excerpt}</p> : null}
      {first.guide.source ? (
        <p className="place-wiki-credit" data-testid="from-the-wiki-credit">
          {creditLine(first.guide.title, first.guide.source)}
        </p>
      ) : null}
      <button
        type="button"
        className="touch-text-button place-wiki-read"
        data-testid="read-wiki-page"
        onClick={() => {
          readPage(first.guide.id);
        }}
      >
        <UiIcon name="book" size={18} />
        Read the full page
      </button>
      {rest.length > 0 ? (
        <ul className="touch-plain-list place-lists" aria-label="More from the wiki">
          {rest.map((page) => (
            <li key={page.guide.id}>
              <button
                type="button"
                className="place-list-row"
                data-testid="wiki-page-row"
                onClick={() => {
                  readPage(page.guide.id);
                }}
              >
                <UiIcon name="book" size={20} />
                <span className="place-list-row-text">
                  <span>{page.guide.title}</span>
                  <span className="muted small-text">{about(page)}</span>
                </span>
                <UiIcon name="chevron" size={18} strokeWidth={1.8} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Why a page is on this location's card, in words. */
function about(page: LocationPage): string {
  switch (page.via.what) {
    case 'location':
    case 'name':
      return 'about this location';
    case 'type':
      return `about the type ${page.via.label}`;
    case 'region':
      return `about the region ${page.via.label}`;
  }
}

/** "From “Waystones” on Example Wiki · CC BY-SA 4.0 · By the contributors of …" */
function creditLine(title: string, source: GuideSource): string {
  const licence = source.licenseConfirmed
    ? `${source.license.name} (confirmed by you)`
    : source.license.name;
  return [`From “${title}” on ${source.site}`, licence, source.credit].filter(Boolean).join(' · ');
}
