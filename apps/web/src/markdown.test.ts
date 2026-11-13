import { describe, expect, it } from 'vitest';
import { guideSearchText, isInlinePicture, renderGuideMarkdown, shownSize } from './markdown';

describe('renderGuideMarkdown', () => {
  it('renders ordinary Markdown', () => {
    const html = renderGuideMarkdown('Herbs grow near **water**.\n\n- one\n- two');
    expect(html).toContain('<strong>water</strong>');
    expect(html).toContain('<li>one</li>');
  });

  it('escapes raw HTML instead of passing it through', () => {
    const html = renderGuideMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\nText <b onclick="x()">bold</b>',
    );
    expect(html).not.toMatch(/<script|<img|<b /);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;img src=x onerror=');
  });

  it('opens links in a new tab without opener or referrer', () => {
    const html = renderGuideMarkdown('[notes](https://example.test/a) and https://example.test/b');
    expect(html).toContain(
      '<a href="https://example.test/a" target="_blank" rel="noopener noreferrer">notes</a>',
    );
    expect(html).toContain(
      '<a href="https://example.test/b" target="_blank" rel="noopener noreferrer">',
    );
  });

  it('drops script links and does not load images', () => {
    const html = renderGuideMarkdown(
      '[click](javascript:alert(1)) ![a tracking pixel](https://example.test/p.png)',
    );
    expect(html).not.toContain('href="javascript');
    expect(html).not.toContain('<img');
  });
});

describe('in-app links', () => {
  const known = new Set(['demo:loc:0412', 'demo:guide:walk', 'demo:checklist:waystones']);
  const options = { isAppTarget: (id: string) => known.has(id) };

  it('turns a link to a content id into a button that carries the id', () => {
    const html = renderGuideMarkdown(
      'Go to [the old well](demo:loc:0412), then read [the walkthrough](demo:guide:walk "Part 2").',
      options,
    );
    expect(html).toContain(
      '<button type="button" class="app-link" data-atlas-target="demo:loc:0412">the old well</button>',
    );
    expect(html).toContain(
      '<button type="button" class="app-link" data-atlas-target="demo:guide:walk" title="Part 2">the walkthrough</button>',
    );
    expect(html).not.toContain('href="demo:');
    expect(html).not.toContain('target="_blank"');
  });

  it('keeps formatting inside the link and handles autolinks', () => {
    const html = renderGuideMarkdown(
      '[**every** stone](demo:checklist:waystones) <demo:loc:0412>',
      options,
    );
    expect(html).toContain(
      'data-atlas-target="demo:checklist:waystones"><strong>every</strong> stone</button>',
    );
    expect(html).toContain('data-atlas-target="demo:loc:0412">demo:loc:0412</button>');
  });

  it('shows a link to something the pack does not have as plain text', () => {
    const html = renderGuideMarkdown(
      '[gone](demo:loc:9999), [elsewhere](other:loc:0412) and [a thing](demo:entity:x)',
      options,
    );
    expect(html).toContain('<span class="app-link-missing">gone</span>');
    expect(html).toContain('<span class="app-link-missing">elsewhere</span>');
    expect(html).toContain('<span class="app-link-missing">a thing</span>');
    expect(html).not.toMatch(/<a |<button/);
    // Without a pack to check against, no id link can be followed.
    expect(renderGuideMarkdown('[well](demo:loc:0412)')).toContain('app-link-missing');
  });

  it('on a page read from a site, says that a page it links to was not read yet', () => {
    const page = { ...options, unreadPage: 'This page has not been read yet' };
    const html = renderGuideMarkdown(
      '[the gate](demo:guide:gate), [gone](demo:loc:9999) and [named](demo:guide:x "Its name")',
      page,
    );
    expect(html).toContain(
      '<span class="app-link-missing" data-unread="" title="This page has not been read yet">the gate</span>',
    );
    // Only a link to a page; a title of its own wins.
    expect(html).toContain('<span class="app-link-missing">gone</span>');
    expect(html).toContain('title="Its name">named</span>');
    // Elsewhere a link to a page that is not there stays as it was.
    expect(renderGuideMarkdown('[the gate](demo:guide:gate)', options)).toContain(
      '<span class="app-link-missing">the gate</span>',
    );
  });

  it('leaves web links alone next to in-app links', () => {
    const html = renderGuideMarkdown(
      '[site](https://example.test/) and [well](demo:loc:0412)',
      options,
    );
    expect(html).toContain(
      '<a href="https://example.test/" target="_blank" rel="noopener noreferrer">site</a>',
    );
    expect(html).toContain('data-atlas-target="demo:loc:0412">well</button>');
  });
});

