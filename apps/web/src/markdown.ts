import { parseId } from '@atlas/schema';
import MarkdownIt, { type Token } from 'markdown-it';

/**
 * Renders guide Markdown from a pack, which is untrusted content.
 *
 * - `html: false` escapes any raw HTML in the source instead of passing it
 *   through, so the output contains only tags the renderer itself creates.
 * - markdown-it's link validation drops `javascript:`, `vbscript:`, `file:`
 *   and `data:` link targets.
 * - Images are not rendered (their alt text is kept), so a guide cannot make
 *   the app fetch remote content.
 * - Links open in a new tab with `rel="noopener noreferrer"`.
 * - A link whose target is a content id, such as `[the old well](demo:loc:0412)`,
 *   is an in-app link (see {@link MarkdownOptions.isAppTarget}): it becomes a
 *   button carrying the id in `data-atlas-target`, which the app acts on, and
 *   never a link the browser follows. An id the pack does not have, or of a
 *   kind the app cannot show, becomes plain text.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
markdown.disable('image');

export interface MarkdownOptions {
  /** Whether an in-app link to this content id can be followed. */
  isAppTarget?: (id: string) => boolean;
}

interface AppLinkMeta {
  appLink?: 'ok' | 'missing';
}

markdown.core.ruler.push('atlas_app_links', (state) => {
  const isAppTarget = (state.env as MarkdownOptions | undefined)?.isAppTarget;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    // Links do not nest, so each link_open is closed by the next link_close.
    let open: Token | null = null;
    for (const token of block.children) {
      if (token.type === 'link_open') {
        const href = String(token.attrGet('href') ?? '');
        open = parseId(href) ? token : null;
        if (!open) continue;
        const ok = isAppTarget?.(href) ?? false;
        const title = token.attrGet('title');
        (token.meta as AppLinkMeta | null) = { appLink: ok ? 'ok' : 'missing' };
        if (ok) {
          token.tag = 'button';
          token.attrs = [
            ['type', 'button'],
            ['class', 'app-link'],
            ['data-atlas-target', href],
          ];
        } else {
          token.tag = 'span';
          token.attrs = [['class', 'app-link-missing']];
        }
        if (title !== null && title !== '') token.attrSet('title', String(title));
      } else if (token.type === 'link_close' && open) {
        token.tag = open.tag;
        open = null;
      }
    }
  }
});

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  if ((token.meta as AppLinkMeta | null)?.appLink) return self.renderToken(tokens, index, options);
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** HTML for a guide body. Safe to insert with `innerHTML`. */
export function renderGuideMarkdown(source: string, options: MarkdownOptions = {}): string {
  return markdown.render(source, { ...options });
}

/** The content id of the in-app link an event happened in, if any. */
export function appLinkTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-atlas-target]')?.getAttribute('data-atlas-target') ?? null;
}
