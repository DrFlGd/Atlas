import { parseId } from '@atlas/schema';
import MarkdownIt, { type Token } from 'markdown-it';

/**
 * Renders guide Markdown from a pack, which is untrusted content.
 *
 * - `html: false` escapes any raw HTML in the source instead of passing it
 *   through, so the output contains only tags the renderer itself creates.
 * - markdown-it's link validation drops `javascript:`, `vbscript:`, `file:`
 *   and `data:` link targets.
 * - A picture is shown only when its target is the id of a picture of the
 *   pack (`![the gate](demo:picture:gate)`, see
 *   {@link MarkdownOptions.picture}), from the pack's own folder. Any other
 *   image is shown as its alternative text, so a guide cannot make the app
 *   fetch remote content.
 * - Links open in a new tab with `rel="noopener noreferrer"`.
 * - A link whose target is a content id, such as `[the old well](demo:loc:0412)`,
 *   is an in-app link (see {@link MarkdownOptions.isAppTarget}): it becomes a
 *   button carrying the id in `data-atlas-target`, which the app acts on, and
 *   never a link the browser follows. An id the pack does not have, or of a
 *   kind the app cannot show, becomes plain text.
 * - Text between double bars, `||like this||`, is hidden until the reader
 *   asks for it (see {@link revealHiddenText}): a "Show hidden text" button
 *   stands where it begins, and the hidden part is in the page with the
 *   `hidden` attribute, so it is neither seen, read out nor reachable with
 *   the keyboard. A hidden part may span paragraphs, lists and code, and
 *   may hold in-app links. Bars pair up left to right; a last bar without a
 *   partner, bars in code and escaped bars stay plain text.
 */
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true });

/** A picture of the pack, as a guide shows it. */
export interface GuidePicture {
  /** Where the app loads it: in the pack's own folder. */
  url: string;
  caption?: string;
  credit?: string;
  width?: number;
  height?: number;
}

export interface MarkdownOptions {
  /** Whether an in-app link to this content id can be followed. */
  isAppTarget?: (id: string) => boolean;
  /** The pack's picture with this id, or null when the pack has none. */
  picture?: (id: string) => GuidePicture | null;
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

// ---------------------------------------------------------------------------
// Pictures: only the pack's own, by id

interface PictureMeta {
  alt: string;
  picture: GuidePicture | null;
}

markdown.core.ruler.push('atlas_pictures', (state) => {
  const pictureOf = (state.env as MarkdownOptions | undefined)?.picture;
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    for (const token of block.children) {
      if (token.type !== 'image') continue;
      const src = String(token.attrGet('src') ?? '');
      const alt = token.children ? altText(token.children) : token.content;
      const picture = parseId(src)?.kind === 'picture' ? (pictureOf?.(src) ?? null) : null;
      token.type = 'atlas_picture';
      token.meta = { alt, picture } satisfies PictureMeta;
      token.children = null;
    }
  }
});

function altText(tokens: readonly Token[]): string {
  return tokens.map((token) => (token.children ? altText(token.children) : token.content)).join('');
}

markdown.renderer.rules.atlas_picture = (tokens, index) => {
  const { alt, picture } = tokens[index]!.meta as unknown as PictureMeta;
  const escape = markdown.utils.escapeHtml;
  if (!picture) {
    // Never fetched: what the picture shows, in words.
    return alt ? `<span class="picture-alt">${escape(alt)}</span>` : '';
  }
  const size =
    picture.width && picture.height ? ` width="${picture.width}" height="${picture.height}"` : '';
  const note = [picture.caption, picture.credit].filter(Boolean).join(' · ');
  return (
    `<span class="guide-picture"><img src="${escape(picture.url)}" alt="${escape(alt)}"${size} loading="lazy" decoding="async">` +
    (note ? `<span class="guide-picture-note">${escape(note)}</span>` : '') +
    '</span>'
  );
};

// ---------------------------------------------------------------------------
// Hidden text: ||like this||

interface HiddenMeta {
  /** A `||` that opens (or closes) hidden part `part`. */
  hiddenMark?: { part: number; opens: boolean };
  /** A whole block inside hidden part `part`. */
  hiddenPart?: number;
}

const metaOf = (token: Token) => (token.meta ?? {}) as HiddenMeta;