describe('hidden text', () => {
  const known = new Set(['demo:loc:0412', 'demo:loc:0413']);
  const options = { isAppTarget: (id: string) => known.has(id) };
  const SHOW = (part: number) =>
    `<button type="button" class="hidden-text-show" data-hidden-show="${part}">Show hidden text</button>`;
  const SPAN = (part: number) => `<span class="hidden-text" data-hidden-part="${part}" hidden="">`;

  it('hides text inside a sentence behind a button', () => {
    const html = renderGuideMarkdown('Pull the ||left|| lever, then the ||right|| one.');
    expect(html).toBe(
      `<p>Pull the ${SHOW(1)}${SPAN(1)}left</span> lever, then the ${SHOW(2)}${SPAN(2)}right</span> one.</p>\n`,
    );
  });

  it('keeps in-app links working inside hidden text', () => {
    const html = renderGuideMarkdown('The key: ||[Well lever](demo:loc:0412)||', options);
    expect(html).toBe(
      `<p>The key: ${SHOW(1)}${SPAN(1)}<button type="button" class="app-link" data-atlas-target="demo:loc:0412">Well lever</button></span></p>\n`,
    );
  });

  it('hides a part that spans paragraphs, a list and code', () => {
    const html = renderGuideMarkdown(
      [
        'Solution: ||Turn the valves in this order:',
        '',
        '1. Left',
        '2. [Right](demo:loc:0413)',
        '',
        '```',
        'code',
        '```',
        '',
        'Then pull the lever.||',
        '',
        'Still shown.',
      ].join('\n'),
      options,
    );
    expect(html).toContain(
      `<p>Solution: ${SHOW(1)}${SPAN(1)}Turn the valves in this order:</span></p>`,
    );
    expect(html).toContain('<ol data-hidden-part="1" hidden="">');
    expect(html).toContain('data-atlas-target="demo:loc:0413">Right</button>');
    expect(html).toContain(
      '<div class="hidden-text-block" data-hidden-part="1" hidden><pre><code>code',
    );
    expect(html).toContain(`<p>${SPAN(1)}Then pull the lever.</span></p>`);
    expect(html).toContain('<p>Still shown.</p>');
    // One button for the whole part.
    expect(html.match(/data-hidden-show/g)).toHaveLength(1);
  });

  it('nests properly with emphasis and links around the bars', () => {
    const html = renderGuideMarkdown('**a ||b** c|| and [go ||there||](demo:loc:0412)', options);
    expect(html).toBe(
      `<p><strong>a ${SHOW(1)}${SPAN(1)}b</span></strong>${SPAN(1)} c</span> and ` +
        `${SHOW(2)}<button type="button" class="app-link" data-atlas-target="demo:loc:0412">go ${SPAN(2)}there</span></button></p>\n`,
    );
  });

  it('hides list items between bars in a tight list', () => {
    const html = renderGuideMarkdown('- a ||b\n- c\n- d|| e');
    expect(html).toBe(
      `<ul>\n<li>a ${SHOW(1)}${SPAN(1)}b</span></li>\n<li data-hidden-part="1" hidden="">${SPAN(1)}c</span></li>\n<li>${SPAN(1)}d</span> e</li>\n</ul>\n`,
    );
  });

  it('leaves a bar without a partner, bars in code and escaped bars as text', () => {
    expect(renderGuideMarkdown('a || b')).toBe('<p>a || b</p>\n');
    expect(renderGuideMarkdown('||a|| ||')).toBe(`<p>${SHOW(1)}${SPAN(1)}a</span> ||</p>\n`);
    expect(renderGuideMarkdown('`x || y` ||')).toBe('<p><code>x || y</code> ||</p>\n');
    expect(renderGuideMarkdown('\\|\\|a\\|\\|')).toBe('<p>||a||</p>\n');
  });

  it('stays safe: no raw HTML or images get in through hidden text', () => {
    const html = renderGuideMarkdown(
      '||<img src=x onerror="alert(1)"> ![p](https://example.test/p.png) [x](javascript:alert(1))||',
    );
    expect(html).not.toMatch(/<img|href="javascript|onerror="/);
    expect(html).toContain('&lt;img');
  });
});

