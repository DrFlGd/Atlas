import { PadGlyph } from '../input/PadGlyph';
import {
  glyphStyle,
  setPadSetting,
  usePad,
  type GlyphSetting,
  type HintsSetting,
} from '../input/padState';
import type { PanSpeed } from '../input/padMath';
import { GroupTitle, SwitchTrack } from './widgets';

const HINTS: { value: HintsSetting; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'always', label: 'Always' },
  { value: 'never', label: 'Never' },
];

const GLYPHS: { value: GlyphSetting; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'letters', label: 'Letters' },
  { value: 'shapes', label: 'Shapes' },
];

const SPEEDS: { value: PanSpeed; label: string }[] = [
  { value: 'slow', label: 'Slow' },
  { value: 'normal', label: 'Normal' },
  { value: 'fast', label: 'Fast' },
];

/** One choice of a few, as the other settings are. */
function Choice<T extends string>({
  id,
  label,
  note,
  choices,
  value,
  onChoose,
}: {
  id: string;
  label: string;
  note: React.ReactNode;
  choices: { value: T; label: string }[];
  value: T;
  onChoose: (value: T) => void;
}) {
  return (
    <div className="touch-setting-row touch-setting-row-noted" data-testid={`pad-${id}`}>
      <span className="touch-setting-label" id={`pad-${id}-label`}>
        {label}
      </span>
      <div
        className="touch-segmented"
        role="group"
        aria-labelledby={`pad-${id}-label`}
        aria-describedby={`pad-${id}-note`}
      >
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className="touch-segment"
            aria-pressed={value === choice.value}
            data-testid={`pad-${id}-${choice.value}`}
            onClick={() => {
              onChoose(choice.value);
            }}
          >
            {choice.label}
          </button>
        ))}
      </div>
      <span className="touch-switch-note touch-setting-note" id={`pad-${id}-note`}>
        {note}
      </span>
    </div>
  );
}

/** Whether Atlas sees a controller now, and what to do when it does not. */
function Detected() {
  const padId = usePad((s) => s.padId);
  const offered = usePad((s) => s.offered);
  return (
    <p
      className="touch-switch-note pad-detected"
      data-testid="pad-detected"
      data-detected={padId !== null}
    >
      {padId !== null ? (
        <>
          <strong>A controller is detected now.</strong>{' '}
          <span className="pad-detected-name">{padId}</span>
        </>
      ) : offered ? (
        <>
          <strong>No controller is detected now.</strong> Press a button on it if one is connected.
          If none shows here, Steam Input may be sending keys instead: the keys under Keys and
          controller work then.
        </>
      ) : (
        <>
          <strong>This app cannot see controllers here.</strong> Steam Input can send keys instead:
          the keys under Keys and controller work then.
        </>
      )}
    </p>
  );
}

/**
 * The settings of a controller (stored on the device as the theme is): when
 * the hint bar shows, the glyphs of the buttons, how fast the sticks move
 * the map, and up and down turned round; and whether a controller is
 * detected now.
 */
export function ControllerSettings() {
  const hints = usePad((s) => s.hints);
  const glyphs = usePad((s) => s.glyphs);
  const speed = usePad((s) => s.speed);
  const invertY = usePad((s) => s.invertY);
  const style = usePad(glyphStyle);
  return (
    <section
      aria-labelledby="pad-settings-heading"
      className="touch-settings pad-settings"
      data-testid="controller-settings"
    >
      <GroupTitle id="pad-settings-heading">Controller</GroupTitle>
      <Detected />
      <Choice
        id="hints"
        label="Button hints"
        note="A bar at the bottom of the screen shows what the buttons do there. Automatic shows it after you use the controller, and hides it after you use the mouse, the touch screen or the keys."
        choices={HINTS}
        value={hints}
        onChoose={(value) => {
          setPadSetting('hints', value);
        }}
      />
      <Choice
        id="glyphs"
        label="Button names"
        note={
          <>
            Letters (A, B, X, Y) or shapes (cross, circle, square, triangle). Automatic takes them
            from the controller. Now:{' '}
            <span className="pad-glyph-sample">
              {(['a', 'b', 'x', 'y'] as const).map((button) => (
                <PadGlyph key={button} button={button} style={style} size={18} />
              ))}
            </span>
          </>
        }
        choices={GLYPHS}
        value={glyphs}
        onChoose={(value) => {
          setPadSetting('glyphs', value);
        }}
      />
      <Choice
        id="speed"
        label="Map speed"
        note="How fast the sticks move the map."
        choices={SPEEDS}
        value={speed}
        onChoose={(value) => {
          setPadSetting('speed', value);
        }}
      />
      <button
        type="button"
        role="switch"
        aria-checked={invertY}
        className="touch-switch-card"
        data-testid="pad-invert"
        onClick={() => {
          setPadSetting('invertY', !invertY);
        }}
      >
        <span className="touch-switch-label">
          Invert up and down
          <span className="touch-switch-note">
            Push a stick up to see more of the map below, as when you drag it
          </span>
        </span>
        <SwitchTrack on={invertY} />
      </button>
    </section>
  );
}
