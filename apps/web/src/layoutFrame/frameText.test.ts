import { describe, expect, it } from 'vitest';
import {
  FRAME_POLICY,
  FRAME_SHELL,
  PICTURE_BOX,
  defangSheet,
  elementFate,
  isAtlasAttribute,
  keptAttribute,
  ownSheetsFor,
  pictureBox,
  sheetsFor,
  type PageSheet,
} from './frameText';

const none = () => null;
const attrs =
  (given: Record<string, string>) =>
  (name: string): string | null =>
    given[name] ?? null;

describe('what of a page goes into the closed frame', () => {
  it('leaves out every element that runs, loads, sends or shows another page', () => {
    for (const name of [
      'script',
      'SCRIPT',
      'noscript',
      'iframe',
      'frame',
      'frameset',
      'object',
      'embed',
      'applet',
      'portal',
      'fencedframe',
      'link',
      'base',
      'style',
    ]) {
      expect(elementFate(name, none), name).toBe('remove');
    }
    expect(elementFate('meta', attrs({ 'http-equiv': 'refresh', content: '0;url=x' }))).toBe(
      'remove',
    );
    expect(elementFate('meta', attrs({ name: 'description' }))).toBe('keep');
    // A form is gone, what it shows stays.
    expect(elementFate('form', attrs({ action: 'https://forms.example.org/' }))).toBe('div');
    for (const name of ['div', 'p', 'img', 'table', 'ul', 'svg', 'video', 'template']) {
      expect(elementFate(name, none), name).toBe('keep');
    }
  });

  it('takes no event, no address of anything loaded, no style of its own and no attribute of the app’s', () => {
    expect(keptAttribute('div', 'onclick', 'go()')).toBe(false);
    expect(keptAttribute('body', 'ONLOAD', 'go()')).toBe(false);
    expect(keptAttribute('img', 'src', 'https://pictures.example.org/a.png')).toBe(false);
    expect(keptAttribute('img', 'srcset', 'a.png 1x')).toBe(false);
    expect(keptAttribute('video', 'poster', 'a.png')).toBe(false);
    expect(keptAttribute('source', 'src', 'a.webm')).toBe(false);
    expect(keptAttribute('table', 'background', 'a.png')).toBe(false);
    expect(keptAttribute('a', 'ping', 'https://count.example.org/')).toBe(false);
    expect(keptAttribute('button', 'formaction', '/send')).toBe(false);
    expect(keptAttribute('div', 'style', 'color: red')).toBe(false);
    expect(keptAttribute('div', 'data-atlas-box', '0 0 10 10')).toBe(false);
    expect(keptAttribute('div', 'data-atlas-layout', '1 16')).toBe(false);
    // An SVG picture or use loads its `href`; one inside the page does not.
    expect(keptAttribute('image', 'href', 'https://pictures.example.org/a.svg')).toBe(false);
    expect(keptAttribute('use', 'xlink:href', 'sprites.svg#leaf')).toBe(false);
    expect(keptAttribute('use', 'href', '#leaf')).toBe(true);
    // A link is followed only when pressed, and nothing in the frame is pressed.
    expect(keptAttribute('a', 'href', 'https://wiki.example.org/wiki/Moss')).toBe(true);
    for (const [name, value] of [
      ['class', 'cards'],
      ['id', 'moss'],
      ['width', '120'],
      ['colspan', '2'],
      ['data-sort', '3'],
      ['hidden', ''],
      ['aria-hidden', 'true'],
    ] as const) {
      expect(keptAttribute('div', name, value), name).toBe(true);
    }
  });

  it('gives a picture a box of the size it states, else a small fixed one', () => {
    expect(pictureBox({ width: '120', height: '80', style: null })).toBe('');
    expect(pictureBox({ width: null, height: null, style: 'width: 50%; height: 3em' })).toBe('');
    expect(pictureBox({ width: '120px', height: null, style: null })).toBe(
      `height: ${PICTURE_BOX}px`,
    );
    expect(pictureBox({ width: null, height: null, style: null })).toBe(
      `width: ${PICTURE_BOX}px; height: ${PICTURE_BOX}px`,
    );
    // `max-width` is no width.
    expect(pictureBox({ width: 'auto', height: '10', style: 'max-width: 100%' })).toBe(
      `width: ${PICTURE_BOX}px`,
    );
  });

  it('tells the app’s attributes by their name', () => {
    expect(isAtlasAttribute('data-atlas-hidden')).toBe(true);
    expect(isAtlasAttribute('DATA-ATLAS-BOX')).toBe(true);
    expect(isAtlasAttribute('data-atlas-full')).toBe(true);
    expect(isAtlasAttribute('data-atlasx')).toBe(false);
    expect(isAtlasAttribute('data-layout')).toBe(false);
  });

  it('is a document that allows nothing from the network', () => {
    expect(FRAME_POLICY).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(FRAME_SHELL).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">`,
    );
    expect(FRAME_SHELL.indexOf('Content-Security-Policy')).toBeLessThan(
      FRAME_SHELL.indexOf('<body'),
    );
  });
});

