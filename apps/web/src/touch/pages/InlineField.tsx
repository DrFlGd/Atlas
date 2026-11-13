import { useContext, useEffect, useLayoutEffect, useRef } from 'react';
import {
  offsetIn,
  piecesFromDom,
  piecesToHtml,
  selectIn,
  selectionIn,
} from '../../markdownEdit/dom';
import {
  insertInline,
  inlineLength,
  toggleMark,
  type Inline,
  type InlineContext,
} from '../../markdownEdit/inline';
import { useOwnPictures } from '../../state/ownPictures';
import { PictureContext } from './pictureContext';
import {
  choosePicture,
  clearPendingFocus,
  fields,
  redoEdit,
  setFocused,
  undoEdit,
  usePageEditor,
  type FieldApi,
} from './pageEditorState';

/** A key pressed in a field that the block it is in may act on. */
export type FieldKey = 'Enter' | 'ShiftEnter' | 'Tab' | 'ShiftTab' | 'BackspaceAtStart' | 'Escape';

/** Text as typed or pasted: its line ends as the field holds them. */
function typedPieces(text: string, context: InlineContext): Inline[] {
  const pieces: Inline[] = [];
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((line, i) => {
      if (i > 0) {
        pieces.push(
          context === 'block'
            ? { kind: 'soft', marks: {} }
            : { kind: 'text', text: ' ', marks: {} },
        );
      }
      if (line) pieces.push({ kind: 'text', text: line, marks: {} });
    });
  return pieces;
}

/**
 * A field of text with its marks shown as they read (bold, italic, links,
 * hidden text, pictures), typed in as any text is. What it holds is read
 * back from it as it is typed in; the text tools change it through the
 * field (see `FieldApi`).
 */
