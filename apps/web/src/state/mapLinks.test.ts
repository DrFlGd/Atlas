import { describe, expect, it } from 'vitest';
import { useMapLinks } from './mapLinks';
import { useAtlas } from './store';

describe('the links of pages to locations of a map, as the game shown changes', () => {
  it('has no entries, and fails nowhere, for a game whose pack cannot be read', async () => {
    useAtlas.setState({
      game: { entry: { id: 'my-game', url: 'x', title: 'My Game' } } as never,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useMapLinks.getState()).toMatchObject({ gameId: null, links: [], sources: [] });
    useAtlas.setState({ game: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useMapLinks.getState()).toMatchObject({ gameId: null, links: [], sources: [] });
  });
});
