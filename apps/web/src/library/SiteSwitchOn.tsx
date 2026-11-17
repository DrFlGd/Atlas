import { closeSwitchOn, switchSite, useSites } from '../state/siteRules';

/** A file just added, or one switched on: the hosts it names, to see before it is on. */
export function AddedFile() {
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
            {confirm.saved ? 'Saved' : 'Added'} <strong>{confirm.name}</strong> ({confirm.title}).
            It is switched off.{' '}
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
            <strong>
              It widens the limits of the importers’ shipped files, or takes the place of one of
              their readers.
            </strong>{' '}
            Switch it on only if the site or the guide’s author gave permission:
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
