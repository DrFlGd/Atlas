import { useEffect, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { undo } from '../state/actions';
import { useAtlas } from '../state/store';
import { KeyHint } from './widgets';
import { useKeyHints } from './state';

/**
 * The latest notice, at the top of the map or of the screen shown,
 * announced to screen readers. A change that undo takes back gets an Undo
 * button. While it shows, its height is `--touch-toast-h` on the layout, and
 * what stands at the top moves down by it (see touch.css), so the notice
 * never lies over a button.
 */
export function TouchToast({ wide }: { wide: boolean }) {
  const notice = useAtlas((s) => s.notice);
  const [dismissed, setDismissed] = useState(0);
  const hints = useKeyHints();
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => {
        setDismissed(notice.seq);
      },
      notice.tone === 'error' ? 8000 : notice.undo || notice.action ? 6000 : 3500,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  const shown = notice && notice.seq !== dismissed ? notice : null;
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = region.current;
    const layout = element?.closest<HTMLElement>('.touch');
    if (!element || !layout) return;
    const follow = () => {
      layout.style.setProperty('--touch-toast-h', `${element.offsetHeight}px`);
    };
    follow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      layout.style.removeProperty('--touch-toast-h');
    };
  }, [shown?.seq, wide]);
  return (
    <div
      ref={region}
      className={wide ? 'touch-toast-region touch-toast-region-wide' : 'touch-toast-region'}
      role="status"
      aria-live="polite"
    >
      {shown ? (
        <div
          className={shown.tone === 'error' ? 'touch-toast touch-toast-error' : 'touch-toast'}
          key={shown.seq}
          data-testid="toast"
        >
          <span className="touch-toast-text">{shown.text}</span>
          {shown.undo ? (
            <button
              type="button"
              className="touch-toast-action"
              data-testid="toast-undo"
              title={hints ? 'Undo (Z)' : undefined}
              aria-keyshortcuts={hints ? 'Z' : undefined}
              onClick={() => {
                setDismissed(shown.seq);
                undo();
              }}
            >
              <UiIcon name="undo" size={18} strokeWidth={1.9} />
              Undo
              <KeyHint k="Z" />
            </button>
          ) : shown.action ? (
            <button
              type="button"
              className="touch-toast-action"
              data-testid="toast-action"
              onClick={() => {
                setDismissed(shown.seq);
                shown.action?.run();
              }}
            >
              <UiIcon name="undo" size={18} strokeWidth={1.9} />
              {shown.action.label}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
