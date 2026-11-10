import { useEffect, useState } from 'react';
import { useAtlas } from '../state/store';

/** The latest notice, shown briefly over the map and announced to screen readers. */
export function Toast() {
  const notice = useAtlas((s) => s.notice);
  const [dismissed, setDismissed] = useState(0);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(
      () => {
        setDismissed(notice.seq);
      },
      notice.tone === 'error' ? 8000 : 3500,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {notice && notice.seq !== dismissed ? (
        <div
          className={notice.tone === 'error' ? 'toast toast-error' : 'toast'}
          key={notice.seq}
          data-testid="toast"
        >
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}
