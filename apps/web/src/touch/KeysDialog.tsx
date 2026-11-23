import { useEffect, useId, useRef } from 'react';
import { UiIcon } from '../components/icons';
import { CONTEXTS, guideRows, keyLabel, wordsOf } from '../input/bindings';
import { PadGlyphs } from '../input/PadGlyph';
import { glyphStyle, usePad } from '../input/padState';
import { useAtlas } from '../state/store';
import { MOUSE_HELP, MOUSE_HELP_3D } from './keys';
import { setKeysOpen, useTouch } from './state';

/**
 * The guide of keys and controller, and what the mouse does on the map: the
 * `?` key, View on a controller, or the keyboard button. Each context has
 * a table of what can be done there, with its keys and its controller
 * buttons, from the one table of them (`input/bindings.ts`).
 */
export function KeysDialog() {
  const open = useTouch((s) => s.keysOpen);
  const game = useAtlas((s) => s.game);
  const style = usePad(glyphStyle);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const lists = game && !game.checklists.isEmpty ? 'Lists' : null;

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
            <h2 id={titleId}>Keys and controller</h2>
            <button type="button" className="icon-button" aria-label="Close" onClick={close}>
              <UiIcon name="close" />
            </button>
          </header>
          {CONTEXTS.map((context) => {
            const rows = guideRows(context.id, { lists });
            if (rows.length === 0) return null;
            return (
              <section
                key={context.id}
                className="keys-group"
                aria-labelledby={`${titleId}-${context.id}`}
                data-testid={`keys-${context.id}`}
              >
                <h3 className="section-title" id={`${titleId}-${context.id}`}>
                  {context.title}
                </h3>
                <table className="keys-table">
                  <thead>
                    <tr>
                      <th scope="col">What</th>
                      <th scope="col">Keyboard</th>
                      <th scope="col">Controller</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id} data-action={row.id}>
                        <td>{wordsOf(row, { lists })}</td>
                        <td className="keys-cell">
                          {row.keys.length > 0 ? (
                            row.keys.map((key) => <kbd key={key}>{keyLabel(key)}</kbd>)
                          ) : (
                            <span className="muted" aria-label="None">
                              –
                            </span>
                          )}
                        </td>
                        <td className="keys-cell keys-pad">
                          {row.pad.length > 0 ? (
                            <PadGlyphs buttons={row.pad} style={style} />
                          ) : (
                            <span className="muted" aria-label="None">
                              –
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            );
          })}
          <h3 className="section-title">Mouse, on the map</h3>
          <dl className="keys-list keys-list-mouse">
            {MOUSE_HELP.map((entry) => (
              <div key={entry.action} className="keys-row">
                <dt>{entry.action}</dt>
                <dd>{entry.what}</dd>
              </div>
            ))}
          </dl>
          <h3 className="section-title">Mouse, in the 3D view</h3>
          <dl className="keys-list keys-list-mouse">
            {MOUSE_HELP_3D.map((entry) => (
              <div key={entry.action} className="keys-row">
                <dt>{entry.action}</dt>
                <dd>{entry.what}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small keys-note">
            The controller works where Atlas sees one: Settings says whether it does. Where Steam
            Input sends keys instead, the keys above work.
          </p>
        </div>
      ) : null}
    </dialog>
  );
}
