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
