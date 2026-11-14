import type { BuildThing } from '@atlas/core';
import type { OwnList } from '@atlas/schema';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { UiIcon } from '../components/icons';
import {
  addToBuild,
  buildListsOf,
  newBuildList,
  rememberBuildList,
  rememberedBuildList,
} from '../state/buildPlanner';
import { numberFormat } from '../state/derived';
import type { LoadedGame } from '../state/store';
import '../styles/editor.css';

/**
 * Which Build guide to add to: one of the person's, or a new one. With a
 * thing, it is added to the list chosen; without, the list is only
 * remembered for the next thing.
 */
export function BuildListDialog({
  game,
  thing,
  onClose,
}: {
  game: LoadedGame;
  thing: BuildThing | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const labelId = useId();
  const nameId = useId();
  const lists = buildListsOf();
  const remembered = rememberedBuildList(game);
  const [chosen, setChosen] = useState<string>(
    remembered?.checklist.id ?? lists[0]?.checklist.id ?? NEW,
  );
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const options = () => [...lists.map((list) => list.checklist.id), NEW];

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (lists.length === 0) nameRef.current?.focus();
    else radios.current[Math.max(0, options().indexOf(chosen))]?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
    // Once, as it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKey = (event: KeyboardEvent, index: number) => {
    const by =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? -1
          : 0;
    if (!by) return;
    event.preventDefault();
    const all = options();
    const next = (index + by + all.length) % all.length;
    setChosen(all[next]!);
    radios.current[next]?.focus();
  };

  const finish = () => {
    let list: OwnList | null | undefined;
    if (chosen === NEW) {
      list = newBuildList(game, name);
      if (!list) {
        setProblem('Your lists cannot be changed right now.');
        return;
      }
    } else {
      list = lists.find((l) => l.checklist.id === chosen);
      if (!list) return;
    }
    const id = list.checklist.id;
    onClose();
    if (thing) addToBuild(game, id, thing);
    else rememberBuildList(game, id);
  };

  const stepsText = (list: OwnList) =>
    list.items.length === 1 ? 'one step' : `${numberFormat.format(list.items.length)} steps`;

  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small"
      aria-labelledby={titleId}
      data-testid="build-list-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <form
        className="own-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          finish();
        }}
      >
        <header className="own-dialog-head">
          <h2 id={titleId} className="own-dialog-title">
            {thing ? 'Add to a build guide' : 'Build guide to add to'}
          </h2>
          <button
            type="button"
            className="touch-icon-button own-dialog-close"
            aria-label="Close"
            onClick={onClose}
          >
            <UiIcon name="close" size={20} strokeWidth={1.8} />
          </button>
        </header>
        <p className="own-dialog-line">
          {thing ? `“${thing.name}” goes at the end of the list. ` : ''}
          What you add next goes to the same list, until you change it.
        </p>
        <div id={labelId} className="own-label own-group-label">
          Build guide
        </div>
        <div role="radiogroup" aria-labelledby={labelId} className="own-copy-list">
          {options().map((id, index) => {
            const list = lists.find((l) => l.checklist.id === id);
            const checked = id === chosen;
            return (
              <button
                key={id}
                ref={(element) => {
                  radios.current[index] = element;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="own-copy-row"
                data-testid={list ? 'build-list-choice' : 'build-list-new'}
                onClick={() => {
                  setChosen(id);
                  setProblem(null);
                  if (!list) requestAnimationFrame(() => nameRef.current?.focus());
                }}
                onKeyDown={(event) => {
                  onKey(event, index);
                }}
              >
                <span className="own-template-icon">
                  <UiIcon name={list ? 'numbered' : 'plus'} size={18} strokeWidth={1.7} />
                </span>
                <span className="own-copy-text">
                  <span className="own-copy-name">
                    {list ? list.checklist.name : 'A new build guide'}
                  </span>
                  <span className="own-copy-detail">
                    {list ? stepsText(list) : 'A list of your own, template Build guide'}
                  </span>
                </span>
                <span className="own-template-check" aria-hidden="true">
                  {checked ? <UiIcon name="check" size={14} strokeWidth={2.8} /> : null}
                </span>
              </button>
            );
          })}
        </div>
        {chosen === NEW ? (
          <div className="own-field">
            <label htmlFor={nameId} className="own-label">
              Name of the new build guide
            </label>
            <input
              ref={nameRef}
              id={nameId}
              className="own-input"
              type="text"
              value={name}
              maxLength={120}
              autoComplete="off"
              placeholder="My build"
              data-testid="build-list-name"
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
            />
          </div>
        ) : null}
        {problem ? (
          <p className="own-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            data-testid="build-list-done"
          >
            {thing ? 'Add' : 'Use this list'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** The choice of a new list, among the lists' ids. */
const NEW = 'new';
