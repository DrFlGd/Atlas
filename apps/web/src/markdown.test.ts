import { describe, expect, it } from 'vitest';
import { renderGuideMarkdown } from './markdown';

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
