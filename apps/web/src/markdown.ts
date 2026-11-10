import MarkdownIt from 'markdown-it';

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
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });
markdown.disable('image');

const defaultLinkOpen =
  markdown.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));

markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]!;
  token.attrSet('target', '_blank');
  token.attrSet('rel', 'noopener noreferrer');
  return defaultLinkOpen(tokens, index, options, env, self);
};

/** HTML for a guide body. Safe to insert with `innerHTML`. */
export function renderGuideMarkdown(source: string): string {
  return markdown.render(source);
}
