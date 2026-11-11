import { useMemo } from 'react';
import { appLinkTarget, renderGuideMarkdown } from '../markdown';
import { followAppLink, markdownOptionsFor } from '../state/checklists';
import { useAtlas } from '../state/store';

/**
 * Guide Markdown from the pack, rendered safely (see `renderGuideMarkdown`).
 * In-app links are buttons; pressing one acts in the app. Web links open
 * outside the app as before.
 */
export function MarkdownBody({ source, className }: { source: string; className: string }) {
  const game = useAtlas((s) => s.game);
  const html = useMemo(
    () => renderGuideMarkdown(source, game ? markdownOptionsFor(game) : {}),
    [source, game],
  );
  return (
    <div
      className={className}
      onClick={(event) => {
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
