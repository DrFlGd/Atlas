import {
  hiddenParts,
  isOrdered,
  outlineOf,
  rowId,
  templateName,
  type OutlineRow,
} from '@atlas/core';
import type { OwnList } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { checklistBack } from '../../state/checklists';
import { numberFormat } from '../../state/derived';
import {
  deleteOwnList,
  exportOwnList,
  flushOwnLists,
  ownListById,
  restoreOwnList,
  useOwnLists,
  type SaveState,
} from '../../state/ownLists';
import { notify } from '../../state/actions';
import { type LoadedGame } from '../../state/store';
import { centreOn } from '../listViews';
import { TemplateDialog } from '../OwnLists';
import { AddPanel } from './AddPanel';
import {
  addHeading,
  changeEditedTemplate,
  closePanel,
  moveBy,
  moveTo,
  openAdd,
  openRow,
  renameEdited,
  setPicking,
  setPreview,
  stepNumber,
  stopEditing,
  suggestEditedOrder,
  useEditor,
} from './editorState';
import { locationDetail } from './locations';
import { HeadingPanel, StepPanel } from './StepPanel';
import '../../styles/editor.css';

/**
 * The list editor, on a wide screen: the list's outline in the panel (its
 * headings and numbered steps), the list on the map, and the open step (or
 * the ways to add steps) in a panel on the right. The map is the app's own,
 * with the list's locations numbered over it (`followMap` in
 * `editorState.ts`); a tap on a location adds it after the open step.
 */
export function EditorOutline({ game }: { game: LoadedGame }) {
  const listId = useEditor((s) => s.listId);
  const list = useOwnLists((s) => s.lists.find((l) => l.checklist.id === listId));
  if (!list) return null;
  return <Outline game={game} list={list} />;
}

/** The side panel on the right of the map: the open step or heading, or Add. */
export function EditorSide({ game }: { game: LoadedGame }) {
  const listId = useEditor((s) => s.listId);
  const panel = useEditor((s) => s.panel);
  const open = useEditor((s) => s.open);
  const list = useOwnLists((s) => s.lists.find((l) => l.checklist.id === listId));
  if (!list || !panel) return null;
  if (panel === 'add') return <AddPanel game={game} list={list} />;
  const row = outlineOf(list).find((r) => rowId(r) === open);
  if (!row) return null;
  return row.kind === 'heading' ? (
    <HeadingPanel key={row.heading.id} list={list} heading={row.heading} />
  ) : (
    <StepPanel key={row.item.id} game={game} list={list} item={row.item} />
  );
}

