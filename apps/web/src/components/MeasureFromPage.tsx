import { useEffect, useId, useState } from 'react';
import { pageMeasureOffered, setMeasureFromPage, useImport } from '../state/importing';

/** The tick box's words, and its hint. Exported for tests. */
export const MEASURE_LABEL = 'Measure the map picture from the page (zooms the page out)';
export const MEASURE_HINT =
  'For a map that came out cut off. After the page has loaded, this app presses the page’s own zoom-out button until the map is zoomed out all the way, and notes which map images the page loads. The page window opens as large as your screen; leave it as it is until it closes by itself. This takes up to about two minutes more for each map.';

/**
 * "Measure the map picture from the page": a tick box, off at first, shown
 * only in an app that downloads map images and only when the importer of
 * one of `urls` can measure its page. Mount it behind
 * `__ATLAS_DOWNLOADS__`.
 */
export function MeasureFromPage({ urls }: { urls: readonly string[] }) {
  const ticked = useImport((s) => s.measureFromPage);
  const [offered, setOffered] = useState(false);
  const boxId = useId();
  const hintId = useId();
  const key = urls.join('\n');

  useEffect(() => {
    let live = true;
    pageMeasureOffered(key ? key.split('\n') : []).then(
      (yes) => {
        if (live) setOffered(yes);
      },
      () => {
        if (live) setOffered(false);
      },
    );
    return () => {
      live = false;
    };
  }, [key]);

  if (!offered) return null;
  return (
    <div className="add-map-measure" data-testid="add-map-measure">
      <label htmlFor={boxId} className="checkbox-row">
        <input
          id={boxId}
          type="checkbox"
          checked={ticked}
          aria-describedby={hintId}
          data-testid="add-map-measure-box"
          onChange={(event) => {
            setMeasureFromPage(event.target.checked);
          }}
        />
        <span>{MEASURE_LABEL}</span>
      </label>
      <p className="muted small" id={hintId}>
        {MEASURE_HINT}
      </p>
    </div>
  );
}
