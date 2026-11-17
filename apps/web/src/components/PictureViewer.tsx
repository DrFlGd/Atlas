import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { closePicture, fittedSize, useViewer, type ShownPicture } from '../state/pictureViewer';
import { UiIcon } from './icons';

/**
 * The larger view of a picture, over everything: a photo of a location or
 * a list entry, or a picture in the text of a page. It is a modal dialog:
 * focus goes into it, and Escape, the close button, a press on the dimmed
 * backdrop or Android's Back button (`touch/back.ts` closes the dialog on
 * top) closes it, and focus returns to the picture it was opened from.
 *
 * The picture is fitted to the window, a small one enlarged up to
 * `MOST_ENLARGED` times with sharp pixels. One larger than the
 * window can be seen at its real size (one pixel of its file to one pixel
 * of the page): a press on it, or the zoom button, switches between the
 * two, and at real size it is moved by dragging, by scrolling, with a
 * finger, or with the arrow keys. Pinching is not handled: a touch screen
 * uses the zoom button. Sizes are set through the elements' style objects,
 * never a style attribute, as the desktop app's content security policy
 * refuses those.
 *
 * A GIF that moves, opened from a page with its bytes (`moving`), is
 * shown from those bytes, as a picture of its own (a `blob:` address made
 * when the view opens and let go when it closes): it plays from its start
 * each time, even when the page's picture of it has stopped, and nothing
 * is read again. It plays as it would on the page without the system's
 * setting for less motion, with or without it: opening it is asking to
 * see it.
 */

/** Room kept around a fitted picture, in CSS pixels: beside it, and above and below for the buttons and caption. */
const MARGIN_X = 24;
const MARGIN_Y = 120;
/** A press that moves less than this is a press, not a drag. */
const DRAG_PX = 5;
/** How far an arrow key moves a picture at real size. */
const ARROW_PX = 48;
const ARROWS: Partial<Record<string, { x: number; y: number }>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** The room a fitted picture has: the window less the margins. */
const roomOf = () => ({
  width: Math.max(80, window.innerWidth - MARGIN_X),
  height: Math.max(80, window.innerHeight - MARGIN_Y),
});

/** The larger view, mounted once in each layout. */
export function PictureViewer() {
  const shown = useViewer((s) => s.shown);
  const opened = useViewer((s) => s.opened);
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Which opening the dialog shows: a close event comes a moment after the
  // dialog closes, and must not close a picture opened again meanwhile
  // (Escape, then Enter at once on the picture).
  const showing = useRef(0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (shown && !dialog.open) {
      opener.current = shown.opener ?? null;
      showing.current = opened;
      dialog.showModal();
      // The focus goes to its close button (React's autoFocus ran before the dialog was open).
      dialog.querySelector<HTMLElement>('[data-close]')?.focus();
    }
    if (!shown && dialog.open) dialog.close();
  }, [shown, opened]);

  return (
    <dialog
      ref={ref}
      className="photo-viewer"
      aria-label={shown ? shown.description : 'Picture'}
      data-testid="photo-viewer"
      onClose={(event) => {
        // Opened again since it closed: that picture stays.
        if (event.currentTarget.open || useViewer.getState().opened !== showing.current) return;
        closePicture();
        // Back to the picture it was opened from.
        const back = opener.current;
        opener.current = null;
        if (back?.isConnected) back.focus({ preventScroll: true });
      }}
      onClick={(event) => {
        // A press beside the picture, on the dimmed backdrop.
        const target = event.target as HTMLElement;
        if (target === event.currentTarget || target.dataset.backdrop !== undefined) {
          closePicture();
        }
      }}
    >
      {shown ? <ViewerBody key={opened} shown={shown} /> : null}
    </dialog>
  );
}

