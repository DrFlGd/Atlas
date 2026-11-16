import { describe, expect, it } from 'vitest';
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
      'div.guide-form.guide-side.guide-side-2',
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
