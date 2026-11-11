import { useId, useState } from 'react';
import { copyText } from '../clipboard';
import type { StopDetail } from '../desktop';
import { displayTime } from '../activityLog';
import { numberFormat } from '../state/derived';
import { openActivityLog } from '../state/activityLog';

/** "Island – Surface, level 3: column 0 of 216, row 231 of 232 (an edge of the map)". */
function describeImage(detail: StopDetail): string {
  const parts: string[] = [];
  if (detail.layer) parts.push(detail.layer);
  const place = detail.place;
  if (place) {
    parts.push(
      `level ${place.z}: column ${place.x} of ${place.columns}, row ${place.y} of ${place.rows}, counted from 0 (${
        place.x === 0 || place.y === 0 || place.x + 1 >= place.columns || place.y + 1 >= place.rows
          ? 'at an edge of the map'
          : 'not at an edge'
      })`,
    );
  }
  return parts.join(', ');
}

/**
 * What stopped a download on a refusal or a web page: which image, how
 * many were saved before it, the server's answer, and the way to the log.
 */
export function StopDetails({ detail }: { detail: StopDetail }) {
  const urlId = useId();
  const [copied, setCopied] = useState(false);
  return (
    <div className="stop-detail" data-testid="stop-detail">
      <dl className="stop-detail-list">
        <dt>Image</dt>
        <dd data-testid="stop-detail-image">{describeImage(detail) || 'Not known'}</dd>
        <dt>Saved before it</dt>
        <dd data-testid="stop-detail-saved">
          {numberFormat.format(detail.savedBefore)} image{detail.savedBefore === 1 ? '' : 's'} in
          this download
        </dd>
        <dt>Answer</dt>
        <dd>
          HTTP {detail.status} from {detail.host}, {displayTime(detail.at)}
        </dd>
      </dl>
      <label htmlFor={urlId} className="field-label small">
        Address of the image
      </label>
      <div className="inline-form">
        <input
          id={urlId}
          className="text-input stop-detail-url"
          data-testid="stop-detail-url"
          readOnly
          spellCheck={false}
          value={detail.url}
          onFocus={(event) => {
            event.target.select();
          }}
        />
        <button
          type="button"
          className="button"
          onClick={() => {
            void copyText(detail.url).then(setCopied);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {detail.headers.length > 0 || detail.body ? (
        <details className="stop-detail-answer">
          <summary>What the server sent</summary>
          <ul className="stop-detail-headers">
            {detail.headers.map(([name, value]) => (
              <li key={name}>
                {name}: {value}
              </li>
            ))}
          </ul>
          {detail.body ? <p className="stop-detail-body">{detail.body}</p> : null}
        </details>
      ) : null}
      <ViewLogButton />
    </div>
  );
}

/** Opens the activity log on its downloads. */
export function ViewLogButton() {
  return (
    <button
      type="button"
      className="link-button"
      data-testid="view-log"
      onClick={() => {
        openActivityLog('download');
      }}
    >
      View log
    </button>
  );
}
