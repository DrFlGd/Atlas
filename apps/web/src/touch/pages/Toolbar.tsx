import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { emptyParagraph, newList, newTable } from '../../markdownEdit/blocks';
import { newBlock, withModel } from '../../markdownEdit/draft';
import {
  hasMarkIn,
  linkSpan,
  setLink,
  type Inline,
  type ToggleMark,
} from '../../markdownEdit/inline';
import { listTexts, setOrdered } from '../../markdownEdit/structure';
import {
  changeBlock,
  fieldOfCell,
  fieldOfList,
  focusedBlock,
  insertBlock,
  setModel,
  toggle,
  withField,
} from './pageActions';
import { MenuItem } from './PageBlocks';
import { focusedField, focusField, redoEdit, undoEdit, usePageEditor } from './pageEditorState';

/** What a toolbar dialog is for. */
export type ToolDialog = 'picture' | 'page-link' | 'location-link' | 'web-link' | null;

/** Keeps the focus (and the selection) in the text while a tool is pressed. */
const keepFocus = (event: React.MouseEvent | React.PointerEvent) => {
  event.preventDefault();
};

function ToolButton({
  label,
  icon,
  text,
  onClick,
  disabled,
  pressed,
  testId,
  ...rest
}: {
  label: string;
  icon?: Parameters<typeof UiIcon>[0]['name'];
  text?: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  testId?: string;
} & Pick<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-haspopup' | 'aria-expanded'>) {
  return (
    <button
      type="button"
      className={`pe-tool${pressed ? ' pe-tool-on' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      data-testid={testId}
      onMouseDown={keepFocus}
      onClick={onClick}
      {...rest}
    >
      {icon ? <UiIcon name={icon} size={18} /> : null}
      {text ? <span className="pe-tool-text">{text}</span> : null}
    </button>
  );
}

function setHeading(level: number): void {
  const block = focusedBlock();
  if (!block) return;
  const model = block.model;
  if (model.kind !== 'paragraph' && model.kind !== 'heading') return;
  const at = focusedField()?.selection()[0] ?? 0;
  setModel(
    block.key,
    level === 0
      ? { kind: 'paragraph', content: model.content }
      : {
          kind: 'heading',
          level,
          setext: model.kind === 'heading' && model.setext && level <= 2,
          content: model.content.filter((piece) => piece.kind !== 'break'),
        },
  );
  focusField(`${block.key}`, at);
}

/** A paragraph's lines, each as an item's text. */
function lines(content: Inline[]): Inline[][] {
  const out: Inline[][] = [[]];
  for (const piece of content) {
    if (piece.kind === 'soft' || piece.kind === 'break') out.push([]);
    else out.at(-1)!.push(piece);
  }
  return out.filter((line) => line.length > 0);
}

function setList(ordered: boolean): void {
  const block = focusedBlock();
  if (!block) {
    insertBlock(newList(ordered), (key) => fieldOfList(key, [0]));
    return;
  }
  const model = block.model;
  if (model.kind === 'list') {
    if (model.ordered !== ordered) {
      setModel(block.key, setOrdered(model, ordered));
      return;
    }
    // The same list again: its items become paragraphs.
    changeBlock(block.key, (b, page) => {
      const paragraphs = listTexts(model).map((content) =>
        newBlock(page, { kind: 'paragraph', content }),
      );
      const first = paragraphs[0];
      if (first) focusField(`${first.key}`, 0);
      return paragraphs.length > 0 ? paragraphs : [withModel(page, b, emptyParagraph())];
    });
    return;
  }
  if (model.kind === 'paragraph' || model.kind === 'heading') {
    const items = lines(model.content);
    const list = newList(ordered);
    list.items = (items.length > 0 ? items : [[]]).map((content) => ({ content, children: null }));
    setModel(block.key, list);
    focusField(fieldOfList(block.key, [0]), 'end');
    return;
  }
  insertBlock(newList(ordered), (key) => fieldOfList(key, [0]));
}

function setQuote(): void {
  const block = focusedBlock();
  if (!block) {
    insertBlock({ kind: 'quote', paragraphs: [[]] }, (key) => `${key}:q0`);
    return;
  }
  const model = block.model;
  if (model.kind === 'quote') {
    changeBlock(block.key, (_, page) =>
      model.paragraphs.map((content) => newBlock(page, { kind: 'paragraph', content })),
    );
    return;
  }
  if (model.kind === 'paragraph') {
    setModel(block.key, { kind: 'quote', paragraphs: [model.content] });
    focusField(`${block.key}:q0`, 'end');
    return;
  }
  insertBlock({ kind: 'quote', paragraphs: [[]] }, (key) => `${key}:q0`);
}

/** The text tools over the page. */
export function Toolbar({ openDialog }: { openDialog: (dialog: ToolDialog) => void }) {
  const focused = usePageEditor((s) => s.focused);
  const canUndo = usePageEditor((s) => s.undo.length > 0);
  const canRedo = usePageEditor((s) => s.redo.length > 0);
  const block = usePageEditor((s) =>
    s.focused ? s.page.blocks.find((b) => b.key === s.focused!.block) : undefined,
  );
  // Follows the selection, so Bold says whether the text chosen is bold.
  const [, setTick] = useState(0);
  useEffect(() => {
    const onChange = () => {
      setTick((n) => n + 1);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
    };
  }, []);
  const field = focused ? focusedField() : null;
  const selection = field?.selection() ?? [0, 0];
  const pieces = field?.pieces() ?? [];
  const has = (mark: ToggleMark) =>
    field !== null && hasMarkIn(pieces, selection[0], selection[1], mark);
  const chosen = selection[1] > selection[0];
  const kind = block?.asText ? 'markdown' : block?.model.kind;
  const textField = field !== null;
  const headingLevel = block?.model.kind === 'heading' ? block.model.level : 0;
  const listType =
    block?.model.kind === 'list' ? (block.model.ordered ? 'numbered' : 'bulleted') : null;

  return (
    <div className="pe-toolbar" role="toolbar" aria-label="Text tools" data-testid="text-tools">
      <Menu
        label="Heading"
        icon="heading"
        text={headingLevel ? `Heading ${headingLevel}` : 'Text'}
        disabled={kind !== 'paragraph' && kind !== 'heading'}
        testId="tool-heading"
      >
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                close();
                setHeading(0);
              }}
            >
              Normal text
            </MenuItem>
            {[1, 2, 3, 4, 5, 6].map((level) => (
              <MenuItem
                key={level}
                testId={`heading-${level}`}
                onClick={() => {
                  close();
                  setHeading(level);
                }}
              >
                Heading {level}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      <span className="pe-tool-gap" />
      <ToolButton
        label="Bold"
        text="B"
        testId="tool-bold"
        disabled={!textField || !chosen}
        pressed={has('strong')}
        onClick={() => {
          toggle('strong');
        }}
      />
      <ToolButton
        label="Italic"
        text="I"
        testId="tool-italic"
        disabled={!textField || !chosen}
        pressed={has('em')}
        onClick={() => {
          toggle('em');
        }}
      />
      <Menu label="List" icon="bullets" testId="tool-list">
        {(close) => (
          <>
            <MenuItem
              testId="list-bulleted"
              onClick={() => {
                close();
                setList(false);
              }}
            >
              {listType === 'bulleted' ? 'Not a list' : 'Bulleted list'}
            </MenuItem>
            <MenuItem
              testId="list-numbered"
              onClick={() => {
                close();
                setList(true);
              }}
            >
              {listType === 'numbered' ? 'Not a list' : 'Numbered list'}
            </MenuItem>
          </>
        )}
      </Menu>
      <ToolButton
        label="Add a table"
        icon="grid"
        testId="tool-table"
        onClick={() => {
          insertBlock(newTable(3, 2), (key) => fieldOfCell(key, 0, 0));
        }}
      />
      <ToolButton
        label="Add a picture"
        icon="image"
        testId="tool-picture"
        onClick={() => {
          openDialog('picture');
        }}
      />
      <span className="pe-tool-gap" />
      <ToolButton
        label="Link to a page"
        icon="book"
        testId="tool-page-link"
        disabled={!textField}
        onClick={() => {
          openDialog('page-link');
        }}
      />
      <ToolButton
        label="Link to a location"
        icon="pin"
        testId="tool-location-link"
        disabled={!textField}
        onClick={() => {
          openDialog('location-link');
        }}
      />
      <ToolButton
        label="Hidden text"
        icon="eyeOff"
        testId="tool-hidden"
        disabled={!textField || !chosen}
        pressed={has('hidden')}
        onClick={() => {
          toggle('hidden');
        }}
      />
      <Menu label="More text tools" icon="more" testId="tool-more">
        {(close) => (
          <>
            <MenuItem
              disabled={!textField || !chosen}
              onClick={() => {
                close();
                toggle('s');
              }}
            >
              {has('s') ? 'Not struck through' : 'Strikethrough'}
            </MenuItem>
            <MenuItem
              disabled={!textField || !chosen}
              onClick={() => {
                close();
                toggle('code');
              }}
            >
              {has('code') ? 'Not code' : 'Code in the text'}
            </MenuItem>
            <MenuItem
              disabled={!textField}
              testId="tool-web-link"
              onClick={() => {
                close();
                openDialog('web-link');
              }}
            >
              Link to a web page
            </MenuItem>
            <MenuItem
              disabled={!textField || !linkSpan(pieces, selection[0], selection[1])}
              testId="tool-remove-link"
              onClick={() => {
                close();
                withField((f, start, end, p) => {
                  const span = linkSpan(p, start, end);
                  if (span) f.apply(setLink(p, span.start, span.end, null), [span.start, span.end]);
                });
              }}
            >
              Remove the link
            </MenuItem>
            <MenuItem
              testId="tool-quote"
              onClick={() => {
                close();
                setQuote();
              }}
            >
              {kind === 'quote' ? 'Not a quote' : 'Quote'}
            </MenuItem>
            <MenuItem
              testId="tool-code-block"
              onClick={() => {
                close();
                insertBlock({ kind: 'code', fence: '```', info: '', text: '\n' });
              }}
            >
              Add code
            </MenuItem>
            <MenuItem
              testId="tool-rule"
              onClick={() => {
                close();
                insertBlock({ kind: 'rule' });
              }}
            >
              Add a line across the page
            </MenuItem>
          </>
        )}
      </Menu>
      <span className="pe-tool-space" />
      <ToolButton
        label="Undo"
        icon="undo"
        testId="tool-undo"
        disabled={!canUndo}
        onClick={undoEdit}
      />
      <ToolButton
        label="Redo"
        icon="forward"
        testId="tool-redo"
        disabled={!canRedo}
        onClick={redoEdit}
      />
    </div>
  );
}

/** A toolbar button that opens a menu of choices. */
export function Menu({
  label,
  icon,
  text,
  disabled,
  testId,
  children,
}: {
  label: string;
  icon?: Parameters<typeof UiIcon>[0]['name'];
  text?: string;
  disabled?: boolean;
  testId?: string;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return (
    <span
      ref={root}
      className="pe-menu-anchor"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <ToolButton
        label={label}
        icon={icon}
        text={text}
        disabled={disabled}
        testId={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      />
      {open ? (
        <div id={id} className="pe-menu" role="menu" aria-label={label}>
          {children(() => {
            setOpen(false);
          })}
        </div>
      ) : null}
    </span>
  );
}
