import { useEffect, useRef, useState } from 'react';
import type { CbzBook } from './cbz';
import { marksIn, type Size } from './layout';
import type { PageLink, PdfBook, TextRun } from './pdf';

/**
 * One page of a guidebook in the reader, where the column puts it: a PDF
 * page drawn on a canvas, with its links over it and the words looked for
 * marked where its text says they are; or a CBZ page's picture.
 */
export function PageView({
  page,
  top,
  width,
  height,
  scale,
  pdf,
  cbz,
  words,
  onSize,
  onGo,
}: {
  page: number;
  top: number;
  width: number;
  height: number;
  scale: number;
  pdf: PdfBook | null;
  cbz: CbzBook | null;
  /** The words looked for, to mark on the page (empty for none). */
  words: readonly string[];
  /** The page's own size (at scale 1), once known. */
  onSize: (size: Size) => void;
  /** A link to another page of the guidebook was followed. */
  onGo: (page: number) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div
      className="gb-page"
      data-testid="guidebook-page-view"
      data-page={page}
      style={{ top, width, height }}
    >
      {problem ? (
        <p className="gb-page-problem">{problem}</p>
      ) : pdf ? (
        <PdfPage
          book={pdf}
          page={page}
          scale={scale}
          words={words}
          onSize={onSize}
          onGo={onGo}
          onProblem={setProblem}
        />
      ) : cbz ? (
        <CbzPage book={cbz} page={page} onSize={onSize} onProblem={setProblem} />
      ) : null}
    </div>
  );
}

/** How long a page waits for the zoom to stop changing before it is drawn again. */
const DRAW_WAIT = 80;

function PdfPage({
  book,
  page,
  scale,
  words,
  onSize,
  onGo,
  onProblem,
}: {
  book: PdfBook;
  page: number;
  scale: number;
  words: readonly string[];
  onSize: (size: Size) => void;
  onGo: (page: number) => void;
  onProblem: (problem: string) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [links, setLinks] = useState<PageLink[]>([]);
  const [runs, setRuns] = useState<TextRun[] | null>(null);

  useEffect(() => {
    let current = true;
    void book.size(page).then(
      (size) => {
        if (current) onSize(size);
      },
      () => undefined,
    );
    void book.links(page).then(
      (found) => {
        if (current) setLinks(found);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
    // onSize changes with every drawing of the reader; the page's size does not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, page]);

  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const stop = new AbortController();
    const timer = window.setTimeout(
      () => {
        book.draw(page, target, scale, stop.signal).then(
          () => {
            if (!stop.signal.aborted) setDrawn(true);
          },
          (error: unknown) => {
            if (!stop.signal.aborted) {
              onProblem(error instanceof Error ? error.message : 'This page could not be shown.');
            }
          },
        );
      },
      drawn ? DRAW_WAIT : 0,
    );
    return () => {
      window.clearTimeout(timer);
      stop.abort();
    };
    // Drawn again only for another page or zoom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, page, scale]);

  const marking = words.length > 0;
  useEffect(() => {
    if (!marking) return;
    let current = true;
    void book.textRuns(page).then(
      (found) => {
        if (current) setRuns(found);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [book, page, marking]);

  const marks =
    marking && runs
      ? runs.flatMap((run) =>
          marksIn(run.text, words).map((mark) => ({
            x: (run.rect.x + mark.start * run.rect.width) * scale,
            y: run.rect.y * scale,
            width: mark.width * run.rect.width * scale,
            height: run.rect.height * scale,
          })),
        )
      : [];

  return (
    <>
      <canvas
        ref={canvas}
        className="gb-canvas"
        data-drawn={drawn ? 'true' : undefined}
        aria-label={`Page ${page}`}
        role="img"
      />
      {marks.length > 0 ? (
        <div className="gb-marks" aria-hidden="true">
          {marks.slice(0, 500).map((mark, index) => (
            <span
              key={index}
              className="gb-mark"
              data-testid="guidebook-mark"
              style={{ left: mark.x, top: mark.y, width: mark.width, height: mark.height }}
            />
          ))}
        </div>
      ) : null}
      {links.map((link, index) => {
        const style = {
          left: link.rect.x * scale,
          top: link.rect.y * scale,
          width: link.rect.width * scale,
          height: link.rect.height * scale,
        };
        return link.url ? (
          <a
            key={index}
            className="gb-link"
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            title={link.url}
            style={style}
          >
            <span className="visually-hidden">{link.url}</span>
          </a>
        ) : link.page !== null ? (
          <button
            key={index}
            type="button"
            className="gb-link"
            title={`Go to page ${link.page}`}
            aria-label={`Go to page ${link.page}`}
            style={style}
            onClick={() => {
              onGo(link.page!);
            }}
          />
        ) : null;
      })}
    </>
  );
}

function CbzPage({
  book,
  page,
  onSize,
  onProblem,
}: {
  book: CbzBook;
  page: number;
  onSize: (size: Size) => void;
  onProblem: (problem: string) => void;
}) {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    book.picture(page).then(
      (made) => {
        if (current) setAddress(made);
      },
      (error: unknown) => {
        if (current) {
          onProblem(error instanceof Error ? error.message : 'This page could not be shown.');
        }
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, page]);
  if (!address) return null;
  return (
    <img
      className="gb-picture"
      src={address}
      alt={`Page ${page}`}
      draggable={false}
      onLoad={(event) => {
        const picture = event.currentTarget;
        onSize({ width: picture.naturalWidth || 1, height: picture.naturalHeight || 1 });
      }}
      onError={() => {
        onProblem('This page is not a picture that can be shown.');
      }}
    />
  );
}
