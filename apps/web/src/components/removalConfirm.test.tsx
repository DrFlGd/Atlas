import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeleteImagesConfirmView } from './DeleteImagesConfirm';
import { DeletePackConfirmView } from './DeletePackConfirm';

const noop = () => undefined;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

describe('DeletePackConfirmView', () => {
  const view = (props: Partial<Parameters<typeof DeletePackConfirmView>[0]> = {}) =>
    renderToStaticMarkup(
      <DeletePackConfirmView
        title="My Game"
        info={{ files: 320, bytes: 2_500_000, downloading: true }}
        withProgress={false}
        working={false}
        error={null}
        onWithProgress={noop}
        onConfirm={noop}
        onCancel={noop}
        {...props}
      />,
    );

  it('asks in plain words, with the amount and the running download', () => {
    const shown = text(view());
    expect(shown).toContain('Delete My Game?');
    expect(shown).toContain('its 320 map images (about 2.5 MB)');
    expect(shown).toContain('The download is stopped first.');
    expect(shown).toContain('Also delete my progress for this game in this app');
    expect(shown).toContain('Keep it');
    expect(view()).toContain('data-testid="confirm-delete-pack"');
  });

  it('offers to delete the person’s own lists too, unticked', () => {
    expect(text(view())).not.toContain('Also delete my lists and guides');
    const offered = view({ onWithLists: noop });
    expect(text(offered)).toContain('Also delete my lists and guides for this game');
    expect(offered).not.toMatch(/data-testid="delete-pack-lists"[^>]*checked/);
    expect(view({ onWithLists: noop, withLists: true })).toMatch(
      /data-testid="delete-pack-lists" checked=""/,
    );
  });

  it('shows that it is working, and a plain error', () => {
    const working = view({ working: true });
    expect(text(working)).toContain('Stopping the download…');
    expect(working).toMatch(/data-testid="confirm-delete-pack" disabled=""/);
    const failed = view({
      info: { files: 1, bytes: 10, downloading: false },
      error: 'Another Atlas window or app is working on this map’s files right now.',
    });
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain('Another Atlas window or app');
  });
});

describe('DeleteImagesConfirmView', () => {
  const view = (props: Partial<Parameters<typeof DeleteImagesConfirmView>[0]> = {}) =>
    renderToStaticMarkup(
      <DeleteImagesConfirmView
        title="My Game"
        info={{ files: 12, bytes: 840_000, downloading: false }}
        working={false}
        error={null}
        onConfirm={noop}
        onCancel={noop}
        {...props}
      />,
    );

  it('says what is removed and what stays', () => {
    const shown = text(view());
    expect(shown).toContain('Delete the downloaded map images of My Game?');
    expect(shown).toContain('This removes 12 map images (about 840 KB) of My Game');
    expect(shown).toContain('your found marks');
    expect(shown).toContain('Delete map images');
    expect(shown).toContain('Keep them');
  });

  it('waits for the count before it can delete', () => {
    const counting = view({ info: null });
    expect(text(counting)).toContain('Counting the downloaded map images…');
    expect(counting).toMatch(/data-testid="confirm-delete-images" disabled=""/);
  });

  it('offers only Close when there is nothing to delete or it could not be counted', () => {
    const nothing = view({ info: { files: 0, bytes: 0, downloading: false } });
    expect(nothing).not.toContain('confirm-delete-images');
    expect(text(nothing)).toContain('There are no downloaded map images of My Game to delete.');
    expect(text(nothing)).toContain('Close');
    const failed = view({ info: null, error: 'Atlas could not look at the map images.' });
    expect(failed).not.toContain('confirm-delete-images');
    expect(text(failed)).not.toContain('Counting');
    expect(failed).toContain('role="alert"');
  });
});
