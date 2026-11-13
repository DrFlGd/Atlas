import { isOwnId } from '@atlas/schema';

import type { Picture } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  insertInline,
  pieceLength,
  linkSpan,
  setLink,
  type Inline,
  type LinkMark,
} from '../../markdownEdit/inline';
import { insertBlockAfter, newBlock } from '../../markdownEdit/draft';
import { pictureOf } from '../../state/guides';
import { useOwnPages } from '../../state/ownPages';
import {
  keepPhoto,
  PHOTO_ACCEPT,
  pickPhoto,
  shrinkPhoto,
  useOwnPictureUrl,
} from '../../state/ownPictures';
import type { LoadedGame } from '../../state/store';
import { GuideFinder, LocationFinder } from '../editor/StepPanel';
import {
  addDraftPicture,
  answerLeave,
  changePage,
  choosePicture,
  fields,
  focusedField,
  focusField,
  usePageEditor,
} from './pageEditorState';
import type { ToolDialog } from './Toolbar';

/** A dialog over the editor, closed with Escape or Back. */
export function Modal({
  title,
  children,
  onClose,
  testId,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  testId?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`own-dialog ${wide ? 'pe-dialog-wide' : 'own-dialog-small'}`}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="own-dialog-body">
        <h2 id={titleId} className="own-dialog-title">
          {title}
        </h2>
        {children}
      </div>
    </dialog>
  );
}

/** Links the text chosen, or puts in `text` linked where nothing is chosen. */
function linkSelection(link: LinkMark, text: string): void {
  const field = focusedField();
  if (!field) return;
  const [start, end] = field.selection();
  const pieces = field.pieces();
  if (start < end) {
    field.apply(setLink(pieces, start, end, link), [start, end]);
    return;
  }
  // The cursor in a link: that link changes.
  const span = linkSpan(pieces, start, end);
  if (span) {
    field.apply(setLink(pieces, span.start, span.end, link), [span.start, span.end]);
    return;
  }
  const added: Inline[] = [{ kind: 'text', text, marks: { link } }];
  field.apply(insertInline(pieces, start, end, added), [start, start + text.length]);
}

export function ToolDialogs({
  game,
  dialog,
  onClose,
}: {
  game: LoadedGame;
  dialog: ToolDialog;
  onClose: () => void;
}) {
  switch (dialog) {
    case 'page-link':
      return (
        <Modal title="Link to a page" onClose={onClose} testId="page-link-dialog">
          <GuideFinder
            game={game}
            hint="The link opens the page in Guides."
            onCancel={onClose}
            onChoose={(guideId) => {
              const title = game.pack.data.guides.find((g) => g.id === guideId)?.title ?? 'page';
              onClose();
              linkSelection({ href: guideId }, title);
            }}
          />
        </Modal>
      );
    case 'location-link':
      return (
        <Modal title="Link to a location" onClose={onClose} testId="location-link-dialog">
          <LocationFinder
            game={game}
            label="Find a location to link"
            hint="The link shows the location on the map."
            onCancel={onClose}
            onChoose={(locationId) => {
              const title = game.pack.locations.get(locationId)?.name ?? 'location';
              onClose();
              linkSelection({ href: locationId }, title);
            }}
          />
        </Modal>
      );
    case 'web-link':
      return <WebLinkDialog onClose={onClose} />;
    case 'picture':
      return <PictureDialog game={game} onClose={onClose} replace={null} />;
    case null:
      return null;
  }
}

