import type { TargetInfo } from '@atlas/core';
import type { GuideEntry, GuideSource, Location } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { guideSearchText } from '../markdown';
import { notify } from '../state/actions';
import { numberFormat } from '../state/derived';
import { canChangeGuideLinks, useGuideLinks } from '../state/guideLinks';
import { pagesAt, type LocationPage } from '../state/guideMatches';
import type { LoadedGame } from '../state/store';
import {
  hasWikiPages,
  linkPageAt,
  linkWords,
  nameTargetAt,
  searchWiki,
  unlinkPageAt,
  type LinkReach,
  type WikiHit,
} from '../state/wikiSearch';
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
 * that is most about it (this location alone, its own name, then its type,
 * then its region), with its first lines, its credit and a way to the full
 * page; and the other pages linked to it, each a way to its page. The link
 * can be taken off, and another page searched for. Without a linked page,
 * "Search wiki" searches the saved pages (see `wikiSearch.ts`).
 */
export function FromTheWiki({ game, locationId }: { game: LoadedGame; locationId: string }) {
  // The links and the pages of other games change what is linked here.
  useGuideLinks((s) => s.links.choices);
  useGuideLinks((s) => s.others);
  const canChange = useGuideLinks((s) => canChangeGuideLinks(s));
  const [searching, setSearching] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  useEffect(() => {
    if (!searching && returnFocus.current) {
      returnFocus.current = false;
      opener.current?.focus();
    }
  });
  const pages = pagesAt(game, locationId);
  const location = game.pack.locations.get(locationId);
  const searchable = location !== undefined && hasWikiPages(game);
  const first = pages[0];
  const close = () => {
    returnFocus.current = true;
    setSearching(false);
  };
  const search =
    searching && location ? (
      <WikiSearch game={game} location={location} linked={pages} onClose={close} />
    ) : null;
  if (!first) {
    if (!searchable) return null;
    return (
      search ?? (
        <div className="place-wiki-find">
          <button
            ref={opener}
            type="button"
            className="touch-text-button"
            data-testid="search-wiki"
            onClick={() => {
              setSearching(true);
            }}
          >
            <UiIcon name="search" size={18} />
            Search wiki
          </button>
        </div>
      )
    );
  }
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
      {canChange ? (
        <div className="place-wiki-actions">
          <button
            type="button"
            className="touch-text-button"
            data-testid="unlink-wiki-page"
            aria-label={`Not this page: take the link of ${first.guide.title} to ${linkWords(first.via)} off`}
            onClick={() => {
              unlinkPageAt(first.guide, first.via);
            }}
          >
            <UiIcon name="close" size={16} />
            Not this page
          </button>
          {searchable && !searching ? (
            <button
              ref={opener}
              type="button"
              className="touch-text-button"
              data-testid="search-wiki"
              onClick={() => {
                setSearching(true);
              }}
            >
              <UiIcon name="search" size={16} />
              Search for another page
            </button>
          ) : null}
        </div>
      ) : null}
      {search}
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

/** Why a page was found for a name, in words. */
function foundBy(hit: WikiHit): string {
  const site = hit.guide.source?.site;
  const why =
    hit.via === 'text'
      ? 'Mentions the name'
      : hit.via === 'other-name'
        ? `Also called “${hit.name}”`
        : hit.exact
          ? 'Same name'
          : 'A name close to it';
  return site ? `${why} · ${site}` : why;
}

/**
 * The saved pages that may be about a location, the best first, each with
 * "Read" and "This is the page". Linking asks whether the page is about
 * every location of the name or only this one, when the map has more than
 * one location of it.
 */
function WikiSearch({
  game,
  location,
  linked,
  onClose,
}: {
  game: LoadedGame;
  location: Location;
  linked: readonly LocationPage[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState(location.name);
  const [searched, setSearched] = useState(location.name);
  const [asking, setAsking] = useState<{ guide: GuideEntry; name: TargetInfo } | null>(null);
  const cannot = useGuideLinks((s) =>
    canChangeGuideLinks(s)
      ? null
      : (s.readOnly ?? 'Your links between pages and the map cannot be changed now.'),
  );
  const hits = useMemo(() => searchWiki(game, searched), [game, searched]);
  const headingId = useId();
  const inputId = useId();
  const askId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  const linkedHere = new Set(linked.map((page) => page.guide.id));
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    if (asking) askRef.current?.focus();
  }, [asking]);

  const link = (guide: GuideEntry, reach: LinkReach, name: TargetInfo | null) => {
    const problem = linkPageAt(game, guide.id, location.id, reach);
    if (problem) {
      notify(problem, 'error');
      return;
    }
    notify(
      reach === 'name' && name
        ? `Linked “${guide.title}” to every location named ${name.label}.`
        : `Linked “${guide.title}” to ${location.name}.`,
    );
    onClose();
  };
  const choose = (guide: GuideEntry) => {
    const name = nameTargetAt(game, location.id);
    // One location of that name: there is nothing to ask.
    if (name && name.locations.length > 1) setAsking({ guide, name });
    else link(guide, name ? 'name' : 'location', name);
  };

  return (
    <section
      className="place-wiki-search"
      aria-labelledby={headingId}
      data-testid="wiki-search"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          if (asking) setAsking(null);
          else onClose();
        }
      }}
    >
      <div className="place-wiki-search-head">
        <h3 className="place-wiki-heading" id={headingId}>
          Search wiki
        </h3>
        <button
          type="button"
          className="touch-text-button"
          data-testid="close-wiki-search"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <form
        className="place-wiki-search-form"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setAsking(null);
          setSearched(query.trim() || location.name);
        }}
      >
        <label htmlFor={inputId} className="visually-hidden">
          Search the saved pages for
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="touch-text-input"
          type="search"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          data-testid="wiki-search-input"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
        />
        <button type="submit" className="touch-button" data-testid="wiki-search-go">
          Search
        </button>
      </form>
      <p className="muted small-text" role="status" data-testid="wiki-search-summary">
        {hits.length === 0
          ? `No saved page fits “${searched}”. Try other words.`
          : `${hits.length === 1 ? '1 saved page fits' : `${numberFormat.format(hits.length)} saved pages fit`} “${searched}”, the best first.`}
      </p>
      {cannot ? <p className="muted small-text">{cannot}</p> : null}
      {asking ? (
        <div
          className="place-wiki-ask"
          role="group"
          aria-labelledby={askId}
          data-testid="wiki-link-question"
        >
          <p id={askId}>
            Is “{asking.guide.title}” about every location named {asking.name.label}, or only this
            one?
          </p>
          <div className="place-wiki-ask-buttons">
            <button
              ref={askRef}
              type="button"
              className="touch-button touch-button-primary"
              data-testid="link-every-location"
              onClick={() => {
                link(asking.guide, 'name', asking.name);
              }}
            >
              Every location named {asking.name.label} (
              {numberFormat.format(asking.name.locations.length)})
            </button>
            <button
              type="button"
              className="touch-button"
              data-testid="link-this-location"
              onClick={() => {
                link(asking.guide, 'location', asking.name);
              }}
            >
              Only this one
            </button>
            <button
              type="button"
              className="touch-text-button"
              onClick={() => {
                setAsking(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {hits.length > 0 ? (
        <ul className="touch-plain-list place-wiki-hits" aria-label="Saved pages">
          {hits.map((hit) => {
            const here = linkedHere.has(hit.guide.id);
            return (
              <li
                key={hit.guide.id}
                className="place-wiki-hit"
                data-testid="wiki-search-hit"
                data-via={hit.via}
              >
                <span className="place-list-row-text">
                  <span className="place-wiki-hit-title">{hit.guide.title}</span>
                  <span className="muted small-text">
                    {here ? 'Linked here · ' : ''}
                    {foundBy(hit)}
                  </span>
                </span>
                <span className="place-wiki-hit-buttons">
                  <button
                    type="button"
                    className="touch-text-button"
                    data-testid="wiki-search-read"
                    aria-label={`Read ${hit.guide.title}`}
                    onClick={() => {
                      readPage(hit.guide.id);
                    }}
                  >
                    Read
                  </button>
                  {cannot || here ? null : (
                    <button
                      type="button"
                      className="touch-button"
                      data-testid="wiki-search-link"
                      aria-label={`This is the page: ${hit.guide.title}`}
                      onClick={() => {
                        choose(hit.guide);
                      }}
                    >
                      This is the page
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
