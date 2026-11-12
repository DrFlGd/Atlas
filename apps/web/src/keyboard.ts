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
 * What a layout does for some keys in its own way. The classic layout sets
 * none; the standard layout (`src/touch/`) sets them while it is shown.
 */
export interface ShortcutOverrides {
  /** `/`: go to search. */
  search: () => void;
  /** `C`: open or close the checklists and guides. */
  checklists: () => void;
  /** `Escape`: close what is on top. */
  escape: () => void;
  /** `?`: show the list of keys. */
  keys: () => void;
}

let overrides: ShortcutOverrides | null = null;

/** Lets a layout handle some keys itself (see {@link ShortcutOverrides}); null gives them back. */
export function setShortcutOverrides(next: ShortcutOverrides | null): void {
  overrides = next;
}

/**
 * Global shortcuts: `F` marks the selection found (or not), `Z` undoes,
 * `/` focuses search, `N` jumps to the nearest unfound visible marker, `C`
 * opens or closes the checklists and guides, and `Escape` clears the
 * selection. None fire while typing or inside a dialog. A layout can do
 * some of them its own way (see {@link setShortcutOverrides}).
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
          if (overrides) overrides.search();
          else focusSearch();
          break;
        case '?':
          if (!overrides) break;
          event.preventDefault();
          overrides.keys();
          break;
        case 'n':
          event.preventDefault();
          jumpToNearestUnfound();
          break;
        case 'c':
          event.preventDefault();
          if (overrides) overrides.checklists();
          else toggleLeftTab('checklists');
          break;
        case 'escape':
          if (overrides) {
            overrides.escape();
          } else if (useAtlas.getState().selectedId) {
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
