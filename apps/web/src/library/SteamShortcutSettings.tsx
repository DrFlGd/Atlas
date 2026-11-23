import { useEffect, useState } from 'react';
import type { SteamStatus } from '../desktop';
import { steamShortcutOffered } from '../features';
import {
  foundText,
  loadSteam,
  restartLabel,
  restartSteam,
  restartText,
  setSteam,
  stateText,
  userName,
  useSteam,
} from '../state/steamShortcut';
import { useAtlas } from '../state/store';

/**
 * Settings, "Atlas in Steam", in the desktop app without downloads on
 * Windows and Linux (see `state/steamShortcut.ts`): what Steam and user
 * were found, "Add Atlas to Steam" with its artwork or "Take Atlas out of
 * Steam", and while Steam runs, "Restart Steam and add it".
 */
export function SteamShortcutSettings() {
  const offered = useAtlas(steamShortcutOffered);
  if (__ATLAS_DOWNLOADS__ || !offered) return null;
  return <SteamShortcutSection />;
}

function SteamShortcutSection() {
  const status = useSteam((s) => s.status);
  const problem = useSteam((s) => s.problem);
  useEffect(() => {
    void loadSteam();
  }, []);
  return (
    <section className="settings-group" aria-label="Atlas in Steam" data-testid="settings-steam">
      <h2 className="settings-group-title">Atlas in Steam</h2>
      <p className="muted small">
        Add Atlas to your Steam library as a non-Steam game, with its own artwork. Then you can
        start it from Steam, also in Game Mode on a Steam Deck.
      </p>
      {status ? <SteamShortcutState status={status} /> : null}
      {problem ? (
        <p className="small" role="alert" data-testid="steam-problem">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** How often the status is read again while a change waits for Steam to close. */
const WAITING_LOOK_MS = 5000;

function SteamShortcutState({ status }: { status: SteamStatus }) {
  const working = useSteam((s) => s.working);
  const restarting = useSteam((s) => s.restarting);
  // While a change waits, the shell writes it as soon as Steam is closed:
  // the person may close Steam themselves.
  const waitingForSteam = status.waiting && !restarting;
  useEffect(() => {
    if (!waitingForSteam) return;
    const timer = setInterval(() => void loadSteam(), WAITING_LOOK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [waitingForSteam]);
  const [chosen, setChosen] = useState<string | null>(null);
  const user = chosen ?? status.user ?? '';
  const canAdd =
    status.folder !== null && status.users.length > 0 && status.refused === null && !restarting;
  const state = stateText(status);
  return (
    <>
      <p className="small" data-testid="steam-found">
        {foundText(status)}
      </p>
      {status.users.length > 1 ? (
        <label className="small">
          Steam user{' '}
          <select
            className="select"
            data-testid="steam-user"
            value={user}
            disabled={working || restarting}
            onChange={(event) => {
              const next = event.target.value;
              setChosen(next);
              if (status.wanted) void setSteam(true, next);
            }}
          >
            {status.users.map((u) => (
              <option key={u.id} value={u.id}>
                {userName(u)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {status.refused !== null && status.folder !== null ? (
        <p className="small" role="alert" data-testid="steam-refused">
          {status.refused}
        </p>
      ) : null}
      {state ? (
        <p className="small" role="status" data-testid="steam-state">
          {state}
        </p>
      ) : null}
      {status.folder === null ? null : (
        <div className="row-actions wrap">
          {status.wanted ? (
            <button
              type="button"
              className="button"
              data-testid="steam-remove"
              disabled={working || restarting}
              onClick={() => void setSteam(false)}
            >
              Take Atlas out of Steam
            </button>
          ) : (
            <button
              type="button"
              className="button button-primary"
              data-testid="steam-add"
              disabled={working || !canAdd}
              onClick={() => void setSteam(true, user || undefined)}
            >
              Add Atlas to Steam
            </button>
          )}
        </div>
      )}
      {status.waiting && status.running ? (
        <>
          <p className="muted small" data-testid="steam-restart-help">
            {restartText(status)}
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button button-primary"
              data-testid="steam-restart"
              disabled={working || restarting}
              onClick={() => void restartSteam()}
            >
              {restartLabel(status)}
            </button>
            {restarting ? (
              <span className="small" role="status" data-testid="steam-restarting">
                Steam is restarting. This can take a minute.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
