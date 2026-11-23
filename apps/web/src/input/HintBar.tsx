import { useEffect, useRef } from 'react';
import { useAtlas } from '../state/store';
import { hintsFor } from './bindings';
import { PadGlyphs } from './PadGlyph';
import { glyphStyle, hintsShown, usePad } from './padState';

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
  const bar = useRef<HTMLDivElement>(null);

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
  const hints = hintsFor(context, { lists });
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
