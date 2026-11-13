import { isOwnId } from '@atlas/schema';
import {
  addOwnPage,
  addOwnSection,
  deleteOwnPage,
  deleteOwnSection,
  moveEntry,
  newOwnId,
  pageChange,
  pageTitle,
  parentOf,
  renameSection,
  sectionsWithin,
  setPageHidden,
  stepInLayout,
  type ContentsParent,
} from '@atlas/core';
import type { PagesLayout } from '@atlas/schema';
import { useId, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { guidesOf } from '../../state/guides';
import { changeContents, canChangeOwnPages, layoutOf, useOwnPages } from '../../state/ownPages';
import type { LoadedGame } from '../../state/store';
import { sectionChoices } from './pageActions';
import { MenuItem } from './PageBlocks';
import { ConfirmDialog, Modal } from './PageDialogs';
import { editNewPage, openPageEditor, packPage, usePageEditor } from './pageEditorState';

/**
 * The contents as the person arranges it, beside the page edited: sections
 * that hold pages and sections, each moved by dragging its handle, by
 * Alt+Up and Alt+Down on it, or from its menu ("Move up", "Move down",
 * "Move to section…"); new pages and sections of one's own; a wiki page
 * hidden or shown again; one's own deleted.
 */

interface Drop {
  id: string;
  /** Before the entry, after it, or into the section (at its end). */
  where: 'before' | 'after' | 'into';
}

/** The title of an entry of the contents, as shown. */
function titleOf(game: LoadedGame, id: string): string {
  const { contents } = guidesOf(game);
  const own = useOwnPages.getState().own;
  return (
    contents.section(id)?.title ??
    contents.guide(id)?.title ??
    own.sections.find((s) => s.id === id)?.title ??
    game.pack.data.sections?.find((s) => s.id === id)?.title ??
    game.pack.data.guides.find((g) => g.id === id)?.title ??
    id
  );
}

/** Where `id` goes for a drop on another entry: its new parent, and the entry it goes before. */
function dropPlace(layout: PagesLayout, drop: Drop): { to: ContentsParent; before: string | null } {
  if (drop.where === 'into') return { to: drop.id, before: null };
  const parent = parentOf(layout, drop.id) ?? null;
  const items = parent === null ? layout.top : (layout.sections[parent] ?? []);
  const at = items.indexOf(drop.id);
  if (drop.where === 'before') return { to: parent, before: drop.id };
  return { to: parent, before: items[at + 1] ?? null };
}

function move(game: LoadedGame, id: string, to: ContentsParent, before: string | null): void {
  const layout = layoutOf(game);
  if (to !== null && (to === id || sectionsWithin(layout, id).has(to))) return;
  changeContents(
    (own, l) => moveEntry(own, l, id, parentOf(l, id) ?? null, to, before),
    `Moved “${titleOf(game, id)}”`,
  );
}

function step(game: LoadedGame, id: string, by: -1 | 1): void {
  const layout = layoutOf(game);
  const place = stepInLayout(layout, id, parentOf(layout, id) ?? null, by);
  if (place) move(game, id, place.to, place.before);
}

export function ContentsEditor({ game }: { game: LoadedGame }) {
  // The contents follow the person's changes.
  useOwnPages((s) => s.own);
  const canChange = useOwnPages((s) => canChangeOwnPages(s));
  const layout = layoutOf(game);
  const editing = usePageEditor((s) => s.guideId);
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: 'rename'; id: string }
    | { kind: 'move'; id: string }
    | { kind: 'delete'; id: string }
    | { kind: 'new-section' }
    | null
  >(null);

  /** The parent and the place a new page or section goes: beside the page edited. */
  const newPlace = (): { to: ContentsParent; before: string | null } => {
    if (!editing) return { to: null, before: null };
    return { to: parentOf(layout, editing) ?? null, before: null };
  };

  const startDrag = (id: string, event: React.PointerEvent) => {
    if (!canChange) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ id, drop: null });
  };
  const dragMove = (event: React.PointerEvent) => {
    if (!drag) return;
    const element = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((e) => e instanceof HTMLElement && e.dataset.entry);
    if (!(element instanceof HTMLElement) || element.dataset.entry === drag.id) {
      setDrag({ ...drag, drop: null });
      return;
    }
    const rect = element.getBoundingClientRect();
    const y = (event.clientY - rect.top) / rect.height;
    const section = element.dataset.kind === 'section';
    const where: Drop['where'] = section
      ? y < 0.3
        ? 'before'
        : y > 0.7
          ? 'after'
          : 'into'
      : y < 0.5
        ? 'before'
        : 'after';
    setDrag({ ...drag, drop: { id: element.dataset.entry!, where } });
  };
  const endDrag = () => {
    if (drag?.drop) {
      const place = dropPlace(layout, drag.drop);
      move(game, drag.id, place.to, place.before);
    }
    setDrag(null);
  };

  const level = (items: readonly string[], depth: number): React.ReactNode =>
    items.map((id) => {
      const isSection = id in layout.sections;
      const dropHere = drag?.drop?.id === id ? drag.drop.where : null;
      return (
        <li key={id} className="pe-tree-item">
          <Row
            game={game}
            id={id}
            depth={depth}
            section={isSection}
            current={editing === id}
            dropHere={dropHere}
            dragging={drag?.id === id}
            canChange={canChange}
            onDragStart={(event) => {
              startDrag(id, event);
            }}
            onDragMove={dragMove}
            onDragEnd={endDrag}
            onDialog={(kind) => {
              setDialog({ kind, id });
            }}
          />
          {isSection ? (
            <ul className="touch-plain-list">{level(layout.sections[id] ?? [], depth + 1)}</ul>
          ) : null}
        </li>
      );
    });

  return (
    <nav className="pe-contents" aria-label="Contents" data-testid="contents-editor">
      <h2 className="pe-contents-title">Guides</h2>
      <p className="pe-note">{game.pack.manifest.title}. Drag to move a page or a section.</p>
      <div className="pe-contents-actions">
        <button
          type="button"
          className="own-pill-button"
          disabled={!canChange}
          data-testid="new-page"
          onClick={() => {
            const taken = new Set([
              ...game.pack.data.guides.map((g) => g.id),
              ...useOwnPages.getState().own.pages.map((p) => p.id),
            ]);
            const id = newOwnId(game.pack.manifest.gameId, 'guide', taken);
            const place = newPlace();
            const added = changeContents(
              (o, l) =>
                addOwnPage(
                  o,
                  l,
                  { id, title: 'New page', body: '' },
                  place.to,
                  place.before,
                  new Date(),
                ),
              'Added a page',
            );
            if (added) editNewPage(id);
          }}
        >
          <UiIcon name="plus" size={14} /> New page
        </button>
        <button
          type="button"
          className="own-pill-button"
          disabled={!canChange}
          data-testid="new-section"
          onClick={() => {
            setDialog({ kind: 'new-section' });
          }}
        >
          <UiIcon name="folder" size={14} /> New section
        </button>
      </div>
      <ul className="touch-plain-list pe-tree" data-testid="contents-tree">
        {level(layout.top, 0)}
      </ul>
      {dialog?.kind === 'rename' || dialog?.kind === 'new-section' ? (
        <NameDialog
          title={dialog.kind === 'rename' ? 'Rename the section' : 'New section'}
          initial={dialog.kind === 'rename' ? titleOf(game, dialog.id) : ''}
          action={dialog.kind === 'rename' ? 'Rename' : 'Add the section'}
          onClose={() => {
            setDialog(null);
          }}
          onName={(name) => {
            if (dialog.kind === 'rename') {
              const id = dialog.id;
              const packSection = game.pack.data.sections?.find((s) => s.id === id);
              changeContents(
                (o) => renameSection(o, packSection, id, name),
                `Renamed the section “${name}”`,
              );
            } else {
              const taken = new Set([
                ...(game.pack.data.sections ?? []).map((s) => s.id),
                ...useOwnPages.getState().own.sections.map((s) => s.id),
              ]);
              const id = newOwnId(game.pack.manifest.gameId, 'section', taken);
              const place = newPlace();
              changeContents(
                (o, l) => addOwnSection(o, l, { id, title: name }, place.to, place.before),
                `Added the section “${name}”`,
              );
            }
          }}
        />
      ) : null}
      {dialog?.kind === 'move' ? (
        <MoveDialog
          game={game}
          id={dialog.id}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <ConfirmDialog
          title={`Delete “${titleOf(game, dialog.id)}”?`}
          text={
            dialog.id in layout.sections
              ? 'What the section holds stays, where the section was.'
              : 'The page and its text go. You can undo this for a while.'
          }
          confirm={dialog.id in layout.sections ? 'Delete the section' : 'Delete the page'}
          testId="delete-entry-dialog"
          onClose={() => {
            setDialog(null);
          }}
          onConfirm={() => {
            const id = dialog.id;
            const title = titleOf(game, id);
            const section = id in layout.sections;
            if (!section && usePageEditor.getState().guideId === id) {
              usePageEditor.setState({
                guideId: null,
                base: { title: '', text: '' },
                title: '',
                text: '',
              });
            }
            changeContents(
              (o, l) => (section ? deleteOwnSection(o, l, id) : deleteOwnPage(o, l, id)),
              `Deleted “${title}”`,
            );
          }}
        />
      ) : null}
    </nav>
  );
}

