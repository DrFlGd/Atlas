import { useId, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import type { SteamLaunch } from '../desktop';
import { steamLaunchOffered } from '../features';
import { useAtlas } from '../state/store';

/** Where the line looks for Atlas when Atlas does not run from an AppImage. */
export const USUAL_APPIMAGE = '$HOME/Applications/Atlas.AppImage';

/** What Copy did: nothing yet, copied, or the text selected for the person to copy. */
type Copied = 'no' | 'yes' | 'selected';

/**
 * Settings, "Start Atlas with a game in Steam", in the desktop app without
 * downloads on Linux: the line to put into a game's launch options in
 * Steam, so that Atlas starts with that game (as a window of the game,
 * reached with the Steam button), with Copy and the steps. The shell builds
 * the line from the AppImage Atlas runs from (see the shell's `linux.rs`);
 * this only shows it.
 */
export function SteamLaunchSettings() {
  const launch = useAtlas(steamLaunchOffered);
  if (__ATLAS_DOWNLOADS__ || !launch) return null;
  return <SteamLaunchSection launch={launch} />;
}

function SteamLaunchSection({ launch }: { launch: SteamLaunch }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<Copied>('no');
  const helpId = useId();
  const line = launch.state === 'refused' ? null : launch.line;
  return (
    <section
      className="settings-group"
      aria-label="Start Atlas with a game in Steam"
      data-testid="settings-steam-launch"
    >
      <h2 className="settings-group-title">Start Atlas with a game in Steam</h2>
      <p className="muted small">
        Put this line into the launch options of a game in Steam, and Atlas starts with that game
        without coming in front of it. Then press the Steam button to switch between the game and
        Atlas.
      </p>
      {line === null ? null : (
        <>
          <textarea
            ref={box}
            className="steam-launch-line"
            readOnly
            rows={3}
            spellCheck={false}
            aria-label="The line for the game's launch options"
            aria-describedby={helpId}
            data-testid="steam-launch-line"
            value={line}
            onFocus={() => {
              if (copied === 'selected') box.current?.select();
            }}
          />
          <div className="row-actions wrap">
            <button
              type="button"
              className="button button-primary"
              data-testid="steam-launch-copy"
              onClick={() => {
                const area = box.current;
                void copyText(line, area?.closest('dialog') ?? document.body).then((done) => {
                  if (done) {
                    setCopied('yes');
                    return;
                  }
                  area?.focus();
                  area?.select();
                  setCopied('selected');
                });
              }}
            >
              Copy
            </button>
            {copied === 'no' ? null : (
              <span className="small" role="status" data-testid="steam-launch-copied">
                {copied === 'yes' ? 'Copied.' : 'The line is selected. Press Ctrl+C to copy it.'}
              </span>
            )}
          </div>
        </>
      )}
      <p className="small" id={helpId} data-testid="steam-launch-path">
        {pathSentence(launch)}
      </p>
      {line === null ? null : (
        <ol className="small steam-launch-steps" data-testid="steam-launch-steps">
          <li>Press Copy.</li>
          <li>In Steam, open the Properties of the game.</li>
          <li>Under General, paste the line into Launch Options.</li>
          <li>Start the game. To stop Atlas starting with it, delete the line again.</li>
        </ol>
      )}
    </section>
  );
}

/** What the line names, in one or two sentences. */
export function pathSentence(launch: SteamLaunch): string {
  switch (launch.state) {
    case 'appImage':
      return `The line names the file Atlas runs from now: ${launch.path}. If you move that file, start Atlas from its new folder and copy the line again.`;
    case 'usual':
      return `Atlas is not running from an AppImage now, so the line names ${USUAL_APPIMAGE}, the file Atlas.AppImage in the Applications folder of your home folder. If your Atlas.AppImage is somewhere else, change that path in the line.`;
    case 'refused':
      return `Atlas runs from ${launch.path}, and that path holds a character that cannot go in the line safely: a quotation mark, an apostrophe, a dollar sign, a backtick, a backslash or a line break. Move Atlas.AppImage to a folder whose path has none of them, such as Applications in your home folder, start it from there and come back here.`;
  }
}
