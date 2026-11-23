import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import {
  guidebookFacts,
  searchGuidebooks,
  type Guidebook,
  type GuidebookHit,
} from '../state/guidebookData';
import {
  closeGuidebook,
  keepReadText,
  loadGuidebookTexts,
  noteReading,
  rememberPage,
  textToRead,
  useGuidebooks,
  type OpenGuidebook,
} from '../state/guidebooks';
import { numberFormat } from '../state/derived';
import { dateWords, isIssue, issueName, pagesWords, type Issue } from '../state/magazineData';
import { openCbz, type CbzBook } from './cbz';
import {
  clampZoom,
  column,
  fitZoom,
  GAP,
  nextHit,
  pageAt,
  pagesInView,
  searchWords,
  stepZoom,
  typedPage,
  type Size,
} from './layout';
import { PageView } from './PageView';
import { openPdf, type OutlineItem, type PdfBook } from './pdf';
import '../styles/guidebooks.css';

/**
 * The guidebook reader: a guidebook's pages over the whole window, read
 * page by page or as one column to scroll, with zoom (the buttons, Ctrl
 * and the wheel, two fingers), fit to the width or to the page, a page to
 * go to, the PDF's own contents (its outline), Back to the page before a
 * jump, and search in its text with the pages found and, in a PDF whose
 * text says where it is, the words marked on the page. The page each
 * guidebook was left at is remembered on this device (see `guidebooks.ts`).
 * An issue of a magazine is read the same way, its contents the games it
 * covers with their pages, before the PDF's own.
 *
 * It is a modal dialog: Esc closes it, and the Android app's Back goes
 * back to the page before a jump, then closes it.
 */
export default function GuidebookReader() {
  const open = useGuidebooks((s) => s.open);
  if (!open) return null;
  return <Reader key={open.seq} open={open} />;
}

/** A guidebook opened: a PDF or a CBZ. */
type Book = { type: 'pdf'; pdf: PdfBook } | { type: 'cbz'; cbz: CbzBook; first: Size };

type Fit = 'width' | 'page' | null;
type Mode = 'scroll' | 'page';

const VIEW_KEY = 'atlas-guidebook-view';

/** How the person last read guidebooks on this device: page by page or scrolling, and the fit. */
function savedView(): { mode: Mode; fit: Fit } {
  try {
    const saved = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as {
      mode?: unknown;
      fit?: unknown;
    };
    return {
      mode: saved.mode === 'page' ? 'page' : 'scroll',
      fit: saved.fit === 'page' ? 'page' : saved.fit === null ? null : 'width',
    };
  } catch {
    return { mode: 'scroll', fit: 'width' };
  }
}