describe('raised and lowered text, and line breaks in table cells', () => {
  it('raises ^text^ and lowers ~text~, and leaves strikethrough as it is', () => {
    expect(renderGuideMarkdown('The Vale^DLC^ and H~2~O, ~~struck~~.')).toBe(
      '<p>The Vale<sup>DLC</sup> and H<sub>2</sub>O, <s>struck</s>.</p>\n',
    );
    // A note's mark, as a page shows it.
    expect(renderGuideMarkdown('As told^\\[a\\]^ before.')).toBe(
      '<p>As told<sup>[a]</sup> before.</p>\n',
    );
  });

  it('holds a space only escaped, and marks, links and code inside', () => {
    expect(renderGuideMarkdown('^two\\ words^')).toBe('<p><sup>two words</sup></p>\n');
    expect(renderGuideMarkdown('^**b**^ ~`a b`~ ^[c d](demo:guide:walk)^')).toBe(
      '<p><sup><strong>b</strong></sup> <sub><code>a b</code></sub> <sup><span class="app-link-missing">c d</span></sup></p>\n',
    );
  });

  it('does not make marks of text that only looks like them', () => {
    for (const text of [
      'x^2 + y^2 = r^2',
      '^two words^',
      'a ^ b ^ c',
      '\\^not raised\\^ and \\~not lowered\\~',
      '~ about 5 ~',
      '^^',
      '`^code^`',
      'a^\nb^',
    ]) {
      expect(renderGuideMarkdown(text)).not.toMatch(/<su[pb]>/);
    }
  });

  it('stays safe: nothing but the tags the renderer makes', () => {
    const html = renderGuideMarkdown(
      '^<img src=x onerror="alert(1)">^ ~[x](javascript:alert(1))~ ^![p](https://example.test/p.png)^',
    );
    expect(html).not.toMatch(/<img|href="javascript|onerror="/);
  });

  it('hides text in a table cell, its bars escaped as a table needs any bar there', () => {
    const html = renderGuideMarkdown('| Room | Floor |\n| --- | --- |\n| \\|\\|Vault\\|\\| | 9 |');
    expect(html).toContain(
      '<td><button type="button" class="hidden-text-show" data-hidden-show="1">Show hidden text</button><span class="hidden-text" data-hidden-part="1" hidden="">Vault</span></td>\n<td>9</td>',
    );
  });

  it('breaks a line in a table cell at <br>, and nowhere else', () => {
    const html = renderGuideMarkdown(
      '| Damage | Note |\n| --- | --- |\n| 82 DPS<br>16.4 a hit | a<BR>b \\<br> c `x<br>y` |\n\nA <br> in text.',
    );
    expect(html).toContain('<td>82 DPS<br>\n16.4 a hit</td>');
    // Only the exact text, not escaped, not in code.
    expect(html).toContain('<td>a&lt;BR&gt;b &lt;br&gt; c <code>x&lt;br&gt;y</code></td>');
    expect(html).toContain('<p>A &lt;br&gt; in text.</p>');
    expect(guideSearchText('| a |\n| - |\n| one<br>two |')).toBe('a one two');
  });

  it('hides a whole table between bars in paragraphs of their own, and leaves out the last bar', () => {
    const html = renderGuideMarkdown('||\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n||\n\nAfter.');
    expect(html).toMatch(
      /^<p><button type="button" class="hidden-text-show" data-hidden-show="1">Show hidden text<\/button><\/p>\n<table data-hidden-part="1" hidden="">/,
    );
    expect(html).toMatch(/<\/table>\n+<p>After\.<\/p>\n$/);
    expect(guideSearchText('||\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n||\n\nAfter.')).toBe('After.');
  });
});

