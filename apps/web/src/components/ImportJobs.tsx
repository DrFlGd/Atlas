import { useEffect, useId, useState } from 'react';
import { downloadsOffered } from '../features';
import { pagesOfAddresses } from '../state/importing';
import {
  changeJob,
  jobText,
  loadJobs,
  removeJob,
  renameJob,
  startJob,
  unqueueJob,
  useImportJobs,
  whyJobNeedsPerson,
  type ImportJob,
  type JobWhat,
} from '../state/importJobs';
import { useAtlas } from '../state/store';
import { localDate } from './packFileText';

/**
 * Jobs (see `state/importJobs.ts`): "Save as a job" beside the buttons that
 * start an import, and the list of jobs in Downloads, each with Start,
 * Rename, Change and Remove.
 */

/** "Save as a job", in an app that downloads, where the jobs are listed in Downloads. */
export function SaveAsJob({
  onSave,
  disabled = false,
  testId,
}: {
  onSave: () => unknown;
  disabled?: boolean;
  testId: string;
}) {
  const offered = useAtlas((s) => __ATLAS_DOWNLOADS__ && downloadsOffered(s));
  if (!offered) return null;
  return (
    <button
      type="button"
      className="button"
      data-testid={testId}
      title="Keeps what this would read, to start it later from Downloads; nothing is read now"
      disabled={disabled}
      onClick={() => void onSave()}
    >
      Save as a job
    </button>
  );
}

