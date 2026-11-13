import { useId, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import type { BlockModel, ListModel, TableModel } from '../../markdownEdit/blocks';
import {
  insertBlockAfter,
  moveBlock,
  newBlock,
  removeBlock,
  replaceBlock,
  withModel,
  withSource,
  type EditBlock,
} from '../../markdownEdit/draft';
import { inlineLength, insertInline, splitInline, type Inline } from '../../markdownEdit/inline';
import {
  addRow,
  cellAt,
  indentItem,
  itemAt,
  outdentItem,
  removeItem,
  setCell,
  splitItem,
  setItemContent,
} from '../../markdownEdit/structure';
import { InlineField, type FieldKey } from './InlineField';
import {
  changeBlock,
  currentList,
  fieldOfCell,
  fieldOfList,
  fieldOfQuote,
  setModel,
} from './pageActions';
import {
  changePage,
  focusField,
  rereadBlocks,
  setFocusedBlock,
  usePageEditor,
} from './pageEditorState';

/**
 * The page in the formatted view: each block with tools of its own type
 * (a paragraph's or heading's text, a list's items, a table's cells, a
 * quote, code), and a menu to move it, edit it as Markdown or delete it.
 * What has no tools of its own is edited as Markdown, kept as written.
 */

export function PageBlocks() {
  const page = usePageEditor((s) => s.page);
  return (
    <div className="pe-blocks" data-testid="page-blocks">
      {page.blocks.map((block, index) => (
        <BlockFrame
          key={block.key}
          block={block}
          first={index === 0}
          last={index === page.blocks.length - 1}
        />
      ))}
      <button
        type="button"
        className="pe-add-paragraph"
        data-testid="add-paragraph"
        onClick={() => {
          const last = page.blocks.at(-1);
          if (last?.model.kind === 'paragraph' && inlineLength(last.model.content) === 0) {
            focusField(`${last.key}`, 0);
            return;
          }
          changePage((p) => {
            const block = newBlock(p);
            focusField(`${block.key}`, 0);
            return insertBlockAfter(p, null, block);
          });
        }}
      >
        {page.blocks.length === 0 ? 'Start writing' : 'Add text at the end'}
      </button>
    </div>
  );
}

function BlockFrame({ block, first, last }: { block: EditBlock; first: boolean; last: boolean }) {
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const focused = usePageEditor((s) => s.focused?.block === block.key);
  const raw = block.model.kind === 'raw' || block.asText;
  return (
    <div
      className={`pe-block pe-block-${block.asText ? 'text' : block.model.kind}${focused ? ' pe-block-focused' : ''}`}
      data-testid="page-block"
      data-block={block.key}
      data-kind={block.asText ? 'markdown' : block.model.kind}
    >
      <div className="pe-block-side">
        <button
          type="button"
          className="pe-block-handle"
          aria-label="Move, edit as Markdown or delete this part"
          title="Move, edit as Markdown or delete this part"
          aria-haspopup="menu"
          aria-expanded={menu}
          aria-controls={menu ? menuId : undefined}
          data-testid="block-menu"
          onClick={() => {
            setMenu(!menu);
          }}
          onKeyDown={(event) => {
            if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
              event.preventDefault();
              changePage((page) => moveBlock(page, block.key, event.key === 'ArrowUp' ? -1 : 1));
            }
          }}
        >
          <UiIcon name="grip" size={16} />
        </button>
        {menu ? (
          <div
            id={menuId}
            className="pe-menu"
            role="menu"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setMenu(false);
              }
            }}
          >
            <MenuItem
              disabled={first}
              onClick={() => {
                setMenu(false);
                changePage((page) => moveBlock(page, block.key, -1));
              }}
            >
              Move up
            </MenuItem>
            <MenuItem
              disabled={last}
              onClick={() => {
                setMenu(false);
                changePage((page) => moveBlock(page, block.key, 1));
              }}
            >
              Move down
            </MenuItem>
            {block.model.kind !== 'raw' ? (
              <MenuItem
                testId="block-as-markdown"
                onClick={() => {
                  setMenu(false);
                  if (block.asText) rereadBlocks();
                  else changeBlock(block.key, (b) => ({ ...b, asText: true }));
                }}
              >
                {block.asText ? 'Edit with the text tools' : 'Edit as Markdown'}
              </MenuItem>
            ) : null}
            <MenuItem
              danger
              testId="block-delete"
              onClick={() => {
                setMenu(false);
                changePage((page) => removeBlock(page, block.key));
              }}
            >
              Delete this part
            </MenuItem>
          </div>
        ) : null}
      </div>
      <div className="pe-block-main">
        {raw ? <MarkdownBlock block={block} /> : <BlockBody block={block} />}
      </div>
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  disabled,
  danger,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`pe-menu-item${danger ? ' pe-menu-danger' : ''}`}
      disabled={disabled}
      data-testid={testId}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function BlockBody({ block }: { block: EditBlock }) {
  const { model, key } = block;
  switch (model.kind) {
    case 'paragraph':
      return <ParagraphBlock block={block} content={model.content} />;
    case 'heading':
      return <HeadingBlock block={block} level={model.level} content={model.content} />;
    case 'list':
      return <ListBlock blockKey={key} list={model} />;
    case 'table':
      return <TableBlock blockKey={key} table={model} />;
    case 'quote':
      return <QuoteBlock blockKey={key} paragraphs={model.paragraphs} />;
    case 'code':
      return <CodeBlock blockKey={key} model={model} />;
    case 'rule':
      return (
        <div
          className="pe-rule"
          role="separator"
          tabIndex={0}
          aria-label="A line across the page"
          onFocus={() => {
            setFocusedBlock(key);
          }}
        />
      );
    case 'raw':
      return null;
  }
}

