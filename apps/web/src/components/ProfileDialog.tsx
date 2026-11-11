import {
  exportFileName,
  parseExport,
  type ExportFile,
  type ExportSelection,
  type ImportMode,
  type ImportPlan,
  type Profile,
} from '@atlas/core';
import { useEffect, useId, useRef, useState } from 'react';
import { desktop } from '../desktop';
import { progressFilesOffered } from '../features';
import {
  applyImport,
  createProfile,
  deleteProfile,
  duplicateProfile,
  exportProgress,
  notify,
  previewImport,
  renameProfile,
  setProfileDialogOpen,
  switchProfile,
} from '../state/actions';
import { numberFormat } from '../state/derived';
import { useAtlas } from '../state/store';
import { UiIcon } from './icons';

/**
 * Saves text as a file: through the system's save dialog in the desktop
 * app, else through a temporary download link. Resolves to false when the
 * user closed the dialog.
 */
async function saveFile(name: string, text: string): Promise<boolean> {
  if (desktop) return (await desktop.saveTextFile(name, text)) !== null;
  download(name, text);
  return true;
}

/** Saves text as a file through a temporary download link. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/** Profiles of the current game, and export and import of progress. */
export function ProfileDialog() {
  const open = useAtlas((s) => s.profileDialogOpen);
  const progressFiles = useAtlas(progressFilesOffered);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      data-testid="profile-dialog"
      onClose={() => {
        setProfileDialogOpen(false);
      }}
      onClick={(event) => {
        // A click on the backdrop lands on the dialog element itself.
        if (event.target === ref.current) setProfileDialogOpen(false);
      }}
    >
      {open ? (
        <div className="dialog-body">
          <header className="dialog-head">
            <h2 id={titleId}>Profiles</h2>
            <button
              type="button"
              className="icon-button"
              aria-label="Close"
              onClick={() => {
                setProfileDialogOpen(false);
              }}
            >
              <UiIcon name="close" />
            </button>
          </header>
          <ProfileList />
          <NewProfile />
          {progressFiles ? <ExportImport /> : <NoProgressFiles />}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * In place of export and import where the shell cannot save or open files
 * (the Android app, whose system dialogs give addresses it cannot use yet).
 */
function NoProgressFiles() {
  return (
    <section className="dialog-section" aria-label="Export and import">
      <h3 className="section-title">Export and import</h3>
      <p className="muted small" data-testid="no-progress-files">
        Progress files cannot be exported or imported in this app yet. Your progress is saved on
        this device.
      </p>
    </section>
  );
}

function ProfileList() {
  const profiles = useAtlas((s) => s.profiles);
  const profileId = useAtlas((s) => s.profileId);
  const title = useAtlas((s) => s.game?.pack.manifest.title ?? '');
  return (
    <section className="dialog-section">
      <p className="muted small">
        Each profile keeps its own progress for <strong>{title}</strong>.
      </p>
      <ul className="profile-list" data-testid="profile-list">
        {profiles.map((profile) => (
          <ProfileRow
            key={profile.id}
            profile={profile}
            active={profile.id === profileId}
            only={profiles.length === 1}
          />
        ))}
      </ul>
    </section>
  );
}

function ProfileRow({
  profile,
  active,
  only,
}: {
  profile: Profile;
  active: boolean;
  only: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(profile.name);
  const [confirming, setConfirming] = useState(false);
  const inputId = useId();
  const run = (task: Promise<void>) => {
    task.catch((error: unknown) => {
      notify(error instanceof Error ? error.message : String(error), 'error');
    });
  };

  return (
    <li
      className={active ? 'profile-row profile-row-active' : 'profile-row'}
      data-testid="profile-row"
    >
      {renaming ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              renameProfile(profile.id, name).then(() => {
                setRenaming(false);
              }),
            );
          }}
        >
          <label htmlFor={inputId} className="visually-hidden">
            New name for {profile.name}
          </label>
          <input
            id={inputId}
            className="text-input"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
            }}
          />
          <button type="submit" className="button button-primary" disabled={!name.trim()}>
            Rename
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setRenaming(false);
              setName(profile.name);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <>
          <button
            type="button"
            className="profile-switch"
            aria-pressed={active}
            onClick={() => {
              run(switchProfile(profile.id));
            }}
          >
            <span className="profile-dot" aria-hidden="true" />
            <span className="profile-row-name">{profile.name}</span>
            {active ? <span className="muted small">active</span> : null}
          </button>
          <div className="profile-actions">
            <button
              type="button"
              className="icon-button"
              aria-label={`Rename ${profile.name}`}
              title="Rename"
              onClick={() => {
                setRenaming(true);
              }}
            >
              <UiIcon name="pencil" size={16} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Duplicate ${profile.name}`}
              title="Duplicate"
              onClick={() => {
                run(duplicateProfile(profile.id));
              }}
            >
              <UiIcon name="copy" size={16} />
            </button>
            {confirming ? (
              <button
                type="button"
                className="button button-danger"
                onClick={() => {
                  run(deleteProfile(profile.id));
                }}
                onBlur={() => {
                  setConfirming(false);
                }}
                autoFocus
              >
                Delete {only ? 'and start fresh' : ''}
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete ${profile.name}`}
                title="Delete"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                <UiIcon name="trash" size={16} />
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function NewProfile() {
  const [name, setName] = useState('');
  const inputId = useId();
  return (
    <form
      className="inline-form dialog-section"
      onSubmit={(event) => {
        event.preventDefault();
        void createProfile(name).then(() => {
          setName('');
        });
      }}
    >
      <label htmlFor={inputId} className="visually-hidden">
        New profile name
      </label>
      <input
        id={inputId}
        className="text-input"
        placeholder="New profile name"
        maxLength={80}
        value={name}
        onChange={(event) => {
          setName(event.target.value);
        }}
      />
      <button type="submit" className="button button-primary" disabled={!name.trim()}>
        <UiIcon name="plus" size={16} /> Create
      </button>
    </form>
  );
}

interface PendingImport {
  file: ExportFile;
  fileName: string;
}

function ExportImport() {
  const profileId = useAtlas((s) => s.profileId);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [planned, setPlanned] = useState<{
    source: PendingImport;
    mode: ImportMode;
    plan: ImportPlan;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputId = useId();
  const modeName = useId();

  useEffect(() => {
    if (!pending) return;
    let current = true;
    void previewImport(pending.file, mode).then((plan) => {
      if (current) setPlanned({ source: pending, mode, plan });
    });
    return () => {
      current = false;
    };
  }, [pending, mode]);
  const plan = planned?.source === pending && planned.mode === mode ? planned.plan : null;

  const readImport = (fileName: string, text: string) => {
    const parsed = parseExport(text);
    if (parsed.ok) setPending({ file: parsed.file, fileName });
    else setError(parsed.error);
  };

  const runExport = (selection: ExportSelection) => {
    void exportProgress(selection)
      .then(async (file) => {
        const saved = await saveFile(exportFileName(file), `${JSON.stringify(file, null, 2)}\n`);
        if (!saved) return;
        notify(`Exported ${file.profiles.length} profile${file.profiles.length === 1 ? '' : 's'}.`);
      })
      .catch((reason: unknown) => {
        notify(reason instanceof Error ? reason.message : String(reason), 'error');
      });
  };

  return (
    <section className="dialog-section" aria-labelledby={`${fileInputId}-heading`}>
      <h3 className="section-title" id={`${fileInputId}-heading`}>
        Export and import
      </h3>
      <div className="row-actions wrap">
        <button
          type="button"
          className="button"
          disabled={!profileId}
          onClick={() => {
            if (profileId) runExport({ scope: 'profile', profileId });
          }}
        >
          <UiIcon name="download" size={16} /> Export this profile
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            runExport({ scope: 'all' });
          }}
        >
          <UiIcon name="download" size={16} /> Export all profiles
        </button>
        {desktop ? (
          <button
            type="button"
            className="button"
            data-testid="import-file-desktop"
            onClick={() => {
              setError(null);
              setPending(null);
              void desktop!.openTextFile().then(
                (opened) => {
                  if (opened) readImport(opened.name, opened.contents);
                },
                (reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : String(reason));
                },
              );
            }}
          >
            <UiIcon name="upload" size={16} /> Import from file…
          </button>
        ) : (
          <>
            <label className="button file-button" htmlFor={fileInputId}>
              <UiIcon name="upload" size={16} /> Import from file…
            </label>
            <input
              id={fileInputId}
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              data-testid="import-file"
              onChange={(event) => {
                const input = event.target;
                const chosen = input.files?.[0];
                input.value = '';
                if (!chosen) return;
                setError(null);
                setPending(null);
                void chosen.text().then((text) => {
                  readImport(chosen.name, text);
                });
              }}
            />
          </>
        )}
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {pending ? (
        <div className="import-review" data-testid="import-review">
          <p>
            <strong>{pending.fileName}</strong> holds {pending.file.profiles.length} profile
            {pending.file.profiles.length === 1 ? '' : 's'} (
            {pending.file.profiles.map((p) => p.name).join(', ') || 'none'}), exported{' '}
            {new Date(pending.file.exportedAt).toLocaleString()}.
          </p>
          <fieldset className="import-modes">
            <legend className="visually-hidden">How to import</legend>
            <label>
              <input
                type="radio"
                name={modeName}
                value="merge"
                checked={mode === 'merge'}
                onChange={() => {
                  setMode('merge');
                }}
              />
              <span>
                <strong>Merge</strong>: keep whichever copy of each record is newer.
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={modeName}
                value="replace"
                checked={mode === 'replace'}
                onChange={() => {
                  setMode('replace');
                }}
              />
              <span>
                <strong>Replace</strong>:{' '}
                {pending.file.scope === 'all'
                  ? 'the profiles of these games become exactly what the file holds.'
                  : 'this profile’s progress becomes exactly what the file holds.'}
              </span>
            </label>
          </fieldset>
          {plan ? (
            <p className="muted small" role="status">
              Changes {numberFormat.format(plan.changed.progress)} progress records,{' '}
              {plan.changed.profiles} profile{plan.changed.profiles === 1 ? '' : 's'} and{' '}
              {plan.changed.presets} preset{plan.changed.presets === 1 ? '' : 's'}.
            </p>
          ) : null}
          <div className="row-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={!plan}
              onClick={() => {
                if (!plan) return;
                void applyImport(plan).then(() => {
                  notify(`Imported ${pending.fileName} (${mode}).`);
                  setPending(null);
                });
              }}
            >
              Import
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setPending(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
