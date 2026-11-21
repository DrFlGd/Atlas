import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { exitAtlas, useExitOffered } from '../state/exit';

/**
 * "Exit Atlas" (see `state/exit.ts`): a button at the head of Settings, and
 * a round one in the rail of the layout for fingers on a handheld, where
 * Game Mode gives the window no close button. Both ask first, in a dialog
 * that a finger, the mouse, the keys or a controller answer (the dialog
 * takes the focus, so the D-pad moves between its two buttons and B
 * closes it).
 */
export function ExitButton({ place }: { place: 'settings' | 'rail' }) {
  const offered = useExitOffered();
  const [asking, setAsking] = useState(false);
  if (!offered) return null;
  const open = () => {
    setAsking(true);
  };
  return (
    <>
      {place === 'rail' ? (
        <button
          type="button"
          className="touch-round-button touch-rail-tool"
          aria-label="Exit Atlas"
          title="Exit Atlas"
          aria-haspopup="dialog"
          data-testid="exit-rail"
          onClick={open}
        >
          <UiIcon name="power" size={20} />
        </button>
      ) : (
        <button
          type="button"
          className="button exit-button"
          aria-haspopup="dialog"
          data-testid="exit-settings"
          onClick={open}
        >
          <UiIcon name="power" size={18} />
          Exit Atlas
        </button>
      )}
      {asking ? (
        <ExitDialog
          onClose={() => {
            setAsking(false);
          }}
        />
      ) : null}
    </>
  );
}

function ExitDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const textId = useId();
  const [working, setWorking] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog exit-dialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      data-testid="exit-dialog"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2 id={titleId}>Exit Atlas?</h2>
        </header>
        <p id={textId}>
          Atlas closes. What you found and your settings are kept. Anything being downloaded or read
          stops where it is.
        </p>
        <div className="row-actions">
          <button
            type="button"
            className="button button-primary"
            data-testid="exit-confirm"
            disabled={working}
            autoFocus
            onClick={() => {
              setWorking(true);
              void exitAtlas().then((ended) => {
                if (!ended) onClose();
              });
            }}
          >
            Exit Atlas
          </button>
          <button type="button" className="button" disabled={working} onClick={onClose}>
            Stay
          </button>
        </div>
      </div>
    </dialog>
  );
}
