import { beforeEach, describe, expect, it, vi } from 'vitest';

const reloadShownGame = vi.fn(() => Promise.resolve(true));
const switchGame = vi.fn(() => Promise.resolve());
vi.mock('./actions', () => ({ reloadShownGame, switchGame, notify: vi.fn() }));

const { usePageEditor } = await import('../touch/pages/pageEditorState');
const { useAtlas } = await import('./store');
const { packWritten, showWiki } = await import('./shownGameRefresh');

/** The game shown, as far as these steps look at it. */
const show = (id: string | null) => {
  useAtlas.setState({
    game: id
      ? ({ entry: { id } } as unknown as NonNullable<ReturnType<typeof useAtlas.getState>['game']>)
      : null,
  });
};

beforeEach(() => {
  reloadShownGame.mockClear();
  switchGame.mockClear();
  usePageEditor.setState({ open: false });
});

describe('Show this wiki', () => {
  it('loads the wiki again when it is the game shown already', async () => {
    show('example-wiki');
    await showWiki('example-wiki');
    expect(reloadShownGame).toHaveBeenCalledWith('example-wiki');
    expect(switchGame).not.toHaveBeenCalled();
  });

  it('shows the wiki when another game is shown', async () => {
    show('demo');
    await showWiki('example-wiki');
    expect(switchGame).toHaveBeenCalledWith('example-wiki');
    expect(reloadShownGame).not.toHaveBeenCalled();
  });
});

describe('the game shown after a step wrote its pack', () => {
  it('is loaded again; another game shown is left alone', () => {
    show('wiki-a');
    packWritten('wiki-b');
    expect(reloadShownGame).not.toHaveBeenCalled();
    packWritten('wiki-a');
    expect(reloadShownGame).toHaveBeenCalledWith('wiki-a');
  });

  it('during a go, at most once a minute', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-14T10:00:00Z'));
      show('wiki-go');
      packWritten('wiki-go', { duringGo: true });
      packWritten('wiki-go', { duringGo: true });
      expect(reloadShownGame).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date('2026-11-14T10:01:01Z'));
      packWritten('wiki-go', { duringGo: true });
      expect(reloadShownGame).toHaveBeenCalledTimes(2);
      // The end of the go, always.
      packWritten('wiki-go');
      expect(reloadShownGame).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits while a page is being edited, and is loaded again when the editor closes', () => {
    show('wiki-edit');
    usePageEditor.setState({ open: true });
    packWritten('wiki-edit');
    packWritten('wiki-edit');
    expect(reloadShownGame).not.toHaveBeenCalled();
    usePageEditor.setState({ open: false });
    expect(reloadShownGame).toHaveBeenCalledTimes(1);
    expect(reloadShownGame).toHaveBeenCalledWith('wiki-edit');
  });
});