/** What the map says while the editor is open: what a tap does now. */
export function EditorMapHint() {
  const listId = useEditor((s) => s.listId);
  const open = useEditor((s) => s.open);
  const picking = useEditor((s) => s.picking);
  const picked = useEditor((s) => s.picked.length);
  const panel = useEditor((s) => s.panel);
  const tab = useEditor((s) => s.addTab);
  const list = useOwnLists((s) => s.lists.find((l) => l.checklist.id === listId));
  if (!list) return null;
  let text: string;
  if (picking) {
    text =
      picking.purpose === 'link'
        ? 'Tap a location to link it in the note'
        : 'Tap a location for this step';
  } else if (panel === 'add' && tab === 'type') {
    text =
      picked === 0
        ? 'Tick types of location to pick them'
        : `${numberFormat.format(picked)} ${picked === 1 ? 'location is' : 'locations are'} picked`;
  } else {
    const number = stepNumber(list, open);
    const rows = outlineOf(list);
    const openRow = rows.find((r) => rowId(r) === open);
    text =
      number > 0
        ? `Tap a location to add it after step ${number}`
        : openRow?.kind === 'heading'
          ? `Tap a location to add it under “${openRow.heading.title}”`
          : 'Tap a location to add it at the end';
  }
  return (
    <div className="touch-pill editor-map-hint" role="status" data-testid="editor-map-hint">
      <UiIcon name={picking ? 'pin' : 'plus'} size={18} strokeWidth={1.9} />
      <span className="editor-map-hint-text">{text}</span>
      {picking ? (
        <button
          type="button"
          className="editor-hint-cancel"
          onClick={() => {
            setPicking(null);
          }}
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}

/** The bar over a list shown in Preview, with the way back to editing. */
export function PreviewBar() {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="editor-preview-bar" data-testid="editor-preview-bar">
      <span className="editor-preview-label">
        <UiIcon name="eye" size={18} strokeWidth={1.8} />
        Preview: the list as it will be used
      </span>
      <button
        ref={ref}
        type="button"
        className="own-pill-button own-pill-primary editor-preview-back"
        data-testid="back-to-editing"
        onClick={() => {
          setPreview(false);
        }}
      >
        Back to editing
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The outline

const SAVE_TEXT: Record<SaveState, string> = {
  saved: 'saved',
  unsaved: 'saving…',
  saving: 'saving…',
  failed: 'not saved',
};

function Outline({ game, list }: { game: LoadedGame; list: OwnList }) {
  const save = useOwnLists((s) => s.save);
  const saveError = useOwnLists((s) => s.saveError);
  const open = useEditor((s) => s.open);
  const announce = useEditor((s) => s.announce);
  const panel = useEditor((s) => s.panel);
  const rows = useMemo(() => outlineOf(list), [list]);
  const steps = rows.filter((r) => r.kind === 'step').length;
  const type = list.checklist.type ?? 'collection';
  const ordered = isOrdered(type);
  const [menu, setMenu] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const hintId = useId();
  const drag = useRowDrag(rows);

  // Scroll the open row into view when it changes (a step added from the map).
  useEffect(() => {
    if (!open) return;
    const element = document.querySelector<HTMLElement>(
      `.editor-outline [data-row-id="${CSS.escape(open)}"]`,
    );
    element?.scrollIntoView({ block: 'nearest' });
  }, [open, rows]);

  const stepNumbers = useMemo(() => {
    const numbers = new Map<string, number>();
    let n = 0;
    for (const row of rows) if (row.kind === 'step') numbers.set(row.item.id, ++n);
    return numbers;
  }, [rows]);

  const headingCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let current: string | null = null;
    for (const row of rows) {
      if (row.kind === 'heading') {
        current = row.heading.id;
        counts.set(current, 0);
      } else if (current) {
        counts.set(current, counts.get(current)! + 1);
      }
    }
    return counts;
  }, [rows]);

  const leave = () => {
    stopEditing();
    checklistBack();
  };

  return (
    <div className="editor-outline" data-testid="list-editor" data-list-type={type}>
      <header className="editor-head">
        <button
          type="button"
          className="touch-icon-button editor-back"
          aria-label="Back to the lists"
          data-testid="editor-back"
          onClick={leave}
        >
          <UiIcon name="back" size={22} strokeWidth={1.8} />
        </button>
        <div className="editor-head-text">
          <ListName list={list} />
          <p className="editor-head-figure">
            {templateName(type)} ·{' '}
            {steps === 1 ? 'one step' : `${numberFormat.format(steps)} steps`} ·{' '}
            <span
              className={save === 'failed' ? 'editor-save editor-save-failed' : 'editor-save'}
              data-testid="save-state"
              data-state={save}
              title={saveError ?? undefined}
            >
              {SAVE_TEXT[save]}
            </span>
          </p>
        </div>
        <span className="editor-badge">Editing</span>
        <button
          ref={menuButton}
          type="button"
          className="touch-icon-button editor-menu-button"
          aria-label="List menu"
          aria-haspopup="menu"
          aria-expanded={menu}
          data-testid="list-menu"
          onClick={() => {
            setMenu(!menu);
          }}
        >
          <UiIcon name="more" size={22} strokeWidth={3} />
        </button>
        {menu ? (
          <ListMenu
            onClose={(refocus) => {
              setMenu(false);
              if (refocus) menuButton.current?.focus();
            }}
            onChangeTemplate={() => {
              setTemplateOpen(true);
            }}
            onExport={() => {
              void flushOwnLists().then(() =>
                exportOwnList(game, ownListById(list.checklist.id) ?? list),
              );
            }}
            onDelete={() => {
              setConfirmDelete(true);
            }}
          />
        ) : null}
      </header>
      {save === 'failed' ? (
        <p className="editor-save-problem" role="alert">
          Your changes could not be saved{saveError ? `: ${saveError}` : '.'}{' '}
          <button
            type="button"
            className="own-text-button"
            onClick={() => {
              void flushOwnLists();
            }}
          >
            Try again
          </button>
        </p>
      ) : null}
      <div className="editor-head-actions">
        <button
          type="button"
          className="own-pill-button editor-preview-button"
          data-testid="editor-preview"
          onClick={() => {
            setPreview(true);
          }}
        >
          <UiIcon name="eye" size={18} strokeWidth={1.8} />
          Preview
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-primary editor-done"
          data-testid="editor-done"
          onClick={() => {
            stopEditing();
          }}
        >
          Done
        </button>
      </div>
      <p id={hintId} className="visually-hidden">
        Alt with the up or down arrow moves a row. The handle can be dragged.
      </p>
      <ul
        className="touch-plain-list editor-rows"
        aria-label={`${list.checklist.name}, outline`}
        data-testid="editor-rows"
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        {rows.length === 0 ? (
          <li className="editor-empty">
            Nothing here yet. Tap a location on the map, or use Add below.
          </li>
        ) : null}
        {rows.map((row, index) => (
          <OutlineItem
            key={rowId(row)}
            game={game}
            row={row}
            index={index}
            open={rowId(row) === open}
            number={row.kind === 'step' ? stepNumbers.get(row.item.id)! : 0}
            headingCount={row.kind === 'heading' ? headingCounts.get(row.heading.id)! : 0}
            ordered={ordered}
            describedBy={hintId}
            dropBefore={drag.dropBefore === index}
            dropAfter={drag.dropBefore === rows.length && index === rows.length - 1}
            dragging={drag.dragId === rowId(row)}
            onHandleDown={drag.onHandleDown}
          />
        ))}
      </ul>
      <footer className="editor-foot">
        <button
          ref={addButton}
          type="button"
          className="own-pill-button"
          aria-pressed={panel === 'add'}
          data-testid="editor-add"
          onClick={() => {
            if (panel === 'add') closePanel();
            else openAdd();
          }}
        >
          <UiIcon name="plus" size={18} strokeWidth={1.9} />
          Add
        </button>
        <button
          type="button"
          className="own-pill-button"
          data-testid="editor-heading"
          onClick={addHeading}
        >
          Heading
        </button>
        <button
          type="button"
          className="own-pill-button editor-suggest"
          data-testid="editor-suggest"
          disabled={steps < 2}
          onClick={suggestEditedOrder}
        >
          Suggest an order
        </button>
      </footer>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>
      {templateOpen ? (
        <TemplateDialog
          game={game}
          mode={{
            kind: 'change',
            current: type,
            onChoose: (next) => {
              if (next === type) return;
              changeEditedTemplate(next);
              notify(`“${list.checklist.name}” is now a ${templateName(next).toLowerCase()}.`);
            },
          }}
          onClose={() => {
            setTemplateOpen(false);
            menuButton.current?.focus();
          }}
        />
      ) : null}
      {confirmDelete ? (
        <DeleteListDialog
          list={list}
          onClose={() => {
            setConfirmDelete(false);
            menuButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** The list's name, renamed in place: a click (or Enter) on it gives a field. */
function ListName({ list }: { list: OwnList }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(list.checklist.name);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const finish = (keep: boolean) => {
    if (keep && value.trim()) renameEdited(value);
    setEditing(false);
    requestAnimationFrame(() => button.current?.focus());
  };
  if (editing) {
    return (
      <input
        ref={input}
        className="editor-name-input"
        aria-label="List name"
        data-testid="editor-name-input"
        value={value}
        maxLength={120}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onBlur={() => {
          finish(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setValue(list.checklist.name);
            finish(false);
          }
        }}
      />
    );
  }
  return (
    <h1 className="editor-name">
      <button
        ref={button}
        type="button"
        className="editor-name-button"
        aria-label={`${list.checklist.name}. Rename`}
        data-testid="editor-name"
        title="Rename"
        onClick={() => {
          setValue(list.checklist.name);
          setEditing(true);
        }}
      >
        {list.checklist.name}
      </button>
    </h1>
  );
}

/** One row of the outline: a heading or a numbered step, with a handle to move it. */
function OutlineItem({
  game,
  row,
  index,
  open,
  number,
  headingCount,
  ordered,
  describedBy,
  dropBefore,
  dropAfter,
  dragging,
  onHandleDown,
}: {
  game: LoadedGame;
  row: OutlineRow;
  index: number;
  open: boolean;
  number: number;
  headingCount: number;
  ordered: boolean;
  describedBy: string;
  dropBefore: boolean;
  dropAfter: boolean;
  dragging: boolean;
  onHandleDown: (event: React.PointerEvent, id: string, index: number) => void;
}) {
  const id = rowId(row);
  const name = row.kind === 'heading' ? row.heading.title : row.item.name;
  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const target = event.currentTarget.dataset.part ?? 'row';
    moveBy(id, event.key === 'ArrowUp' ? -1 : 1);
    // The row was moved in the page: give it the focus back.
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(
          `.editor-outline [data-row-id="${CSS.escape(id)}"] [data-part="${target}"]`,
        )
        ?.focus();
    });
  };
  const className = [
    'editor-row',
    row.kind === 'heading' ? 'editor-row-heading' : 'editor-row-step',
    open ? 'editor-row-open' : '',
    dropBefore ? 'editor-drop-before' : '',
    dropAfter ? 'editor-drop-after' : '',
    dragging ? 'editor-row-dragging' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const handle = (
    <button
      type="button"
      className="editor-handle"
      data-part="handle"
      aria-label={`Move ${name}`}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        onHandleDown(event, id, index);
      }}
    >
      <UiIcon name="grip" size={18} strokeWidth={1.8} />
    </button>
  );
  if (row.kind === 'heading') {
    return (
      <li className={className} data-row-id={id} data-testid="editor-row" data-kind="heading">
        {handle}
        <button
          type="button"
          className="editor-row-main"
          data-part="row"
          aria-current={open ? 'true' : undefined}
          aria-describedby={describedBy}
          onKeyDown={onKeyDown}
          onClick={() => {
            openRow(id);
          }}
        >
          <span className="editor-heading-title">{name}</span>
          <span className="editor-heading-count">
            {headingCount === 1 ? '1 step' : `${numberFormat.format(headingCount)} steps`}
          </span>
        </button>
      </li>
    );
  }
  const item = row.item;
  const location = item.locationIds
    .map((locationId) => game.pack.locations.get(locationId))
    .find((l) => l !== undefined);
  const detail = location ? locationDetail(game, location.id) : 'No location';
  const hidden = item.note ? hiddenParts(item.note).length > 0 : false;
  const optional = ordered && item.optional === true;
  return (
    <li className={className} data-row-id={id} data-testid="editor-row" data-kind="step">
      {handle}
      <button
        type="button"
        className="editor-row-main"
        data-part="row"
        aria-current={open ? 'true' : undefined}
        aria-describedby={describedBy}
        onKeyDown={onKeyDown}
        onClick={() => {
          openRow(id);
          if (location) centreOn(game, location.id);
        }}
      >
        <span
          className={[
            'editor-number',
            location ? 'editor-number-place' : '',
            optional ? 'editor-number-optional' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        >
          {number}
        </span>
        <span className="editor-row-text">
          <span className="editor-row-name" data-testid="editor-row-name">
            <span className="visually-hidden">Step {number}: </span>
            {item.name}
          </span>
          <span className="editor-row-detail">{detail}</span>
        </span>
        {hidden ? (
          <span className="editor-mark" title="Has hidden text" data-testid="mark-hidden">
            <UiIcon name="eyeOff" size={18} strokeWidth={1.7} />
            <span className="visually-hidden">Has hidden text</span>
          </span>
        ) : null}
        {optional ? (
          <span className="editor-chip" data-testid="mark-optional">
            Optional
          </span>
        ) : null}
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Dragging rows

/**
 * Dragging a row by its handle, with a finger or a mouse: the row goes
 * where the line shows when it is let go.
 */
function useRowDrag(rows: readonly OutlineRow[]) {
  const [state, setState] = useState<{
    id: string;
    pointer: number;
    /** Middles of the rows' boxes, when the drag started. */
    middles: number[];
    from: number;
    before: number;
  } | null>(null);
  return {
    dragId: state?.id ?? null,
    dropBefore:
      state && state.before !== state.from && state.before !== state.from + 1 ? state.before : null,
    onHandleDown: (event: React.PointerEvent, id: string, index: number) => {
      if (event.button > 0) return;
      const list = (event.currentTarget as HTMLElement).closest('ul');
      if (!list) return;
      const middles = [...list.querySelectorAll<HTMLElement>('[data-row-id]')].map((element) => {
        const box = element.getBoundingClientRect();
        return box.top + box.height / 2;
      });
      list.setPointerCapture(event.pointerId);
      setState({ id, pointer: event.pointerId, middles, from: index, before: index });
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (state?.pointer !== event.pointerId) return;
      let before = state.middles.findIndex((middle) => event.clientY < middle);
      if (before < 0) before = state.middles.length;
      if (before !== state.before) setState({ ...state, before });
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (state?.pointer !== event.pointerId) return;
      const { id, from, before } = state;
      setState(null);
      // In the outline without the row being moved.
      const to = before > from ? before - 1 : before;
      if (to !== from && to >= 0 && to < rows.length) moveTo(id, to);
    },
    onPointerCancel: () => {
      setState(null);
    },
  };
}

// ---------------------------------------------------------------------------
// The list menu

function ListMenu({
  onClose,
  onChangeTemplate,
  onExport,
  onDelete,
}: {
  onClose: (refocus: boolean) => void;
  onChangeTemplate: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element;
      if (!ref.current?.contains(target) && !target.closest('[data-testid="list-menu"]')) {
        onClose(false);
      }
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [onClose]);
  const item = (label: string, testId: string, run: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={danger ? 'editor-menu-item editor-menu-danger' : 'editor-menu-item'}
      data-testid={testId}
      onClick={() => {
        onClose(false);
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      className="editor-menu"
      role="menu"
      aria-label="List"
      onKeyDown={(event) => {
        const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const by = event.key === 'ArrowDown' ? 1 : -1;
          items[(at + by + items.length) % items.length]?.focus();
        } else if (event.key === 'Tab') {
          onClose(false);
        }
      }}
    >
      {item('Change template…', 'menu-change-template', onChangeTemplate)}
      {item('Export…', 'menu-export', onExport)}
      {item('Delete list…', 'menu-delete', onDelete, true)}
    </div>
  );
}

/** Asks before deleting a list; Undo puts it back. */
function DeleteListDialog({ list, onClose }: { list: OwnList; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  const steps = list.items.length;
  return (
    <dialog
      ref={ref}
      className="own-dialog own-dialog-small"
      aria-labelledby={titleId}
      data-testid="delete-list-dialog"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="own-dialog-body">
        <h2 id={titleId} className="own-dialog-title">
          Delete “{list.checklist.name}”?
        </h2>
        <p className="own-dialog-line">
          {steps === 0
            ? 'The list is empty.'
            : `Its ${steps === 1 ? 'step goes' : `${numberFormat.format(steps)} steps go`} with it.`}{' '}
          Your found marks on the map stay.
        </p>
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" autoFocus onClick={onClose}>
            Keep it
          </button>
          <button
            type="button"
            className="own-pill-button own-pill-danger"
            data-testid="confirm-delete-list"
            onClick={() => {
              const deleted = deleteOwnList(list.checklist.id);
              onClose();
              stopEditing();
              checklistBack();
              if (deleted) {
                notify(`Deleted “${deleted.checklist.name}”.`, 'info', {
                  action: {
                    label: 'Undo',
                    run: () => {
                      restoreOwnList(deleted);
                      notify(`“${deleted.checklist.name}” is back.`);
                    },
                  },
                });
              }
            }}
          >
            Delete list
          </button>
        </footer>
      </div>
    </dialog>
  );
}
