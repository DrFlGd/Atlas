import { useEffect, useId, useRef, useState } from 'react';
import { UiIcon } from '../components/icons';
import { canChangeOwnPages, choosePageWidth, pageWidthOf, useOwnPages } from '../state/ownPages';
import { PAGE_WIDTH_NAMES as WIDTHS } from '../state/pageWidthNames';
import type { LoadedGame } from '../state/store';

/**
 * "Page width" in the head of Guides, on a computer or a tablet: how wide
 * the game's pages are shown. The person's choice is kept with their own
 * pages, so it stays when the game is built again or its pack is updated,
 * and wins over the width the site's rules file gave the pack. A phone
 * always shows a page as wide as the phone, so the menu is not shown there.
 */
export function PageWidthMenu({ game }: { game: LoadedGame }) {
  const state = useOwnPages();
  const { width, site } = pageWidthOf(game, state);
  const can = canChangeOwnPages(state);
  const [open, setOpen] = useState(false);
  const menu = useId();
  const root = useRef<HTMLSpanElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) return;
    items.current[WIDTHS.findIndex((item) => item.width === width)]?.focus();
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
    };
    // Focus the chosen width only when the menu opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const label = `Page width: ${WIDTHS.find((item) => item.width === width)!.name}`;
  return (
    <span
      ref={root}
      className="guides-width"
      onKeyDown={(event) => {
        if (!open) return;
        const at = items.current.findIndex((item) => item === document.activeElement);
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>('button')?.focus();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const step = event.key === 'ArrowDown' ? 1 : WIDTHS.length - 1;
          items.current[(Math.max(at, 0) + step) % WIDTHS.length]?.focus();
        }
      }}
    >
      <button
        type="button"
        className="touch-icon-button"
        aria-label={label}
        title={can ? label : `${label}. It cannot be changed while the pages cannot be changed.`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menu : undefined}
        data-testid="guides-width"
        data-width={width}
        disabled={!can}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <UiIcon name="width" size={20} />
      </button>
      {open ? (
        <div id={menu} className="guides-width-menu" role="menu" aria-label="Page width">
          {WIDTHS.map((item, n) => (
            <button
              key={item.width}
              ref={(button) => {
                items.current[n] = button;
              }}
              type="button"
              role="menuitemradio"
              aria-checked={item.width === width}
              className="guides-width-item"
              data-testid={`guides-width-${item.width}`}
              onClick={() => {
                choosePageWidth(item.width);
                setOpen(false);
              }}
            >
              <span className="guides-width-check" aria-hidden="true">
                {item.width === width ? <UiIcon name="check" size={16} /> : null}
              </span>
              <span className="guides-width-words">
                <span className="guides-width-name">
                  {item.name}
                  {item.width === site ? (
                    <span className="guides-width-site"> · the site’s width</span>
                  ) : null}
                </span>
                <span className="guides-width-says">{item.says}</span>
              </span>
            </button>
          ))}
          <p className="guides-width-note">
            Kept with your own pages. A phone always shows a page as wide as the phone.
          </p>
        </div>
      ) : null}
    </span>
  );
}
