import { UiIcon } from '../components/icons';
import { useKeyHints } from './state';

/** A ring that fills with progress, from the top clockwise. Decorative; the control carries the label. */
export function ProgressRing({
  value,
  size,
  stroke,
}: {
  /** Percent, 0 to 100. */
  value: number;
  size: number;
  stroke: number;
}) {
  const r = 16;
  const circumference = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, value)) / 100) * circumference;
  return (
    <svg
      className="touch-ring"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="touch-ring-track" cx="20" cy="20" r={r} fill="none" strokeWidth={stroke} />
      {filled > 0 ? (
        <circle
          className="touch-ring-fill"
          cx="20"
          cy="20"
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filled.toFixed(1)} ${circumference.toFixed(1)}`}
          transform="rotate(-90 20 20)"
        />
      ) : null}
    </svg>
  );
}

/** The look of a switch; the button around it has `role="switch"`. */
export function SwitchTrack({ on }: { on: boolean }) {
  return (
    <span className={on ? 'touch-switch touch-switch-on' : 'touch-switch'} aria-hidden="true">
      <span className="touch-switch-thumb" />
    </span>
  );
}

/** A thin bar that fills with progress. Decorative. */
export function Meter({ found, total }: { found: number; total: number }) {
  return (
    <span className="touch-meter" aria-hidden="true">
      <span
        className="touch-meter-fill"
        style={{ width: `${(found / Math.max(1, total)) * 100}%` }}
      />
    </span>
  );
}

/** The look of a tick: a box (checklist entries) or a circle (places). */
export function TickMark({ done, round = false }: { done: boolean; round?: boolean }) {
  const shape = round ? ' touch-tick-round' : '';
  return done ? (
    <span className={`touch-tick touch-tick-done${shape}`} aria-hidden="true">
      <UiIcon name="check" size={16} strokeWidth={2.6} />
    </span>
  ) : (
    <span className={`touch-tick${shape}`} aria-hidden="true" />
  );
}

/** The heading of a group of rows, with an optional figure at its end. */
export function GroupTitle({
  id,
  children,
  figure,
}: {
  id?: string;
  children: React.ReactNode;
  figure?: React.ReactNode;
}) {
  return (
    <div className="touch-group-head">
      <h2 className="touch-group-title" id={id}>
        {children}
      </h2>
      {figure !== undefined ? <span className="touch-figure">{figure}</span> : null}
    </div>
  );
}

/** A key shown on a button, where keys are shown (see {@link useKeyHints}). Hidden from screen readers; the button says it with `aria-keyshortcuts`. */
export function KeyHint({ k }: { k: string }) {
  return useKeyHints() ? (
    <kbd className="touch-kbd" aria-hidden="true">
      {k}
    </kbd>
  ) : null;
}