/** Enter in a paragraph or heading: the text after the place goes to a new paragraph. */
function splitText(
  key: number,
  [start, end]: [number, number],
  pieces: Inline[],
  heading: number | null,
) {
  const [before, after] = splitInline(insertInline(pieces, start, end, []), start);
  changeBlock(key, (block, page) => {
    const first = withModel(
      page,
      block,
      heading === null
        ? { kind: 'paragraph', content: before }
        : { kind: 'heading', level: heading, setext: false, content: before },
    );
    const second = newBlock(page, { kind: 'paragraph', content: after });
    focusField(`${second.key}`, 0);
    return [first, second];
  });
}

/** Backspace at the start of a paragraph: it joins the paragraph or heading before it. */
function joinPrevious(key: number, pieces: Inline[]): boolean {
  const page = usePageEditor.getState().page;
  const at = page.blocks.findIndex((b) => b.key === key);
  const previous = page.blocks[at - 1];
  if (!previous || previous.asText) return false;
  const model = previous.model;
  if (model.kind !== 'paragraph' && model.kind !== 'heading') return false;
  const length = inlineLength(model.content);
  changePage((p) => {
    const prev = p.blocks.find((b) => b.key === previous.key)!;
    const joined = withModel(p, prev, { ...model, content: [...model.content, ...pieces] });
    focusField(`${previous.key}`, length);
    return removeBlock(replaceBlock(p, previous.key, joined), key);
  });
  return true;
}

function ParagraphBlock({ block, content }: { block: EditBlock; content: Inline[] }) {
  return (
    <InlineField
      id={`${block.key}`}
      block={block.key}
      pieces={content}
      context="block"
      label="Text"
      placeholder="Write here"
      testId="paragraph-field"
      onChange={(pieces, typing) => {
        setModel(block.key, { kind: 'paragraph', content: pieces }, typing);
      }}
      onKey={(key, selection, pieces) => {
        if (key === 'Enter') {
          splitText(block.key, selection, pieces, null);
          return true;
        }
        if (key === 'BackspaceAtStart') return joinPrevious(block.key, pieces);
        return false;
      }}
    />
  );
}

