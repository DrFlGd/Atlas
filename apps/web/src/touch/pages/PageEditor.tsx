import { pageChange } from '@atlas/core';
import { useCallback, useEffect, useId, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { MarkdownBody } from '../../components/MarkdownBody';
import type { ShownPicture } from '../../markdownEdit/dom';
import { pictureOf } from '../../state/guides';
import { useOwnPages } from '../../state/ownPages';
import { useOwnPictures } from '../../state/ownPictures';
import { useAtlas, type LoadedGame } from '../../state/store';
import { AboutPage } from './AboutPage';
import { ContentsEditor } from './ContentsEditor';
import { ContextBar } from './ContextBars';
import { PictureContext } from './pictureContext';
import { PageBlocks } from './PageBlocks';
import { LeaveDialog, ToolDialogs } from './PageDialogs';
import {
  answerRestore,
  cancelEditing,
  closePageEditor,
  dropPageEditor,
  isDirty,
  packPage,
  redoEdit,
  saveAndClose,
  setMarkdown,
  setMode,
  setTitle,
  setWikiView,
  undoEdit,
  usePageEditor,
} from './pageEditorState';
import { Toolbar, type ToolDialog } from './Toolbar';
import '../../styles/editor.css';
import '../../styles/pageEditor.css';

/**
 * The page editor (loaded when first opened): the contents to arrange
 * beside it, the page's title and text with the text tools or as
 * Markdown, and "About this page". Wide, the three are side by side;
 * compact (a phone), the page fills the screen, "About this page" under
 * it, and the contents open from a button.
 */
export default function PageEditor({ wide }: { wide: boolean }) {
  const game = useAtlas((s) => s.game);
  // Another game shown: the editor closes (what was typed is kept in this browser).
  const [gameShown] = useState(game?.pack.manifest.gameId);
  useEffect(() => {
    if (game?.pack.manifest.gameId !== gameShown) dropPageEditor();
  }, [game, gameShown]);
  if (!game) return null;
  return <EditorLayout game={game} wide={wide} />;
}

function EditorLayout({ game, wide }: { game: LoadedGame; wide: boolean }) {
  const guideId = usePageEditor((s) => s.guideId);
  const [contentsOpen, setContentsOpen] = useState(false);
  const status = useOwnPages((s) => s.status);
  const readOnly = useOwnPages((s) => s.readOnly);
  const error = useOwnPages((s) => s.error);
  const pictures = useCallback(
    (src: string): ShownPicture | null => {
      const picture = pictureOf(game, src);
      return picture
        ? {
            url: picture.url,
            ...(picture.width ? { width: picture.width } : {}),
            ...(picture.height ? { height: picture.height } : {}),
          }
        : null;
    },
    [game],
  );
  // Pictures of one's own show once read, and as they are added: the fields are told by a new function.
  const draftPictures = useOwnPages((s) => s.draftPictures);
  const ownFiles = useOwnPictures((s) => s.files);
  const pictureOfPage = useCallback(
    (src: string) => pictures(src),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pictures, draftPictures, ownFiles],
  );

  return (
    <PictureContext.Provider value={pictureOfPage}>
      <div
        className={wide ? 'pe pe-wide' : 'pe pe-compact'}
        data-testid="page-editor"
        onKeyDown={(event) => {
          // Undo and Redo of the page, wherever the focus is in it (but a field of its own).
          const target = event.target as HTMLElement;
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
          const mod = event.ctrlKey || event.metaKey;
          if (!mod || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key === 'z' || key === 'y') {
            event.preventDefault();
            if (key === 'y' || event.shiftKey) redoEdit();
            else undoEdit();
          }
        }}
      >
        {wide || contentsOpen ? (
          <div className={wide ? 'pe-side' : 'pe-sheet'}>
            {!wide ? (
              <button
                type="button"
                className="own-pill-button pe-sheet-close"
                onClick={() => {
                  setContentsOpen(false);
                }}
              >
                Back to the page
              </button>
            ) : null}
            <ContentsEditor game={game} />
          </div>
        ) : null}
        <main className="pe-main" aria-label="Page editor">
          {status === 'error' || readOnly ? (
            <p className="pe-banner pe-banner-error" role="alert">
              {readOnly ?? error}
            </p>
          ) : null}
          {guideId ? (
            <PageArea
              game={game}
              guideId={guideId}
              wide={wide}
              onContents={() => {
                setContentsOpen(true);
              }}
            />
          ) : (
            <NoPage
              wide={wide}
              onContents={() => {
                setContentsOpen(true);
              }}
            />
          )}
        </main>
        {wide && guideId ? (
          <div className="pe-aside">
            <AboutPage game={game} guideId={guideId} />
          </div>
        ) : null}
        <LeaveDialog />
      </div>
    </PictureContext.Provider>
  );
}

function NoPage({ wide, onContents }: { wide: boolean; onContents: () => void }) {
  return (
    <div className="pe-empty">
      <p>Choose a page in the contents to edit it, or add a page of your own.</p>
      {!wide ? (
        <button type="button" className="own-pill-button" onClick={onContents}>
          Show the contents
        </button>
      ) : null}
      <button
        type="button"
        className="own-pill-button"
        data-testid="close-editor"
        onClick={closePageEditor}
      >
        Done editing
      </button>
    </div>
  );
}