describe('coloured words', () => {
  it('colours [words]{color=#hex} with only the colour as an attribute, never a style', () => {
    expect(renderGuideMarkdown('A [relic]{color=#B8714A} and [two words]{color=#f80}.')).toBe(
      '<p>A <span class="text-colour" data-text-colour="#b8714a">relic</span> and <span class="text-colour" data-text-colour="#ff8800">two words</span>.</p>\n',
    );
  });

  it('holds other marks and links, and stands in a link or raised text', () => {
    expect(renderGuideMarkdown('[**b** [a page](https://example.org)]{color=#c33}')).toBe(
      '<p><span class="text-colour" data-text-colour="#cc3333"><strong>b</strong> <a href="https://example.org" target="_blank" rel="noopener noreferrer">a page</a></span></p>\n',
    );
    expect(renderGuideMarkdown('[[a page]{color=#c33}](https://example.org)')).toBe(
      '<p><a href="https://example.org" target="_blank" rel="noopener noreferrer"><span class="text-colour" data-text-colour="#cc3333">a page</span></a></p>\n',
    );
    expect(renderGuideMarkdown('Cellar^[AB]{color=#82c936}^')).toBe(
      '<p>Cellar<sup><span class="text-colour" data-text-colour="#82c936">AB</span></sup></p>\n',
    );
    const cell = renderGuideMarkdown(
      '| A |\n| - |\n| [x y]{color=#0f0}<br>\\|\\|[z]{color=#00f}\\|\\| |',
    );
    expect(cell).toContain(
      '<td><span class="text-colour" data-text-colour="#00ff00">x y</span><br>\n<button type="button" class="hidden-text-show" data-hidden-show="1">Show hidden text</button><span class="hidden-text" data-hidden-part="1" hidden=""><span class="text-colour" data-text-colour="#0000ff">z</span></span></td>',
    );
    expect(guideSearchText('[x y]{color=#0f0} and ||[z]{color=#00f}||')).toBe('x y and');
  });

  it('takes nothing but # and three or six hexadecimal digits right after the words', () => {
    for (const text of [
      '[x]{color=red}',
      '[x] {color=#fff}',
      '[x]{color=#ffff}',
      '[x]{ color=#fff}',
      '[x]{color=#fff;background:red}',
      '[x]{style="color:red"}',
      '[]{color=#fff}',
      '\\[x]{color=#fff}',
      '`[x]{color=#fff}`',
    ]) {
      expect(renderGuideMarkdown(text), text).not.toContain('text-colour');
    }
  });

  it('stays safe: no attribute, style or tag gets in through a colour', () => {
    const html = renderGuideMarkdown(
      '[x]{color=#f00" onmouseover="alert(1)} [y]{color=#f00 style=x} [<img src=x onerror=alert(1)>]{color=#123} [[z](javascript:alert(1))]{color=#123}',
    );
    // Only the tags and attributes the renderer makes; the rest is text.
    expect(html).not.toMatch(/<img|<[^>]*\s(?:on\w+|style)=|href="javascript/);
    expect(html).toContain('<span class="text-colour" data-text-colour="#112233">&lt;img');
  });
});

describe('pictures', () => {
  const pictures = new Map([
    [
      'demo:picture:gate',
      { url: 'https://app.test/packs/demo/pictures/gate.png', caption: 'The gate', credit: 'Ann' },
    ],
  ]);
  const options = { picture: (id: string) => pictures.get(id) ?? null };

  it('shows a picture of the pack by its id, with its caption and credit', () => {
    const html = renderGuideMarkdown('See ![the old gate](demo:picture:gate).', options);
    expect(html).toContain(
      '<img src="https://app.test/packs/demo/pictures/gate.png" alt="the old gate" loading="lazy" decoding="async">',
    );
    expect(html).toContain('<span class="guide-picture-note">The gate · Ann</span>');
  });

  it('shows a picture at the size its title gives, a small one in the line of text', () => {
    const small = renderGuideMarkdown(
      'Found in ![the gate](demo:picture:gate "=28x13") only.',
      options,
    );
    expect(small).toContain(
      '<span class="guide-picture inline"><img src="https://app.test/packs/demo/pictures/gate.png" alt="the gate" width="28" height="13" title="The gate" loading="lazy" decoding="async"></span>',
    );
    // No line under a picture in the line of text.
    expect(small).not.toContain('guide-picture-note');
    const large = renderGuideMarkdown('![the gate](demo:picture:gate "=300")', options);
    expect(large).toContain('<span class="guide-picture sized"><img');
    expect(large).toContain('alt="the gate" width="300" loading="lazy"');
    expect(large).toContain('<span class="guide-picture-note">The gate · Ann</span>');
    // Any other title is not a size.
    for (const title of ['28x13', '=0x5', '=28x', '=12345', 'The gate', '= 28']) {
      const html = renderGuideMarkdown(`![the gate](demo:picture:gate "${title}")`, options);
      expect(html).toContain('<span class="guide-picture"><img');
      expect(html).not.toMatch(/ width=/);
    }
    expect(shownSize('=28x13')).toEqual({ width: 28, height: 13 });
    expect(shownSize('=28')).toEqual({ width: 28 });
    expect(isInlinePicture({ width: 200, height: 48 })).toBe(true);
    expect(isInlinePicture({ width: 200, height: 49 })).toBe(false);
    expect(isInlinePicture({ width: 40 })).toBe(true);
    expect(isInlinePicture(null)).toBe(false);
  });

  it('never loads any other picture: it shows what it shows in words', () => {
    const html = renderGuideMarkdown(
      '![a tracking pixel](https://example.test/p.png) ![gone](demo:picture:gone) ![](demo:picture:none) ![a map](demo:loc:0412) ![*x*](//example.test/p.png "t")',
      options,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.test');
    expect(html).toContain('<span class="picture-alt">a tracking pixel</span>');
    expect(html).toContain('<span class="picture-alt">gone</span>');
    expect(html).toContain('<span class="picture-alt">a map</span>');
    expect(html).toContain('<span class="picture-alt">x</span>');
  });

  it('shows nothing but words without the pack’s pictures', () => {
    expect(renderGuideMarkdown('![the old gate](demo:picture:gate)')).toBe(
      '<p><span class="picture-alt">the old gate</span></p>\n',
    );
  });

  it('escapes what it writes', () => {
    const odd = {
      picture: () => ({ url: 'x" onerror="alert(1)', caption: '<b>c</b>' }),
    };
    const html = renderGuideMarkdown('![a"b](demo:picture:gate)', odd);
    expect(html).not.toContain('onerror="alert');
    expect(html).toContain('alt="a&quot;b"');
    expect(html).toContain('&lt;b&gt;c&lt;/b&gt;');
  });

  it('hides a picture inside hidden text with it', () => {
    const html = renderGuideMarkdown('Look: ||![the gate](demo:picture:gate)||', options);
    expect(html).toMatch(
      /<span class="hidden-text" data-hidden-part="1" hidden=""><span class="guide-picture"><img/,
    );
  });
});

describe('guideSearchText', () => {
  it('reads the words as shown, without hidden text, targets or marks', () => {
    expect(
      guideSearchText(
        '## Tower\n\nClimb [the stairs](demo:loc:1) ![a bell](demo:picture:bell) and `code`.\n\n| A | B |\n| - | - |\n| one | \\|\\|two\\|\\| |\n\n||Whole\n\nparagraphs||\n\n    indented || code\n\nend ||secret||',
      ),
    ).toBe('Tower Climb the stairs a bell and code. A B one indented || code end');
  });

  it('pairs bars as the page does', () => {
    expect(guideSearchText('a ||b|| c || d')).toBe('a c || d');
    expect(guideSearchText('```\n||\n```\n\n||secret|| shown')).toBe('|| shown');
  });
});