function WebLinkDialog({ onClose }: { onClose: () => void }) {
  const field = focusedField();
  const [start, end] = field?.selection() ?? [0, 0];
  const span = field ? linkSpan(field.pieces(), start, end) : null;
  const [address, setAddress] = useState(
    span && /^https?:/i.test(span.link.href) ? span.link.href : 'https://',
  );
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const addressId = useId();
  const textId = useId();
  const needsText = start === end && !span;
  return (
    <Modal title="Link to a web page" onClose={onClose} testId="web-link-dialog">
      <form
        className="pe-form"
        onSubmit={(event) => {
          event.preventDefault();
          const href = address.trim();
          let ok: boolean;
          try {
            const url = new URL(href);
            ok = url.protocol === 'https:' || url.protocol === 'http:';
          } catch {
            ok = false;
          }
          if (!ok) {
            setError('Type a web address that starts with https:// or http://.');
            return;
          }
          onClose();
          linkSelection({ href }, text.trim() || href);
        }}
      >
        <label htmlFor={addressId}>Web address</label>
        <input
          id={addressId}
          className="own-input"
          type="url"
          autoFocus
          value={address}
          data-testid="web-link-address"
          onChange={(event) => {
            setAddress(event.target.value);
          }}
        />
        {needsText ? (
          <>
            <label htmlFor={textId}>Text of the link</label>
            <input
              id={textId}
              className="own-input"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
              }}
            />
          </>
        ) : null}
        {error ? (
          <p className="pe-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer className="own-dialog-foot">
          <span className="own-space" />
          <button type="button" className="own-pill-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="own-pill-button own-pill-primary">
            Link
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** A picture of the game, as the dialog shows it to choose. */
function PictureChoice({
  game,
  picture,
  onChoose,
}: {
  game: LoadedGame;
  picture: Picture;
  onChoose: () => void;
}) {
  const own = isOwnId(picture.id);
  const ownUrl = useOwnPictureUrl(game.pack.manifest.gameId, own ? picture : undefined);
  const url = own ? (ownUrl === 'missing' ? null : ownUrl) : pictureOf(game, picture.id)?.url;
  const name = picture.caption ?? picture.id.split(':').at(-1) ?? 'Picture';
  return (
    <li>
      <button
        type="button"
        className="pe-picture-choice"
        data-testid="picture-choice"
        data-picture={picture.id}
        onClick={onChoose}
      >
        {url ? <img src={url} alt="" loading="lazy" /> : <span className="pe-picture-none" />}
        <span className="pe-picture-name">{name}</span>
      </button>
    </li>
  );
}

/**
 * "Add a picture", or "Replace the picture": one of the game's pictures,
 * or a picture of one's own added from a file.
 */
export function PictureDialog({
  game,
  onClose,
  replace,
}: {
  game: LoadedGame;
  onClose: () => void;
  /** The picture to replace: its field and place. */
  replace: { field: string; at: number } | null;
}) {
  const gameId = game.pack.manifest.gameId;
  const [alt, setAlt] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const altId = useId();
  const findId = useId();
  const savedPictures = useOwnPages((s) => s.own.pictures);
  const draftPictures = useOwnPages((s) => s.draftPictures);
  const ownPictures = useMemo(
    () => [...(savedPictures ?? []), ...draftPictures],
    [savedPictures, draftPictures],
  );
  const pictures = useMemo(() => {
    const all = [...(game.pack.data.pictures ?? []), ...ownPictures];
    const text = query.trim().toLowerCase();
    const found = text
      ? all.filter((p) => `${p.caption ?? ''} ${p.id}`.toLowerCase().includes(text))
      : all;
    return found.slice(0, 120);
  }, [game, ownPictures, query]);

  const choose = (picture: Picture) => {
    onClose();
    const text = alt.trim() || (picture.caption ?? 'Picture');
    if (replace) {
      const field = fields.get(replace.field);
      if (!field) return;
      const pieces = field.pieces();
      let pos = 0;
      const next = pieces.map((piece): Inline => {
        const here = pos;
        pos += pieceLength(piece);
        if (here !== replace.at || piece.kind !== 'picture') return piece;
        // The size it was given stays with it.
        return { ...piece, src: picture.id, alt: alt.trim() || piece.alt };
      });
      field.apply(next);
      choosePicture(replace);
      return;
    }
    const piece: Inline = { kind: 'picture', src: picture.id, alt: text, marks: {} };
    const field = focusedField();
    if (field?.context === 'block') {
      const [start, end] = field.selection();
      field.apply(insertInline(field.pieces(), start, end, [piece]), [start + 1, start + 1]);
      return;
    }
    const focusedBlock = usePageEditor.getState().focused?.block ?? null;
    changePage((page) => {
      const block = newBlock(page, { kind: 'paragraph', content: [piece] });
      focusField(`${block.key}`, 'end');
      return insertBlockAfter(page, focusedBlock, block);
    });
  };

  return (
    <Modal
      title={replace ? 'Replace the picture' : 'Add a picture'}
      onClose={onClose}
      testId="picture-dialog"
      wide
    >
      <div className="pe-form">
        <label htmlFor={altId}>What the picture shows (read out in place of it)</label>
        <input
          id={altId}
          className="own-input"
          value={alt}
          data-testid="picture-alt-new"
          onChange={(event) => {
            setAlt(event.target.value);
          }}
        />
      </div>
      <div className="pe-picture-own">
        <input
          ref={input}
          type="file"
          accept={PHOTO_ACCEPT}
          hidden
          data-testid="picture-file"
          aria-label="Choose a picture file"
        />
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          disabled={busy}
          data-testid="add-own-picture"
          onClick={() => {
            setError(null);
            void (async () => {
              const bytes = await pickPhoto(input.current);
              if (!bytes) return;
              if (bytes.length === 0) {
                setError('That file could not be read as a picture.');
                return;
              }
              setBusy(true);
              try {
                const picture = await keepPhoto(gameId, await shrinkPhoto(bytes));
                addDraftPicture(picture);
                choose(picture);
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          {busy ? 'Adding your picture…' : 'Add your own picture from a file'}
        </button>
        <p className="pe-note">
          Your own pictures are kept with your pages, never in the game’s files.
        </p>
        {error ? (
          <p className="pe-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      {(game.pack.data.pictures?.length ?? 0) + ownPictures.length > 0 ? (
        <>
          <label htmlFor={findId} className="pe-label">
            Or choose a picture of this game
          </label>
          <input
            id={findId}
            className="own-input"
            type="search"
            placeholder="Find a picture by its caption"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
          />
          <ul className="touch-plain-list pe-picture-grid">
            {pictures.map((picture) => (
              <PictureChoice
                key={picture.id}
                game={game}
                picture={picture}
                onChoose={() => {
                  choose(picture);
                }}
              />
            ))}
          </ul>
        </>
      ) : null}
      <footer className="own-dialog-foot">
        <span className="own-space" />
        <button type="button" className="own-pill-button" onClick={onClose}>
          Cancel
        </button>
      </footer>
    </Modal>
  );
}

/** "Save your changes?" when leaving a page with changes not saved. */
export function LeaveDialog() {
  const leaving = usePageEditor((s) => s.leaving);
  const title = usePageEditor((s) => s.title);
  if (!leaving) return null;
  return (
    <Modal
      title={`Save your changes to “${title.trim() || 'this page'}”?`}
      onClose={() => {
        answerLeave('stay');
      }}
      testId="leave-dialog"
    >
      <p className="own-dialog-line">Your changes to this page are not saved yet.</p>
      <footer className="own-dialog-foot">
        <button
          type="button"
          className="own-pill-button own-pill-danger"
          data-testid="leave-discard"
          onClick={() => {
            answerLeave('discard');
          }}
        >
          Don’t save
        </button>
        <span className="own-space" />
        <button
          type="button"
          className="own-pill-button"
          autoFocus
          onClick={() => {
            answerLeave('stay');
          }}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          data-testid="leave-save"
          onClick={() => {
            answerLeave('save');
          }}
        >
          Save
        </button>
      </footer>
    </Modal>
  );
}

/** A question to make sure before something that drops the person's work. */
export function ConfirmDialog({
  title,
  text,
  confirm,
  onConfirm,
  onClose,
  testId,
}: {
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => void;
  onClose: () => void;
  testId?: string;
}) {
  return (
    <Modal title={title} onClose={onClose} testId={testId}>
      <p className="own-dialog-line">{text}</p>
      <footer className="own-dialog-foot">
        <span className="own-space" />
        <button type="button" className="own-pill-button" autoFocus onClick={onClose}>
          Keep it
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-danger"
          data-testid="confirm-button"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {confirm}
        </button>
      </footer>
    </Modal>
  );
}
