import type { BuildThing } from '@atlas/core';
import { UiIcon } from '../components/icons';
import type { LoadedGame } from '../state/store';
import { useAddToBuild } from './buildChoice';

/**
 * "Add to build" buttons: at the head of a page, on a location's card, and
 * small on a row (see `buildChoice.tsx` for what a press does).
 */

/** "Add to build" as {@link useAddToBuild} gives it. */
export type AddToBuild = ReturnType<typeof useAddToBuild>;

/**
 * "Add to build" at the head of a page: the button, and which Build guide
 * it adds to, with "Change". The question it may ask is `build.dialog`,
 * shown by the page, which shares it with the rows of its tables.
 */
export function AddToBuildBar({ build, thing }: { build: AddToBuild; thing: BuildThing }) {
  if (!build.offered) return null;
  return (
    <div className="build-add-bar" data-testid="add-to-build-bar">
      <button
        type="button"
        className="touch-button build-add-button"
        data-testid="add-to-build"
        onClick={(event) => {
          build.add(thing, event.currentTarget);
        }}
      >
        <UiIcon name="plus" size={18} strokeWidth={1.9} />
        Add to build
      </button>
      {build.target ? (
        <span className="build-add-target muted small-text">
          to {build.target.checklist.name}
          <button
            type="button"
            className="guides-inline-button build-add-change"
            data-testid="build-list-change"
            aria-label={`Adds to ${build.target.checklist.name}. Change`}
            onClick={(event) => {
              build.choose(event.currentTarget);
            }}
          >
            Change
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** "Add to build" as a button of its own: on a location's card, or as a small one on a row. */
export function AddToBuildButton({
  game,
  thing,
  small = false,
}: {
  game: LoadedGame;
  thing: BuildThing;
  small?: boolean;
}) {
  const build = useAddToBuild(game);
  if (!build.offered) return null;
  return (
    <>
      <button
        type="button"
        className={small ? 'touch-icon-button build-add-small' : 'touch-text-button'}
        data-testid="add-to-build"
        aria-label={small ? `Add “${thing.name}” to build` : undefined}
        title={small ? 'Add to build' : undefined}
        onClick={(event) => {
          build.add(thing, event.currentTarget);
        }}
      >
        <UiIcon name="plus" size={18} strokeWidth={1.9} />
        {small ? null : 'Add to build'}
      </button>
      {build.dialog}
    </>
  );
}