/** The index of each token's partner (open with close), by nesting. */
function partners(tokens: readonly Token[]): Map<number, number> {
  const match = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, i) => {
    if (token.nesting === 1) open.push(i);
    else if (token.nesting === -1) {
      const start = open.pop();
      if (start !== undefined) {
        match.set(start, i);
        match.set(i, start);
      }
    }
  });
  return match;
}

/** Table parts are never hidden as a whole: hiding a cell would move the others. */
const TABLE_PARTS = /^(thead|tbody|tr|th|td)_open$/;

markdown.core.ruler.before('text_join', 'atlas_hidden_text', (state) => {
  const marks: { token: Token; block: number }[] = [];
  // Every `||` in text becomes a token of its own. Code and escaped bars
  // (`text_special` until text_join) are not text, so they do not count.
  state.tokens.forEach((block, b) => {
    if (block.type !== 'inline' || !block.children) return;
    const children: Token[] = [];
    for (const child of block.children) {
      if (child.type !== 'text' || !child.content.includes('||')) {
        children.push(child);
        continue;
      }
      const pieces = child.content.split('||');
      pieces.forEach((piece, i) => {
        if (i > 0) {
          const mark = new state.Token('text', '', 0);
          mark.content = '||';
          children.push(mark);
          marks.push({ token: mark, block: b });
        }
        if (piece !== '') {
          const text = new state.Token('text', '', 0);
          text.content = piece;
          children.push(text);
        }
      });
    }
    block.children = children;
  });
  if (marks.length < 2) return;

  // Bars pair up left to right; a last one alone stays text.
  const blockPartners = partners(state.tokens);
  let parts = 0;
  for (let m = 0; m + 1 < marks.length; m += 2) {
    const part = ++parts;
    const [open, close] = [marks[m]!, marks[m + 1]!];
    (open.token.meta as HiddenMeta | null) = { hiddenMark: { part, opens: true } };
    (close.token.meta as HiddenMeta | null) = { hiddenMark: { part, opens: false } };
    // Whole blocks between the two (a list, a code block) are hidden as
    // they are; the text of any other block on the way is wrapped below.
    let j = open.block + 1;
    while (j < close.block) {
      const token = state.tokens[j]!;
      const end = blockPartners.get(j);
      if (token.nesting === 1 && end !== undefined && end < close.block) {
        // A paragraph without tags (in a tight list) has no element to hide.
        if (!token.hidden && !TABLE_PARTS.test(token.type)) {
          (token.meta as HiddenMeta | null) = { ...metaOf(token), hiddenPart: part };
          token.attrSet('data-hidden-part', String(part));
          token.attrSet('hidden', '');
          j = end + 1;
          continue;
        }
      } else if (token.nesting === 0 && token.type !== 'inline') {
        (token.meta as HiddenMeta | null) = { ...metaOf(token), hiddenPart: part };
      }
      j++;
    }
  }

  // The text from a bar that opens to the bar that closes is wrapped in
  // spans that nest properly with what is around them, as many as needed.
  // The hidden part the text is in, as it goes from block to block.
  const open: { part: number | null } = { part: null };
  for (const block of state.tokens) {
    if (block.type !== 'inline' || !block.children) continue;
    const children = block.children;
    const match = partners(children);
    const closeAt = (from: number, which: number) => {
      const i = children.findIndex(
        (t, k) => k >= from && metaOf(t).hiddenMark?.part === which && !metaOf(t).hiddenMark!.opens,
      );
      return i < 0 ? Infinity : i;
    };
    const out: Token[] = [];
    let start = -1;
    let end = Infinity;
    let spanOpen = false;
    let linkAt = -1;
    if (open.part !== null) end = closeAt(0, open.part);
    const closeSpan = () => {
      if (!spanOpen) return;
      out.push(new state.Token('hidden_text_close', 'span', -1));
      spanOpen = false;
    };
    const openSpan = () => {
      if (spanOpen || open.part === null) return;
      const span = new state.Token('hidden_text_open', 'span', 1);
      span.attrs = [
        ['class', 'hidden-text'],
        ['data-hidden-part', String(open.part)],
        ['hidden', ''],
      ];
      out.push(span);
      spanOpen = true;
    };
    children.forEach((token, i) => {
      const mark = metaOf(token).hiddenMark;
      if (mark?.opens) {
        open.part = mark.part;
        start = i;
        end = closeAt(i, mark.part);
        const show = new state.Token('hidden_text_show', 'button', 0);
        show.meta = { hiddenShow: mark.part };
        // Never inside a link: the button goes before it.
        if (linkAt >= 0) out.splice(linkAt, 0, show);
        else out.push(show);
        return;
      }
      if (mark) {
        closeSpan();
        open.part = null;
        return;
      }
      if (token.type === 'link_open') linkAt = out.length;
      if (open.part !== null) {
        const partner = match.get(i);
        const leaves =
          (token.nesting === 1 && (partner === undefined || partner > end)) ||
          (token.nesting === -1 && (partner === undefined || partner < start));
        if (leaves) closeSpan();
        else openSpan();
      }
      out.push(token);
      if (token.type === 'link_close') linkAt = -1;
    });
    closeSpan();
    block.children = out;
  }
});