export function InlineField({
  id,
  block,
  pieces,
  context,
  label,
  className,
  placeholder,
  testId,
  onChange,
  onKey,
}: {
  id: string;
  block: number;
  pieces: Inline[];
  context: InlineContext;
  label: string;
  className?: string;
  placeholder?: string;
  testId?: string;
  onChange: (pieces: Inline[], typing: boolean) => void;
  /** A key the block acts on, with the selection; true when it did. */
  onKey?: (key: FieldKey, selection: [number, number], pieces: Inline[]) => boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useRef<Inline[] | null>(null);
  const lastSelection = useRef<[number, number]>([0, 0]);
  const pictureOf = useContext(PictureContext);
  const ownFiles = useOwnPictures((s) => s.files);
  const latest = useRef({ onChange, onKey, pieces });
  useLayoutEffect(() => {
    latest.current = { onChange, onKey, pieces };
  });

  // Shown anew when what it holds changed from outside (a tool, Undo).
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || shown.current === pieces) return;
    const focused = element.ownerDocument.activeElement === element;
    const selection = focused ? selectionIn(element) : null;
    element.innerHTML = piecesToHtml(pieces, pictureOf);
    shown.current = pieces;
    if (focused && selection) selectIn(element, ...clamp(selection, pieces));
  }, [pieces, pictureOf]);

  // A photo of one's own shows once its file is read.
  useEffect(() => {
    const element = ref.current;
    if (!element || !pieces.some((piece) => piece.kind === 'picture')) return;
    if (!element.querySelector('.md-picture-missing')) return;
    const focused = element.ownerDocument.activeElement === element;
    const selection = focused ? selectionIn(element) : null;
    element.innerHTML = piecesToHtml(pieces, pictureOf);
    if (focused && selection) selectIn(element, ...clamp(selection, pieces));
  }, [ownFiles, pieces, pictureOf]);

  const apply = (next: Inline[], select?: [number, number]) => {
    const element = ref.current;
    if (!element) return;
    element.innerHTML = piecesToHtml(next, pictureOf);
    shown.current = next;
    latest.current.onChange(next, false);
    if (select) {
      element.focus({ preventScroll: true });
      selectIn(element, ...clamp(select, next));
      lastSelection.current = clamp(select, next);
    }
  };

  // Known to the text tools while it is shown.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const api: FieldApi = {
      id,
      block,
      context,
      element,
      pieces: () => shown.current ?? latest.current.pieces,
      selection: () =>
        (element.ownerDocument.activeElement === element ? selectionIn(element) : null) ??
        lastSelection.current,
      apply,
    };
    fields.set(id, api);
    return () => {
      if (fields.get(id) === api) fields.delete(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, block, context]);

  // The cursor put here when asked (a new block, a cell moved to).
  const pending = usePageEditor((s) => (s.pendingFocus?.field === id ? s.pendingFocus : null));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!pending || !element) return;
    clearPendingFocus();
    element.focus({ preventScroll: false });
    const length = inlineLength(shown.current ?? pieces);
    const at = pending.at === 'end' ? length : Math.min(pending.at, length);
    selectIn(element, at);
    lastSelection.current = [at, at];
    element.scrollIntoView({ block: 'nearest' });
  }, [pending, pieces]);

  // Enter and Shift+Enter, as typed on any keyboard (a phone's sends no key for them).
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== 'insertParagraph' && event.inputType !== 'insertLineBreak') return;
      event.preventDefault();
      const current = shown.current ?? latest.current.pieces;
      const selection = selectionIn(element) ?? [inlineLength(current), inlineLength(current)];
      const key: FieldKey = event.inputType === 'insertParagraph' ? 'Enter' : 'ShiftEnter';
      if (latest.current.onKey?.(key, selection, current)) return;
      if (context === 'block' || key === 'ShiftEnter') {
        // A line break inside the text.
        const piece: Inline =
          context === 'block' && key === 'ShiftEnter'
            ? { kind: 'break', marks: {} }
            : context === 'block'
              ? { kind: 'soft', marks: {} }
              : { kind: 'text', text: ' ', marks: {} };
        apply(insertInline(current, selection[0], selection[1], [piece]), [
          selection[0] + 1,
          selection[0] + 1,
        ]);
      }
    };
    element.addEventListener('beforeinput', onBeforeInput);
    return () => {
      element.removeEventListener('beforeinput', onBeforeInput);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [context]);

  return (
    <div
      ref={ref}
      className={`pe-field${className ? ` ${className}` : ''}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline={context === 'block'}
      aria-label={label}
      data-placeholder={placeholder}
      data-testid={testId}
      data-field={id}
      spellCheck
      onFocus={() => {
        setFocused(id, block);
      }}
      onInput={() => {
        const element = ref.current;
        if (!element) return;
        const next = piecesFromDom(element);
        shown.current = next;
        lastSelection.current = selectionIn(element) ?? lastSelection.current;
        latest.current.onChange(next, true);
      }}
      onKeyUp={() => {
        if (ref.current) lastSelection.current = selectionIn(ref.current) ?? lastSelection.current;
      }}
      onMouseUp={() => {
        if (ref.current) lastSelection.current = selectionIn(ref.current) ?? lastSelection.current;
      }}
      onBlur={() => {
        // Kept for a tool used after (a dialog that takes the focus).
      }}
      onClick={(event) => {
        const element = ref.current;
        const picture = (event.target as Element).closest('[data-md-picture]');
        if (!element || !picture || !element.contains(picture)) return;
        event.preventDefault();
        const parent = picture.parentNode!;
        const at = offsetIn(element, parent, Array.from(parent.childNodes).indexOf(picture));
        // Chosen: the field has the focus, the picture is selected.
        element.focus({ preventScroll: true });
        selectIn(element, at, at + 1);
        lastSelection.current = [at, at + 1];
        setFocused(id, block);
        choosePicture({ field: id, at });
      }}
      onPaste={(event) => {
        event.preventDefault();
        const element = ref.current;
        if (!element) return;
        const text = event.clipboardData.getData('text/plain');
        if (!text) return;
        const current = shown.current ?? latest.current.pieces;
        const [start, end] = selectionIn(element) ?? lastSelection.current;
        const added = typedPieces(text, context);
        const length = inlineLength(added);
        apply(insertInline(current, start, end, added), [start + length, start + length]);
      }}
      onKeyDown={(event) => {
        const element = ref.current;
        if (!element) return;
        const current = shown.current ?? latest.current.pieces;
        const selection = selectionIn(element) ?? lastSelection.current;
        const mod = event.ctrlKey || event.metaKey;
        if (mod && !event.altKey) {
          const key = event.key.toLowerCase();
          if (key === 'z' || key === 'y') {
            event.preventDefault();
            if (key === 'y' || event.shiftKey) redoEdit();
            else undoEdit();
            return;
          }
          const mark = key === 'b' ? 'strong' : key === 'i' ? 'em' : null;
          if (mark) {
            event.preventDefault();
            apply(toggleMark(current, selection[0], selection[1], mark), selection);
            return;
          }
        }
        let key: FieldKey | null = null;
        if (event.key === 'Tab') key = event.shiftKey ? 'ShiftTab' : 'Tab';
        else if (event.key === 'Escape') key = 'Escape';
        else if (event.key === 'Backspace' && selection[0] === 0 && selection[1] === 0 && !mod) {
          key = 'BackspaceAtStart';
        }
        if (key && latest.current.onKey?.(key, selection, current)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    />
  );
}

function clamp([start, end]: [number, number], pieces: readonly Inline[]): [number, number] {
  const length = inlineLength(pieces);
  return [Math.min(start, length), Math.min(end, length)];
}
