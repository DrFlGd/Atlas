import { useEffect } from 'react';
import type { KeptPackRow, KeptPacksSchedule } from '../desktop';
import { downloadsOffered } from '../features';
import {
  SCHEDULE_NAMES,
  STATE_NAMES,
  chooseKeptPacksFolder,
  loadKeptPacks,
  revealKeptPacksFolder,
  rowDetails,
  setKeptPacks,
  statusLine,
  stopKeptPacks,
  useKeptPacks,
  writeAllKeptPacks,
  writeKeptPackAgain,
  writingText,
} from '../state/keptPacks';
import { useAtlas } from '../state/store';

/**
 * Settings, "Keep packs for Game Repo up to date", in the desktop app with
 * downloads (`state/keptPacks.ts`): the switch with the folder, chosen in
 * the system's folder dialog; how often the folder is checked; "Write all
 * packs now"; one status line; and each game with its state, and "Write
 * again" for a pack removed from the folder.
 */
export function KeptPacks() {
  const downloads = useAtlas(downloadsOffered);
  const status = useKeptPacks((s) => s.status);
  const error = useKeptPacks((s) => s.error);
  const pending = useKeptPacks((s) => s.pending);
  useEffect(() => {
    if (__ATLAS_DOWNLOADS__ && downloads) void loadKeptPacks();
  }, [downloads]);
  if (!__ATLAS_DOWNLOADS__ || !downloads) return null;
  return (
    <section
      className="settings-group"
      aria-label="Keep packs for Game Repo up to date"
      data-testid="settings-kept-packs"
    >
      <h2 className="settings-group-title">Keep packs for Game Repo up to date</h2>
      <p className="muted small">
        Game Repo, another app, reads pack files from its Maps and Guides folder. With this on,
        Atlas writes a pack file of each map and wiki read from a site on this computer, each map
        you made in Atlas here and each map Map Maker made into the packs folder, the folder Atlas
        reads pack files from (see Games in other folders), or into another folder you choose, and
        writes it again when it changes: once a session, an update or a download of its map images
        or photos is finished, once you change a map you made or your own things of it, at each
        start, and daily or weekly if you choose. A pack file of the game already in the folder, in
        any folder inside it and under any name, is replaced where it lies; a new one goes into the
        folder “No game yet”. Atlas never moves, renames or deletes anything else there. A pack file
        you delete stays deleted until you press Write again, and one that is newer than this
        computer’s copy, written on another computer, is left as it is. Each pack file carries every
        map image on this computer and the photos kept for your own use. Only the pack file of a map
        you made in Atlas carries your own lists, locations, notes and pages of it; one of a map
        read from a site or made by Map Maker never does.
      </p>
      {status ? (
        <>
          <div className="row-actions wrap">
            <label className="switch">
              <input
                type="checkbox"
                role="switch"
                data-testid="kept-packs-switch"
                checked={status.on}
                disabled={pending}
                aria-label={`Keep packs up to date: ${status.on ? 'on' : 'off'}`}
                onChange={(event) => {
                  void setKeptPacks(event.target.checked, status.schedule);
                }}
              />
              <span className="switch-track" aria-hidden="true" />
              {status.on ? 'On' : 'Off'}
            </label>
          </div>
          <p className="path" data-testid="kept-packs-folder">
            {status.folder}
            {status.folderIsDefault ? (
              <span className="badge">Default: the packs folder</span>
            ) : null}
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button"
              data-testid="kept-packs-choose"
              disabled={pending}
              onClick={() => void chooseKeptPacksFolder()}
            >
              {status.folderChosen ? 'Change folder…' : 'Choose folder…'}
            </button>
            <button type="button" className="button" onClick={() => void revealKeptPacksFolder()}>
              Open folder
            </button>
            <label className="small">
              Check the folder{' '}
              <select
                data-testid="kept-packs-schedule"
                value={status.schedule}
                disabled={pending}
                onChange={(event) => {
                  void setKeptPacks(status.on, event.target.value as KeptPacksSchedule);
                }}
              >
                {(Object.keys(SCHEDULE_NAMES) as KeptPacksSchedule[]).map((schedule) => (
                  <option key={schedule} value={schedule}>
                    {SCHEDULE_NAMES[schedule]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p
            className={status.problem && !status.running ? 'small' : 'muted small'}
            role={status.problem && !status.running ? 'alert' : undefined}
            data-testid="kept-packs-status"
          >
            {statusLine(status)}
          </p>
          <div className="row-actions wrap">
            <button
              type="button"
              className="button"
              data-testid="kept-packs-write-all"
              disabled={!status.on || status.running || pending}
              onClick={() => void writeAllKeptPacks()}
            >
              Write all packs now
            </button>
            {status.running ? (
              <button
                type="button"
                className="button"
                data-testid="kept-packs-stop"
                onClick={() => void stopKeptPacks()}
              >
                Stop
              </button>
            ) : null}
          </div>
          {status.on && status.games.length > 0 ? (
            <ul className="kept-packs-list" data-testid="kept-packs-games">
              {status.games.map((row) => (
                <KeptPackItem key={row.id} row={row} disabled={pending} />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p className="small" role="alert" data-testid="kept-packs-error">
          {status ? error : `Could not read this setting: ${error}`}
        </p>
      ) : null}
    </section>
  );
}

function KeptPackItem({ row, disabled }: { row: KeptPackRow; disabled: boolean }) {
  return (
    <li
      className="kept-packs-row"
      data-testid="kept-pack-row"
      data-id={row.id}
      data-state={row.state}
    >
      <div className="kept-packs-head">
        <strong>{row.title}</strong>
        <span className={row.state === 'failed' ? 'library-status-problem' : 'muted'}>
          {STATE_NAMES[row.state]}
        </span>
        {row.state === 'not-in-folder' ? (
          <button
            type="button"
            className="button button-small"
            data-testid="kept-pack-write-again"
            disabled={disabled}
            onClick={() => void writeKeptPackAgain(row.id)}
          >
            Write again
          </button>
        ) : null}
      </div>
      {rowDetails(row).map((line) => (
        <p key={line} className="muted small">
          {line}
        </p>
      ))}
    </li>
  );
}

/**
 * The Library's short line while a pack is being written into the folder
 * of kept packs. Nothing at other times.
 */
export function KeptPacksLine() {
  const downloads = useAtlas(downloadsOffered);
  const text = useKeptPacks((s) => writingText(s.status));
  useEffect(() => {
    if (__ATLAS_DOWNLOADS__ && downloads) void loadKeptPacks();
  }, [downloads]);
  if (!__ATLAS_DOWNLOADS__ || !downloads || !text) return null;
  return (
    <p className="muted small kept-packs-line" role="status" data-testid="kept-packs-line">
      {text}
    </p>
  );
}