function ViewerBody({ shown }: { shown: ShownPicture }) {
  const titleId = useId();
  const stage = useRef<HTMLDivElement>(null);
  // A GIF that moves is shown from its own bytes, as a picture of their own,
  // given to the picture directly (null here) and let go when the view closes.
  const [src, setSrc] = useState<string | null>(shown.moving ? null : shown.url);
  const picture = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = picture.current;
    if (!shown.moving || !img) return;
    const own = URL.createObjectURL(new Blob([shown.moving as BlobPart], { type: 'image/gif' }));
    img.src = own;
    return () => {
      URL.revokeObjectURL(own);
    };
  }, [shown.moving]);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [room, setRoom] = useState(roomOf);
  const [real, setReal] = useState(false);
  // Where the picture was pressed, as a part of its width and height: kept in view at real size.
  const focusAt = useRef<{ x: number; y: number }>({ x: 0.5, y: 0.5 });
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
    id: number;
  } | null>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const resize = () => {
      setRoom(roomOf());
    };
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
    };
  }, []);

  const fitted = natural ? fittedSize(natural, room) : null;
  const zoomable = fitted?.zoomable === true;
  const atReal = real && zoomable;

  // At real size, the place pressed is brought to the middle of the view.
  useLayoutEffect(() => {
    const view = stage.current;
    if (!view || !atReal || !natural) return;
    view.scrollLeft = focusAt.current.x * natural.width - view.clientWidth / 2;
    view.scrollTop = focusAt.current.y * natural.height - view.clientHeight / 2;
  }, [atReal, natural]);

  const toggle = (at?: { x: number; y: number }) => {
    if (!zoomable) return;
    focusAt.current = at ?? { x: 0.5, y: 0.5 };
    setReal((was) => !was);
  };

  const size = !fitted || !natural ? null : atReal ? natural : fitted;
  const upscaled = fitted !== null && !atReal && fitted.scale >= 2;
  const zoomLabel = atReal ? 'Fit to the window' : 'Show at real size';

  return (
    <figure
      className="photo-viewer-figure"
      data-zoom={atReal ? 'real' : 'fitted'}
      onKeyDown={(event) => {
        // The arrow keys move a picture at real size wherever the focus is in the view.
        const view = stage.current;
        const step = ARROWS[event.key];
        if (!atReal || !view || !step || event.target === view) return;
        event.preventDefault();
        view.scrollBy(step.x * ARROW_PX, step.y * ARROW_PX);
      }}
    >
      <div
        ref={stage}
        className="photo-viewer-stage"
        data-backdrop=""
        data-testid="photo-viewer-stage"
        tabIndex={atReal ? 0 : -1}
        aria-label={
          atReal
            ? 'The picture at its real size: drag, scroll or use the arrow keys to move around it'
            : undefined
        }
        onPointerDown={(event) => {
          if (!atReal || event.button !== 0) return;
          const view = event.currentTarget;
          drag.current = {
            x: event.clientX,
            y: event.clientY,
            left: view.scrollLeft,
            top: view.scrollTop,
            moved: false,
            id: event.pointerId,
          };
          dragged.current = false;
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (start?.id !== event.pointerId) return;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (!start.moved && Math.hypot(dx, dy) < DRAG_PX) return;
          if (!start.moved) {
            start.moved = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          event.currentTarget.scrollLeft = start.left - dx;
          event.currentTarget.scrollTop = start.top - dy;
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          dragged.current = drag.current.moved;
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onClick={(event) => {
          // The end of a drag beside the picture closes nothing.
          if (dragged.current) {
            dragged.current = false;
            event.stopPropagation();
          }
        }}
      >
        <img
          ref={picture}
          src={src ?? undefined}
          alt={shown.description}
          draggable={false}
          data-upscaled={upscaled ? '' : undefined}
          data-sized={size ? '' : undefined}
          data-testid="photo-viewer-picture"
          className={zoomable ? (atReal ? 'zoom-out' : 'zoom-in') : undefined}
          style={size ? { width: `${size.width}px`, height: `${size.height}px` } : undefined}
          onLoad={(event) => {
            const img = event.currentTarget;
            if (img.naturalWidth > 0) {
              setNatural({ width: img.naturalWidth, height: img.naturalHeight });
            }
          }}
          onError={() => {
            // Its own bytes could not be shown: its file, as any other picture.
            if (src === null) setSrc(shown.url);
            else if (shown.fallbackUrl && src !== shown.fallbackUrl) setSrc(shown.fallbackUrl);
          }}
          onClick={(event) => {
            event.stopPropagation();
            // The end of a drag is no press.
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            const box = event.currentTarget.getBoundingClientRect();
            toggle({
              x: (event.clientX - box.left) / Math.max(1, box.width),
              y: (event.clientY - box.top) / Math.max(1, box.height),
            });
          }}
        />
      </div>
      <figcaption>
        <span id={titleId}>{shown.description}</span>
        {shown.credit ? <span className="photo-viewer-credit"> · {shown.credit}</span> : null}
        {natural ? (
          <span className="photo-viewer-size" data-testid="photo-viewer-size">
            {' '}
            · {natural.width.toLocaleString('en')} × {natural.height.toLocaleString('en')} pixels
          </span>
        ) : null}
      </figcaption>
      <div className="photo-viewer-tools">
        {zoomable ? (
          <button
            type="button"
            className="photo-viewer-button"
            aria-label={zoomLabel}
            title={zoomLabel}
            aria-pressed={atReal}
            data-testid="photo-viewer-zoom"
            onClick={() => {
              toggle();
            }}
          >
            <UiIcon name={atReal ? 'zoomOut' : 'zoomIn'} size={20} />
          </button>
        ) : null}
        <button
          type="button"
          className="photo-viewer-button"
          aria-label="Close picture"
          title="Close"
          data-close=""
          onClick={closePicture}
        >
          <UiIcon name="close" size={20} />
        </button>
      </div>
    </figure>
  );
}
