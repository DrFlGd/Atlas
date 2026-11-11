import { useEffect } from 'react';
import {
  focusSearch,
  jumpToNearestUnfound,
  select,
  setPane,
  toggleFound,
  undo,
} from './state/actions';
import { toggleLeftTab } from './state/checklists';
import { useAtlas } from './state/store';

/** Whether a key event comes from somewhere the user types, where shortcuts must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(
      target.type,
    );
  }
  return false;
}

/**
 * Global shortcuts: `F` marks the selection found (or not), `Z` undoes,
 * `/` focuses search, `N` jumps to the nearest unfound visible marker, `C`
 * opens or closes the checklists and guides, and `Escape` clears the
 * selection. None fire while typing or inside a dialog.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || isTypingTarget(event.target)) return;
      // A modal dialog has its own keys; its close event can lag behind the keypress.
      if (document.querySelector('dialog[open]')) return;
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if (command) {
        if (key === 'z' && !event.shiftKey) {
          event.preventDefault();
          undo();
        }
        return;
      }
      switch (key) {
        case 'f':
          event.preventDefault();
          toggleFound();
          break;
        case 'z':
          event.preventDefault();
          undo();
          break;
        case '/':
          event.preventDefault();
          focusSearch();
          break;
        case 'n':
          event.preventDefault();
          jumpToNearestUnfound();
          break;
        case 'c':
          event.preventDefault();
          toggleLeftTab('checklists');
          break;
        case 'escape':
          if (useAtlas.getState().selectedId) {
            select(null);
            if (window.matchMedia('(max-width: 899px)').matches) setPane('details', false);
          }
          break;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
