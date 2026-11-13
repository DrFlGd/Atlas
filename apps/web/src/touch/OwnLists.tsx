import { listType, templateName, TEMPLATES, type ChecklistEntry } from '@atlas/core';
import type { ChecklistType } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { UiIcon, type UiIconName } from '../components/icons';
import { notify } from '../state/actions';
import { numberFormat } from '../state/derived';
import {
  canChangeOwnLists,
  copyGameList,
  createOwnList,
  entryOfOwn,
  importOwnListText,
  pickListFile,
  useOwnLists,
} from '../state/ownLists';
import type { LoadedGame } from '../state/store';
import { startEditing } from './editor/editorState';
import { useTouch } from './state';
import '../styles/editor.css';

/**
 * The person's own lists on Lists: "Your own", above the game's lists, with
 * "New list or guide" and "Import a list" where lists can be made (from a
 * tablet's width up), and one quiet line saying so on a phone.
 */
export function OwnListsSection({
  game,
  row,
}: {
  game: LoadedGame;
  /** How a list is listed, as the game's lists are. */
  row: (entry: ChecklistEntry, template: string) => React.ReactNode;
}) {
  const status = useOwnLists((s) => s.status);
  const error = useOwnLists((s) => s.error);
  const readOnly = useOwnLists((s) => s.readOnly);
  const lists = useOwnLists((s) => s.lists);
  // Lists are made where the editor fits: a tablet on its side, or a computer.
  const room = useTouch((s) => s.editorRoom);
  const [dialog, setDialog] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const editable = status === 'ready' && readOnly === null;
  if (!room && lists.length === 0) {
    return (
      <p className="touch-note own-phone-note" data-testid="own-lists-phone-note">
        Your own lists and guides can be made on a wider screen: a tablet on its side, or a
        computer.
      </p>
    );
  }
  return (
    <section aria-labelledby="own-heading" data-testid="own-lists">
      <h2 className="touch-group-title touch-lists-heading" id="own-heading">
        Your own
      </h2>
      {status === 'error' ? <p className="touch-note own-note">{error}</p> : null}
      {readOnly ? <p className="touch-note own-note">{readOnly}</p> : null}
      {lists.length > 0 ? (
        <ul className="touch-plain-list touch-list-cards">
          {lists.map((list) => (
            <li key={list.checklist.id}>
              {row(entryOfOwn(game, list), templateName(list.checklist.type ?? 'collection'))}
            </li>
          ))}
        </ul>
      ) : null}
      {room ? (
        editable ? (
          <div className="own-actions">
            <button
              ref={newButton}
              type="button"
              className="own-new-button"
              data-testid="new-own-list"
              aria-haspopup="dialog"
              onClick={() => {
                setDialog(true);
              }}
            >
              <UiIcon name="plus" size={20} strokeWidth={1.9} />
              New list or guide
            </button>
            <button
              type="button"
              className="own-import-button"
              data-testid="import-own-list"
              onClick={() => {
                void importFromFile(game);
              }}
            >
              <UiIcon name="upload" size={18} strokeWidth={1.8} />
              Import a list
            </button>
          </div>
        ) : null
      ) : (
        <p className="touch-note own-phone-note" data-testid="own-lists-phone-note">
          Lists and guides can be made and changed on a wider screen: a tablet on its side, or a
          computer.
        </p>
      )}
      {dialog ? (
        <TemplateDialog
          game={game}
          mode={{ kind: 'new' }}
          onClose={() => {
            setDialog(false);
            newButton.current?.focus();
          }}
        />
      ) : null}
    </section>
  );
}