function saveView(mode: Mode, fit: Fit): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ mode, fit }));
  } catch {
    // Not kept: the next guidebook opens as the first one did.
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A PDF page at zoom 1 is as large as printed: 96 pixels for 72 points. */
const PDF_UNIT = 96 / 72;
/** The size of a page guessed until the first one is read. */
const LETTER: Size = { width: 612, height: 792 };

function Reader({ open }: { open: OpenGuidebook }) {
  const { guidebook } = open;
  const issue = isIssue(guidebook) ? guidebook : null;
  /** What it is called in the sentences the reader shows. */
  const noun = issue ? 'issue' : 'guidebook';
  const title = issue ? issueName(issue) : guidebook.title;
  const dialog = useRef<HTMLDialogElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [page, setPage] = useState(open.page);
  const [{ mode, fit }, setView] = useState(savedView);
  const [manualZoom, setManualZoom] = useState(1);
  const [history, setHistory] = useState<number[]>([]);
  const [sizes, setSizes] = useState<ReadonlyMap<number, Size>>(new Map());
  // A search from outside the reader opens on its page, with the pages found listed.
  const [panel, setPanel] = useState<'contents' | 'found' | null>(open.query ? 'found' : null);
  const [finding, setFinding] = useState(open.query !== null);
  const [query, setQuery] = useState(open.query ?? '');
  const [room, setRoom] = useState<Size>({ width: 800, height: 600 });
  const [top, setTop] = useState(0);
  const [pinch, setPinch] = useState(1);
  // Grows with each jump, so a jump to the page shown scrolls to its top again.
  const [jump, setJump] = useState(0);
  // Where to scroll to once the column is laid out (a page, and how far down it, 0 to 1)…
  const scrollTo = useRef<{ page: number; within: number } | null>({ page: open.page, within: 0 });
  // …else where the reader is, kept as the zoom and the pages' sizes change.
  const place = useRef<{ page: number; within: number } | null>(null);

  // The dialog over everything.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  // Opening the file.
  useEffect(() => {
    let alive = true;
    const still = () => alive;
    let opened: Book | null = null;
    void (async () => {
      try {
        if (guidebook.type === 'pdf') {
          opened = { type: 'pdf', pdf: await openPdf(guidebook.url, guidebook.bytes) };
        } else {
          const cbz = await openCbz(guidebook.url, guidebook.bytes);
          opened = { type: 'cbz', cbz, first: await pictureSize(await cbz.picture(1)) };
        }
        if (still()) setBook(opened);
        else closeBook(opened);
      } catch (error) {
        if (still()) setProblem(errorText(error));
      }
    })();
    return () => {
      alive = false;
      if (opened) closeBook(opened);
    };
  }, [guidebook]);

  const pages = book ? (book.type === 'pdf' ? book.pdf.pages : book.cbz.pages) : guidebook.pages;
  const unit = book?.type === 'cbz' ? 1 : PDF_UNIT;
  const first: Size = book ? (book.type === 'pdf' ? book.pdf.firstSize : book.first) : LETTER;
  const sizeOf = useCallback((n: number) => sizes.get(n) ?? first, [sizes, first]);
  // A fit follows the room, and the page shown page by page (else the first page).
  const zoom = fit ? fitZoom(fit, mode === 'page' ? sizeOf(page) : first, room, unit) : manualZoom;
  const scale = zoom * unit;

  // The text of its pages, for search: from the pack, kept, or read from the PDF once.
  const texts = useGuidebooks((s) => s.texts);
  const reading = useGuidebooks((s) => s.reading[guidebook.key]);
  useEffect(() => {
    if (!book) return;
    let alive = true;
    const still = () => alive;
    void (async () => {
      await loadGuidebookTexts([guidebook]);
      if (book.type !== 'pdf' || !still() || !textToRead(guidebook)) return;
      noteReading(guidebook.key, 0, book.pdf.pages);
      try {
        const text = await book.pdf.allText((done, total) => {
          if (still()) noteReading(guidebook.key, done, total);
        }, still);
        if (text && still()) await keepReadText(guidebook, text);
      } catch {
        // Its text cannot be read: it is not searched.
      } finally {
        noteReading(guidebook.key, null, 0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [book, guidebook]);

  // The size of the room for pages.
  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setRoom({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const layout = useMemo(
    () =>
      mode === 'scroll'
        ? column(pages, sizes, first, scale)
        : column(1, new Map([[1, sizeOf(page)]]), first, scale),
    [mode, pages, sizes, first, scale, sizeOf, page],
  );

  // Scrolling to the place asked for, or keeping the place, once the column is laid out.
  useLayoutEffect(() => {
    const element = view.current;
    if (!element || !book) return;
    const asked = scrollTo.current;
    scrollTo.current = null;
    if (mode === 'page') {
      if (asked) element.scrollTop = 0;
      return;
    }
    const target = asked ?? place.current;
    if (!target) return;
    const start = layout.starts[target.page - 1] ?? 0;
    const height = layout.heights[target.page - 1] ?? 0;
    element.scrollTop =
      target.within > 0 ? start + target.within * height - element.clientHeight / 3 : start - GAP;
  }, [layout, mode, book, jump]);

  // The page shown follows the scroll.
  const onScroll = () => {
    const element = view.current;
    if (!element || mode !== 'scroll') return;
    setTop(element.scrollTop);
    const middle = element.scrollTop + element.clientHeight / 3;
    const at = pageAt(layout.starts, middle);
    const start = layout.starts[at - 1] ?? 0;
    const height = Math.max(1, layout.heights[at - 1] ?? 0);
    place.current = { page: at, within: Math.min(1, Math.max(0, (middle - start) / height)) };
    if (at !== page) setPage(at);
  };

  // Where it was left, on this device.
  useEffect(() => {
    rememberPage(guidebook, page);
  }, [guidebook, page]);

  /** Shows a page: a jump (a link, the contents, a page typed, a page found) can be gone back from. */
  const goTo = (to: number, isJump: boolean) => {
    const target = Math.min(Math.max(1, to), pages);
    if (isJump && target !== page) setHistory((was) => [...was.slice(-49), page]);
    scrollTo.current = { page: target, within: 0 };
    setPage(target);
    setJump((was) => was + 1);
  };

  const back = () => {
    const last = history.at(-1);
    if (last === undefined) return false;
    setHistory(history.slice(0, -1));
    scrollTo.current = { page: last, within: 0 };
    setPage(last);
    setJump((was) => was + 1);
    return true;
  };

  const changeZoom = (next: number) => {
    setView((was) => {
      saveView(was.mode, null);
      return { ...was, fit: null };
    });
    setManualZoom(clampZoom(next));
  };
  const changeFit = (next: Fit) => {
    setView((was) => {
      saveView(was.mode, next);
      return { ...was, fit: next };
    });
  };
  const changeMode = (next: Mode) => {
    scrollTo.current = { page, within: 0 };
    setView((was) => {
      saveView(next, was.fit);
      return { ...was, mode: next };
    });
  };

  // Ctrl and the wheel, and two fingers, zoom.
  const zoomRef = useRef(zoom);
  const changeZoomRef = useRef(changeZoom);
  useEffect(() => {
    zoomRef.current = zoom;
    changeZoomRef.current = changeZoom;
  });
  useEffect(() => {
    const element = view.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      changeZoomRef.current(zoomRef.current * Math.exp(-event.deltaY * 0.002));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    const touches = new Map<number, { x: number; y: number }>();
    let start: number | null = null;
    let factor = 1;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) {
        start = distance();
        factor = 1;
      }
    };
    const move = (event: PointerEvent) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2 && start) {
        factor = clampZoom(zoomRef.current * (distance() / start)) / zoomRef.current;
        setPinch(factor);
      }
    };
    const up = (event: PointerEvent) => {
      if (!touches.delete(event.pointerId)) return;
      if (start !== null && touches.size < 2) {
        start = null;
        setPinch(1);
        if (Math.abs(factor - 1) > 0.01) changeZoomRef.current(zoomRef.current * factor);
      }
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
    };
  }, []);

  // Search in its text.
  const hits = useMemo(
    () => (query.trim() ? searchGuidebooks([guidebook], texts, query, 100_000) : []),
    [guidebook, texts, query],
  );
  const hitPages = useMemo(() => hits.map((hit) => hit.page), [hits]);
  const words = useMemo(() => (finding ? searchWords(query) : []), [finding, query]);
  const textKnown = texts.has(guidebook.key);

  const onKey = (event: React.KeyboardEvent) => {
    const typing = (event.target as HTMLElement).closest('input, textarea') !== null;
    const control = event.ctrlKey || event.metaKey;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (typing && finding && query) setQuery('');
      else closeGuidebook();
      return;
    }
    if (control && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      setFinding(true);
      window.setTimeout(() => {
        dialog.current?.querySelector<HTMLInputElement>('[data-testid="guidebook-find"]')?.focus();
      });
      return;
    }
    if (control && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      changeZoom(stepZoom(zoom, 1));
      return;
    }
    if (control && event.key === '-') {
      event.preventDefault();
      changeZoom(stepZoom(zoom, -1));
      return;
    }
    if (typing || mode !== 'page') return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      goTo(page + 1, false);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      goTo(page - 1, false);
    } else if (event.key === 'Home') {
      goTo(1, false);
    } else if (event.key === 'End') {
      goTo(pages, false);
    }
  };

  const shown =
    mode === 'scroll'
      ? pagesInView(layout.starts, top, top + room.height, 1)
      : { first: page, last: page };
  const slots: number[] = [];
  if (book) for (let n = shown.first; n <= shown.last; n++) slots.push(n);

  // An issue's contents are the games it covers, with or without the PDF's own.
  const outlineOffered = book?.type === 'pdf' || (issue !== null && issue.issue.games.length > 0);
  return (
    <dialog
      ref={dialog}
      className="gb-reader"
      aria-label={title}
      data-testid="guidebook-reader"
      data-mode={mode}
      data-page={page}
      data-type={guidebook.type}
      data-kind={issue ? 'issue' : 'guidebook'}
      onKeyDown={onKey}
      onCancel={(event) => {
        event.preventDefault();
        // Esc closes it; the Android app's Back goes to the page before a jump, then out.
        if (event.nativeEvent.isTrusted || !back()) closeGuidebook();
      }}
    >
      <header className="gb-bar">
        <button
          type="button"
          className="gb-button"
          data-testid="guidebook-back"
          disabled={history.length === 0}
          title={
            history.length > 0
              ? `Back to page ${numberFormat.format(history.at(-1)!)}`
              : 'Back goes to the page you were on before a jump'
          }
          onClick={() => {
            back();
          }}
        >
          <UiIcon name="back" size={18} />
          Back
        </button>
        <div className="gb-heading">
          <h1 className="gb-title" data-testid="guidebook-title">
            {title}
          </h1>
          <p className="gb-facts">
            {[issue ? dateWords(issue.issue.date) : null, guidebookFacts({ ...guidebook, pages })]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <button
          type="button"
          className="gb-icon-button"
          aria-label={`Close the ${noun}`}
          title={`Close the ${noun} (Esc)`}
          data-testid="guidebook-close"
          onClick={closeGuidebook}
        >
          <UiIcon name="close" size={20} />
        </button>
        <div className="gb-tools" role="toolbar" aria-label="Pages">
          {outlineOffered ? (
            <button
              type="button"
              className="gb-button"
              aria-pressed={panel === 'contents'}
              data-testid="guidebook-contents-button"
              onClick={() => {
                setPanel(panel === 'contents' ? null : 'contents');
              }}
            >
              <UiIcon name={panel === 'contents' ? 'contentsHide' : 'contentsShow'} size={18} />
              Contents
            </button>
          ) : null}
          <button
            type="button"
            className="gb-button"
            aria-pressed={finding}
            data-testid="guidebook-find-button"
            onClick={() => {
              setFinding(!finding);
              if (finding && panel === 'found') setPanel(null);
            }}
          >
            <UiIcon name="search" size={18} />
            Find
          </button>
          <PageField
            page={page}
            pages={pages}
            onGo={(n) => {
              goTo(n, true);
            }}
          />
          <span className="gb-group" role="group" aria-label="Turn the page">
            <button
              type="button"
              className="gb-icon-button"
              aria-label="Previous page"
              data-testid="guidebook-previous"
              disabled={page <= 1}
              onClick={() => {
                goTo(page - 1, false);
              }}
            >
              <UiIcon name="arrowUp" size={18} />
            </button>
            <button
              type="button"
              className="gb-icon-button"
              aria-label="Next page"
              data-testid="guidebook-next"
              disabled={page >= pages}
              onClick={() => {
                goTo(page + 1, false);
              }}
            >
              <UiIcon name="arrowDown" size={18} />
            </button>
          </span>
          <span className="gb-group" role="group" aria-label="Zoom">
            <button
              type="button"
              className="gb-icon-button"
              aria-label="Zoom out"
              title="Zoom out (Ctrl and −)"
              data-testid="guidebook-zoom-out"
              onClick={() => {
                changeZoom(stepZoom(zoom, -1));
              }}
            >
              <UiIcon name="zoomOut" size={18} />
            </button>
            <span className="gb-zoom" data-testid="guidebook-zoom" aria-live="polite">
              {Math.round(zoom * pinch * 100)}%
            </span>
            <button
              type="button"
              className="gb-icon-button"
              aria-label="Zoom in"
              title="Zoom in (Ctrl and +)"
              data-testid="guidebook-zoom-in"
              onClick={() => {
                changeZoom(stepZoom(zoom, 1));
              }}
            >
              <UiIcon name="zoomIn" size={18} />
            </button>
          </span>
          <span className="gb-group" role="group" aria-label="Fit">
            <button
              type="button"
              className="gb-button"
              aria-pressed={fit === 'width'}
              data-testid="guidebook-fit-width"
              onClick={() => {
                changeFit('width');
              }}
            >
              <UiIcon name="width" size={18} />
              Fit width
            </button>
            <button
              type="button"
              className="gb-button"
              aria-pressed={fit === 'page'}
              data-testid="guidebook-fit-page"
              onClick={() => {
                changeFit('page');
              }}
            >
              <UiIcon name="picture" size={18} />
              Fit page
            </button>
          </span>
          <span className="gb-group" role="group" aria-label="Read">
            <button
              type="button"
              className="gb-button"
              aria-pressed={mode === 'page'}
              data-testid="guidebook-page-by-page"
              onClick={() => {
                changeMode('page');
              }}
            >
              Page by page
            </button>
            <button
              type="button"
              className="gb-button"
              aria-pressed={mode === 'scroll'}
              data-testid="guidebook-scrolling"
              onClick={() => {
                changeMode('scroll');
              }}
            >
              Scrolling
            </button>
          </span>
        </div>
        {finding ? (
          <FindBar
            query={query}
            onQuery={(text) => {
              setQuery(text);
              if (text.trim()) setPanel('found');
            }}
            hits={hitPages}
            known={textKnown}
            reading={reading ?? null}
            type={guidebook.type}
            noun={noun}
            onStep={(step) => {
              const to = nextHit(hitPages, page, step);
              if (to !== null) goTo(to, false);
            }}
            listShown={panel === 'found'}
            onList={() => {
              setPanel(panel === 'found' ? null : 'found');
            }}
          />
        ) : null}
      </header>
      <div className="gb-body">
        {panel === 'contents' && book && outlineOffered ? (
          <Contents
            book={book.type === 'pdf' ? book.pdf : null}
            issue={issue}
            page={page}
            onGo={(n) => {
              goTo(n, true);
              if (room.width < 700) setPanel(null);
            }}
          />
        ) : panel === 'found' && finding && query.trim() ? (
          <Found
            hits={hits}
            page={page}
            onGo={(n) => {
              goTo(n, true);
              if (room.width < 700) setPanel(null);
            }}
          />
        ) : null}
        <div
          ref={view}
          className="gb-view"
          data-testid="guidebook-view"
          tabIndex={-1}
          onScroll={onScroll}
        >
          {problem ? (
            <p className="gb-problem" role="alert" data-testid="guidebook-problem">
              {problem}
            </p>
          ) : !book ? (
            <p className="gb-wait" role="status">
              Opening the {noun}…
            </p>
          ) : (
            <div
              className="gb-column"
              style={{
                height: layout.height,
                width: layout.width,
                transform: pinch === 1 ? undefined : `scale(${pinch})`,
              }}
            >
              {slots.map((n) => {
                const size = sizeOf(n);
                return (
                  <PageView
                    key={n}
                    page={n}
                    top={mode === 'scroll' ? (layout.starts[n - 1] ?? GAP) : GAP}
                    width={size.width * scale}
                    height={size.height * scale}
                    scale={scale}
                    pdf={book.type === 'pdf' ? book.pdf : null}
                    cbz={book.type === 'cbz' ? book.cbz : null}
                    words={hitPages.includes(n) ? words : []}
                    onSize={(found) => {
                      setSizes((was) => {
                        const known = was.get(n);
                        return known?.width === found.width && known.height === found.height
                          ? was
                          : new Map(was).set(n, found);
                      });
                    }}
                    onGo={(to) => {
                      goTo(to, true);
                    }}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

function closeBook(book: Book): void {
  if (book.type === 'pdf') book.pdf.close();
  else book.cbz.close();
}

/** The natural size of a picture. */
function pictureSize(address: string): Promise<Size> {
  return new Promise((resolve, reject) => {
    const picture = new Image();
    picture.onload = () => {
      resolve({ width: picture.naturalWidth || 1, height: picture.naturalHeight || 1 });
    };
    picture.onerror = () => {
      reject(new Error('The first page of this guidebook is not a picture that can be shown.'));
    };
    picture.src = address;
  });
}

/** "Page [12] of 212": the page shown, and a page to go to. */
function PageField({
  page,
  pages,
  onGo,
}: {
  page: number;
  pages: number;
  onGo: (page: number) => void;
}) {
  const [text, setText] = useState(String(page));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(page);
  return (
    <form
      className="gb-page-field"
      onSubmit={(event) => {
        event.preventDefault();
        const to = typedPage(text, pages);
        if (to !== null) onGo(to);
        setEditing(false);
        // The keys turn the pages again.
        event.currentTarget.closest('dialog')?.querySelector<HTMLElement>('.gb-view')?.focus();
      }}
    >
      <label>
        <span>Page</span>
        <input
          className="gb-page-input"
          inputMode="numeric"
          aria-label={`Page, of ${pages}`}
          data-testid="guidebook-page"
          value={shown}
          onFocus={(event) => {
            setText(String(page));
            setEditing(true);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setEditing(false);
          }}
          onChange={(event) => {
            setText(event.target.value);
          }}
        />
      </label>
      <span className="gb-of" data-testid="guidebook-pages">
        of {numberFormat.format(pages)}
      </span>
    </form>
  );
}

/** Search in the guidebook: the words, how many pages have them, and the next and previous one. */
function FindBar({
  query,
  onQuery,
  hits,
  known,
  reading,
  type,
  noun,
  onStep,
  listShown,
  onList,
}: {
  query: string;
  onQuery: (query: string) => void;
  hits: readonly number[];
  known: boolean;
  reading: { done: number; total: number } | null;
  type: Guidebook['type'];
  noun: 'guidebook' | 'issue';
  onStep: (step: 1 | -1) => void;
  listShown: boolean;
  onList: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const words = query.trim();
  const state = reading
    ? `Reading the text of the pages for search: ${numberFormat.format(reading.done)} of ${numberFormat.format(reading.total)}.`
    : !known
      ? type === 'cbz'
        ? `This ${noun} has no text to search: its pages are pictures.`
        : `The text of this ${noun} could not be read, so it cannot be searched.`
      : !words
        ? ''
        : hits.length === 0
          ? `No page has “${words}”.`
          : `${numberFormat.format(hits.length)} ${hits.length === 1 ? 'page has' : 'pages have'} “${words}”.`;
  return (
    <div className="gb-find" role="search">
      <UiIcon name="search" size={18} />
      <input
        ref={input}
        type="search"
        className="gb-find-input"
        placeholder={`Find in this ${noun}`}
        aria-label={`Find in this ${noun}`}
        data-testid="guidebook-find"
        value={query}
        onChange={(event) => {
          onQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <button
        type="button"
        className="gb-icon-button"
        aria-label="Previous page found"
        data-testid="guidebook-find-previous"
        disabled={hits.length === 0}
        onClick={() => {
          onStep(-1);
        }}
      >
        <UiIcon name="chevronUp" size={18} />
      </button>
      <button
        type="button"
        className="gb-icon-button"
        aria-label="Next page found"
        data-testid="guidebook-find-next"
        disabled={hits.length === 0}
        onClick={() => {
          onStep(1);
        }}
      >
        <UiIcon name="chevronDown" size={18} />
      </button>
      <button
        type="button"
        className="gb-button"
        aria-pressed={listShown}
        disabled={hits.length === 0}
        data-testid="guidebook-found-button"
        onClick={onList}
      >
        Pages found
      </button>
      <p className="gb-find-state" role="status" data-testid="guidebook-find-state">
        {state}
      </p>
    </div>
  );
}

/** The pages found, each with a line of its text. */
function Found({
  hits,
  page,
  onGo,
}: {
  hits: readonly GuidebookHit[];
  page: number;
  onGo: (page: number) => void;
}) {
  const shown = hits.slice(0, 500);
  return (
    <nav className="gb-side" aria-label="Pages found" data-testid="guidebook-found">
      <h2 className="gb-side-title">Pages found</h2>
      <ul className="gb-list">
        {shown.map((hit) => (
          <li key={hit.page}>
            <button
              type="button"
              className="gb-entry"
              aria-current={hit.page === page ? 'page' : undefined}
              data-testid="guidebook-found-page"
              onClick={() => {
                onGo(hit.page);
              }}
            >
              <span className="gb-entry-page">Page {numberFormat.format(hit.page)}</span>
              <Snippet hit={hit} />
            </button>
          </li>
        ))}
      </ul>
      {hits.length > shown.length ? (
        <p className="gb-side-note">
          The first {numberFormat.format(shown.length)} pages are listed. Next and Previous go to
          every page found.
        </p>
      ) : null}
    </nav>
  );
}

function Snippet({ hit }: { hit: GuidebookHit }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  hit.marks.forEach(([start, end], i) => {
    if (start > at) parts.push(hit.snippet.slice(at, start));
    parts.push(<mark key={i}>{hit.snippet.slice(start, end)}</mark>);
    at = end;
  });
  parts.push(hit.snippet.slice(at));
  return <span className="gb-entry-line">{parts}</span>;
}

/**
 * The contents: an issue's games, each with the pages about it, and the
 * PDF's own contents (its outline), each item a link to its page.
 */
function Contents({
  book,
  issue,
  page,
  onGo,
}: {
  book: PdfBook | null;
  issue: Issue | null;
  page: number;
  onGo: (page: number) => void;
}) {
  const [items, setItems] = useState<OutlineItem[] | null>(null);
  useEffect(() => {
    if (!book) return;
    let current = true;
    void book.outline().then((read) => {
      if (current) setItems(read);
    });
    return () => {
      current = false;
    };
  }, [book]);
  const games = issue?.issue.games ?? [];
  return (
    <nav className="gb-side" aria-label="Contents" data-testid="guidebook-contents">
      {games.length > 0 ? (
        <>
          <h2 className="gb-side-title">Games in this issue</h2>
          <ul className="gb-list">
            {games.map((game, index) => {
              const first = game.pages[0]?.[0] ?? 1;
              const here = game.pages.some(([from, to]) => page >= from && page <= to);
              return (
                <li key={index}>
                  <button
                    type="button"
                    className="gb-entry"
                    aria-current={here ? 'page' : undefined}
                    data-testid="issue-game"
                    onClick={() => {
                      onGo(first);
                    }}
                  >
                    <span className="gb-entry-title">
                      {game.title}
                      {game.system ? ` (${game.system})` : ''}
                    </span>
                    <span className="gb-entry-page">{pagesWords(game.pages)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {book ? (
        <>
          <h2 className="gb-side-title">Contents</h2>
          {items === null ? (
            <p className="gb-side-note">Reading the contents…</p>
          ) : items.length === 0 ? (
            <p className="gb-side-note">
              This {issue ? 'issue' : 'guidebook'} has no list of contents of its own.
            </p>
          ) : (
            <OutlineLevel items={items} page={page} onGo={onGo} />
          )}
        </>
      ) : null}
    </nav>
  );
}

function OutlineLevel({
  items,
  page,
  onGo,
}: {
  items: readonly OutlineItem[];
  page: number;
  onGo: (page: number) => void;
}) {
  return (
    <ul className="gb-list">
      {items.map((item, index) => (
        <li key={index}>
          <button
            type="button"
            className="gb-entry"
            disabled={item.page === null}
            aria-current={item.page === page ? 'page' : undefined}
            data-testid="guidebook-contents-item"
            onClick={() => {
              if (item.page !== null) onGo(item.page);
            }}
          >
            <span className="gb-entry-title">{item.title}</span>
            {item.page !== null ? (
              <span className="gb-entry-page">{numberFormat.format(item.page)}</span>
            ) : null}
          </button>
          {item.items.length > 0 ? (
            <OutlineLevel items={item.items} page={page} onGo={onGo} />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