markdown.renderer.rules.hidden_text_show = (tokens, index) => {
  const part = (tokens[index]!.meta as { hiddenShow: number }).hiddenShow;
  return `<button type="button" class="hidden-text-show" data-hidden-show="${part}">Show hidden text</button>`;
};

// Blocks without an element of their own to carry `hidden` are wrapped.
for (const rule of ['fence', 'code_block', 'hr'] as const) {
  const base =
    markdown.renderer.rules[rule] ??
    ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
  markdown.renderer.rules[rule] = (tokens, index, options, env, self) => {
    const html = base(tokens, index, options, env, self);
    const part = metaOf(tokens[index]!).hiddenPart;
    return part === undefined
      ? html
      : `<div class="hidden-text-block" data-hidden-part="${part}" hidden>${html}</div>`;
  };
}

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

/**
 * The words of a guide body as it reads before anything hidden is shown,
 * read with the renderer itself, so hidden text is left out exactly as the
 * page hides it: for searching pages and quoting a line of them.
 */
export function guideSearchText(source: string): string {
  const words: string[] = [];
  let hiddenBlocks = 0;
  for (const block of markdown.parse(source, {})) {
    if (hiddenBlocks > 0) {
      hiddenBlocks += block.nesting;
      continue;
    }
    if (block.attrGet('hidden') !== null) {
      // A whole block inside a hidden part; its close comes with it.
      hiddenBlocks = block.nesting === 1 ? 1 : 0;
      continue;
    }
    if (block.type === 'fence' || block.type === 'code_block') {
      if (metaOf(block).hiddenPart === undefined) words.push(block.content);
      continue;
    }
    if (block.type !== 'inline' || !block.children) continue;
    let hidden = 0;
    for (const token of block.children) {
      if (token.type === 'hidden_text_open') hidden++;
      else if (token.type === 'hidden_text_close') hidden--;
      else if (hidden > 0) continue;
      else if (token.type === 'text' || token.type === 'code_inline') words.push(token.content);
      else if (token.type === 'atlas_picture')
        words.push((token.meta as unknown as PictureMeta).alt);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') words.push(' ');
    }
    words.push(' ');
  }
  return words.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Shows the hidden part whose "Show hidden text" button an event happened
 * in, if it did: every piece of that part in `root` loses `hidden`, the
 * button goes, and the focus moves to the text. It stays shown until the
 * text is rendered again. Returns whether it acted.
 */
export function revealHiddenText(target: EventTarget | null, root: Element): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('[data-hidden-show]');
  const part = button?.getAttribute('data-hidden-show');
  if (!button || !root.contains(button) || !part || !/^\d+$/.test(part)) return false;
  const pieces = [...root.querySelectorAll(`[data-hidden-part="${part}"]`)];
  for (const piece of pieces) {
    piece.removeAttribute('hidden');
    piece.classList.add('hidden-text-shown');
  }
  button.remove();
  const first = pieces[0];
  if (first instanceof HTMLElement) {
    first.tabIndex = -1;
    first.focus({ preventScroll: true });
  }
  return true;
}

/** The content id of the in-app link an event happened in, if any. */
export function appLinkTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  return target.closest('[data-atlas-target]')?.getAttribute('data-atlas-target') ?? null;
}
