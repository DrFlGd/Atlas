import {
  CONFIRMABLE_LICENCES,
  MAX_GIVEN_BY,
  MAX_LICENCE_NOTE,
  MAX_LICENCE_WORDS,
  NO_LICENCE_RECORDED,
  isTermsAddress,
  readingWayOf,
  siteLicenceOf,
  type PictureSize,
  type ReadingWay,
  type RulesLicence,
  type SiteInfo,
  type SiteLicence,
} from '@atlas/importer-api';
import { useEffect, useId, useState, type ReactNode } from 'react';
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
  type LicenceAnswer,
  type LicenceAsk,
  type SiteMemory,
} from '../state/importing';
import { parseAddresses } from '../state/importRun';
import { showLibraryAdd, useLibrary } from '../state/libraryView';
import {
  DEFAULT_PICTURE_SIZE,
  PICTURE_SIZE_LABELS,
  PICTURE_SIZE_NOTE,
  PICTURE_SIZE_TEXTS,
  WAY_LABELS,
  WAY_TEXTS,
} from '../state/readingWays';
import {
  loadWikiNotes,
  setSiteLicence,
  setSitePictures,
  setSiteWay,
  useWikiNotes,
} from '../state/wikiNotes';
import { memoryParts } from './removalText';

/**
 * How a site's pages are read, as the person chooses among the ways its
 * importer offers (`siteInfo` of the contract), and what they answer for
 * the licence of a site whose pages state none. Both are kept per site with
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

/** The sizes a site's pictures can be kept at, in the order shown. */
const PICTURE_SIZES: readonly PictureSize[] = ['full', 'shown'];

/**
 * "Pictures: Full size / As the page shows them": the size a wiki's
 * pictures are kept at, with what each costs. Changed at once, never
 * during a session; it counts for pages read from then on, and for the
 * wiki built again from its saved pages.
 */
