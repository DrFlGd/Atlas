import { useEffect, useId, useRef, useState } from 'react';
import { MAX_OWN_NAME_LENGTH } from '@atlas/schema';
import { renameMapOrLevelOf, type RenameTarget } from '../state/mapNames';
import { UiIcon } from './icons';

/**
 * "Rename…" beside a map or a level: in the map switcher and in the game's
 * details in the Library. It opens a dialog with the name to change, and
 * "Use the original name" once the person has given one (see
 * `state/mapNames.ts`). A finger, the mouse, the keys and a controller all
 * reach it: the dialog takes the focus, and Esc or B closes it.
 */
export function RenameMapButton({
  target,
  name,
  className = 'icon-button rename-map-button',
  withText = false,
}: {
  target: RenameTarget;
  /** The name shown now: the person's, or the pack's. */
  name: string;
  className?: string;
  /** "Rename…" in words beside the pencil, where there is room. */
  withText?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const what = target.kind === 'map' ? 'map' : 'level';
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={`Rename the ${what} ${name}…`}
        title={`Rename the ${what}…`}
        aria-haspopup="dialog"
        data-testid={`rename-${target.kind}`}
        data-id={target.id}
        onClick={(event) => {
          // Not a press of the row it sits in.
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <UiIcon name="pencil" size={16} />
        {withText ? 'Rename…' : null}
      </button>
      {open ? (
        <RenameMapDialog
          target={target}
          name={name}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function RenameMapDialog({
  target,
  name,
  onClose,
}: {
  target: RenameTarget;
  name: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  const noteId = useId();
  const [value, setValue] = useState(name);
  const [problem, setProblem] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const renamed = name !== target.original;
  const what = target.kind === 'map' ? 'map' : 'level';
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    input.current?.select();
  }, []);
  const run = (wanted: string | null) => {
    setWorking(true);
    void renameMapOrLevelOf(target, wanted).then((error) => {
      setWorking(false);
      if (error) setProblem(error);
      else onClose();
    });
  };
  return (
    <dialog
      ref={ref}
      className="dialog rename-map-dialog"
      aria-labelledby={titleId}
      data-testid="rename-map-dialog"
      onClose={onClose}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === ref.current) onClose();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) {
            setProblem('Give it a name, or use the original name.');
            return;
          }
          run(value);
        }}
      >
        <header className="dialog-head">
          <h2 id={titleId}>Rename the {what}</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <UiIcon name="close" />
          </button>
        </header>
        <label htmlFor={inputId} className="rename-map-label">
          Name
        </label>
        <input
          ref={input}
          id={inputId}
          className="text-input rename-map-input"
          maxLength={MAX_OWN_NAME_LENGTH}
          aria-describedby={noteId}
          data-testid="rename-map-input"
          value={value}
          disabled={working}
          onChange={(event) => {
            setValue(event.target.value);
            setProblem(null);
          }}
        />
        <p id={noteId} className="muted small" data-testid="rename-map-original">
          The original name is {target.original}. Your name is kept with your own data for this
          game, so reading the game again or updating it keeps it.
        </p>
        {problem ? (
          <p className="rename-map-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="row-actions wrap">
          <button
            type="submit"
            className="button button-primary"
            data-testid="rename-map-save"
            disabled={working}
          >
            Rename
          </button>
          {renamed ? (
            <button
              type="button"
              className="button"
              data-testid="rename-map-original-button"
              disabled={working}
              onClick={() => {
                run(null);
              }}
            >
              Use the original name
            </button>
          ) : null}
          <button type="button" className="button" disabled={working} onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
