import { useEffect, useState } from 'react';
import { sitesOffered } from '../features';
import { loadImporters } from '../state/importing';
import {
  WAY_NAMES,
  addSiteFile,
  askSwitchOn,
  closeSwitchOn,
  closeTrial,
  loadSites,
  removeSiteFile,
  saveSiteRulesFile,
  switchSite,
  trialInWords,
  trySavedPage,
  tryWithAddress,
  useSites,
  type SiteEntry,
  type SiteTrying,
} from '../state/siteRules';
import { useAtlas } from '../state/store';

/**
 * Settings, "Sites", in Atlas Importer: the site rules files the importers
 * read sites by (`state/siteRules.ts`). Each file with its site's name,
 * the types of its parts, the hosts it names and the ways of reading it
 * offers, a switch, and what is wrong with it; "Add a rules file…" for a
 * file of the person's, which is off until they have seen its hosts and
 * what it widens and switched it on; "Try on a saved page…" for a file with
 * a part read by rules; and the guide and the schema to save for writing
 * one.
 */
export function SitesSettings() {
  const offered = useAtlas(sitesOffered);
  const phase = useSites((s) => s.phase);
  const entries = useSites((s) => s.entries);
  const error = useSites((s) => s.error);
  const folder = useSites((s) => s.folder);
  useEffect(() => {
    if (__ATLAS_DOWNLOADS__ && offered) void loadImporters().then(loadSites);
  }, [offered]);
  if (!__ATLAS_DOWNLOADS__ || !offered) return null;
  const own = entries.filter((entry) => entry.own);
  const builtIn = entries.filter((entry) => !entry.own);
  return (
    <section className="settings-group" aria-label="Sites" data-testid="settings-sites">
      <h2 className="settings-group-title">Sites</h2>
      <p className="muted small">
        The sites the importers read, each described by a site rules file: its name, its addresses,
        the ways its pages can be read and its licence. Files come with the importers, and you can
        add your own. A file only describes a site: it holds no program. The limits of reading a
        site are held in its file, so that they can change when the site or a guide’s author gives
        permission, and you check each file before you switch it on. A file of yours that reads more
        than a file of the importers, or reads a site they refuse, says so before it is on. Some
        things no file changes: the app always says who it is, follows a site’s robots.txt when it
        reads by itself, pauses between pages, stops at the first refusal and never answers a check
        that you are a person.
      </p>
      {folder ? (
        <p className="muted small">
          Your files are kept in <span className="path-inline">{folder}</span>.
        </p>
      ) : null}
      <AddedFile />
      {phase === 'failed' ? (
        <p className="small" role="alert">
          Could not read the Sites folder: {error}
        </p>
      ) : null}
      {own.length > 0 ? (
        <>
          <h3 className="settings-subtitle">Your files</h3>
          <SiteList entries={own} />
        </>
      ) : null}
      {builtIn.length > 0 ? (
        <>
          <h3 className="settings-subtitle">Files that come with the importers</h3>
          <SiteList entries={builtIn} />
        </>
      ) : phase === 'ready' && own.length === 0 ? (
        <p className="muted small">No importer of this app reads sites by site rules files.</p>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button"
          data-testid="sites-add"
          onClick={() => void addSiteFile()}
        >
          Add a rules file…
        </button>
        <button
          type="button"
          className="button"
          data-testid="sites-save-guide"
          onClick={() => void saveSiteRulesFile('guide')}
        >
          Save the guide…
        </button>
        <button
          type="button"
          className="button"
          data-testid="sites-save-schema"
          onClick={() => void saveSiteRulesFile('schema')}
        >
          Save the schema…
        </button>
      </div>
      <p className="muted small">
        The guide tells you, or anyone helping you, how to write a site rules file, and the schema
        describes its fields for a program that checks one. A file you add is checked first and
        stays switched off until you have seen the sites it names and switched it on. A file of
        yours for a site a file of the importers also describes takes that file’s place while it is
        on.
      </p>
    </section>
  );
}

/** A file just added, or one switched on: the hosts it names, to see before it is on. */
function AddedFile() {
  const confirm = useSites((s) => s.confirm);
  const refused = useSites((s) => s.refused);
  if (refused) {
    return (
      <div className="download-note" role="alert" data-testid="sites-refused">
        <p>
          <strong>{refused.name} was not added.</strong> It has{' '}
          {refused.problems.length === 1 ? 'this problem' : 'these problems'}:
        </p>
        <ul>
          {refused.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (!confirm) return null;
  return (
    <div
      className="download-confirm"
      role="group"
      aria-label={`Switch on ${confirm.name}?`}
      data-testid="sites-confirm"
    >
      <p>
        {confirm.added ? (
          <>
            Added <strong>{confirm.name}</strong> ({confirm.title}). It is switched off.{' '}
          </>
        ) : null}
        Switch on {confirm.added ? 'this file' : <strong>{confirm.name}</strong>}? The importers
        then read {confirm.hosts.length === 1 ? 'this site' : 'these sites'} by it:
      </p>
      <ul className="sites-hosts" data-testid="sites-confirm-hosts">
        {confirm.hosts.map((host) => (
          <li key={host} className="path-inline">
            {host}
          </li>
        ))}
      </ul>
      {confirm.widens.length > 0 ? (
        <>
          <p>
            <strong>It widens the limits of the importers’ files.</strong> Switch it on only if the
            site or the guide’s author gave permission:
          </p>
          <ul className="sites-widens" data-testid="sites-confirm-widens">
            {confirm.widens.map((widening) => (
              <li key={widening}>{widening}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button button-primary"
          data-testid="sites-confirm-on"
          onClick={() => void switchSite(confirm.key, true)}
        >
          Switch it on
        </button>
        <button
          type="button"
          className="button"
          data-testid="sites-confirm-off"
          onClick={() => {
            closeSwitchOn();
          }}
        >
          Leave it off
        </button>
      </div>
    </div>
  );
}

function SiteList({ entries }: { entries: readonly SiteEntry[] }) {
  return (
    <ul className="profile-list" data-testid="sites-list">
      {entries.map((entry) => (
        <SiteRow key={entry.key} entry={entry} />
      ))}
    </ul>
  );
}

function SiteRow({ entry }: { entry: SiteEntry }) {
  const trying = useSites((s) => (s.trying?.key === entry.key ? s.trying : null));
  const facts = entry.refusal
    ? ['Refused: the importers never read these sites']
    : [
        entry.defaults ? 'For every site its reader recognises by address' : entry.types.join(', '),
        entry.ways.length > 0
          ? entry.ways.map((way) => WAY_NAMES[way]).join(', ')
          : entry.defaults
            ? ''
            : 'Ways of its reader',
      ].filter(Boolean);
  const usable = entry.readable || entry.on;
  return (
    <li
      className="profile-row pack-row"
      data-testid="site-row"
      data-key={entry.key}
      data-on={entry.on}
    >
      <div className="pack-info">
        <span>
          <strong>{entry.title}</strong>{' '}
          {entry.replacedBy ? <span className="badge">Your file is used</span> : null}
          {entry.replaces ? <span className="badge">In place of the importer’s</span> : null}
        </span>
        <span className="muted small">
          {entry.name}
          {entry.importer ? ` · Comes with ${entry.importer}` : ''}
        </span>
        {facts.length > 0 ? <span className="muted small">{facts.join(' · ')}</span> : null}
        {entry.hosts.length > 0 ? (
          <span className="muted small" data-testid="site-hosts">
            {entry.hosts.length === 1 ? 'Host: ' : 'Hosts: '}
            {entry.hosts.join(', ')}
          </span>
        ) : null}
        {entry.refusal ? <span className="small">{entry.refusal}</span> : null}
        {entry.replacedBy ? (
          <span className="small">
            Your file {entry.replacedBy} is switched on and is used in place of this one.
          </span>
        ) : null}
        {entry.widens.length > 0 ? (
          <div className="small" data-testid="site-widens">
            It widens the limits of the importers’ files:
            <ul className="sites-widens">
              {entry.widens.map((widening) => (
                <li key={widening}>{widening}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {entry.problems.length > 0 ? (
          <ul className="small sites-problems" data-testid="site-problems">
            {entry.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : null}
        <div className="row-actions">
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              data-testid="site-switch"
              checked={entry.on}
              disabled={!usable}
              aria-label={`${entry.title}: ${entry.on ? 'on' : 'off'}`}
              onChange={(event) => {
                if (event.target.checked && entry.own) askSwitchOn(entry);
                else void switchSite(entry.key, event.target.checked);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            {entry.on ? 'On' : 'Off'}
          </label>
          {entry.tryable ? (
            <button
              type="button"
              className="button button-small"
              data-testid="site-try"
              onClick={() => void trySavedPage(entry)}
            >
              Try on a saved page…
            </button>
          ) : null}
          {entry.own ? (
            <button
              type="button"
              className="button button-small"
              data-testid="site-remove"
              onClick={() => void removeSiteFile(entry.name)}
            >
              Remove
            </button>
          ) : null}
        </div>
        {trying ? <SiteTrialCard trying={trying} /> : null}
      </div>
    </li>
  );
}

/** "Try on a saved page": the page's address when it gives none, then what the reader understood. */
function SiteTrialCard({ trying }: { trying: SiteTrying }) {
  const [address, setAddress] = useState('');
  const [wrong, setWrong] = useState(false);
  const result = trying.result;
  const lines = result ? trialInWords(result) : [];
  return (
    <div
      className="download-confirm sites-trial"
      role="group"
      aria-label={`${trying.title} tried on ${trying.page}`}
      data-testid="site-trial"
    >
      <p>
        <strong>{trying.title}</strong> tried on <span className="path-inline">{trying.page}</span>
        {trying.address ? (
          <>
            , the page at <span className="path-inline">{trying.address}</span>
          </>
        ) : null}
        . Nothing was kept, and nothing was downloaded.
      </p>
      {trying.phase === 'address' ? (
        <form
          className="sites-trial-address"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void tryWithAddress(address).then((ok) => {
              setWrong(!ok);
            });
          }}
        >
          <label htmlFor="site-trial-address">
            The page does not say its own address. Which address was it saved from?
          </label>
          <div className="row-actions wrap">
            <input
              id="site-trial-address"
              className="text-input"
              type="url"
              inputMode="url"
              placeholder="https://"
              data-testid="site-trial-address"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
              }}
            />
            <button type="submit" className="button button-primary" data-testid="site-trial-go">
              Try it
            </button>
          </div>
          {wrong ? (
            <p className="small" role="alert">
              Give the whole address, starting with https://.
            </p>
          ) : null}
        </form>
      ) : null}
      {trying.phase === 'trying' ? <p className="muted">Trying the file on the page…</p> : null}
      {trying.phase === 'failed' ? (
        <p className="download-error" role="alert">
          {trying.error}
        </p>
      ) : null}
      {result && lines.length > 0 ? (
        <ul className="sites-trial-facts" data-testid="site-trial-facts">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {result?.text ? (
        <blockquote className="sites-trial-text" data-testid="site-trial-text">
          {result.text}
        </blockquote>
      ) : null}
      {result && result.problems.length > 0 ? (
        <>
          <p>
            {result.part === null
              ? 'The file did not read the page:'
              : result.problems.length === 1
                ? 'One thing went wrong:'
                : 'These things went wrong:'}
          </p>
          <ul className="sites-problems" data-testid="site-trial-problems">
            {result.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </>
      ) : result ? (
        <p className="muted small">Every selector of the file matched on this page.</p>
      ) : null}
      <div className="row-actions wrap">
        <button
          type="button"
          className="button"
          data-testid="site-trial-close"
          onClick={() => {
            closeTrial();
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