function HeadingBlock({
  block,
  level,
  content,
}: {
  block: EditBlock;
  level: number;
  content: Inline[];
}) {
  return (
    <InlineField
      id={`${block.key}`}
      block={block.key}
      pieces={content}
      context="line"
      label={`Heading ${level}`}
      className={`pe-heading pe-heading-${level}`}
      placeholder="Heading"
      testId="heading-field"
      onChange={(pieces, typing) => {
        const model = block.model.kind === 'heading' ? block.model : null;
        setModel(
          block.key,
          { kind: 'heading', level, setext: model?.setext ?? false, content: pieces },
          typing,
        );
      }}
      onKey={(key, selection, pieces) => {
        if (key === 'Enter') {
          splitText(block.key, selection, pieces, level);
          return true;
        }
        return false;
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Lists

function ListBlock({ blockKey, list }: { blockKey: number; list: ListModel }) {
  return <ListLevel blockKey={blockKey} root={list} level={list} path={[]} />;
}

function ListLevel({
  blockKey,
  root,
  level,
  path,
}: {
  blockKey: number;
  root: ListModel;
  level: ListModel;
  path: number[];
}) {
  const Tag = level.ordered ? 'ol' : 'ul';
  return (
    <Tag className="pe-list" start={level.ordered && level.start !== 1 ? level.start : undefined}>
      {level.items.map((item, index) => {
        const here = [...path, index];
        return (
          <li key={index} className="pe-list-item">
            <InlineField
              id={fieldOfList(blockKey, here)}
              block={blockKey}
              pieces={item.content}
              context="block"
              label={`List item ${here.map((n) => n + 1).join('.')}`}
              placeholder="List item"
              testId="list-item-field"
              onChange={(pieces, typing) => {
                setModel(
                  blockKey,
                  setItemContent(currentList(blockKey) ?? root, here, pieces),
                  typing,
                );
              }}
              onKey={(key, selection, pieces) => listKey(blockKey, here, key, selection, pieces)}
            />
            {item.children ? (
              <ListLevel blockKey={blockKey} root={root} level={item.children} path={here} />
            ) : null}
          </li>
        );
      })}
    </Tag>
  );
}

function listKey(
  blockKey: number,
  path: number[],
  key: FieldKey,
  [start, end]: [number, number],
  pieces: Inline[],
): boolean {
  const list = currentList(blockKey);
  if (!list) return false;
  if (key === 'Tab' || key === 'ShiftTab') {
    const moved = key === 'Tab' ? indentItem(list, path) : outdentItem(list, path);
    if (moved) {
      setModel(blockKey, moved.list);
      focusField(fieldOfList(blockKey, moved.path), start);
    }
    return true;
  }
  if (key === 'Enter') {
    const item = itemAt(list, path);
    if (inlineLength(pieces) === 0 && !item?.children) {
      // Enter in an empty item: out of the list, a level at a time.
      const out = outdentItem(list, path);
      if (out) {
        setModel(blockKey, out.list);
        focusField(fieldOfList(blockKey, out.path), 0);
        return true;
      }
      const rest = removeItem(list, path);
      changeBlock(blockKey, (block, page) => {
        const paragraph = newBlock(page);
        focusField(`${paragraph.key}`, 0);
        return rest.items.length > 0 ? [withModel(page, block, rest), paragraph] : [paragraph];
      });
      return true;
    }
    const [before, after] = splitInline(insertInline(pieces, start, end, []), start);
    const split = splitItem(list, path, before, after);
    setModel(blockKey, split.list);
    focusField(fieldOfList(blockKey, split.path), 0);
    return true;
  }
  if (key === 'BackspaceAtStart') {
    const out = outdentItem(list, path);
    if (out) {
      setModel(blockKey, out.list);
      focusField(fieldOfList(blockKey, out.path), 0);
      return true;
    }
    const index = path[0]!;
    if (index === 0) {
      // The first item becomes a paragraph before the list.
      const rest = removeItem(list, path);
      changeBlock(blockKey, (block, page) => {
        const paragraph = newBlock(page, { kind: 'paragraph', content: pieces });
        focusField(`${paragraph.key}`, 0);
        return rest.items.length > 0 ? [paragraph, withModel(page, block, rest)] : [paragraph];
      });
      return true;
    }
    // Joined to the item before.
    const previous = list.items[index - 1]!;
    const length = inlineLength(previous.content);
    let joined = setItemContent(list, [index - 1], [...previous.content, ...pieces]);
    joined = removeItem(joined, path);
    setModel(blockKey, joined);
    focusField(fieldOfList(blockKey, [index - 1]), length);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tables

function currentTable(blockKey: number): TableModel | null {
  const block = usePageEditor.getState().page.blocks.find((b) => b.key === blockKey);
  return block?.model.kind === 'table' ? block.model : null;
}

const alignOf = (table: TableModel, column: number) => table.align[column] ?? undefined;

function TableBlock({ blockKey, table }: { blockKey: number; table: TableModel }) {
  const columns = table.header.length;
  const cell = (row: number, column: number) => {
    const Tag = row === 0 ? 'th' : 'td';
    return (
      <Tag
        key={column}
        style={{ textAlign: alignOf(table, column) }}
        scope={row === 0 ? 'col' : undefined}
      >
        <InlineField
          id={fieldOfCell(blockKey, row, column)}
          block={blockKey}
          pieces={cellAt(table, row, column)}
          context="cell"
          label={row === 0 ? `Heading of column ${column + 1}` : `Row ${row}, column ${column + 1}`}
          testId="table-cell"
          onChange={(pieces, typing) => {
            setModel(
              blockKey,
              setCell(currentTable(blockKey) ?? table, row, column, pieces),
              typing,
            );
          }}
          onKey={(key) => tableKey(blockKey, row, column, key)}
        />
      </Tag>
    );
  };
  return (
    <div className="pe-table-wrap">
      <table className="pe-table" data-testid="table-editor">
        <thead>
          <tr>{Array.from({ length: columns }, (_, column) => cell(0, column))}</tr>
        </thead>
        <tbody>
          {table.rows.map((_, r) => (
            <tr key={r}>{Array.from({ length: columns }, (_, column) => cell(r + 1, column))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function tableKey(blockKey: number, row: number, column: number, key: FieldKey): boolean {
  const table = currentTable(blockKey);
  if (!table) return false;
  const columns = table.header.length;
  const rows = table.rows.length + 1;
  if (key === 'Tab' || key === 'ShiftTab') {
    let index = row * columns + column + (key === 'Tab' ? 1 : -1);
    if (index < 0) return true;
    if (index >= rows * columns) {
      // Tab in the last cell: a new row.
      setModel(blockKey, addRow(table, rows - 1));
      index = rows * columns;
    }
    focusField(fieldOfCell(blockKey, Math.floor(index / columns), index % columns), 'end');
    return true;
  }
  if (key === 'Enter') {
    if (row + 1 >= rows) setModel(blockKey, addRow(table, rows - 1));
    focusField(fieldOfCell(blockKey, row + 1, column), 'end');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Quotes and code

function QuoteBlock({ blockKey, paragraphs }: { blockKey: number; paragraphs: Inline[][] }) {
  const current = () => {
    const block = usePageEditor.getState().page.blocks.find((b) => b.key === blockKey);
    return block?.model.kind === 'quote' ? block.model.paragraphs : paragraphs;
  };
  return (
    <blockquote className="pe-quote">
      {paragraphs.map((content, index) => (
        <InlineField
          key={index}
          id={fieldOfQuote(blockKey, index)}
          block={blockKey}
          pieces={content}
          context="block"
          label={`Quote, paragraph ${index + 1}`}
          testId="quote-field"
          onChange={(pieces, typing) => {
            const next = [...current()];
            next[index] = pieces;
            setModel(blockKey, { kind: 'quote', paragraphs: next }, typing);
          }}
          onKey={(key, [start, end], pieces) => {
            if (key !== 'Enter') return false;
            const list = [...current()];
            if (inlineLength(pieces) === 0 && index === list.length - 1 && list.length > 1) {
              // Enter in an empty last paragraph: out of the quote.
              list.pop();
              changeBlock(blockKey, (block, page) => {
                const paragraph = newBlock(page);
                focusField(`${paragraph.key}`, 0);
                return [withModel(page, block, { kind: 'quote', paragraphs: list }), paragraph];
              });
              return true;
            }
            const [before, after] = splitInline(insertInline(pieces, start, end, []), start);
            list.splice(index, 1, before, after);
            setModel(blockKey, { kind: 'quote', paragraphs: list });
            focusField(fieldOfQuote(blockKey, index + 1), 0);
            return true;
          }}
        />
      ))}
    </blockquote>
  );
}

function CodeBlock({
  blockKey,
  model,
}: {
  blockKey: number;
  model: Extract<BlockModel, { kind: 'code' }>;
}) {
  const infoId = useId();
  return (
    <div className="pe-code">
      {model.fence !== null ? (
        <label htmlFor={infoId} className="pe-code-info">
          <span>Language</span>
          <input
            id={infoId}
            className="own-input"
            value={model.info}
            spellCheck={false}
            onFocus={() => {
              setFocusedBlock(blockKey);
            }}
            onChange={(event) => {
              setModel(
                blockKey,
                { ...model, info: event.target.value.replace(/[`\n]/g, '') },
                true,
              );
            }}
          />
        </label>
      ) : null}
      <textarea
        className="pe-code-text"
        aria-label="Code"
        spellCheck={false}
        data-testid="code-field"
        rows={Math.min(20, Math.max(2, model.text.split('\n').length))}
        value={model.text.replace(/\n$/, '')}
        onFocus={() => {
          setFocusedBlock(blockKey);
        }}
        onChange={(event) => {
          setModel(blockKey, { ...model, text: `${event.target.value}\n` }, true);
        }}
      />
    </div>
  );
}

/** A part edited as Markdown: what has no tools, or what the person chose to. */
function MarkdownBlock({ block }: { block: EditBlock }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const why =
    block.model.kind === 'raw'
      ? block.model.why === 'hidden'
        ? 'Hidden text that runs across parts of the page is edited as Markdown.'
        : 'This part has no text tools of its own, so it is edited as Markdown.'
      : 'Edited as Markdown. Choose “Edit with the text tools” in its menu to go back.';
  const noteId = useId();
  return (
    <div className="pe-markdown-block">
      <p id={noteId} className="pe-note">
        {why}
      </p>
      <textarea
        ref={area}
        className="pe-markdown-text"
        aria-label="Markdown of this part"
        aria-describedby={noteId}
        spellCheck={false}
        data-testid="markdown-block"
        rows={Math.min(24, Math.max(3, block.source.split('\n').length + 1))}
        value={block.source}
        onFocus={() => {
          setFocusedBlock(block.key);
        }}
        onChange={(event) => {
          const source = event.target.value;
          // Kept as Markdown while it is typed, whatever it becomes.
          changeBlock(block.key, (b) => ({ ...withSource(b, source), asText: true }), true);
        }}
      />
    </div>
  );
}
