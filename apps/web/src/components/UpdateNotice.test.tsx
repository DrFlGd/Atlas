import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FoundUpdate } from '../state/updates';
import { UpdateNoticeView } from './UpdateNotice';

const noop = () => undefined;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const FOUND: FoundUpdate = {
  state: 'available',
  version: '0.27.0',
  current: '0.26.0',
  notes: '- **Routes.** A route is a path on the map.\n- **Fixed:** a map name.',
  date: null,
};

const view = (
  over: Partial<Parameters<typeof UpdateNoticeView>[0]['view']> = {},
  platform = 'windows',
) =>
  renderToStaticMarkup(
    <UpdateNoticeView
      found={FOUND}
      view={{ phase: 'idle', received: 0, total: null, installProblem: null, ...over }}
      platform={platform}
      onInstall={noop}
      onLater={noop}
      onSkip={noop}
    />,
  );

describe('the notice of a new version', () => {
  it('names the new version and what is new, with Install now, Later and Skip this version', () => {
    const html = view();
    const shown = text(html);
    expect(shown).toContain('Atlas 0.27.0 is available');
    expect(shown).toContain('You have Atlas 0.26.0.');
    expect(shown).toContain('What’s new');
    expect(html).toContain('<li>Routes. A route is a path on the map.</li>');
    expect(html).toContain('<li>Fixed: a map name.</li>');
    expect(shown).toContain('saves your changes and closes Atlas');
    expect(html).toMatch(/data-testid="update-install"[^>]*>.*Install now/);
    expect(html).toMatch(/data-testid="update-later"[^>]*>Later/);
    expect(html).toMatch(/data-testid="update-skip"[^>]*>Skip this version/);
    // It covers nothing: not a modal dialog.
    expect(html).toContain('aria-modal="false"');
    expect(html).not.toMatch(/disabled/);
  });

  it('says on Linux that the new version replaces this one', () => {
    expect(text(view({}, 'linux'))).toContain('replaces this version with the new one');
  });

  it('shows the download’s progress, and no button can be pressed while it runs', () => {
    const html = view({ phase: 'downloading', received: 30_000_000, total: 120_000_000 });
    expect(text(html)).toContain('Downloading… 25% (30.0 of 120.0 MB)');
    expect(html).toContain('aria-valuenow="25"');
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(text(view({ phase: 'installing' }))).toContain(
      'Installing… Atlas starts again in a moment.',
    );
  });

  it('says why it did not work, and offers to try again', () => {
    const html = view({
      phase: 'failed',
      installProblem: 'Atlas could not reach the update server.',
    });
    expect(text(html)).toContain('Atlas could not reach the update server.');
    expect(html).toMatch(/data-testid="update-install"[^>]*>.*Try again/);
  });
});
