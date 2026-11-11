import { foldersOffered } from '../features';
import { openActivityLog } from '../state/activityLog';
import { useAtlas } from '../state/store';

/** The way to the activity log from the Maps dialog. */
export function ActivityLogSection() {
  const folders = useAtlas(foldersOffered);
  return (
    <section className="dialog-section" aria-label="Activity log">
      <h3 className="dialog-subhead">Activity log</h3>
      <p className="muted small">
        {folders
          ? 'What the Atlas apps on this computer did with downloads, added maps and these folders.'
          : 'What this app did with the games on this device, such as imports and deletes.'}{' '}
        Copy it to send it with a question about a problem.
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
