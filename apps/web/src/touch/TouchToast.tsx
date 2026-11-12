import { useEffect, useState } from 'react';
import { UiIcon } from '../components/icons';
import { undo } from '../state/actions';
import { useAtlas } from '../state/store';
import { KeyHint } from './widgets';
import { useKeyHints } from './state';

/**
 * The latest notice, at the bottom over the map, announced to screen
 * readers. A change that undo takes back gets an Undo button.
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
      notice.tone === 'error' ? 8000 : notice.undo ? 5000 : 3500,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  const shown = notice && notice.seq !== dismissed ? notice : null;
  return (
    <div
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
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
