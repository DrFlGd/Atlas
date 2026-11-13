import { describe, expect, it } from 'vitest';
import { renderGuideMarkdown } from '../markdown';
import {
  hasMarkIn,
  inlineLength,
  insertInline,
  linkSpan,
  parseInline,
  sameInline,
  setLink,
  splitInline,
  toggleMark,
  writeInline,
  type Inline,
} from './inline';

const options = {
  isAppTarget: (id: string) => id.startsWith('demo:'),
  picture: (id: string) =>
    id === 'demo:picture:gate' ? { url: 'pictures/gate.png', caption: 'The gate' } : null,
};
const render = (markdown: string) => renderGuideMarkdown(markdown, options);

/** Written again from what it holds, a text shows the same. */
function roundTrip(markdown: string): string {
  const written = writeInline(parseInline(markdown));
  expect(render(written)).toBe(render(markdown));
  expect(sameInline(parseInline(written), parseInline(markdown))).toBe(true);
  return written;
}

const text = (t: string, marks: Inline['marks'] = {}): Inline => ({ kind: 'text', text: t, marks });

describe('inline Markdown, read and written', () => {
  it.each([
    'Plain words.',
    'Some **bold**, __bold too__, *italic*, _italic too_ and ~~struck~~ words.',
    '**bold with *italic* inside** and *italic with **bold** inside*.',
    'Code: `a | b`, ``with ` a backtick``, and ` `` ` .',
    'Links: [a page](demo:guide:walk), [a location](demo:loc:0412 "The old well"), [the web](https://example.org/a_(b)).',
    '[**every** stone](demo:checklist:waystones) and <demo:loc:0412> and <https://example.org>.',
    'A bare address https://example.org/a_b and www.example.org in text.',
    '![A gate](demo:picture:gate) and ![a gate "with" title](demo:picture:gate "At dawn").',
    '[![A linked gate](demo:picture:gate)](https://example.org)',
    'Hidden: ||the warden sleeps at noon|| and ||**bold** hidden||.',
    'Escapes: \\*not italic\\*, \\_no\\_, \\[no link\\], a \\| bar, \\\\ a backslash, 2 \\* 3.',
    'Entities: &amp; &copy; &#169; &nbsp;and a lone & sign.',
    'A line\nand a soft break, a hard one\\\nand two spaces  \nend.',
    'snake_case_word and 5*3 and a_b*c.',
    'Typed "quotes" -- dashes... (c) stay as typed.',
    'Raw <b>HTML</b> shows as text.',
    'Not # a heading, - a list, 1. a number',
    'Strike ~~with **bold**~~ inside.',
  ])('%s', (markdown) => {
    roundTrip(markdown);
  });

  it('keeps bold and italic together, inside out', () => {
    const pieces = parseInline('***Both*** words');
    expect(sameInline(parseInline(writeInline(pieces)), pieces)).toBe(true);
  });

  it('keeps hidden text that spans bold', () => {
    roundTrip('Before **bold ||hidden** after|| end.');
  });

  it('escapes what would start a block at the start of a line', () => {
    const pieces = [
      text('# one'),
      { kind: 'soft', marks: {} },
      text('- two'),
      { kind: 'soft', marks: {} },
      text('1. three'),
      { kind: 'soft', marks: {} },
      text('> four'),
      { kind: 'soft', marks: {} },
      text('==='),
      { kind: 'soft', marks: {} },
      text('    five'),
    ] satisfies Inline[];
    const written = writeInline(pieces);
    expect(written).toBe('\\# one\n\\- two\n1\\. three\n\\> four\n\\===\nfive');
    expect(render(written)).toBe('<p># one\n- two\n1. three\n&gt; four\n===\nfive</p>\n');
  });

  it('puts spaces outside marks, and never puts two delimiters together', () => {
    const pieces: Inline[] = [
      text('bold ', { strong: '**' }),
      text('plain '),
      text(' italic', { em: '*' }),
      text('both', { em: '*', strong: '**' }),
      text('bold', { strong: '**' }),
    ];
    const written = writeInline(pieces);
    expect(render(written)).toBe(
      '<p><strong>bold</strong> plain  <em>italic<strong>both</strong></em><strong>bold</strong></p>\n',
    );
  });

  it('writes bars, stars and brackets in text so they stay text', () => {
    const pieces = [text('a || b | c *d* [e](f) `g` <h> ~~i~~ \\ j')];
    expect(render(writeInline(pieces))).toBe(
      '<p>a || b | c *d* [e](f) `g` &lt;h&gt; ~~i~~ \\ j</p>\n',
    );
  });

  it('escapes bars in a table cell, and writes line ends there as spaces', () => {
    expect(writeInline([text('a|b'), { kind: 'soft', marks: {} }, text('c')], 'cell')).toBe(
      'a\\|b c',
    );
  });
});

describe('text tools', () => {
  const pieces = parseInline('one **two** three');

  it('turns bold on, and off again where all of it is bold', () => {
    const on = toggleMark(pieces, 0, 3, 'strong');
    expect(writeInline(on)).toBe('**one** **two** three');
    expect(hasMarkIn(on, 0, 3, 'strong')).toBe(true);
    const off = toggleMark(on, 4, 7, 'strong');
    expect(writeInline(off)).toBe('**one** two three');
    const across = toggleMark(pieces, 2, 6, 'em');
    expect(writeInline(across)).toBe('on*e **tw***__o__ three');
    expect(render(writeInline(across))).toBe(
      '<p>on<em>e <strong>tw</strong></em><strong>o</strong> three</p>\n',
    );
  });

  it('makes code, hides text and links it', () => {
    expect(writeInline(toggleMark(pieces, 8, 13, 'code'))).toBe('one **two** `three`');
    expect(writeInline(toggleMark(pieces, 0, 3, 'hidden'))).toBe('||one|| **two** three');
    const linked = setLink(pieces, 8, 13, { href: 'demo:guide:walk' });
    expect(writeInline(linked)).toBe('one **two** [three](demo:guide:walk)');
    expect(linkSpan(linked, 10, 10)).toEqual({
      start: 8,
      end: 13,
      link: { href: 'demo:guide:walk' },
    });
    expect(writeInline(setLink(linked, 8, 13, null))).toBe('one **two** three');
  });

  it('splits and puts pieces in at a place', () => {
    const [before, after] = splitInline(pieces, 5);
    expect(writeInline(before)).toBe('one **t**');
    expect(writeInline(after)).toBe('**wo** three');
    expect(inlineLength(pieces)).toBe(13);
    const picture: Inline = { kind: 'picture', src: 'demo:picture:gate', alt: 'A gate', marks: {} };
    expect(writeInline(insertInline(pieces, 3, 3, [picture]))).toBe(
      'one![A gate](demo:picture:gate) **two** three',
    );
  });
});