describe('a style sheet made harmless', () => {
  it('loads nothing: no import, no address, no set of pictures', () => {
    const sheet = [
      '@import url("https://wiki.example.org/more.css") screen;',
      "@IMPORT 'other.css';",
      '.cards { display: flex; background: #eee url(https://pictures.example.org/bg.png) no-repeat; }',
      ".hero { background-image: URL( 'a.png' ); cursor: url(hand.cur), pointer; }",
      '.set { background-image: image-set("a.png" 1x, "b.png" 2x); }',
      '.old { background-image: -webkit-image-set(url(a.png) 1x); }',
      '@font-face { font-family: Leaf; src: url(leaf.woff2) format("woff2"), local(Leaf); }',
      '.esc { background: \\75 rl(sneaky.png); }',
    ].join('\n');
    const safe = defangSheet(sheet);
    expect(safe).not.toMatch(/@import/iu);
    expect(safe).not.toMatch(/\.png|\.cur|\.woff2|\.css/u);
    expect(safe).not.toMatch(/image-set/iu);
    expect(safe).toContain('.cards { display: flex; background: #eee url() no-repeat; }');
    expect(safe).toContain('cursor: url(), pointer;');
    expect(safe).toContain('.set { background-image: none; }');
    expect(safe).toContain('src: url() format("woff2"), local(Leaf);');
    expect(safe).toContain('.esc { background: url(); }');
  });

  it('leaves the rest of the sheet as it was, and reads strings and comments as such', () => {
    const rules =
      '.cols { column-count: 3 } /* url(not-a-rule.png) */ .q::before { content: "url(words)" }\n@media (max-width: 720px) { .side { display: none } }';
    expect(defangSheet(rules)).toBe(rules);
    // A name that only ends in "url" is no address.
    expect(defangSheet('.curl(x) {}')).toBe('.curl(x) {}');
    expect(defangSheet('.a { --u: myurl(x) }')).toBe('.a { --u: myurl(x) }');
    // A declaration list, as an element's own style.
    expect(defangSheet('width: 40px; background: url(x.png)')).toBe(
      'width: 40px; background: url()',
    );
  });

  it('ends an import at its semicolon, never past a block', () => {
    expect(defangSheet('@import "a.css"; .b { color: red }')).toBe(' .b { color: red }');
    expect(defangSheet('@import url(a.css) .b { color: red }')).toBe('{ color: red }');
    expect(defangSheet('@import "never-closed')).toBe('');
  });
});

describe('the sheets a page is laid out with', () => {
  const kept = [
    { address: 'https://wiki.example.org/skin.css', text: '.skin {}' },
    { text: '.block-of-another-page {}' },
    { address: 'https://wiki.example.org/site.css', text: '.site {}' },
  ];

  it('are those it links to that are kept, and its own blocks, in its order', () => {
    const page: PageSheet[] = [
      { address: 'https://wiki.example.org/site.css', media: 'screen' },
      { text: '.own {}' },
      { address: 'https://wiki.example.org/not-kept.css' },
      { address: 'https://wiki.example.org/skin.css' },
    ];
    expect(sheetsFor(page, kept)).toEqual([
      { text: '.site {}', media: 'screen' },
      { text: '.own {}' },
      { text: '.skin {}' },
    ]);
  });

  it('are every sheet kept for a page that links to none, as a reader hands its parts over', () => {
    expect(sheetsFor([{ text: '.own {}' }], kept)).toEqual([
      { text: '.skin {}' },
      { text: '.block-of-another-page {}' },
      { text: '.site {}' },
      { text: '.own {}' },
    ]);
    expect(sheetsFor([], kept)).toHaveLength(3);
  });

  it('are none, so the page is not laid out, when the game keeps none it uses', () => {
    expect(sheetsFor([{ text: '.own {}' }], [])).toBeNull();
    expect(
      sheetsFor([{ address: 'https://wiki.example.org/other.css' }, { text: '.own {}' }], kept),
    ).toBeNull();
  });

  it('give the same text once', () => {
    expect(
      sheetsFor([{ address: 'https://wiki.example.org/skin.css' }, { text: '.skin {}' }], kept),
    ).toEqual([{ text: '.skin {}' }]);
  });
});

describe('the sheets a saved page is laid out with, for a trial of a rules file', () => {
  it('are its own blocks only, in its order, each once, with their media', () => {
    expect(
      ownSheetsFor([
        { text: '.reed {}' },
        { text: '.tide {}', media: 'screen' },
        { text: '.reed {}' },
      ]),
    ).toEqual([{ text: '.reed {}' }, { text: '.tide {}', media: 'screen' }]);
  });

  it('are none when it links to a sheet it does not hold, or holds no rules', () => {
    expect(
      ownSheetsFor([{ text: '.reed {}' }, { address: 'https://wiki.example.org/site.css' }]),
    ).toBe('linked');
    expect(ownSheetsFor([])).toBe('none');
    expect(ownSheetsFor([{ text: '   ' }])).toBe('none');
  });
});