export function PicturesChoice({
  size,
  disabled = false,
  onChange,
}: {
  size: PictureSize;
  disabled?: boolean;
  onChange: (size: PictureSize) => void;
}) {
  const name = useId();
  return (
    <fieldset
      className="follow-links site-pictures"
      data-testid="site-pictures"
      data-size={size}
      disabled={disabled}
    >
      <legend>Pictures</legend>
      <div className="follow-links-options">
        {PICTURE_SIZES.map((option) => (
          <label
            key={option}
            className="follow-links-option"
            data-testid={`site-pictures-${option}`}
          >
            <input
              type="radio"
              name={name}
              value={option}
              checked={size === option}
              onChange={() => {
                onChange(option);
              }}
            />
            <span>
              <strong>{PICTURE_SIZE_LABELS[option]}</strong>
              <span className="muted small">{PICTURE_SIZE_TEXTS[option]}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="muted small">{PICTURE_SIZE_NOTE}</p>
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
 * The question a page read waits on: which licence the site's pages are
 * under, when they state none. Nothing of the page is kept until the
 * person answers; "Not now" stops reading.
 */
export function LicenceQuestion() {
  const ask = useImport((s) => s.licenceAsk);
  return ask ? <LicenceAskCard key={`${ask.siteKey} ${ask.url}`} ask={ask} /> : null;
}

function LicenceAskCard({ ask }: { ask: LicenceAsk }) {
  return (
    <div
      className="download-confirm licence-question"
      role="group"
      aria-label="Choose the wiki’s licence"
      data-testid="licence-question"
    >
      <p>
        <strong>Which licence is {ask.siteKey} under?</strong>
      </p>
      <p>{ask.message}</p>
      <LicenceForm
        submit="Confirm and read"
        onAnswer={(answer) => {
          answerLicence(answer);
        }}
      >
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
      </LicenceForm>
      <p className="muted small">
        Your answer is kept for this site, so its other pages are read without asking again. You can
        change it on the wiki’s screen in the Library.
      </p>
    </div>
  );
}

/** The types of answer to the licence question, in the order shown. */
type LicenceType = 'known' | 'permission' | 'none';

const LICENCE_TYPES: readonly LicenceType[] = ['known', 'permission', 'none'];

const LICENCE_TYPE_LABELS: Record<LicenceType, string> = {
  known: 'A known licence',
  permission: 'Fill in',
  none: 'Blank',
};

const LICENCE_TYPE_TEXTS: Record<LicenceType, string> = {
  known:
    'A Creative Commons licence. Choose one only if the wiki says so itself, on a page about its copyright or in its terms.',
  permission:
    'What you have instead, such as permission from the site’s owner. The pages are kept for your own use.',
  none: 'Nothing is recorded about permission, and the pages are kept for your own use.',
};

const typeOf = (licence: SiteLicence | RulesLicence | undefined): LicenceType =>
  licence?.basis === 'permission' ? 'permission' : licence?.basis === 'none' ? 'none' : 'known';

/**
 * The answers to the licence question: a known licence (one of
 * `CONFIRMABLE_LICENCES`), words the person fills in with what they have
 * instead (who gave it, when, the address of its terms and a note are
 * optional), or blank. `initial` is the answer kept, to change it; the
 * main button answers, and `children` are the buttons beside it.
 */
function LicenceForm({
  initial,
  submit,
  disabled = false,
  onAnswer,
  children,
}: {
  initial?: SiteLicence;
  submit: string;
  disabled?: boolean;
  onAnswer: (answer: LicenceAnswer) => void;
  children?: ReactNode;
}) {
  const filled = initial?.basis === 'permission' ? initial : null;
  const [type, setType] = useState<LicenceType>(typeOf(initial));
  const [deed, setDeed] = useState(
    initial && initial.basis !== 'permission' && initial.basis !== 'none' ? initial.url : '',
  );
  const [words, setWords] = useState(filled?.name ?? '');
  const [givenBy, setGivenBy] = useState(filled?.givenBy ?? '');
  const [givenOn, setGivenOn] = useState(filled?.givenOn ?? '');
  const [terms, setTerms] = useState(filled?.url ?? '');
  const [note, setNote] = useState(filled?.note ?? '');
  const name = useId();
  const ids = useId();
  const known = CONFIRMABLE_LICENCES.find((l) => l.url === deed) ?? null;
  const termsUsable = terms.trim() === '' || isTermsAddress(terms.trim());
  const answer: LicenceAnswer | null =
    type === 'known'
      ? known
        ? { name: known.name, url: known.url }
        : null
      : type === 'none'
        ? { basis: 'none', name: NO_LICENCE_RECORDED }
        : words.trim() !== '' && termsUsable
          ? {
              basis: 'permission',
              name: words.trim(),
              ...(terms.trim() ? { url: terms.trim() } : {}),
              ...(givenBy.trim() ? { givenBy: givenBy.trim() } : {}),
              ...(givenOn ? { givenOn } : {}),
              ...(note.trim() ? { note: note.trim() } : {}),
            }
          : null;
  return (
    <>
      <fieldset
        className="follow-links licence-answer"
        data-testid="licence-answer"
        data-type={type}
        disabled={disabled}
      >
        <legend>The licence</legend>
        <div className="follow-links-options">
          {LICENCE_TYPES.map((option) => (
            <label
              key={option}
              className="follow-links-option"
              data-testid={`licence-type-${option}`}
            >
              <input
                type="radio"
                name={name}
                value={option}
                checked={type === option}
                onChange={() => {
                  setType(option);
                }}
              />
              <span>
                <strong>{LICENCE_TYPE_LABELS[option]}</strong>
                <span className="muted small">{LICENCE_TYPE_TEXTS[option]}</span>
              </span>
            </label>
          ))}
        </div>
        {type === 'known' ? (
          <label htmlFor={`${ids}-deed`} className="licence-question-row">
            Licence{' '}
            <select
              id={`${ids}-deed`}
              className="select"
              data-testid="licence-choice"
              value={deed}
              onChange={(event) => {
                setDeed(event.target.value);
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
        ) : null}
        {type === 'permission' ? (
          <div className="licence-fields" data-testid="licence-fields">
            <label className="field-label" htmlFor={`${ids}-words`}>
              What to show under each page
            </label>
            <input
              id={`${ids}-words`}
              className="text-input"
              data-testid="licence-words"
              maxLength={MAX_LICENCE_WORDS}
              placeholder="For example: Permission from the site’s owner for personal use"
              value={words}
              onChange={(event) => {
                setWords(event.target.value);
              }}
            />
            <span className="muted small">A licence’s name or a sentence. This is required.</span>
            <label className="field-label" htmlFor={`${ids}-by`}>
              Who gave it (optional)
            </label>
            <input
              id={`${ids}-by`}
              className="text-input"
              data-testid="licence-given-by"
              maxLength={MAX_GIVEN_BY}
              value={givenBy}
              onChange={(event) => {
                setGivenBy(event.target.value);
              }}
            />
            <label className="field-label" htmlFor={`${ids}-on`}>
              Date (optional)
            </label>
            <input
              id={`${ids}-on`}
              type="date"
              className="text-input"
              data-testid="licence-given-on"
              value={givenOn}
              onChange={(event) => {
                setGivenOn(event.target.value);
              }}
            />
            <label className="field-label" htmlFor={`${ids}-terms`}>
              Address where the terms can be read (optional)
            </label>
            <input
              id={`${ids}-terms`}
              type="url"
              className="text-input"
              data-testid="licence-terms"
              placeholder="https://"
              value={terms}
              aria-invalid={termsUsable ? undefined : true}
              onChange={(event) => {
                setTerms(event.target.value);
              }}
            />
            {termsUsable ? null : (
              <span className="download-error small" role="alert" data-testid="licence-terms-error">
                The address must start with https://.
              </span>
            )}
            <label className="field-label" htmlFor={`${ids}-note`}>
              Note (optional)
            </label>
            <textarea
              id={`${ids}-note`}
              className="text-input"
              data-testid="licence-note"
              maxLength={MAX_LICENCE_NOTE}
              rows={2}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </div>
        ) : null}
      </fieldset>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary"
          data-testid="licence-confirm"
          disabled={disabled || !answer}
          onClick={() => {
            if (answer) onAnswer(answer);
          }}
        >
          {submit}
        </button>
        {children}
      </div>
    </>
  );
}

/** What the person answered for a site's licence, in a sentence, for its screen. */
function licenceAnswerText(licence: SiteLicence): string {
  const on = new Date(licence.confirmedAt).toLocaleDateString('en');
  switch (licence.basis) {
    case 'permission':
      return `You filled in this wiki’s licence: “${licence.name}”, on ${on}. Its pages that state no licence are read under it and kept for your own use.`;
    case 'none':
      return `You chose to record no licence for this wiki, on ${on}. Its pages that state no licence are kept for your own use.`;
    default:
      return `You confirmed this wiki’s licence: ${licence.name}, on ${on}. Its pages that state no licence are read under it.`;
  }
}

/** What a site's rules file answers for its licence, in words (see `SiteInfo.rulesLicence`). */
function rulesLicenceText(licence: RulesLicence, file: string): string {
  switch (licence.basis) {
    case 'permission':
      return `This wiki’s licence comes from its site rules file, ${file}: “${licence.name}”. Its pages that state no licence are read under it and kept for your own use.`;
    case 'none':
      return `This wiki’s site rules file, ${file}, records no licence for it. Its pages that state no licence are kept for your own use.`;
    default:
      return `This wiki’s licence comes from its site rules file, ${file}: ${licence.name}. Its pages that state no licence are read under it.`;
  }
}

/**
 * On a wiki's screen, the licence its site rules file answers, while the
 * person has not answered for the site themselves: "Change it" keeps an
 * answer of their own, which counts instead of the file's.
 */
function RulesFileLicence({
  importerId,
  siteKey,
  licence,
  file,
  disabled,
}: {
  importerId: string;
  siteKey: string;
  licence: RulesLicence;
  file: string;
  disabled: boolean;
}) {
  const [changing, setChanging] = useState(false);
  if (changing) {
    return (
      <div className="wiki-licence-change" data-testid="wiki-licence-change">
        <p className="muted small">
          Your answer counts instead of the file’s, for pages read from now on. Pages already read
          keep theirs until they are read again.
        </p>
        <LicenceForm
          initial={{ ...licence, confirmedAt: new Date().toISOString() }}
          submit="Keep this answer"
          disabled={disabled}
          onAnswer={(answer) => {
            const kept = siteLicenceOf({ ...answer, confirmedAt: new Date().toISOString() });
            if (!kept) return;
            void setSiteLicence(importerId, siteKey, kept).then(() => {
              setChanging(false);
            });
          }}
        >
          <button
            type="button"
            className="button"
            data-testid="wiki-licence-cancel"
            onClick={() => {
              setChanging(false);
            }}
          >
            Cancel
          </button>
        </LicenceForm>
      </div>
    );
  }
  return (
    <p className="muted small" data-testid="wiki-licence-file" data-type={typeOf(licence)}>
      {rulesLicenceText(licence, file)}{' '}
      <button
        type="button"
        className="link-button"
        data-testid="wiki-licence-edit"
        disabled={disabled}
        onClick={() => {
          setChanging(true);
        }}
      >
        Change it
      </button>
    </p>
  );
}

/**
 * On a wiki's screen, what the person answered for its licence: changed
 * there ("Change it", the same answers as the question) or forgotten, so
 * the next page that states none asks again. Pages read before keep the
 * licence they were read under until they are read again.
 */
function WikiLicence({
  importerId,
  siteKey,
  licence,
  disabled,
}: {
  importerId: string;
  siteKey: string;
  licence: SiteLicence;
  disabled: boolean;
}) {
  const [changing, setChanging] = useState(false);
  if (changing) {
    return (
      <div className="wiki-licence-change" data-testid="wiki-licence-change">
        <p className="muted small">
          A new answer counts for pages read from now on. Pages already read keep theirs until they
          are read again.
        </p>
        <LicenceForm
          initial={licence}
          submit="Keep this answer"
          disabled={disabled}
          onAnswer={(answer) => {
            const kept = siteLicenceOf({ ...answer, confirmedAt: new Date().toISOString() });
            if (!kept) return;
            void setSiteLicence(importerId, siteKey, kept).then(() => {
              setChanging(false);
            });
          }}
        >
          <button
            type="button"
            className="button"
            data-testid="wiki-licence-cancel"
            onClick={() => {
              setChanging(false);
            }}
          >
            Cancel
          </button>
        </LicenceForm>
      </div>
    );
  }
  return (
    <p className="muted small" data-testid="wiki-licence" data-type={typeOf(licence)}>
      {licenceAnswerText(licence)}{' '}
      <button
        type="button"
        className="link-button"
        data-testid="wiki-licence-edit"
        disabled={disabled}
        onClick={() => {
          setChanging(true);
        }}
      >
        Change it
      </button>{' '}
      <button
        type="button"
        className="link-button"
        data-testid="wiki-licence-forget"
        disabled={disabled}
        onClick={() => void setSiteLicence(importerId, siteKey, null)}
      >
        Forget it
      </button>
    </p>
  );
}

/**
 * On a wiki's screen: what its importer says about it, how its pages are
 * read (changed at once, never during a go), the size its pictures are
 * kept at in an app that downloads them (`pictures`: its importer's pages
 * come with their pictures), and what the person answered for its
 * licence, which they can change or forget.
 */
export function WikiReading({
  importerId,
  site,
  disabled,
  pictures = false,
}: {
  importerId: string;
  site: SiteInfo;
  disabled: boolean;
  pictures?: boolean;
}) {
  const choices = useWikiNotes((s) => s.byImporter[importerId]?.sites[site.key]);
  useEffect(() => {
    void loadWikiNotes(importerId);
  }, [importerId]);
  const way = readingWayOf(site, choices?.way);
  const licence = choices?.licence;
  const sizes = __ATLAS_DOWNLOADS__ && pictures;
  const fileLicence = !licence && site.rulesLicence && site.rulesFile ? site.rulesLicence : null;
  if (site.ways.length < 2 && !site.notice && !licence && !fileLicence && !sizes) return null;
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
      {sizes ? (
        <PicturesChoice
          size={choices?.pictures ?? DEFAULT_PICTURE_SIZE}
          disabled={disabled}
          onChange={(next) => void setSitePictures(importerId, site.key, next)}
        />
      ) : null}
      {licence ? (
        <WikiLicence
          importerId={importerId}
          siteKey={site.key}
          licence={licence}
          disabled={disabled}
        />
      ) : fileLicence ? (
        <RulesFileLicence
          importerId={importerId}
          siteKey={site.key}
          licence={fileLicence}
          file={site.rulesFile!}
          disabled={disabled}
        />
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