function Row({
  game,
  id,
  depth,
  section,
  current,
  dropHere,
  dragging,
  canChange,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDialog,
}: {
  game: LoadedGame;
  id: string;
  depth: number;
  section: boolean;
  current: boolean;
  dropHere: Drop['where'] | null;
  dragging: boolean;
  canChange: boolean;
  onDragStart: (event: React.PointerEvent) => void;
  onDragMove: (event: React.PointerEvent) => void;
  onDragEnd: () => void;
  onDialog: (kind: 'rename' | 'move' | 'delete') => void;
}) {
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const own = useOwnPages((s) => s.own);
  const title = titleOf(game, id);
  const page = section ? undefined : own.pages.find((p) => p.id === id);
  const change = section ? null : pageChange(packPage(game, id), page);
  const mine = isOwnId(id);
  const tag = mine
    ? 'Yours'
    : change?.hidden
      ? 'Hidden'
      : change?.changed
        ? 'Changed by you'
        : null;
  return (
    <div
      className={`pe-tree-row${section ? ' pe-tree-section' : ''}${current ? ' pe-tree-current' : ''}${
        dragging ? ' pe-tree-dragging' : ''
      }${dropHere ? ` pe-drop-${dropHere}` : ''}`}
      style={{ paddingLeft: 4 + depth * 16 }}
      data-entry={id}
      data-kind={section ? 'section' : 'page'}
      data-testid="contents-row"
    >
      <button
        type="button"
        className="pe-drag"
        aria-label={`Move “${title}”: drag, or Alt with an arrow key`}
        title="Drag to move. Alt+Up or Alt+Down moves it too."
        disabled={!canChange}
        data-testid="contents-handle"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
            event.preventDefault();
            step(game, id, event.key === 'ArrowUp' ? -1 : 1);
          }
        }}
      >
        <UiIcon name="grip" size={14} />
      </button>
      {section ? (
        <span className="pe-tree-name pe-tree-section-name">
          <UiIcon name="folder" size={16} />
          {title}
        </span>
      ) : (
        <button
          type="button"
          className="pe-tree-name"
          aria-current={current ? 'page' : undefined}
          data-testid="contents-page"
          onClick={() => {
            openPageEditor(id);
          }}
        >
          {title}
        </button>
      )}
      {tag ? (
        <span className={`pe-tag${mine ? ' pe-tag-own' : ''}`} data-testid="contents-tag">
          {tag}
        </span>
      ) : null}
      <span className="pe-menu-anchor">
        <button
          type="button"
          className="pe-tree-more"
          aria-label={`More for “${title}”`}
          title="Move, rename, hide or delete"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          disabled={!canChange}
          data-testid="contents-more"
          onClick={() => {
            setMenu(!menu);
          }}
        >
          <UiIcon name="more" size={16} />
        </button>
        {menu ? (
          <div
            id={menuId}
            className="pe-menu pe-menu-right"
            role="menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setMenu(false);
              }
            }}
          >
            <MenuItem
              testId="contents-move-up"
              onClick={() => {
                setMenu(false);
                step(game, id, -1);
              }}
            >
              Move up
            </MenuItem>
            <MenuItem
              testId="contents-move-down"
              onClick={() => {
                setMenu(false);
                step(game, id, 1);
              }}
            >
              Move down
            </MenuItem>
            <MenuItem
              testId="contents-move-to"
              onClick={() => {
                setMenu(false);
                onDialog('move');
              }}
            >
              Move to section…
            </MenuItem>
            {section ? (
              <MenuItem
                onClick={() => {
                  setMenu(false);
                  onDialog('rename');
                }}
              >
                Rename the section
              </MenuItem>
            ) : null}
            {!section && !mine ? (
              <MenuItem
                testId="contents-hide"
                onClick={() => {
                  setMenu(false);
                  const hide = !change?.hidden;
                  changeContents(
                    (o) => setPageHidden(o, id, hide, new Date()),
                    hide ? `Hid “${title}” from the contents` : `Showed “${title}” again`,
                  );
                }}
              >
                {change?.hidden ? 'Show the page again' : 'Hide the page'}
              </MenuItem>
            ) : null}
            {mine ? (
              <MenuItem
                danger
                testId="contents-delete"
                onClick={() => {
                  setMenu(false);
                  onDialog('delete');
                }}
              >
                {section ? 'Delete the section' : 'Delete the page'}
              </MenuItem>
            ) : null}
          </div>
        ) : null}
      </span>
    </div>
  );
}

