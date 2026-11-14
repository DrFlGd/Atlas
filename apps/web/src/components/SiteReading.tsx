import {
  CONFIRMABLE_LICENCES,
  readingWayOf,
  type ReadingWay,
  type SiteInfo,
} from '@atlas/importer-api';
import { useEffect, useId, useState } from 'react';
import {
  answerLicence,
  chooseHow,
  confirmHow,
  forgetWikiSite,
  howAddressFor,
  setHowWay,
  siteMemory,
  stopBrowse,
  useImport,
  type ImportPhase,
  type LicenceAsk,
  type SiteMemory,
} from '../state/importing';
import { parseAddresses } from '../state/importRun';
import { showLibraryAdd, useLibrary } from '../state/libraryView';
import { WAY_LABELS, WAY_TEXTS } from '../state/readingWays';
import { loadWikiNotes, setSiteLicence, setSiteWay, useWikiNotes } from '../state/wikiNotes';
import { memoryParts } from './removalText';

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

/**
 * Before a site is read while no wiki of it is in the Library: what its
 * importer says about it, how to read it (the way chosen before ticked),
 * and what this app still remembers of it from an earlier session, which
 * can be forgotten to start from nothing.
 */
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
          ? 'This choice is kept for this site. While no wiki of this site is in the Library, adding it asks again; once one is, you change it on its screen in the Library. This app never changes it by itself.'
          : 'This is shown whenever this site is added while no wiki of it is in the Library, and on its screen in the Library.'}
      </p>
      <RememberedSite importerId={phase.importerId} url={phase.url} />
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
 * What this app still remembers of a site with no wiki in the Library,
 * from an earlier session (its list of pages, pages that could not be
 * read or were left out, pages kept for later, a confirmed licence), with
 * a way to forget it after asking. The way chosen is not counted here: it
 * is the question being asked.
 */
function RememberedSite({ importerId, url }: { importerId: string; url: string }) {
  const notes = useWikiNotes((s) => s.byImporter[importerId]);
  const queueVersion = useImport((s) => s.queueVersion);
  const [memory, setMemory] = useState<SiteMemory | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void siteMemory(importerId, url)
      .catch(() => null)
      .then((found) => {
        if (current) setMemory(found);
      });
    return () => {
      current = false;
    };
  }, [importerId, url, notes, queueVersion]);
  if (!memory || memory.inLibrary) return null;
  const parts = memoryParts(memory, { way: false });
  if (parts.length === 0) return null;
  const list = parts.join(', ');
  return (
    <div className="site-remembered" data-testid="site-remembered">
      <p className="muted small">
        This app still remembers this wiki from an earlier session: {list}. To start from nothing,
        forget it first.
      </p>
      {asking ? (
        <div
          className="download-confirm removal-confirm"
          role="group"
          aria-label="Forget what this app remembers of this wiki?"
          data-testid="site-forget-confirm"
        >
          <p>
            <strong>Forget what this app remembers of {memory.key}?</strong>
          </p>
          <p className="removal-detail">
            This app forgets {list}, and how its pages are read; the way ticked here is kept again
            when you go on. Nothing that was read is in the Library, so nothing else is deleted.
            This cannot be undone.
          </p>
          {error ? (
            <p className="download-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="button button-danger"
              data-testid="site-forget-confirm-button"
              onClick={() => {
                setError(null);
                void forgetWikiSite(importerId, memory.key).then(
                  () => {
                    setAsking(false);
                  },
                  (failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : String(failure));
                  },
                );
              }}
            >
              Forget it
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setAsking(false);
              }}
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div className="row-actions">
          <button
            type="button"
            className="button"
            data-testid="site-forget"
            onClick={() => {
              setAsking(true);
            }}
          >
            Forget what it remembers
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * After a session of a wiki's pages that kept none: a way to choose how
 * its pages are read and try again, when its importer offers a choice.
 * Nothing is read until the person goes on from that step.
 */
export function ChooseHowOffer({ page }: { page: string }) {
  const draft = useImport((s) => s.draft);
  const [found, setFound] = useState<{ page: string; address: string | null } | null>(null);
  useEffect(() => {
    const { addresses } = parseAddresses(draft);
    let current = true;
    void howAddressFor(page, addresses.length === 1 ? addresses[0]! : null)
      .catch(() => null)
      .then((address) => {
        if (current) setFound({ page, address });
      });
    return () => {
      current = false;
    };
  }, [page, draft]);
  const address = found?.page === page ? found.address : null;
  if (!address) return null;
  return (
    <div data-testid="add-map-how-offer">
      <p className="muted small">
        No page was kept. You can choose another way to read this wiki and try again.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="add-map-how"
          onClick={() => void chooseHow(address)}
        >
          {CHOOSE_HOW}
        </button>
      </div>
    </div>
  );
}

/** The button that shows how a site is read, to choose another way. */
export const CHOOSE_HOW = 'Choose how its pages are read';

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
      {phase.ended && count === 0 ? <ChooseHowOffer page={phase.url} /> : null}
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
