import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PageState, Progress } from './AddFlow';

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('a page being added, in words', () => {
  const row = (state: Parameters<typeof PageState>[0]['state']) =>
    text(renderToStaticMarkup(<PageState state={state} />));

  it('says a map is built for a map page', () => {
    expect(row({ kind: 'converting' })).toBe('Building the map…');
    expect(row({ kind: 'converting', measuring: true })).toBe('Measuring the map picture…');
  });

  it('says a page of a wiki is written into its game, not that a map is built', () => {
    expect(row({ kind: 'converting', of: 'pages' })).toBe('Writing the page into its game…');
    expect(row({ kind: 'converting', of: 'list' })).toBe('Reading the list…');
    expect(row({ kind: 'converting', of: 'pages', waiting: true })).toContain(
      'Waiting for another change to this game…',
    );
  });

  it('says the same when one page of a wiki is added alone', () => {
    const shown = (pages: boolean) =>
      text(
        renderToStaticMarkup(
          <Progress
            phase={{
              kind: 'converting',
              url: 'https://example.org/wiki/Bells',
              importer: 'Example Wiki',
              ...(pages ? { pages } : {}),
            }}
          />,
        ),
      );
    expect(shown(true)).toContain('Writing the page into its game…');
    expect(shown(true)).not.toContain('map pack');
    expect(shown(false)).toContain('Building the map…');
  });
});