function NameDialog({
  title,
  initial,
  action,
  onName,
  onClose,
}: {
  title: string;
  initial: string;
  action: string;
  onName: (name: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputId = useId();
  const name = pageTitle(text);
  return (
    <Modal title={title} onClose={onClose} testId="name-dialog">
      <form
        className="pe-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name) return;
          onClose();
          onName(name);
        }}
      >
        <label htmlFor={inputId}>Name of the section</label>
        <input
          id={inputId}
          className="own-input"
          autoFocus
          value={text}
          data-testid="name-input"
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="own-pill-button own-pill-primary" disabled={!name}>
            {action}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** "Move to section…": the top of the contents, or a section not inside what is moved. */
function MoveDialog({ game, id, onClose }: { game: LoadedGame; id: string; onClose: () => void }) {
  const layout = layoutOf(game);
  const inside = sectionsWithin(layout, id);
  const parent = parentOf(layout, id) ?? null;
  const choices = sectionChoices(game).filter((s) => !inside.has(s.id) && s.id !== id);
  return (
    <Modal title={`Move “${titleOf(game, id)}” to…`} onClose={onClose} testId="move-dialog">
      <ul className="touch-plain-list pe-move-list">
        <li>
          <button
            type="button"
            className="pe-move-choice"
            disabled={parent === null}
            onClick={() => {
              onClose();
              move(game, id, null, null);
            }}
          >
            The top of the contents
          </button>
        </li>
        {choices.map((section) => (
          <li key={section.id}>
            <button
              type="button"
              className="pe-move-choice"
              style={{ paddingLeft: 12 + section.depth * 16 }}
              disabled={section.id === parent}
              data-testid="move-choice"
              onClick={() => {
                onClose();
                move(game, id, section.id, null);
              }}
            >
              {section.title}
            </button>
          </li>
        ))}
      </ul>
      <footer className="own-dialog-foot">
        <span className="own-space" />
        <button type="button" className="own-pill-button" onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Modal>
  );
}
