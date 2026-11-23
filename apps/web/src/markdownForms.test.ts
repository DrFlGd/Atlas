import { describe, expect, it } from 'vitest';
import { rowMarkdown } from '@atlas/schema';
import { guideHeadings, guideSearchText, renderGuideMarkdown } from './markdown';

const options = {
  isAppTarget: (id: string) => id.startsWith('demo:'),
  picture: (id: string) =>
    id === 'demo:picture:stone' ? { url: 'packs/demo/stone.png', width: 64, height: 64 } : null,
};
const render = (text: string) => renderGuideMarkdown(text, options);
const lines = (...parts: string[]) => parts.join('\n\n');

/** The tags of the HTML, without their attributes' values, to compare its shape. */
const shape = (html: string) =>
  [...html.matchAll(/<(\/?)([a-z0-9]+)(?: class="([^"]*)")?/g)].map(
    ([, close, tag, classes]) =>
      `${close}${tag}${classes ? `.${classes.split(' ').join('.')}` : ''}`,
  );

describe('layout forms', () => {
  it('sets blocks side by side with their shares of the width, as classes', () => {
    const html = render(lines('::: side 1:3', '- Menu', '::: next', '## News', 'Text.', '::: end'));
    expect(shape(html)).toEqual([
      'div.guide-form.guide-side.guide-side-2.guide-side-short',
      'div.guide-side-block.guide-share-1',
      'ul',
      'li',
      '/li',
      '/ul',
      '/div',
      'div.guide-side-block.guide-share-3',
      'h2',
      '/h2',
      'p',
      '/p',
      '/div',
      '/div',
    ]);
    expect(html).not.toContain('style');
    expect(html).not.toContain(':::');
  });

  it('makes a card whose first heading is its title bar and a heading of the page', () => {
    const text = lines('::: card', '### Latest news', 'One.', '::: end', '## After');
    const html = render(text);
    expect(html).toContain('<div class="guide-form guide-card">');
    expect(html).toContain(
      '<h3 data-section="latest-news" class="guide-card-title">Latest news</h3>',
    );
    expect(guideHeadings(text).map((heading) => heading.name)).toEqual(['latest-news', 'after']);
    // Without a heading first, no title bar.
    expect(render(lines('::: card', 'One.', '## Later', '::: end'))).not.toContain(
      'guide-card-title',
    );
  });

  it('makes rows, columns and centred blocks', () => {
    expect(render(lines('::: row', '- One\n- Two', '::: end'))).toContain(
      '<div class="guide-form guide-row">\n<ul>',
    );
    expect(render(lines('::: columns 3', '- a\n- b\n- c', '::: end'))).toContain(
      '<div class="guide-form guide-columns guide-columns-3">',
    );
    expect(render(lines('::: centred', '*Made up.*', '::: end'))).toBe(
      '<div class="guide-form guide-centred">\n<p><em>Made up.</em></p>\n</div>\n',
    );
  });

  it('marks a row whose every item starts with a small picture', () => {
    const pictured = lines(
      '::: row',
      '- ![stone](demo:picture:stone "=24") Stones\n- [![stone](demo:picture:stone "=24")](demo:guide:a) Gates',
      '::: end',
    );
    expect(render(pictured)).toContain('<ul class="guide-row-pictures">');
    const mixed = lines(
      '::: row',
      '- ![stone](demo:picture:stone "=24") Stones\n- Gates',
      '::: end',
    );
    expect(render(mixed)).not.toContain('guide-row-pictures');
  });

  it('marks a list in columns whose every item is a line that starts with a small picture', () => {
    const pictured = lines(
      '::: columns 3',
      '- [![stone](demo:picture:stone "=24")](demo:guide:a)[Stones](demo:guide:a)\n- ![reed](demo:picture:reed "=20x16") Reeds\n- ![eel](demo:picture:eel "=24") Eels',
      '::: end',
    );
    expect(render(pictured)).toContain('<ul class="guide-columns-pictures">');
    const mixed = lines(
      '::: columns 3',
      '- ![stone](demo:picture:stone "=24") Stones\n- Reeds\n- ![eel](demo:picture:eel "=24") Eels',
      '::: end',
    );
    expect(render(mixed)).not.toContain('guide-columns-pictures');
    // An item that holds more than its line (a list inside it) keeps its bullet.
    const nested = lines(
      '::: columns 2',
      '- ![stone](demo:picture:stone "=24") Stones\n  - Grey\n- ![eel](demo:picture:eel "=24") Eels',
      '::: end',
    );
    expect(render(nested)).not.toContain('guide-columns-pictures');
    // A large picture is no bullet.
    const large = lines(
      '::: columns 2',
      '- ![stone](demo:picture:stone "=120") Stones\n- ![eel](demo:picture:eel "=120") Eels',
      '::: end',
    );
    expect(render(large)).not.toContain('guide-columns-pictures');
  });

  it('keeps an item of a row of several lines as its lines, beside the pictures it starts with', () => {
    const row = rowMarkdown([
      '[![stone](demo:picture:stone "=24")](demo:guide:a) ![stone](demo:picture:stone "=24")\n[Harbour](demo:guide:a)\n2.4.1\nSince spring',
      '![stone](demo:picture:stone "=24") Fens\n- not a list',
      '![stone](demo:picture:stone "=24") Gates',
    ]);
    const html = render(row);
    expect(html).toContain('<ul class="guide-row-pictures">');
    const items = html.split('<li>').slice(1);
    // The pictures, then the lines in a span of their own, no break before the first.
    expect(items[0]).toMatch(
      /^<button[^>]*><span class="guide-picture inline"><img [^>]*><\/span><\/button> <span class="guide-picture inline"><img [^>]*><\/span> <span class="guide-row-lines"><button[^>]*>Harbour<\/button><br>\n2\.4\.1<br>\nSince spring<\/span><\/li>/u,
    );
    // Words on the pictures' line stay the first line; a further line is never a block.
    expect(items[1]).toContain('<span class="guide-row-lines">Fens<br>\n- not a list</span>');
    expect(html).not.toContain('<ul>');
    // An item of one line is as before.
    expect(items[2]).not.toContain('guide-row-lines');
    // Without pictures, the lines alone.
    expect(render(rowMarkdown(['Harbour\n2.4.1', 'Gates']))).toContain(
      '<li><span class="guide-row-lines">Harbour<br>\n2.4.1</span></li>',
    );
  });

  it('marks blocks side by side that hold only short lines, to stay side by side where narrow', () => {
    const lists = render(
      lines(
        '::: side',
        '[Early](demo:guide:a)',
        '- ![stone](demo:picture:stone "=24") Ash\n- Elm',
        '::: next',
        '#### Late',
        '1. Oak\n2. Yew',
        '::: end',
      ),
    );
    expect(lists).toContain('<div class="guide-form guide-side guide-side-2 guide-side-short">');
    // A long line, an item of more than a line, a table or a form in a block: as before.
    const long = 'Words '.repeat(15);
    for (const other of [
      long,
      '- Ash\n\n  More of it.',
      '| a |\n| --- |\n| b |',
      lines('::: row', '- a\n- b', '::: end'),
    ]) {
      expect(render(lines('::: side', '- Ash', '::: next', other, '::: end'))).not.toContain(
        'guide-side-short',
      );
    }
  });

  it('fills columns by count with a list of lines, and one list a column with as many lists', () => {
    const items = Array.from({ length: 21 }, (_, i) => `- Item ${i}`).join('\n');
    const html = render(lines('::: columns 4', items, '::: end'));
    // Six in each column, as balanced columns of lines hold them.
    expect(
      [...html.matchAll(/<li( class="guide-column-start")?>Item (\d+)/gu)]
        .filter((m) => m[1])
        .map((m) => m[2]),
    ).toEqual(['6', '12', '18']);
    const apart = render(lines('::: columns 3', '- a\n- b\n- c', '* d', '- e\n- f', '::: end'));
    expect(apart.match(/<ul class="guide-column-start">/gu)).toHaveLength(2);
    expect(apart).not.toContain('<li class=');
    // Items of more than a line, or lists not as many as the columns: the browser balances them.
    expect(render(lines('::: columns 2', '- a\n\n  More.\n- b\n- c', '::: end'))).not.toContain(
      'guide-column-start',
    );
    expect(render(lines('::: columns 3', '- a\n- b', '* c', '::: end'))).not.toContain(
      'guide-column-start',
    );
  });

  it('nests forms two deep and more, and keeps every mark working inside', () => {
    const text = lines(
      '::: side 1:2',
      '::: card',
      '#### Menu',
      '::: row',
      '- [Bells](demo:guide:bells "#ringing")\n- ^new^ [x]{color=#c33}',
      '::: end',
      '::: end',
      '::: next',
      '| Maul | {box} |\n| --- | --- |\n| Weight | 9 |',
      '- [![stone](demo:picture:stone)](demo:guide:a) A\n- ![stone](demo:picture:stone) B',
      '| Name | Price |\n| --- | --- |\n| Rope | 3 |',
      'Answer: ||hidden||.',
      '::: end',
    );
    const html = render(text);
    expect(html).toContain('<div class="guide-form guide-card">\n<h4 data-section="menu"');
    expect(html).toContain('<div class="guide-form guide-row">');
    expect(html).toContain('data-atlas-section="ringing"');
    expect(html).toContain('<sup>new</sup>');
    expect(html).toContain('data-text-colour="#cc3333"');
    expect(html).toContain('<aside class="guide-box"');
    expect(html).toContain('<ul class="guide-tiles">');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('data-hidden-show="1"');
    expect(html).not.toContain(':::');
    expect(guideSearchText(text)).toBe(
      'Menu Bells new x Maul Weight 9 stone A stone B Name Price Rope 3 Answer: .',
    );
  });

  it('hides a form whole, or the part of it hidden text spans', () => {
    const whole = render(lines('||', '::: card', '### Secret', 'Text.', '::: end', '||'));
    expect(whole).toContain('<div class="guide-form guide-card" data-hidden-part="1" hidden="">');
    const into = render(
      lines('Before ||starts', '::: side', 'a', '::: next', 'b|| after', '::: end'),
    );
    expect(into).toContain(
      '<div class="guide-side-block guide-share-1" data-hidden-part="1" hidden="">',
    );
    expect(into).toContain(
      '<span class="hidden-text" data-hidden-part="1" hidden="">b</span> after',
    );
    expect(guideHeadings(lines('||', '::: card', '### Secret', '::: end', '||'))[0]?.hidden).toBe(
      true,
    );
    expect(guideSearchText(lines('||', '::: card', '### Secret', '::: end', '||'))).toBe('');
  });

  it('leaves markers without a partner, unknown or out of context as text', () => {
    expect(render(lines('::: card', 'Never closed.'))).toBe(
      '<p>::: card</p>\n<p>Never closed.</p>\n',
    );
    expect(render(lines('::: aside', 'a', '::: end'))).toBe(
      '<p>::: aside</p>\n<p>a</p>\n<p>::: end</p>\n',
    );
    expect(render('::: card\nJoined.\n\n::: end')).toBe(
      '<p>::: card\nJoined.</p>\n<p>::: end</p>\n',
    );
    expect(render(lines('```', '::: card', '```', '::: end'))).toContain('<p>::: end</p>');
    expect(render(lines('\\::: card', 'a', '::: end'))).toBe(
      '<p>::: card</p>\n<p>a</p>\n<p>::: end</p>\n',
    );
    // In a list item or a quote, a marker is text.
    expect(render(lines('- item', '  ::: card', '  a', '  ::: end'))).not.toContain('guide-card');
    expect(render(lines('> ::: card', '> a', '> ::: end'))).not.toContain('guide-card');
    // A separator in a card is text, and the card still closes.
    expect(render(lines('::: card', 'a', '::: next', 'b', '::: end'))).toBe(
      '<div class="guide-form guide-card">\n<p>a</p>\n<p>::: next</p>\n<p>b</p>\n</div>\n',
    );
  });

  it('reads a page of many forms quickly and stays safe', () => {
    const text = Array.from({ length: 400 }, (_, i) =>
      lines('::: side 1:9', `<b>${i}</b>`, '::: next', '::: card', '### x', '::: end', '::: end'),
    ).join('\n\n');
    const started = performance.now();
    const html = render(text);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(html).not.toContain('<b>');
    expect(html.match(/guide-side-block/g)?.length).toBeGreaterThan(0);
  });
});