/** Asks for a list file and adds its list to the game's own lists, then opens it. */
async function importFromFile(game: LoadedGame): Promise<void> {
  let text: string | null;
  try {
    text = await pickListFile();
  } catch (error) {
    notify(
      `Could not open the file: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
    return;
  }
  if (text === null) return;
  const result = importOwnListText(game, text);
  if (!result.ok) {
    notify(result.error, 'error');
    return;
  }
  notify(`Imported “${result.list.checklist.name}”.`);
}

// ---------------------------------------------------------------------------
// New list or guide, and Change template

const ICONS: Record<ChecklistType, UiIconName> = {
  collection: 'grid',
  secrets: 'eyeOff',
  photos: 'image',
  route: 'route',
  build: 'numbered',
  plain: 'checklist',
};

export type TemplateDialogMode =
  | { kind: 'new' }
  /** Change the template of a list being edited. */
  | { kind: 'change'; current: ChecklistType; onChoose: (type: ChecklistType) => void };

/**
 * "New list or guide": a name, the six templates with what each offers,
 * or a copy of one of the game's lists. "Change template" is the same
 * choice for a list being edited; nothing in the list is lost.
 */
export function TemplateDialog({
  game,
  mode,
  onClose,
}: {
  game: LoadedGame;
  mode: TemplateDialogMode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nameId = useId();
  const groupId = useId();
  const [name, setName] = useState('');
  const [type, setType] = useState<ChecklistType>(
    mode.kind === 'change' ? mode.current : 'collection',
  );
  const [copying, setCopying] = useState(false);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (mode.kind === 'new') nameRef.current?.focus();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [mode.kind]);

  const chosen = TEMPLATES.find((t) => t.type === type)!;
  const gameLists = game.checklists.checklists;
  const copyEntry = gameLists.find((entry) => entry.checklist.id === copyId);

  const start = () => {
    if (mode.kind === 'change') {
      mode.onChoose(type);
      onClose();
      return;
    }
    if (!canChangeOwnLists()) {
      setProblem('Your lists cannot be changed right now.');
      return;
    }
    if (copying) {
      if (!copyEntry) {
        setProblem('Choose one of the game’s lists to copy.');
        return;
      }
      const list = copyGameList(game, copyEntry, name);
      if (list) {
        onClose();
        startEditing(list.checklist.id);
      }
      return;
    }
    if (!name.trim()) {
      setProblem('Give the list a name.');
      nameRef.current?.focus();
      return;
    }
    const list = createOwnList(game, name, type);
    if (list) {
      onClose();
      startEditing(list.checklist.id);
    }
  };

  return (
    <dialog
      ref={ref}
      className="own-dialog"
      aria-labelledby={titleId}
      data-testid="template-dialog"
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
          start();
        }}
      >
        <header className="own-dialog-head">
          <h2 id={titleId} className="own-dialog-title">
            {mode.kind === 'change'
              ? 'Change template'
              : copying
                ? 'Copy one of the game’s lists'
                : 'New list or guide'}
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

        {mode.kind === 'new' ? (
          <div className="own-field">
            <label htmlFor={nameId} className="own-label">
              Name
            </label>
            <input
              ref={nameRef}
              id={nameId}
              className="own-input"
              type="text"
              value={name}
              maxLength={120}
              autoComplete="off"
              placeholder={copyEntry ? copyEntry.checklist.name : 'My list'}
              data-testid="own-list-name"
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
            />
          </div>
        ) : (
          <p className="own-dialog-line">
            Every step, note and location stays. Only how the list is shown changes.
          </p>
        )}

        {copying ? (
          <CopyChoice
            game={game}
            lists={gameLists}
            chosen={copyId}
            onChoose={(id) => {
              setCopyId(id);
              setProblem(null);
            }}
          />
        ) : (
          <>
            <div id={groupId} className="own-label own-group-label">
              {mode.kind === 'change' ? 'Template' : 'Start from a template'}
            </div>
            <TemplateChoice
              labelledBy={groupId}
              value={type}
              onChange={(next) => {
                setType(next);
              }}
            />
            <div className="own-starts" aria-live="polite">
              <div className="own-starts-title">
                A{/^[aeiou1]/i.test(chosen.name) ? 'n' : ''} {chosen.name.toLowerCase()} starts with
              </div>
              <ul className="own-chips">
                {chosen.startsWith.map((line) => (
                  <li key={line} className="own-chip">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {problem ? (
          <p className="own-problem" role="alert">
            {problem}
          </p>
        ) : null}

        <footer className="own-dialog-foot">
          {mode.kind === 'new' ? (
            <button
              type="button"
              className="own-text-button"
              data-testid="copy-instead"
              onClick={() => {
                setCopying(!copying);
                setProblem(null);
              }}
            >
              {copying ? 'Start from a template instead' : 'Copy one of the game’s lists instead'}
            </button>
          ) : null}
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="own-pill-button own-pill-primary"
            data-testid="template-start"
          >
            {mode.kind === 'change' ? 'Change' : copying ? 'Copy' : 'Start'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

/** The six templates as a radio group: arrows move the choice, as in any radio group. */
function TemplateChoice({
  labelledBy,
  value,
  onChange,
}: {
  labelledBy: string;
  value: ChecklistType;
  onChange: (type: ChecklistType) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (event: KeyboardEvent, index: number) => {
    const by =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!by) return;
    event.preventDefault();
    const next = (index + by + TEMPLATES.length) % TEMPLATES.length;
    onChange(TEMPLATES[next]!.type);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="own-templates">
      {TEMPLATES.map((template, index) => {
        const checked = template.type === value;
        return (
          <button
            key={template.type}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className="own-template"
            data-testid={`template-${template.type}`}
            onClick={() => {
              onChange(template.type);
            }}
            onKeyDown={(event) => {
              onKey(event, index);
            }}
          >
            <span className="own-template-icon">
              <UiIcon name={ICONS[template.type]} size={20} strokeWidth={1.7} />
            </span>
            <span className="own-template-name">{template.name}</span>
            <span className="own-template-line">{template.line}</span>
            <span className="own-template-offers">{template.offers}</span>
            <span className="own-template-check" aria-hidden="true">
              {checked ? <UiIcon name="check" size={14} strokeWidth={2.8} /> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The game's lists to copy one of, as a radio group. */
function CopyChoice({
  game,
  lists,
  chosen,
  onChoose,
}: {
  game: LoadedGame;
  lists: readonly ChecklistEntry[];
  chosen: string | null;
  onChoose: (id: string) => void;
}) {
  const labelId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const rows = useMemo(
    () =>
      lists.map((entry) => ({
        entry,
        type: listType(entry),
        steps: entry.items.length,
      })),
    [lists],
  );
  const focusable = chosen ?? rows[0]?.entry.checklist.id ?? null;
  if (rows.length === 0) {
    return <p className="own-dialog-line">{game.pack.manifest.title} has no lists to copy.</p>;
  }
  return (
    <>
      <div id={labelId} className="own-label own-group-label">
        The copy is yours to change. The game’s list stays as it is.
      </div>
      <div role="radiogroup" aria-labelledby={labelId} className="own-copy-list">
        {rows.map(({ entry, type, steps }, index) => {
          const checked = entry.checklist.id === chosen;
          return (
            <button
              key={entry.checklist.id}
              ref={(element) => {
                refs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={entry.checklist.id === focusable ? 0 : -1}
              className="own-copy-row"
              data-testid="copy-choice"
              onClick={() => {
                onChoose(entry.checklist.id);
              }}
              onKeyDown={(event) => {
                const by =
                  event.key === 'ArrowDown' || event.key === 'ArrowRight'
                    ? 1
                    : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                      ? -1
                      : 0;
                if (!by) return;
                event.preventDefault();
                const next = (index + by + rows.length) % rows.length;
                onChoose(rows[next]!.entry.checklist.id);
                refs.current[next]?.focus();
              }}
            >
              <span className="own-template-icon">
                <UiIcon name={ICONS[type]} size={18} strokeWidth={1.7} />
              </span>
              <span className="own-copy-text">
                <span className="own-copy-name">{entry.checklist.name}</span>
                <span className="own-copy-detail">
                  {templateName(type)} ·{' '}
                  {steps === 1 ? 'one entry' : `${numberFormat.format(steps)} entries`}
                </span>
              </span>
              <span className="own-template-check" aria-hidden="true">
                {checked ? <UiIcon name="check" size={14} strokeWidth={2.8} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
