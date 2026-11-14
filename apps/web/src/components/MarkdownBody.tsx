import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildRowAt, enhanceBuildRows, type RowThing } from '../buildRows';
import { appLinkTarget, renderGuideMarkdown, revealHiddenText } from '../markdown';
import { enhanceTables, sortTableAt, type PageSorts } from '../tableSort';
import { showTextColours } from '../textColour';
import { followAppLink, markdownOptionsFor } from '../state/checklists';
import { useGuideLinks } from '../state/guideLinks';
import { useOwnPages } from '../state/ownPages';
import { useOwnPictures } from '../state/ownPictures';
import { useAtlas } from '../state/store';

/** What a link to a page of the site that is not in the game says, on a guide page. */
export const UNREAD_PAGE = 'This page has not been read yet';

/**
 * Guide Markdown from the pack, rendered safely (see `renderGuideMarkdown`).
 * In-app links are buttons; pressing one acts in the app. Web links open
 * outside the app as before. Hidden text shows when its button is pressed.
 * On a guide page (`page`) of a game read from a site, a link to a page of
 * it that was not read yet says so (see `MarkdownOptions.unreadPage`).
 * On a page, its tables sort by a column the reader presses (see
 * `tableSort.ts`): the order chosen stays while the page is shown, as it
 * is shown anew when pictures arrive, and goes with another page. With
 * `onAddRow`, a row of a page's table that names something has a button to
 * add it to a build (see `buildRows.ts`).
 */
export function MarkdownBody({
  source,
  className,
  page = false,
  onAddRow,
}: {
  source: string;
  className: string;
  page?: boolean;
  onAddRow?: ((row: RowThing, button: HTMLElement) => void) | undefined;
}) {
  const game = useAtlas((s) => s.game);
  // Pages of other games read with this one can be linked to, once loaded.
  const others = useGuideLinks((s) => s.others);
  // The person's own pages and photos, as they change and as photos are read.
  const own = useOwnPages((s) => s.own);
  const draftPictures = useOwnPages((s) => s.draftPictures);
  const ownPictures = useOwnPictures((s) => s.files);
  const ref = useRef<HTMLDivElement>(null);
  // A picture whose file is not here (one to be downloaded later) shows
  // what it is in words; it is tried again when new images are saved.
  const revision = useAtlas((s) => s.tileRevision);
  const [missingAt, setMissingAt] = useState<number | null>(null);
  const sorts = useRef<{ source: string; tables: PageSorts }>({ source, tables: new Map() });
  // After every render: coloured words show their colours, and the page
  // shown anew has its tables sorted as chosen (another page, or the
  // page's text changed, starts in its own order).
  useLayoutEffect(() => {
    if (ref.current) showTextColours(ref.current);
    if (sorts.current.source !== source) sorts.current = { source, tables: new Map() };
    if (page && ref.current) enhanceTables(ref.current, sorts.current.tables);
    if (page && ref.current) {
      if (onAddRow) enhanceBuildRows(ref.current);
      else {
        for (const button of ref.current.querySelectorAll('[data-build-row]')) button.remove();
        for (const table of ref.current.querySelectorAll('[data-build-rows]')) {
          table.removeAttribute('data-build-rows');
        }
      }
    }
  });
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const onError = (event: Event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      const frame = img.closest('.guide-picture');
      if (!frame || !root.contains(frame)) return;
      frame.setAttribute('data-missing', '');
      const words = document.createElement('span');
      words.className = 'picture-alt';
      // A small picture in the line of text is only its words when it is not here.
      const inLine = frame.classList.contains('inline');
      words.textContent = inLine
        ? img.alt
        : img.alt
          ? `${img.alt} (picture not downloaded)`
          : 'Picture not downloaded';
      img.replaceWith(words);
      setMissingAt(revision);
    };
    // An image's error does not bubble; it is seen on the way down.
    root.addEventListener('error', onError, true);
    return () => {
      root.removeEventListener('error', onError, true);
    };
  });
  const html = useMemo(
    () =>
      renderGuideMarkdown(
        source,
        game
          ? {
              ...markdownOptionsFor(game),
              ...(page && game.pack.data.guides.some((guide) => guide.source)
                ? { unreadPage: UNREAD_PAGE }
                : {}),
            }
          : {},
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, game, page, others, own, draftPictures, ownPictures],
  );
  return (
    <div
      ref={ref}
      key={missingAt === null || missingAt === revision ? 'shown' : revision}
      className={className}
      onClick={(event) => {
        const row = page && onAddRow ? buildRowAt(event.target, event.currentTarget) : null;
        if (row && onAddRow) {
          event.preventDefault();
          const button = (event.target as Element).closest<HTMLElement>('[data-build-row]');
          if (button) onAddRow(row, button);
          return;
        }
        if (page && sortTableAt(event.target, event.currentTarget, sorts.current.tables)) {
          event.preventDefault();
          return;
        }
        // "Show hidden text": shown in place, until the text is rendered again.
        if (revealHiddenText(event.target, event.currentTarget)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const id = appLinkTarget(event.target);
        if (!id) return;
        event.preventDefault();
        followAppLink(id);
      }}
      // markdown-it runs with raw HTML disabled, so this holds only renderer-made tags.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
