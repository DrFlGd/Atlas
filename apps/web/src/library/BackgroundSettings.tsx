import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { BackgroundSetting } from '../desktop';
import { backgroundOffered } from '../features';
import {
  BACKGROUND_BACK,
  BACKGROUND_HELP,
  clearRefusedKeys,
  heldText,
  isModifierCode,
  loadBackground,
  pauseHotkey,
  setHotkeyKeys,
  switchBackground,
  useBackground,
} from '../state/background';
import { useAtlas } from '../state/store';

/**
 * Settings, "Atlas in the background", in the desktop app without
 * downloads where the shell offers it (on Windows for now): keeping Atlas
 * running when its window is closed, a hotkey that brings it forward,
 * staying above other windows and starting with Windows (see
 * `state/background.ts`). Each switch is off until the person turns it on,
 * and says in one sentence what it does.
 */
export function BackgroundSettings() {
  const offered = useAtlas(backgroundOffered);
  if (__ATLAS_DOWNLOADS__ || !offered) return null;
  return <BackgroundSection />;
}

function BackgroundSection() {
  const state = useBackground((s) => s.state);
  const error = useBackground((s) => s.error);
  const refused = useBackground((s) => s.refused);
  const working = useBackground((s) => s.working);
  useEffect(() => {
    void loadBackground();
  }, []);
  return (
    <section
      className="settings-group"
      aria-label="Atlas in the background"
      data-testid="settings-background"
    >
      <h2 className="settings-group-title">Atlas in the background</h2>
      <p className="muted small">
        Keep Atlas ready beside a game, and bring it forward without looking for its window.
      </p>
      {state ? (
        <>
          <Switch
            setting="keepRunning"
            label="Keep Atlas running when its window is closed"
            on={state.keepRunning}
            disabled={working}
            refused={refused.keepRunning}
          />
          <Switch
            setting="hotkey"
            label="Hotkey"
            on={state.hotkey.on}
            disabled={working}
            refused={refused.hotkey ?? state.hotkey.problem ?? undefined}
          >
            <HotkeyKeys keys={state.hotkey.keys} disabled={working} refused={refused.keys} />
          </Switch>
          <Switch
            setting="onTop"
            label="Stay above other windows"
            on={state.onTop}
            disabled={working}
            refused={refused.onTop}
          />
          <Switch
            setting="startWithSystem"
            label="Start Atlas when Windows starts"
            on={state.startWithSystem.on === true}
            disabled={working || state.startWithSystem.on === null}
            refused={refused.startWithSystem ?? state.startWithSystem.problem ?? undefined}
          />
          <p className="muted small" data-testid="background-back">
            {BACKGROUND_BACK}
          </p>
        </>
      ) : null}
      {error ? (
        <p className="small" role="alert" data-testid="background-error">
          Atlas could not read these settings: {error}
        </p>
      ) : null}
    </section>
  );
}

function Switch({
  setting,
  label,
  on,
  disabled,
  refused,
  children,
}: {
  setting: BackgroundSetting;
  label: string;
  on: boolean;
  disabled: boolean;
  refused: string | undefined;
  children?: ReactNode;
}) {
  const helpId = useId();
  return (
    <div className="background-setting" data-testid={`background-${setting}`}>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          data-testid={`background-${setting}-switch`}
          checked={on}
          disabled={disabled}
          aria-describedby={helpId}
          onChange={(event) => {
            void switchBackground(setting, event.target.checked);
          }}
        />
        <span className="switch-track" aria-hidden="true" />
        {label}
      </label>
      <p className="muted small" id={helpId}>
        {BACKGROUND_HELP[setting]}
      </p>
      {children}
      {refused ? (
        <p className="small" role="alert" data-testid={`background-${setting}-problem`}>
          {refused}
        </p>
      ) : null}
    </div>
  );
}

/** The hotkey's keys, and a field that takes new ones as they are pressed. */
function HotkeyKeys({
  keys,
  disabled,
  refused,
}: {
  keys: string;
  disabled: boolean;
  refused: string | undefined;
}) {
  const [pressing, setPressing] = useState(false);
  const [held, setHeld] = useState('');
  const stop = () => {
    setPressing(false);
    setHeld('');
    clearRefusedKeys();
    pauseHotkey(false);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const press = {
      code: event.code,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      win: event.metaKey,
    };
    if (isModifierCode(event.code)) {
      setHeld(heldText(press));
      return;
    }
    if (event.code === 'Escape' && heldText(press) === '') {
      stop();
      return;
    }
    setHeld('');
    void setHotkeyKeys(press).then((taken) => {
      if (taken) {
        setPressing(false);
        pauseHotkey(false);
      }
    });
  };
  return (
    <div className="background-keys">
      <p className="small">
        Keys: <kbd data-testid="background-hotkey-keys">{keys}</kbd>
      </p>
      {pressing ? (
        <div className="row-actions wrap">
          <input
            className="text-input"
            readOnly
            autoFocus
            data-testid="background-hotkey-field"
            aria-label="Press the keys you want"
            placeholder="Press the keys you want"
            value={held}
            onFocus={() => {
              pauseHotkey(true);
            }}
            onBlur={stop}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => {
              setHeld(
                heldText({
                  ctrl: event.ctrlKey,
                  alt: event.altKey,
                  shift: event.shiftKey,
                  win: event.metaKey,
                }),
              );
            }}
          />
          <button
            type="button"
            className="button"
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={stop}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="row-actions wrap">
          <button
            type="button"
            className="button"
            data-testid="background-hotkey-change"
            disabled={disabled}
            onClick={() => {
              setPressing(true);
            }}
          >
            Change keys
          </button>
        </div>
      )}
      {refused ? (
        <p className="small" role="alert" data-testid="background-keys-problem">
          {refused}
        </p>
      ) : null}
    </div>
  );
}
