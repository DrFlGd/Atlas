import type { PadButton } from './bindings';
import { padButtonName, type GlyphStyle } from './padMath';

/**
 * A controller's button drawn as a small glyph, in the colour of the text
 * around it: our own simple drawings, no maker's artwork. Letters mark the
 * face buttons A, B, X and Y; shapes mark them cross, circle, square and
 * triangle, with the bumpers and triggers L1, R1, L2 and R2.
 */

const STROKE = 1.6;

/** A face button: a ring with its letter or its shape. */
function Face({ button, style }: { button: 'a' | 'b' | 'x' | 'y'; style: GlyphStyle }) {
  const ring = <circle cx="12" cy="12" r="10.2" fill="none" strokeWidth={STROKE} />;
  if (style === 'letters') {
    return (
      <>
        {ring}
        <text x="12" y="16.1" textAnchor="middle" fontSize="11.5" fontWeight="700" stroke="none">
          {button.toUpperCase()}
        </text>
      </>
    );
  }
  const shape =
    button === 'a' ? (
      <path d="M8 8 16 16M16 8 8 16" fill="none" strokeWidth={STROKE + 0.2} />
    ) : button === 'b' ? (
      <circle cx="12" cy="12" r="4.6" fill="none" strokeWidth={STROKE + 0.2} />
    ) : button === 'x' ? (
      <rect x="7.8" y="7.8" width="8.4" height="8.4" fill="none" strokeWidth={STROKE + 0.2} />
    ) : (
      <path d="M12 7 17 15.6H7Z" fill="none" strokeWidth={STROKE + 0.2} strokeLinejoin="round" />
    );
  return (
    <>
      {ring}
      {shape}
    </>
  );
}

/** A bumper or a trigger: a rounded block with its name. */
function Shoulder({ label, trigger }: { label: string; trigger: boolean }) {
  return (
    <>
      {trigger ? (
        <path
          d="M4 21V9.5C4 5.4 7.5 3 12 3h8c4.5 0 8 2.4 8 6.5V21Z"
          fill="none"
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      ) : (
        <rect x="2.5" y="6" width="27" height="13" rx="6.5" fill="none" strokeWidth={STROKE} />
      )}
      <text
        x="16"
        y={trigger ? 17 : 16.1}
        textAnchor="middle"
        fontSize="9.5"
        fontWeight="700"
        stroke="none"
      >
        {label}
      </text>
    </>
  );
}

/** A stick seen from above, with L or R, or its press (L3, R3). */
function Stick({ label }: { label: string }) {
  return (
    <>
      <circle cx="12" cy="12" r="10.2" fill="none" strokeWidth={STROKE} strokeDasharray="3 2.2" />
      <circle cx="12" cy="12" r="6.6" fill="none" strokeWidth={STROKE} />
      <text
        x="12"
        y={label.length > 1 ? 14.6 : 15.3}
        textAnchor="middle"
        fontSize={label.length > 1 ? 7 : 9}
        fontWeight="700"
        stroke="none"
      >
        {label}
      </text>
    </>
  );
}

/** The D-pad: a cross. */
function Dpad() {
  return (
    <path
      d="M9 2.5h6v6.5h6.5v6H15v6.5H9V15H2.5V9H9Z"
      fill="none"
      strokeWidth={STROKE}
      strokeLinejoin="round"
    />
  );
}

/** View: a pill with two windows; Menu: a pill with three lines. */
function Small({ menu }: { menu: boolean }) {
  return (
    <>
      <rect x="1.5" y="5" width="21" height="14" rx="7" fill="none" strokeWidth={STROKE} />
      {menu ? (
        <path d="M8 9.2h8M8 12h8M8 14.8h8" fill="none" strokeWidth={1.4} strokeLinecap="round" />
      ) : (
        <>
          <rect x="7.4" y="8.3" width="6.2" height="5" rx="0.8" fill="none" strokeWidth={1.3} />
          <rect x="10.4" y="10.6" width="6.2" height="5" rx="0.8" fill="none" strokeWidth={1.3} />
        </>
      )}
    </>
  );
}

/** One button's glyph, 22 pixels high unless `size` says otherwise. */
export function PadGlyph({
  button,
  style,
  size = 22,
}: {
  button: PadButton;
  style: GlyphStyle;
  size?: number;
}) {
  const wide = button === 'lb' || button === 'rb' || button === 'lt' || button === 'rt';
  const width = wide ? 32 : 24;
  const shapes = style === 'shapes';
  let body: React.ReactNode;
  switch (button) {
    case 'a':
    case 'b':
    case 'x':
    case 'y':
      body = <Face button={button} style={style} />;
      break;
    case 'lb':
    case 'rb':
      body = <Shoulder label={padButtonName(button, style)} trigger={false} />;
      break;
    case 'lt':
    case 'rt':
      body = <Shoulder label={padButtonName(button, style)} trigger />;
      break;
    case 'ls':
      body = <Stick label="L" />;
      break;
    case 'rs':
      body = <Stick label="R" />;
      break;
    case 'l3':
      body = <Stick label="L3" />;
      break;
    case 'r3':
      body = <Stick label="R3" />;
      break;
    case 'dpad':
      body = <Dpad />;
      break;
    case 'view':
    case 'menu':
      body = <Small menu={button === 'menu'} />;
      break;
  }
  return (
    <svg
      className="pad-glyph"
      data-button={button}
      data-style={shapes ? 'shapes' : 'letters'}
      role="img"
      aria-label={padButtonName(button, style)}
      width={(size * width) / 24}
      height={size}
      viewBox={`0 0 ${width} 24`}
      stroke="currentColor"
      fill="currentColor"
    >
      {body}
    </svg>
  );
}

/** The glyphs of an action's buttons side by side (a pair: back or out, then on or in). */
export function PadGlyphs({
  buttons,
  style,
  size,
}: {
  buttons: readonly PadButton[];
  style: GlyphStyle;
  size?: number;
}) {
  return (
    <span className="pad-glyphs">
      {buttons.map((button) => (
        <PadGlyph key={button} button={button} style={style} {...(size ? { size } : {})} />
      ))}
    </span>
  );
}
