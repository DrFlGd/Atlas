import { useEffect, useId } from 'react';
import type { UpdateWay } from '../desktop';
import {
  checkForUpdates,
  elsewhereText,
  loadUpdateSettings,
  setCheckAtStart,
  showUpdateNotice,
  updateWayOf,
  useUpdates,
} from '../state/updates';
import { useAtlas } from '../state/store';

/** The help under "Check for updates when Atlas starts". */
export const AT_START_HELP =
  'A few seconds after Atlas starts, it looks for a new version in the background. It says nothing when there is none or when this computer is offline.';

/**
 * Settings, "Updates", in the desktop app (see `state/updates.ts`): the
 * version, "Check for updates" with what it found, and the setting "Check
 * for updates when Atlas starts", where Atlas updates itself; where it does
 * not, where its updates come from. Not in a browser or the Android app.
 */
export function UpdateSettings() {
  const way = useAtlas(updateWayOf);
  const version = useAtlas((s) => s.app?.version);
  if (!way) return null;
  return (
    <section className="settings-group" aria-label="Updates" data-testid="settings-updates">
      <h2 className="settings-group-title">Updates</h2>
      <p className="small" data-testid="update-version">
        This is Atlas {version}.
      </p>
      {way.way === 'itself' ? (
        <UpdatesItself atStart={way.atStart} />
      ) : (
        <p className="muted small" data-testid="update-elsewhere">
          {elsewhereText(way.from)}
        </p>
      )}
    </section>
  );
}

function UpdatesItself({ atStart }: { atStart: Extract<UpdateWay, { way: 'itself' }>['atStart'] }) {
  const setting = useUpdates((s) => s.atStart);
  const checking = useUpdates((s) => s.checking);
  const found = useUpdates((s) => s.found);
  const problem = useUpdates((s) => s.problem);
  const helpId = useId();
  useEffect(() => {
    void loadUpdateSettings().catch(() => undefined);
  }, []);
  return (
    <>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="update-check"
          disabled={checking}
          onClick={() => {
            void checkForUpdates({ quiet: false });
          }}
        >
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {found?.state === 'available' && !checking ? (
          <button
            type="button"
            className="button button-primary"
            data-testid="update-show"
            onClick={showUpdateNotice}
          >
            See Atlas {found.version}
          </button>
        ) : null}
      </div>
      {checking ? null : problem ? (
        <p className="small" role="alert" data-testid="update-result">
          {problem}
        </p>
      ) : found ? (
        <p className="small" role="status" data-testid="update-result">
          {found.state === 'available'
            ? `Atlas ${found.version} is available.`
            : 'Atlas is up to date.'}
        </p>
      ) : null}
      <div className="background-setting">
        <label className="switch">
          <input
            type="checkbox"
            role="switch"
            data-testid="update-at-start"
            checked={setting ?? true}
            disabled={setting === null}
            aria-describedby={helpId}
            onChange={(event) => {
              setCheckAtStart(event.target.checked);
            }}
          />
          <span className="switch-track" aria-hidden="true" />
          Check for updates when Atlas starts
        </label>
        <p className="muted small" id={helpId}>
          {AT_START_HELP}
        </p>
        {atStart ? null : (
          <p className="muted small" data-testid="update-not-at-start">
            Atlas was started in a way that does not look for updates, such as by Steam with a game.
            Press Check for updates to look now.
          </p>
        )}
      </div>
    </>
  );
}
