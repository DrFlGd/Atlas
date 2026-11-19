import { useState } from 'react';
import {
  ARRIVAL_KEEPS,
  arrivalText,
  dismissArrival,
  loadArrived,
  useArrival,
} from '../state/packArrivals';
import { UiIcon } from './icons';

/**
 * A quiet note in a corner of the window when another version of the pack
 * file of the game shown arrived (see `state/packArrivals.ts`): what came,
 * a button that loads it and what loading it keeps. The person reads on
 * undisturbed until they press it; "Not now" puts the note away.
 */
export function PackArrivalNote() {
  const note = useArrival((s) => s.note);
  const [loading, setLoading] = useState(false);
  if (!note) return null;
  return (
    <section
      className="pack-arrival"
      role="status"
      aria-label="A new version arrived"
      data-testid="pack-arrival"
    >
      <p className="pack-arrival-text">{arrivalText(note)}</p>
      <p className="muted small">{ARRIVAL_KEEPS}</p>
      <div className="row-actions">
        <button
          type="button"
          className="button button-primary button-small"
          data-testid="pack-arrival-load"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            void loadArrived().finally(() => {
              setLoading(false);
            });
          }}
        >
          <UiIcon name="download" size={16} />
          {loading ? 'Loading…' : 'Load it'}
        </button>
        <button
          type="button"
          className="button button-small"
          data-testid="pack-arrival-dismiss"
          disabled={loading}
          onClick={dismissArrival}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
