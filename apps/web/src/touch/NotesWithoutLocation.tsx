import { useId, useRef } from 'react';
import { copyText } from '../clipboard';
import { UiIcon } from '../components/icons';
import { MarkdownBody } from '../components/MarkdownBody';
import { PhotoStrip } from '../components/Photos';
import { notify } from '../state/actions';
import { numberFormat } from '../state/derived';
import { deleteNote, useNotesShown, useOwnNotes, whyNotesCannotChange } from '../state/ownNotes';
import type { LoadedGame } from '../state/store';

/**
 * "Notes without a location", in the filters: the person's notes whose
 * location the game no longer has (or that another note of the same
 * location stands in for), each under the name the location had, to read,
 * copy or delete. Shown only when there are some.
 */
export function NotesWithoutLocation({ game }: { game: LoadedGame }) {
  const unplaced = useNotesShown(game).unplaced;
  const cannot = useOwnNotes((s) => whyNotesCannotChange(s));
  const headingId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  if (unplaced.length === 0) return null;
  return (
    <details className="touch-unplaced-notes" data-testid="notes-without-location">
      <summary className="touch-unplaced-summary">
        <span id={headingId}>Notes without a location</span>
        <span className="touch-figure">{numberFormat.format(unplaced.length)}</span>
      </summary>
      <p className="muted small-text touch-unplaced-lead">
        The game no longer has these locations, or has them under another note of yours. Each is
        kept under the name its location had.
      </p>
      <ul
        className="touch-plain-list touch-unplaced-list"
        aria-labelledby={headingId}
        ref={listRef}
      >
        {unplaced.map(({ keptAs, note }) => (
          <li key={keptAs} className="touch-unplaced-note" data-testid="unplaced-note">
            <h3 className="touch-unplaced-name">{note.name}</h3>
            {note.text.trim() ? (
              <MarkdownBody source={note.text} className="guide-body place-note-body" />
            ) : null}
            {note.photos && note.photos.length > 0 ? (
              <PhotoStrip
                game={game}
                photos={note.photos}
                name={`${note.name}, my note`}
                className="place-photos"
              />
            ) : null}
            <div className="touch-unplaced-actions">
              <button
                type="button"
                className="touch-text-button"
                data-testid="copy-unplaced-note"
                aria-label={`Copy my note on ${note.name}`}
                onClick={(event) => {
                  const host = event.currentTarget;
                  void copyText(`${note.name}\n\n${note.text}`.trim(), host).then((done) => {
                    notify(
                      done
                        ? `Copied your note on “${note.name}”.`
                        : 'The note could not be copied here.',
                      done ? 'info' : 'error',
                    );
                  });
                }}
              >
                <UiIcon name="copy" size={16} />
                Copy
              </button>
              {cannot ? null : (
                <button
                  type="button"
                  className="touch-text-button place-note-delete"
                  data-testid="delete-unplaced-note"
                  aria-label={`Delete my note on ${note.name}`}
                  onClick={() => {
                    deleteNote(keptAs, note.name);
                    // The focus stays in the list.
                    window.setTimeout(() => {
                      listRef.current?.querySelector<HTMLElement>('button')?.focus();
                    }, 0);
                  }}
                >
                  <UiIcon name="trash" size={16} />
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