function PageArea({
  game,
  guideId,
  wide,
  onContents,
}: {
  game: LoadedGame;
  guideId: string;
  wide: boolean;
  onContents: () => void;
}) {
  const title = usePageEditor((s) => s.title);
  const mode = usePageEditor((s) => s.mode);
  const text = usePageEditor((s) => s.text);
  const error = usePageEditor((s) => s.error);
  const restore = usePageEditor((s) => s.restore);
  const wikiView = usePageEditor((s) => s.wikiView);
  const dirty = usePageEditor((s) => isDirty(s));
  const own = useOwnPages((s) => s.own);
  const [dialog, setDialog] = useState<ToolDialog>(null);
  const titleId = useId();
  const pack = packPage(game, guideId);
  const change = pageChange(
    pack,
    own.pages.find((p) => p.id === guideId),
  );

  return (
    <div className="pe-page" data-testid="page-edit">
      <header className="pe-head">
        {!wide ? (
          <button
            type="button"
            className="touch-icon-button"
            aria-label="Contents"
            title="Contents"
            onClick={onContents}
          >
            <UiIcon name="book" size={20} />
          </button>
        ) : null}
        <label htmlFor={titleId} className="visually-hidden">
          Page title
        </label>
        <input
          id={titleId}
          className="pe-title"
          placeholder="Page title"
          value={title}
          maxLength={200}
          data-testid="page-title"
          onChange={(event) => {
            setTitle(event.target.value);
          }}
        />
        <span className="pe-save-state" aria-live="polite">
          {dirty ? 'Not saved' : ''}
        </span>
        <button
          type="button"
          className="own-pill-button"
          data-testid="cancel-edit"
          onClick={cancelEditing}
        >
          Cancel
        </button>
        <button
          type="button"
          className="own-pill-button own-pill-primary"
          data-testid="save-page"
          onClick={saveAndClose}
        >
          Save
        </button>
      </header>
      {error ? (
        <p className="pe-banner pe-banner-error" role="alert">
          {error}
        </p>
      ) : null}
      {restore ? (
        <div className="pe-banner" role="status" data-testid="restore-notice">
          <span>You have changes to this page that were not saved.</span>
          <button
            type="button"
            className="own-pill-button own-pill-primary"
            data-testid="restore-take"
            onClick={() => {
              answerRestore(true);
            }}
          >
            Bring them back
          </button>
          <button
            type="button"
            className="own-pill-button"
            onClick={() => {
              answerRestore(false);
            }}
          >
            Forget them
          </button>
        </div>
      ) : null}
      {change.wikiChanged && pack ? (
        <div className="pe-banner pe-banner-wiki" role="status" data-testid="wiki-changed-editor">
          <span>
            {change.showsWiki
              ? 'The wiki changed this page since you edited it, so its new version is shown and edited here, as you chose. Your version is kept until you save.'
              : 'The wiki changed this page since you edited it. You are editing your version.'}
          </span>
          <button
            type="button"
            className="own-pill-button"
            onClick={() => {
              setWikiView(!wikiView);
            }}
          >
            {wikiView ? 'Back to your version' : 'See the wiki’s new version'}
          </button>
        </div>
      ) : null}
      {wikiView && pack ? (
        <div className="pe-wiki-view" data-testid="wiki-version">
          <p className="pe-note">
            The wiki’s version of this page, as the game’s files have it. It cannot be edited here.
          </p>
          <h1 className="guides-title">{pack.title}</h1>
          <MarkdownBody source={pack.body} className="guide-body guides-page-body" page />
        </div>
      ) : (
        <>
          <div className="pe-tools-row">
            {mode === 'formatted' ? <Toolbar openDialog={setDialog} /> : <span />}
            <div className="pe-mode" role="group" aria-label="How the page is edited">
              <button
                type="button"
                className={`pe-mode-button${mode === 'formatted' ? ' pe-mode-on' : ''}`}
                aria-pressed={mode === 'formatted'}
                data-testid="mode-formatted"
                onClick={() => {
                  setMode('formatted');
                }}
              >
                Formatted
              </button>
              <button
                type="button"
                className={`pe-mode-button${mode === 'markdown' ? ' pe-mode-on' : ''}`}
                aria-pressed={mode === 'markdown'}
                data-testid="mode-markdown"
                onClick={() => {
                  setMode('markdown');
                }}
              >
                Markdown
              </button>
            </div>
          </div>
          {mode === 'formatted' ? <ContextBar game={game} /> : null}
          <div className="pe-body touch-scroll" data-scroll-root>
            {mode === 'formatted' ? (
              <PageBlocks />
            ) : (
              <textarea
                className="pe-markdown"
                aria-label="The page in Markdown"
                spellCheck={false}
                data-testid="markdown-text"
                value={text}
                onChange={(event) => {
                  setMarkdown(event.target.value);
                }}
              />
            )}
          </div>
        </>
      )}
      {!wide ? <AboutPage game={game} guideId={guideId} /> : null}
      <ToolDialogs
        game={game}
        dialog={dialog}
        onClose={() => {
          setDialog(null);
        }}
      />
    </div>
  );
}
