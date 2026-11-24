import { useEffect, useId, useRef, useState } from 'react';
import { OWN_TYPE_COLOURS } from '@atlas/core';
import { ICON_NAMES } from '@atlas/schema';
import { chooseTypeLook, useTypeLookTarget } from '../state/typeLooks';
import { GlyphBadge, UiIcon } from './icons';

/*
 * A type's colour and icon (see `state/typeLooks.ts`): the fields of the
 * type form in Edit locations, and the palette button beside a type in the
 * filters of both layouts, with its dialog. The dialog changes any type of
 * the game shown: the pack's (kept on this device, with "Back to the
 * pack's own") and the person's own.
 */

/** The name of an icon, for its button. */
const iconLabel = (icon: string) => icon.charAt(0).toUpperCase() + icon.slice(1);

const sameColour = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The colours offered for a type, and any other colour (the system's
 * colour picker): "Colour 3 of 12", then "Any colour".
 */
export function TypeColourField({
  value,
  onChange,
}: {
  value: string;
  onChange: (colour: string) => void;
}) {
  const name = useId();
  const offered = OWN_TYPE_COLOURS.some((colour) => sameColour(colour, value));
  return (
    <fieldset className="own-field locations-fieldset">
      <legend className="own-label">Colour</legend>
      <div className="locations-swatches" data-testid="type-colours">
        {OWN_TYPE_COLOURS.map((colour, index) => (
          <label key={colour} className="locations-swatch" title={`Colour ${index + 1}`}>
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              value={colour}
              aria-label={`Colour ${index + 1} of ${OWN_TYPE_COLOURS.length}`}
              checked={sameColour(value, colour)}
              onChange={() => {
                onChange(colour);
              }}
            />
            <span className="locations-swatch-dot" style={{ background: colour }} />
          </label>
        ))}
        <label
          className={
            offered
              ? 'locations-swatch locations-swatch-any'
              : 'locations-swatch locations-swatch-any is-chosen'
          }
          title="Choose any colour"
        >
          <input
            type="color"
            aria-label="Any colour"
            data-testid="type-any-colour"
            value={value.toLowerCase()}
            onChange={(event) => {
              onChange(event.target.value.toLowerCase());
            }}
          />
          Any colour
        </label>
      </div>
    </fieldset>
  );
}

/** The icons offered for a type, each drawn in the colour chosen. */
export function TypeIconField({
  value,
  color,
  onChange,
}: {
  value: string;
  color: string;
  onChange: (icon: string) => void;
}) {
  const name = useId();
  return (
    <fieldset className="own-field locations-fieldset">
      <legend className="own-label">Icon</legend>
      <div className="locations-icons" data-testid="type-icons">
        {ICON_NAMES.map((icon) => (
          <label key={icon} className="locations-icon" title={iconLabel(icon)}>
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              value={icon}
              aria-label={iconLabel(icon)}
              checked={value === icon}
              onChange={() => {
                onChange(icon);
              }}
            />
            <GlyphBadge icon={icon} color={color} size={30} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The palette button beside a type: it opens the dialog that changes the
 * type's colour and icon. A finger, the mouse, the keys and a controller
 * all reach it: the dialog takes the focus, and Esc or B closes it.
 */
export function TypeLookButton({
  typeId,
  name,
  className = 'icon-button type-look-button',
  withText = false,
  size = 16,
}: {
  typeId: string;
  /** The type's name, for the button's label. */
  name: string;
  className?: string;
  /** "Colour and icon…" in words beside the palette, where there is room. */
  withText?: boolean;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={className}
        aria-label={withText ? undefined : `Colour and icon of ${name}…`}
        title={`Change the colour and icon of ${name}`}
        aria-haspopup="dialog"
        data-testid="type-look"
        data-category={typeId}
        onClick={(event) => {
          // Not a press of the row it sits in.
          event.stopPropagation();
          event.preventDefault();
          setOpen(true);
        }}
      >
        <UiIcon name="palette" size={size} />
        {withText ? `Colour and icon of “${name}”…` : null}
      </button>
      {open ? (
        <TypeLookDialog
          typeId={typeId}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

export function TypeLookDialog({ typeId, onClose }: { typeId: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const target = useTypeLookTarget(typeId);
  const [color, setColor] = useState(target?.shown.color ?? OWN_TYPE_COLOURS[0]);
  const [icon, setIcon] = useState(target?.shown.icon ?? 'pin');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  if (!target) return null;
  const { shown, original, changed } = target;
  const run = (look: { color: string; icon: string } | null) => {
    const error = chooseTypeLook(typeId, look);
    if (error) setProblem(error);
    else onClose();
  };
  return (
    <dialog
      ref={ref}
      className="dialog type-look-dialog"
      aria-labelledby={titleId}
      data-testid="type-look-dialog"
      onClose={onClose}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === ref.current) onClose();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          run({ color, icon });
        }}
      >
        <header className="dialog-head">
          <h2 id={titleId}>Colour and icon</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <UiIcon name="close" />
          </button>
        </header>
        <p className="type-look-preview" data-testid="type-look-preview">
          <GlyphBadge icon={icon} color={color} size={36} />
          <span>{shown.name}</span>
        </p>
        <TypeColourField
          value={color}
          onChange={(next) => {
            setColor(next);
            setProblem(null);
          }}
        />
        <TypeIconField
          value={icon}
          color={color}
          onChange={(next) => {
            setIcon(next);
            setProblem(null);
          }}
        />
        {original ? (
          <p className="muted small type-look-note" data-testid="type-look-original">
            The pack’s own colour and icon:{' '}
            <GlyphBadge icon={original.icon} color={original.color} size={20} />. Your choice is
            kept on this device with your own data for this game, so a newer version of the pack
            keeps it. The pack itself is not changed.
            {original.picture !== undefined
              ? ' With a colour or an icon of your own, the type is drawn with them instead of the map’s own icon.'
              : ''}
          </p>
        ) : (
          <p className="muted small type-look-note">
            This is a type of your own. Its name and group are changed in Edit locations.
          </p>
        )}
        {problem ? (
          <p className="type-look-problem" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="row-actions wrap">
          <button type="submit" className="button button-primary" data-testid="type-look-save">
            Save
          </button>
          {original && changed ? (
            <button
              type="button"
              className="button"
              data-testid="type-look-reset"
              onClick={() => {
                run(null);
              }}
            >
              Back to the pack’s own
            </button>
          ) : null}
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
