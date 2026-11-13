import { useEffect, useMemo, useRef, useState } from 'react';
import { appLinkTarget, renderGuideMarkdown, revealHiddenText } from '../markdown';
import { followAppLink, markdownOptionsFor } from '../state/checklists';
import { useGuideLinks } from '../state/guideLinks';
import { useAtlas } from '../state/store';

/**
 * Guide Markdown from the pack, rendered safely (see `renderGuideMarkdown`).
 * In-app links are buttons; pressing one acts in the app. Web links open
 * outside the app as before. Hidden text shows when its button is pressed.
 */
export function MarkdownBody({ source, className }: { source: string; className: string }) {
  const game = useAtlas((s) => s.game);
  // Pages of other games read with this one can be linked to, once loaded.
  const others = useGuideLinks((s) => s.others);
  const ref = useRef<HTMLDivElement>(null);
  // A picture whose file is not here (one to be downloaded later) shows
  // what it is in words; it is tried again when new images are saved.
  const revision = useAtlas((s) => s.tileRevision);
  const [missingAt, setMissingAt] = useState<number | null>(null);
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
    () => renderGuideMarkdown(source, game ? markdownOptionsFor(game) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, game, others],
  );
  return (
    <div
      ref={ref}
      key={missingAt === null || missingAt === revision ? 'shown' : revision}
      className={className}
      onClick={(event) => {
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
