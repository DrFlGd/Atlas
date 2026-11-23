import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { desktop } from '../desktop';
import { saveSetting } from '../state/actions';
import { progressStore, SETTINGS } from '../state/services';
import { useAtlas } from '../state/store';

/**
 * Settings › 3D trial: draws a made-up 3D scene, heavier at each step, and
 * measures how this device keeps up (see `scene/trial.ts`). The report is
 * shown, kept on the device for next time, and can be saved as a file to
 * send. three.js is loaded only when the trial starts.
 */
export function SceneTrialRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="touch-row touch-row-button"
        aria-haspopup="dialog"
        data-testid="open-scene-trial"
        onClick={() => {
          setOpen(true);
        }}
      >
        <span className="touch-row-text">
          <span className="touch-row-title">3D trial</span>
          <span className="touch-row-detail">
            How much of a 3D map this device can show: a short test, with a report
          </span>
        </span>
        <span className="touch-row-end">
          <UiIcon name="chevron" size={18} strokeWidth={1.8} />
        </span>
      </button>
      {open ? (
        <SceneTrialDialog
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

type Phase = { kind: 'idle' } | { kind: 'running'; text: string } | { kind: 'done' };

function SceneTrialDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();
  const app = useAtlas((s) => s.app);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [report, setReport] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    let current = true;
    progressStore()
      .getSetting(SETTINGS.sceneTrial)
      .then((text) => {
        if (current && typeof text === 'string') setReport((shown) => shown ?? text);
      })
      .catch(() => {
        // No report yet.
      });
    return () => {
      current = false;
      abort.current?.abort();
    };
  }, []);

  const start = async () => {
    const container = stage.current;
    if (!container) return;
    const controller = new AbortController();
    abort.current = controller;
    setSaved(null);
    setPhase({ kind: 'running', text: 'Starting…' });
    const [{ runTrial, trialReport }, { deviceSignals }] = await Promise.all([
      import('../scene/trial'),
      import('../scene/device'),
    ]);
    const signals = deviceSignals();
    const count = new Intl.NumberFormat('en');
    const result = await runTrial(
      container,
      signals,
      (progress) => {
        setPhase({
          kind: 'running',
          text: `Step ${progress.step} of ${progress.steps}: ${count.format(progress.triangles)} triangles, ${count.format(Math.round(progress.textureBytes / (1 << 20)))} MB of textures`,
        });
      },
      controller.signal,
    );
    abort.current = null;
    const text = trialReport(result, signals, app, new Date());
    setReport(text);
    saveSetting(SETTINGS.sceneTrial, text);
    setPhase({ kind: 'done' });
  };

  const saveFile = async () => {
    if (!report) return;
    const name = 'atlas-3d-trial.txt';
    if (desktop) {
      const done = await desktop.saveTrialReport(name, report);
      if (done) setSaved(`Saved as ${done.name}.`);
      return;
    }
    const url = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
    setSaved(`Saved as ${name}, with your downloads.`);
  };

  const running = phase.kind === 'running';
  return (
    <dialog
      ref={ref}
      className="dialog scene-trial-dialog"
      aria-labelledby={titleId}
      data-testid="scene-trial"
      onClose={onClose}
      onCancel={(event) => {
        if (running) {
          event.preventDefault();
          abort.current?.abort();
        }
      }}
    >
      <div className="dialog-body">
        <header className="dialog-head">
          <h2 id={titleId}>3D trial</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="Close"
            disabled={running}
            onClick={() => ref.current?.close()}
          >
            <UiIcon name="close" />
          </button>
        </header>
        <p className="muted">
          Draws a made-up 3D scene, heavier at each step, for up to about half a minute, and
          measures how many frames a second this device shows. It stops by itself when frames come
          too slowly or a step fails.
        </p>
        <div ref={stage} className="scene-trial-stage" aria-hidden="true" />
        <div className="scene-trial-actions">
          {running ? (
            <>
              <span role="status" data-testid="scene-trial-step">
                {phase.text}
              </span>
              <button
                type="button"
                className="button"
                onClick={() => {
                  abort.current?.abort();
                }}
              >
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              className="button button-primary"
              data-testid="scene-trial-start"
              onClick={() => {
                void start();
              }}
            >
              {report ? 'Run the trial again' : 'Start the trial'}
            </button>
          )}
        </div>
        {report && !running ? (
          <section className="scene-trial-report" aria-label="Report">
            <h3 className="section-title">
              {phase.kind === 'done' ? 'Report' : 'Report of the last trial'}
            </h3>
            <pre data-testid="scene-trial-report">{report}</pre>
            <div className="scene-trial-actions">
              <button
                type="button"
                className="button"
                data-testid="scene-trial-save"
                onClick={() => {
                  void saveFile();
                }}
              >
                <UiIcon name="save" size={16} />
                Save the report as a file
              </button>
              {saved ? <span className="muted small">{saved}</span> : null}
            </div>
          </section>
        ) : null}
      </div>
    </dialog>
  );
}
