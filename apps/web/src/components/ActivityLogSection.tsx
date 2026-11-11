import { openActivityLog } from '../state/activityLog';

/** The way to the activity log from the Maps dialog. */
export function ActivityLogSection() {
  return (
    <section className="dialog-section" aria-label="Activity log">
      <h3 className="dialog-subhead">Activity log</h3>
      <p className="muted small">
        What the Atlas apps on this computer did with downloads, added maps and these folders. Copy
        it to send it with a question about a problem.
      </p>
      <div className="row-actions">
        <button
          type="button"
          className="button"
          data-testid="open-activity-log"
          onClick={() => {
            openActivityLog();
          }}
        >
          View activity log…
        </button>
      </div>
    </section>
  );
}
