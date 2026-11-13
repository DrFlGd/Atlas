import { isOwnId } from '@atlas/schema';

import { useId, useState } from 'react';
import type { Align } from '../../markdownEdit/blocks';
import { moveBlock } from '../../markdownEdit/draft';
import { insertInline, pieceLength, type Inline } from '../../markdownEdit/inline';
import {
  inlineSize,
  readPictureSize,
  widthSize,
  writePictureSize,
} from '../../markdownEdit/pictureSize';
import {
  addColumn,
  addRow,
  alignColumn,
  removeColumn,
  removeRow,
} from '../../markdownEdit/structure';
import { pictureOf } from '../../state/guides';
import { useOwnPages } from '../../state/ownPages';
import type { LoadedGame } from '../../state/store';
import { fieldOfCell, listAction, partOfField, setModel } from './pageActions';
import { PictureDialog } from './PageDialogs';
import {
  changeDraftPicture,
  changePage,
  choosePicture,
  fields,
  focusField,
  usePageEditor,
} from './pageEditorState';

const keepFocus = (event: React.MouseEvent) => {
  event.preventDefault();
};

function BarButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className="pe-bar-button"
      disabled={disabled}
      data-testid={testId}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The tools of what is being edited: a table's rows and columns, a list's levels, a picture. */
export function ContextBar({ game }: { game: LoadedGame }) {
  const focused = usePageEditor((s) => s.focused);
  const picture = usePageEditor((s) => s.picture);
  const block = usePageEditor((s) =>
    s.focused ? s.page.blocks.find((b) => b.key === s.focused!.block) : undefined,
  );
  if (picture && fields.has(picture.field)) return <PictureBar game={game} at={picture} />;
  if (!focused || !block || block.asText) return null;
  const part = partOfField(focused.field);
  if (block.model.kind === 'table' && part.kind === 'cell') {
    return <TableBar blockKey={block.key} row={part.row} column={part.column} />;
  }
  if (block.model.kind === 'list' && part.kind === 'item') {
    return <ListBar blockKey={block.key} path={part.path} />;
  }
  return null;
}

function TableBar({ blockKey, row, column }: { blockKey: number; row: number; column: number }) {
  const table = usePageEditor((s) => {
    const model = s.page.blocks.find((b) => b.key === blockKey)?.model;
    return model?.kind === 'table' ? model : null;
  });
  const alignId = useId();
  if (!table) return null;
  const columns = table.header.length;
  return (
    <div className="pe-context" role="toolbar" aria-label="Table tools" data-testid="table-tools">
      <BarButton
        testId="table-add-row"
        onClick={() => {
          setModel(blockKey, addRow(table, row));
          focusField(fieldOfCell(blockKey, row + 1, column), 0);
        }}
      >
        Add a row below
      </BarButton>
      <BarButton
        testId="table-remove-row"
        disabled={row === 0}
        onClick={() => {
          setModel(blockKey, removeRow(table, row));
          focusField(fieldOfCell(blockKey, Math.min(row, table.rows.length - 1), column), 'end');
        }}
      >
        Delete this row
      </BarButton>
      <BarButton
        testId="table-add-column"
        onClick={() => {
          setModel(blockKey, addColumn(table, column));
          focusField(fieldOfCell(blockKey, row, column + 1), 0);
        }}
      >
        Add a column to the right
      </BarButton>
      <BarButton
        testId="table-remove-column"
        disabled={columns <= 1}
        onClick={() => {
          setModel(blockKey, removeColumn(table, column));
          focusField(fieldOfCell(blockKey, row, Math.max(0, column - 1)), 'end');
        }}
      >
        Delete this column
      </BarButton>
      <label htmlFor={alignId} className="pe-bar-label">
        Column text
      </label>
      <select
        id={alignId}
        className="pe-bar-select"
        data-testid="table-align"
        value={table.align[column] ?? 'none'}
        onChange={(event) => {
          const value = event.target.value;
          const align: Align =
            value === 'left' || value === 'center' || value === 'right' ? value : null;
          setModel(blockKey, alignColumn(table, column, align));
        }}
      >
        <option value="none">As the view sets it</option>
        <option value="left">To the left</option>
        <option value="center">In the middle</option>
        <option value="right">To the right</option>
      </select>
    </div>
  );
}

function ListBar({ blockKey, path }: { blockKey: number; path: number[] }) {
  return (
    <div className="pe-context" role="toolbar" aria-label="List tools" data-testid="list-tools">
      <BarButton
        testId="list-indent"
        disabled={path.at(-1) === 0}
        onClick={() => {
          listAction(blockKey, path, 'indent');
        }}
      >
        Indent the item
      </BarButton>
      <BarButton
        testId="list-outdent"
        disabled={path.length < 2}
        onClick={() => {
          listAction(blockKey, path, 'outdent');
        }}
      >
        Outdent the item
      </BarButton>
      <span className="pe-note">Tab and Shift+Tab do the same.</span>
    </div>
  );
}

/** The picture at a place of a field's pieces. */
function pictureAt(pieces: readonly Inline[], at: number) {
  let pos = 0;
  for (const piece of pieces) {
    if (pos === at && piece.kind === 'picture') return piece;
    pos += pieceLength(piece);
  }
  return null;
}

