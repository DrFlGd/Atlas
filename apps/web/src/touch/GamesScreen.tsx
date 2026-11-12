import { useEffect, useState } from 'react';
import { DeletePackConfirm } from '../components/DeletePackConfirm';
import { UiIcon } from '../components/icons';
import { PackSummary } from '../components/MapsDialog';
import { PackDetailsView } from '../components/PackFacts';
import { desktop, type PackDetails } from '../desktop';
import { copiesPickedFiles, foldersOffered } from '../features';
import { setTheme, switchGame } from '../state/actions';
import { openActivityLog } from '../state/activityLog';
import { importPickedPackFile, loadPackDetails, pickPackFile } from '../state/packFile';
import { useAtlas } from '../state/store';
import { setKeepScreenOn, useTouch } from './state';
import { GroupTitle, SwitchTrack } from './widgets';

/**
 * Games: the games on this device (tap one to show it), importing a map
 * pack file, each game's details and delete, then the app's settings.
 */
export function GamesScreen() {
  const catalog = useAtlas((s) => s.catalog);
  const library = useAtlas((s) => s.library);
  const shown = useAtlas((s) => s.game?.entry.id);
  const copies = useAtlas(copiesPickedFiles);
  const folders = useAtlas(foldersOffered);
  const canImport = desktop !== null && (copies || folders);
  return (
    <div className="touch-page" data-testid="games-screen">
      <header className="touch-page-head">
        <h1 className="touch-page-title">Games</h1>
      </header>
      <div className="touch-scroll touch-page-body" data-scroll-root>
        <section aria-labelledby="games-heading">
          <GroupTitle id="games-heading">Games on this device</GroupTitle>
          <ul className="touch-plain-list" data-testid="game-list">
            {catalog.map((entry) => {
              const listed = library?.packs.find((p) => p.id === entry.id);
              return (
                <GameRow
                  key={entry.id}
                  id={entry.id}
                  title={entry.title}
                  current={entry.id === shown}
                  origin={
                    listed && !listed.bundled
                      ? 'Imported from a map pack file'
                      : 'Comes with the app'
                  }
                  listed={listed !== undefined}
                  deletable={listed?.origin === 'maps-folder' && !listed.bundled}
                  busy={library?.busy.includes(entry.id) ?? false}
                />
              );
            })}
          </ul>
          {canImport ? (
            <>
              <button
                type="button"
                className="touch-button touch-button-primary touch-button-block"
                data-testid="import-pack-file"
                onClick={() => void (copies ? importPickedPackFile() : pickPackFile())}
              >
                <UiIcon name="upload" size={20} />
                Import map pack file…
              </button>
              <p className="touch-note">
                Add a game with a map pack file (.atlaspack) exported by Atlas on your computer:
                copy it to this device, for example into Download, then import it here.
              </p>
            </>
          ) : null}
        </section>
        <Settings />
      </div>
    </div>
  );
}

function GameRow({
  id,
  title,
  current,
  origin,
  listed,
  deletable,
  busy,
}: {
  id: string;
  title: string;
  current: boolean;
  origin: string;
  listed: boolean;
  deletable: boolean;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [details, setDetails] = useState(false);
  return (
    <li className="touch-game" data-testid="game-row" data-pack={id} data-current={current}>
      <button
        type="button"
        className="touch-game-main"
        aria-current={current ? 'true' : undefined}
        onClick={() => {
          if (!current) void switchGame(id);
        }}
      >
        <span className="touch-game-text">
          <span className="touch-row-title">{title}</span>
          <span className="touch-row-detail">
            {current ? 'Shown · ' : ''}
            {origin}
            {busy ? ' · moving files…' : ''}
          </span>
          {listed && desktop ? <PackSummary id={id} /> : null}
        </span>
        <span className="touch-row-end">
          {current ? <UiIcon name="check" size={20} strokeWidth={2.2} /> : null}
        </span>
      </button>
      {listed && desktop ? (
        <div className="touch-game-actions">
          <button
            type="button"
            className="touch-text-button"
            aria-expanded={details}
            data-testid="pack-details-toggle"
            onClick={() => {
              setDetails(!details);
            }}
          >
            Details
          </button>
          {deletable && !busy ? (
            <button
              type="button"
              className="touch-text-button touch-text-button-danger"
              data-testid="delete-pack"
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete…
            </button>
          ) : null}
        </div>
      ) : null}
      {details ? <GameDetails id={id} /> : null}
      {confirming ? (
        <div className="touch-game-confirm">
          <DeletePackConfirm
            id={id}
            title={title}
            onClose={() => {
              setConfirming(false);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}

/** What is known about a game, read when asked for, as the Maps dialog shows it. */
function GameDetails({ id }: { id: string }) {
  const library = useAtlas((s) => s.library);
  const [details, setDetails] = useState<PackDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadPackDetails(id).then(
      (loaded) => {
        if (!live) return;
        setDetails(loaded);
        setError(null);
      },
      (reason: unknown) => {
        if (live) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      live = false;
    };
  }, [id, library]);
  return (
    <div className="touch-game-details">
      {details ? (
        <PackDetailsView details={details} />
      ) : (
        <p className="touch-note">{error ?? 'Reading…'}</p>
      )}
    </div>
  );
}

function Settings() {
  const theme = useAtlas((s) => s.theme);
  const app = useAtlas((s) => s.app);
  const keepOn = useTouch((s) => s.keepScreenOn);
  const offered = useTouch((s) => s.screenOnOffered);
  return (
    <section aria-labelledby="settings-heading" className="touch-settings">
      <GroupTitle id="settings-heading">Settings</GroupTitle>
      <div className="touch-setting-row">
        <span className="touch-setting-label" id="theme-label">
          Theme
        </span>
        <div className="touch-segmented" role="group" aria-labelledby="theme-label">
          {(['dark', 'light'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="touch-segment"
              aria-pressed={theme === value}
              onClick={() => {
                setTheme(value);
              }}
            >
              {value === 'dark' ? 'Dark' : 'Light'}
            </button>
          ))}
        </div>
      </div>
      {offered ? (
        <button
          type="button"
          role="switch"
          aria-checked={keepOn}
          className="touch-switch-card"
          data-testid="keep-screen-on"
          onClick={() => {
            setKeepScreenOn(!keepOn);
          }}
        >
          <span className="touch-switch-label">
            Keep the screen on
            <span className="touch-switch-note">While Atlas is shown</span>
          </span>
          <SwitchTrack on={keepOn} />
        </button>
      ) : null}
      {desktop ? (
        <button
          type="button"
          className="touch-row touch-row-button"
          data-testid="open-activity-log"
          onClick={() => {
            openActivityLog();
          }}
        >
          <span className="touch-row-text">
            <span className="touch-row-title">Activity log</span>
            <span className="touch-row-detail">
              What this app did with the games on this device, such as imports and deletes
            </span>
          </span>
          <span className="touch-row-end">
            <UiIcon name="chevron" size={18} strokeWidth={1.8} />
          </span>
        </button>
      ) : null}
      <p className="touch-app-version" data-testid="app-version">
        {app?.name ?? 'Atlas'}
        {app?.version ? ` ${app.version}` : ''}
      </p>
    </section>
  );
}
