import { useEffect, useReducer, useRef } from 'react';
import { useAtlas } from '../state/store';
import { useLocationEditor } from '../touch/locations/locationEditorState';
import { hintsFor } from './bindings';
import { PadGlyphs } from './PadGlyph';
import { glyphStyle, hintsShown, reticleTarget, usePad } from './padState';

/**
 * The bar of the controller's buttons at the foot of the screen, as a
 * console game has: the few that matter where the controller is now (see
 * `HINTS` in `bindings.ts`), shown after the controller is used and hidden
 * after the mouse, a finger or a key (or always, or never, by the
 * setting). While it shows, the root has `data-pad-hints`, and the room
 * at the foot of the screen grows by its height (`--atlas-inset-bottom`,
 * see `app.css`), so it covers none of the app's own controls. Where the
 * web view has popovers it is one, so it stays over a dialog too.
 */
export function HintBar() {
  const shown = usePad(hintsShown);
  const context = usePad((s) => s.context);
  const style = usePad(glyphStyle);
  const lists = useAtlas((s) => (s.game && !s.game.checklists.isEmpty ? 'Lists' : null));
  // On the map, A and X act on the location under the crosshair (X also on
  // the one open): drawn again as the map moves, so they show only when
  // there is one to act on.
  useAtlas((s) => s.view);
  const selected = useAtlas((s) => s.selectedId);
  // In Edit locations, A puts a location where the crosshair points (or moves one there).
  const locating = useLocationEditor((s) => (s.active ? (s.moving ? 'move' : 'put') : null));
  const bar = useRef<HTMLDivElement>(null);
  // Whether the crosshair holds a location changes as the 3D view moves, which tells
  // nothing: in Edit locations, A's name is looked at again a few times a second.
  const [, recheck] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!shown || !locating) return;
    const timer = window.setInterval(recheck, 300);
    return () => {
      window.clearInterval(timer);
    };
  }, [shown, locating]);

  useEffect(() => {
    const root = document.documentElement;
    if (!shown) return;
    root.dataset.padHints = '';
    return () => {
      delete root.dataset.padHints;
    };
  }, [shown]);

  // Over a dialog opened after it: shown again, it comes on top.
  useEffect(() => {
    const element = bar.current;
    if (!shown || !element || typeof element.showPopover !== 'function') return;
    try {
      if (element.matches(':popover-open')) element.hidePopover();
      element.showPopover();
    } catch {
      // Without popovers it is a bar like any other.
    }
  }, [shown, context]);

  if (!shown) return null;
  const held = reticleTarget() !== null;
  const underCrosshair = context === 'map' && held;
  const hints = hintsFor(context, { lists })
    .filter((hint) => {
      if (context !== 'map') return true;
      if (hint.id === 'open-location') return underCrosshair || locating !== null;
      if (hint.id === 'mark-found') return underCrosshair || selected !== null;
      return true;
    })
    .map((hint) =>
      hint.id === 'open-location' && locating && (!held || locating === 'move')
        ? { ...hint, label: locating === 'move' ? 'Move here' : 'Put here' }
        : hint,
    );
  return (
    <div
      ref={bar}
      className="pad-hints"
      popover="manual"
      role="note"
      aria-label="Controller buttons"
      data-testid="pad-hints"
      data-context={context}
    >
      <ul className="pad-hints-list">
        {hints.map((hint) => (
          <li key={hint.id} className="pad-hint" data-action={hint.id}>
            <PadGlyphs buttons={hint.pad} style={style} />
            <span className="pad-hint-label">{hint.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
