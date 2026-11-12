import { useEffect, useId, useRef } from 'react';
import { UiIcon } from '../components/icons';
import { checklistScreenTitle } from '../state/checklists';
import { useAtlas } from '../state/store';
import { keyList, MOUSE_HELP } from './keys';
import { setKeysOpen, useTouch } from './state';

/** The list of keys, and what the mouse does on the map: the `?` key, or the keyboard button. */
export function KeysDialog() {
  const open = useTouch((s) => s.keysOpen);
  const game = useAtlas((s) => s.game);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const lists = game && !game.checklists.isEmpty ? checklistScreenTitle(game) : null;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const close = () => {
    setKeysOpen(false);
  };
  return (
    <dialog
      ref={ref}
      className="dialog keys-dialog"
      aria-labelledby={titleId}
      data-testid="keys-dialog"
      onClose={close}
      onClick={(event) => {
        if (event.target === ref.current) close();
      }}
    >
      {open ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Keys and mouse</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={close}>
              <UiIcon name="close" />
            </button>
          </header>
          <h3 className="section-title">Keyboard</h3>
          <dl className="keys-list">
            {keyList(lists).map((entry) => (
              <div key={entry.what} className="keys-row">
                <dt>
                  {entry.keys.map((key) => (
                    <kbd key={key}>{key}</kbd>
                  ))}
                </dt>
                <dd>{entry.what}</dd>
              </div>
            ))}
          </dl>
          <h3 className="section-title">Mouse, on the map</h3>
          <dl className="keys-list keys-list-mouse">
            {MOUSE_HELP.map((entry) => (
              <div key={entry.action} className="keys-row">
                <dt>{entry.action}</dt>
                <dd>{entry.what}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </dialog>
  );
}
