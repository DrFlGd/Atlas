import {
  CONFIRMABLE_LICENCES,
  readingWayOf,
  type ReadingWay,
  type SiteInfo,
} from '@atlas/importer-api';
import { useEffect, useId, useState } from 'react';
import {
  answerLicence,
  confirmHow,
  setHowWay,
  stopBrowse,
  useImport,
  type ImportPhase,
  type LicenceAsk,
} from '../state/importing';
import { showLibraryAdd, useLibrary } from '../state/libraryView';
import { WAY_LABELS, WAY_TEXTS } from '../state/readingWays';
import { loadWikiNotes, setSiteLicence, setSiteWay, useWikiNotes } from '../state/wikiNotes';

/**
 * How a site's pages are read, as the person chooses among the ways its
 * importer offers (`siteInfo` of the contract), and the licence they
 * confirm for a site whose pages state none. Both are kept per site with
 * the importer's wiki notes (`wikiNotes.ts`); the app never changes them by
 * itself. Nothing here reads a page.
 */

/** The ways a site can be read, one ticked, each with what it does. */
export function WaysChoice({
  ways,
  way,
  disabled = false,
  onChange,
}: {
  ways: readonly ReadingWay[];
  way: ReadingWay;
  disabled?: boolean;
  onChange: (way: ReadingWay) => void;
}) {
  const name = useId();
  return (
    <fieldset
      className="follow-links site-ways"
      data-testid="site-ways"
      data-way={way}
      disabled={disabled}
    >
      <legend>How its pages are read</legend>
      <div className="follow-links-options">
        {ways.map((option) => (
          <label key={option} className="follow-links-option" data-testid={`site-way-${option}`}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={way === option}
              onChange={() => {
                onChange(option);
              }}
            />
            <span>
              <strong>{WAY_LABELS[option]}</strong>
              <span className="muted small">{WAY_TEXTS[option]}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** What the importer says about a site, when it says something. */
function SiteNotice({ site }: { site: SiteInfo }) {
  return site.notice ? (
    <p className="site-notice" data-testid="site-notice">
      {site.notice}
    </p>
  ) : null;
}

/** Before a site is first read: what its importer says about it, and how to read it. */
export function HowStep({ phase }: { phase: Extract<ImportPhase, { kind: 'how' }> }) {
  return (
    <div className="dialog-section" data-testid="add-how">
      <p>
        <strong>{phase.site.key}</strong>, read with {phase.importer}. Nothing has been read yet.
      </p>
      <SiteNotice site={phase.site} />
      {phase.site.ways.length > 1 ? (
        <WaysChoice ways={phase.site.ways} way={phase.way} onChange={setHowWay} />
      ) : null}
      <p className="muted small">
        {phase.site.ways.length > 1
          ? 'This choice is kept for this site. You can change it later on its screen in the Library; this app never changes it by itself.'
          : 'This is shown once for this site, and again on its screen in the Library.'}
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="add-how-go"
          onClick={() => void confirmHow()}
        >
          {phase.way === 'browse' ? 'Start browsing' : 'Read it'}
        </button>
      </div>
    </div>
  );
}

/**
 * The question a page read waits on: which Creative Commons licence the
 * site's pages are under, when they state none. Nothing of the page is
 * kept until the person confirms one; "Not now" stops reading.
 */
export function LicenceQuestion() {
  const ask = useImport((s) => s.licenceAsk);
  return ask ? <LicenceAskCard key={`${ask.siteKey} ${ask.url}`} ask={ask} /> : null;
}

function LicenceAskCard({ ask }: { ask: LicenceAsk }) {
  const [chosen, setChosen] = useState<string>('');
  const selectId = useId();
  const licence = CONFIRMABLE_LICENCES.find((l) => l.url === chosen) ?? null;
  return (
    <div
      className="download-confirm licence-question"
      role="group"
      aria-label="Confirm the wiki’s licence"
      data-testid="licence-question"
    >
      <p>
        <strong>Which licence is {ask.siteKey} under?</strong>
      </p>
      <p>{ask.message}</p>
      <p className="muted small">
        Confirm a licence only if the wiki says so itself, on a page about its copyright or in its
        terms. The guide this page becomes says the licence was confirmed by you. It is kept for
        this site, so its other pages are read without asking again.
      </p>
      <label htmlFor={selectId} className="licence-question-row">
        Licence{' '}
        <select
          id={selectId}
          className="select"
          data-testid="licence-choice"
          value={chosen}
          onChange={(event) => {
            setChosen(event.target.value);
          }}
        >
          <option value="">Choose one…</option>
          {CONFIRMABLE_LICENCES.map((option) => (
            <option key={option.url} value={option.url}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="licence-confirm"
          disabled={!licence}
          onClick={() => {
            if (licence) answerLicence(licence);
          }}
        >
          Confirm and read
        </button>
        <button
          type="button"
          className="button"
          data-testid="licence-decline"
          onClick={() => {
            answerLicence(null);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * On a wiki's screen: what its importer says about it, how its pages are
 * read (changed at once, never during a go), and the licence the person
 * confirmed for it, which they can forget.
 */
export function WikiReading({
  importerId,
  site,
  disabled,
}: {
  importerId: string;
  site: SiteInfo;
  disabled: boolean;
}) {
  const choices = useWikiNotes((s) => s.byImporter[importerId]?.sites[site.key]);
  useEffect(() => {
    void loadWikiNotes(importerId);
  }, [importerId]);
  const way = readingWayOf(site, choices?.way);
  const licence = choices?.licence;
  if (site.ways.length < 2 && !site.notice && !licence) return null;
  return (
    <div className="wiki-reading" data-testid="wiki-reading">
      <SiteNotice site={site} />
      {site.ways.length > 1 ? (
        <WaysChoice
          ways={site.ways}
          way={way}
          disabled={disabled}
          onChange={(next) => void setSiteWay(importerId, site.key, next)}
        />
      ) : null}
      {licence ? (
        <p className="muted small" data-testid="wiki-licence">
          You confirmed this wiki’s licence: {licence.name}, on{' '}
          {new Date(licence.confirmedAt).toLocaleDateString('en')}. Its pages that state no licence
          are read under it.{' '}
          <button
            type="button"
            className="link-button"
            data-testid="wiki-licence-forget"
            disabled={disabled}
            onClick={() => void setSiteLicence(importerId, site.key, null)}
          >
            Forget it
          </button>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Browse and keep, while the person browses a site in the app's window:
 * the page kept last, how many, what happened last, and Stop browsing. The
 * app opens no page by itself; closing the window ends it too.
 */
export function BrowseKeep({ phase }: { phase: Extract<ImportPhase, { kind: 'browse' }> }) {
  const last = phase.kept.at(-1);
  const count = phase.kept.length;
  return (
    <div
      className="dialog-section browse-keep"
      data-testid="browse-keep"
      data-state={phase.ended ? 'ended' : 'browsing'}
      data-kept={count}
    >
      <p>
        <strong>{phase.ended ? `Browsing ${phase.site} ended` : `Browsing ${phase.site}`}</strong>,
        kept with {phase.importer}.
      </p>
      <p className="muted small">
        {phase.ended
          ? 'The window is closed. The pages kept are on the wiki’s screen in the Library and in Guides.'
          : 'Browse the wiki in the window this app opened. Each article page you open is kept once it has loaded, once; this app never opens a page by itself, and pages a page links to are listed as found, not read. If the site asks you to confirm you are a person, answer it there: nothing is read while it asks.'}
      </p>
      <p className="browse-keep-status" role="status" data-testid="browse-keep-status">
        {last ? `Kept: ${last.title}` : 'No page kept yet.'}
        {' · '}
        <span className="muted">
          {count === 1 ? '1 page kept' : `${count.toLocaleString('en')} pages kept`}
        </span>
      </p>
      {phase.note ? (
        <p className="muted small" data-testid="browse-keep-note">
          {phase.note}
        </p>
      ) : null}
      {count > 0 ? (
        <ul className="browse-keep-pages" data-testid="browse-keep-pages">
          {phase.kept
            .slice(-8)
            .reverse()
            .map((page) => (
              <li key={page.url}>{page.title}</li>
            ))}
        </ul>
      ) : null}
      {phase.ended ? null : (
        <div className="row-actions">
          <button
            type="button"
            className="button"
            data-testid="browse-keep-stop"
            onClick={() => void stopBrowse()}
          >
            Stop browsing
          </button>
        </div>
      )}
    </div>
  );
}

/** The strip while the person browses a wiki and its pages are kept: the last kept, the count, Stop browsing. */
export function BrowseStrip({ phase }: { phase: Extract<ImportPhase, { kind: 'browse' }> }) {
  const pane = useLibrary((s) => s.pane);
  const last = phase.kept.at(-1);
  const count = phase.kept.length;
  return (
    <footer className="library-strip" data-testid="library-strip" aria-label="Now">
      <span className="library-strip-now" data-testid="library-strip-now">
        <strong>Now:</strong> browsing {phase.site}
        {last ? `. Kept: ${last.title}` : ''}, {count === 1 ? '1 page kept' : `${count} pages kept`}
      </span>
      {pane !== 'add' ? (
        <button type="button" className="button button-small" onClick={showLibraryAdd}>
          See the pages
        </button>
      ) : null}
      <button
        type="button"
        className="button button-small"
        data-testid="library-strip-stop-browsing"
        onClick={() => void stopBrowse()}
      >
        Stop browsing
      </button>
    </footer>
  );
}