function PictureBar({ game, at }: { game: LoadedGame; at: { field: string; at: number } }) {
  // Follows the page, so the bar shows the picture as it is now.
  usePageEditor((s) => s.page);
  const field = fields.get(at.field);
  const piece = field ? pictureAt(field.pieces(), at.at) : null;
  const [replacing, setReplacing] = useState(false);
  const altId = useId();
  const sizeId = useId();
  const widthId = useId();
  const captionId = useId();
  const ownPicture = useOwnPages((s) =>
    piece && isOwnId(piece.src)
      ? ([...s.draftPictures, ...(s.own.pictures ?? [])].find((p) => p.id === piece.src) ?? null)
      : null,
  );
  if (!field || !piece) return null;
  const size = readPictureSize(piece.title);
  const shown = pictureOf(game, piece.src);
  const change = (next: Partial<Extract<Inline, { kind: 'picture' }>>) => {
    const changed: Inline = { ...piece, ...next };
    if ('title' in next && next.title === undefined) delete (changed as { title?: string }).title;
    field.apply(insertInline(field.pieces(), at.at, at.at + 1, [changed]));
  };
  const [width, setWidth] = [
    size.kind === 'width' || size.kind === 'inline' ? String(size.width) : '',
    (text: string) => {
      const next = widthSize(text);
      if (next) change({ title: writePictureSize(next) });
    },
  ];
  const sizeChoice = size.kind === 'other' ? 'other' : size.kind === 'own' ? 'own' : size.kind;
  return (
    <div
      className="pe-context pe-picture-bar"
      role="toolbar"
      aria-label="Picture tools"
      data-testid="picture-tools"
    >
      <label htmlFor={altId} className="pe-bar-label">
        What it shows
      </label>
      <input
        id={altId}
        className="own-input pe-bar-input"
        value={piece.alt}
        data-testid="picture-alt"
        onChange={(event) => {
          change({ alt: event.target.value.replace(/[\n\]]/g, ' ') });
        }}
      />
      <label htmlFor={sizeId} className="pe-bar-label">
        Size
      </label>
      {size.kind === 'other' ? (
        <span className="pe-note">
          Its title, “{size.title}”, is kept as it is: edit the part as Markdown to change it.
        </span>
      ) : (
        <select
          id={sizeId}
          className="pe-bar-select"
          data-testid="picture-size"
          value={sizeChoice}
          onChange={(event) => {
            const value = event.target.value;
            if (value === 'own') change({ title: undefined });
            else if (value === 'inline') {
              change({ title: writePictureSize(inlineSize(shown?.width, shown?.height)) });
            } else {
              const w = Math.min(shown?.width ?? 320, 640);
              change({ title: writePictureSize({ kind: 'width', width: w }) });
            }
          }}
        >
          <option value="own">Its own size</option>
          <option value="inline">In the line of text (small)</option>
          <option value="width">A width in pixels</option>
        </select>
      )}
      {size.kind === 'width' ? (
        <>
          <label htmlFor={widthId} className="pe-bar-label">
            Width in pixels
          </label>
          <input
            id={widthId}
            className="own-input pe-bar-number"
            type="number"
            min={1}
            max={4000}
            defaultValue={width}
            key={width}
            data-testid="picture-width"
            onBlur={(event) => {
              setWidth(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') setWidth(event.currentTarget.value);
            }}
          />
        </>
      ) : null}
      {ownPicture ? (
        <>
          <label htmlFor={captionId} className="pe-bar-label">
            Caption
          </label>
          <input
            id={captionId}
            className="own-input pe-bar-input"
            value={ownPicture.caption ?? ''}
            data-testid="picture-caption"
            onChange={(event) => {
              const caption = event.target.value.slice(0, 300);
              const next = { ...ownPicture };
              if (caption.trim()) next.caption = caption;
              else delete next.caption;
              changeDraftPicture(next);
            }}
          />
        </>
      ) : shown?.caption ? (
        <span className="pe-note">Caption from the wiki: {shown.caption}</span>
      ) : null}
      <BarButton
        testId="picture-replace"
        onClick={() => {
          setReplacing(true);
        }}
      >
        Replace the picture
      </BarButton>
      <BarButton
        onClick={() => {
          changePage((page) => moveBlock(page, field.block, -1));
        }}
      >
        Move up
      </BarButton>
      <BarButton
        onClick={() => {
          changePage((page) => moveBlock(page, field.block, 1));
        }}
      >
        Move down
      </BarButton>
      <BarButton
        testId="picture-remove"
        onClick={() => {
          field.apply(insertInline(field.pieces(), at.at, at.at + 1, []));
          choosePicture(null);
        }}
      >
        Remove the picture
      </BarButton>
      <BarButton
        onClick={() => {
          choosePicture(null);
        }}
      >
        Done
      </BarButton>
      {replacing ? (
        <PictureDialog
          game={game}
          replace={at}
          onClose={() => {
            setReplacing(false);
          }}
        />
      ) : null}
    </div>
  );
}