/** The jobs, in Downloads. */
export function JobsList() {
  const jobs = useImportJobs((s) => s.jobs);
  const loaded = useImportJobs((s) => s.loaded);
  useEffect(() => {
    void loadJobs();
  }, []);
  if (!loaded) return null;
  return (
    <section className="library-downloads-group" data-testid="downloads-saved-jobs">
      <h3>Jobs</h3>
      {jobs.length === 0 ? (
        <p className="muted small" data-testid="downloads-saved-jobs-empty">
          No jobs yet. Save as a job, beside Add, keeps an import to start later; nothing is read
          until you start it.
        </p>
      ) : (
        <>
          <p className="muted small">
            Each job keeps what it reads, not the pages, and is read as the site’s rules are when it
            runs. Jobs started together run one after another, with the pause the site asks for
            between pages; a refusal or Stop ends them.
          </p>
          <ul className="saved-jobs">
            {jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function JobRow({ job }: { job: ImportJob }) {
  const running = useImportJobs((s) => s.running === job.id);
  const queued = useImportJobs((s) => s.queue.includes(job.id));
  const busy = useImportJobs((s) => s.running !== null);
  const [editing, setEditing] = useState<'name' | 'what' | null>(null);
  const [removing, setRemoving] = useState(false);
  const [person, setPerson] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    whyJobNeedsPerson(job.what).then(
      (why) => {
        if (live) setPerson(why);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [job.what]);
  return (
    <li
      className="saved-job"
      data-testid="saved-job"
      data-id={job.id}
      data-state={running ? 'running' : queued ? 'queued' : 'idle'}
    >
      {editing === 'name' ? (
        <RenameJob
          job={job}
          onDone={() => {
            setEditing(null);
          }}
        />
      ) : (
        <span className="library-job-title" data-testid="saved-job-name">
          {job.name}
        </span>
      )}
      <span className="muted small" data-testid="saved-job-text">
        {jobText(job.what)}
      </span>
      {person ? (
        <span className="download-note small" data-testid="saved-job-person">
          It cannot run by itself. {person}
        </span>
      ) : null}
      {job.last ? (
        <span className="muted small" data-testid="saved-job-last">
          Last run {localDate(job.last.at)}: {job.last.text}
        </span>
      ) : null}
      {running ? (
        <span className="small" role="status">
          Running now. Its pages show in Now, above, with Stop.
        </span>
      ) : null}
      {editing === 'what' ? (
        <ChangeJob
          job={job}
          onDone={() => {
            setEditing(null);
          }}
        />
      ) : null}
      {removing ? (
        <span className="library-confirm-inline" role="group" aria-label="Remove the job?">
          <span>Remove this job? What it added stays.</span>
          <button
            type="button"
            className="button button-small button-danger"
            data-testid="saved-job-remove-confirm"
            onClick={() => {
              setRemoving(false);
              removeJob(job.id);
            }}
          >
            Remove
          </button>
          <button
            type="button"
            className="button button-small"
            onClick={() => {
              setRemoving(false);
            }}
          >
            Cancel
          </button>
        </span>
      ) : (
        <span className="row-actions wrap">
          {queued ? (
            <button
              type="button"
              className="button button-small"
              data-testid="saved-job-unqueue"
              onClick={() => {
                unqueueJob(job.id);
              }}
            >
              Take out of the queue
            </button>
          ) : (
            <button
              type="button"
              className="button button-small button-primary"
              data-testid="saved-job-start"
              disabled={running || person !== null}
              onClick={() => void startJob(job.id)}
            >
              {busy && !running ? 'Start after the job running' : 'Start'}
            </button>
          )}
          <button
            type="button"
            className="button button-small"
            data-testid="saved-job-rename"
            disabled={editing !== null}
            onClick={() => {
              setEditing('name');
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            className="button button-small"
            data-testid="saved-job-change"
            disabled={editing !== null || running || queued}
            onClick={() => {
              setEditing('what');
            }}
          >
            Change…
          </button>
          <button
            type="button"
            className="button button-small"
            data-testid="saved-job-remove"
            disabled={running}
            onClick={() => {
              setRemoving(true);
            }}
          >
            Remove…
          </button>
        </span>
      )}
    </li>
  );
}

function RenameJob({ job, onDone }: { job: ImportJob; onDone: () => void }) {
  const id = useId();
  const [name, setName] = useState(job.name);
  return (
    <form
      className="saved-job-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        renameJob(job.id, name);
        onDone();
      }}
    >
      <label htmlFor={id} className="visually-hidden">
        Name of the job
      </label>
      <input
        id={id}
        className="text-input"
        maxLength={100}
        autoFocus
        data-testid="saved-job-name-input"
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onDone();
          }
        }}
      />
      <span className="row-actions">
        <button
          type="submit"
          className="button button-small button-primary"
          data-testid="saved-job-name-save"
          disabled={!name.trim()}
        >
          Rename
        </button>
        <button type="button" className="button button-small" onClick={onDone}>
          Cancel
        </button>
      </span>
    </form>
  );
}

/** What a job reads, to change: its pages' addresses, or its games and their system. */
function ChangeJob({ job, onDone }: { job: ImportJob; onDone: () => void }) {
  const id = useId();
  const what = job.what;
  const [text, setText] = useState(
    what.kind === 'pages' ? what.pages.map((page) => page.url).join('\n') : '',
  );
  const [system, setSystem] = useState(what.kind === 'games' ? what.system : '');
  const [kept, setKept] = useState<string[]>(
    what.kind === 'games' ? what.games.map((game) => game.id) : [],
  );
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    let next: JobWhat;
    if (what.kind === 'pages') {
      const found = await pagesOfAddresses(text);
      if ('problem' in found) {
        setProblem(found.problem);
        return;
      }
      // A page kept keeps the title it had.
      const titles = new Map(what.pages.map((page) => [page.url, page.title]));
      next = {
        ...what,
        pages: found.pages.map((page) => ({ ...page, title: titles.get(page.url) ?? page.title })),
      };
    } else {
      const games = what.games.filter((game) => kept.includes(game.id));
      if (games.length === 0) {
        setProblem('Keep at least one game, or remove the job.');
        return;
      }
      next = { ...what, games, system: system.trim().slice(0, 80) };
    }
    changeJob(job.id, next);
    onDone();
  };
  return (
    <form
      className="saved-job-form"
      data-testid="saved-job-change-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {what.kind === 'pages' ? (
        <>
          <label htmlFor={id} className="field-label">
            Map pages, one address per line
          </label>
          <textarea
            id={id}
            className="library-input add-map-addresses"
            rows={Math.min(8, Math.max(3, what.pages.length + 1))}
            spellCheck={false}
            data-testid="saved-job-pages"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setProblem(null);
            }}
          />
        </>
      ) : (
        <>
          <label htmlFor={id} className="field-label">
            System
          </label>
          <input
            id={id}
            className="text-input"
            maxLength={80}
            data-testid="saved-job-system"
            value={system}
            onChange={(event) => {
              setSystem(event.target.value);
            }}
          />
          <fieldset className="saved-job-games">
            <legend className="field-label">Games</legend>
            {what.games.map((game) => (
              <label key={game.id} className="checkbox-row" data-testid="saved-job-game">
                <input
                  type="checkbox"
                  checked={kept.includes(game.id)}
                  onChange={(event) => {
                    const on = event.target.checked;
                    setKept((now) =>
                      on ? [...now, game.id] : now.filter((other) => other !== game.id),
                    );
                    setProblem(null);
                  }}
                />
                <span>{game.name}</span>
              </label>
            ))}
          </fieldset>
        </>
      )}
      {problem ? (
        <p className="download-error small" role="alert">
          {problem}
        </p>
      ) : null}
      <span className="row-actions">
        <button
          type="submit"
          className="button button-small button-primary"
          data-testid="saved-job-change-save"
        >
          Save the job
        </button>
        <button type="button" className="button button-small" onClick={onDone}>
          Cancel
        </button>
      </span>
    </form>
  );
}
