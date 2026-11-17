import { useEffect, useId, useRef } from 'react';
import type { ShownSelection } from '../state/selectShown';

/**
 * "Tick all" and "Tick none" above a list to tick, with a sentence that
 * says what they act on and how many are ticked (`selectShown.ts`). Each
 * button is disabled when it has nothing to do; the one pressed hands the
 * focus to the other, so the keyboard user is never left without a focus. The sentence
 * is read out politely when the count changes.
 */
export function SelectShown({
  selection,
  text,
  label,
  testId,
  onTick,
}: {
  selection: ShownSelection;
  /** The sentence beside the buttons, such as "This filter shows 12 pages, 3 of them ticked." */
  text: string;
  /** The name of the group of buttons, for screen readers: "Select the pages shown". */
  label: string;
  testId: string;
  onTick: (keys: readonly string[], on: boolean) => void;
}) {
  const textId = useId();
  const all = useRef<HTMLButtonElement>(null);
  const none = useRef<HTMLButtonElement>(null);
  // The button pressed has nothing left to do and is disabled once the list
  // follows: the other one then takes the focus.
  const focusNext = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const next = focusNext.current;
    focusNext.current = null;
    if (next && !next.disabled) next.focus();
  });
  const press = (on: boolean) => {
    const keys = on ? selection.toTick : selection.toUntick;
    if (keys.length === 0) return;
    const pressed = on ? all.current : none.current;
    if (pressed !== null && document.activeElement === pressed) {
      focusNext.current = on ? none.current : all.current;
    }
    onTick(keys, on);
  };
  return (
    <div className="select-shown" role="group" aria-label={label} data-testid={testId}>
      <button
        ref={all}
        type="button"
        className="button button-small"
        data-testid={`${testId}-all`}
        aria-describedby={textId}
        disabled={selection.toTick.length === 0}
        onClick={() => {
          press(true);
        }}
      >
        Tick all
      </button>
      <button
        ref={none}
        type="button"
        className="button button-small"
        data-testid={`${testId}-none`}
        aria-describedby={textId}
        disabled={selection.toUntick.length === 0}
        onClick={() => {
          press(false);
        }}
      >
        Tick none
      </button>
      <span
        id={textId}
        className="muted small select-shown-text"
        role="status"
        data-testid={`${testId}-text`}
      >
        {text}
      </span>
    </div>
  );
}
