import { downloadsOffered } from '../features';
import { downloadFolder, loadDownloads } from './downloads';
import { NO_DOWNLOADS, useAtlas, type LoadedGame } from './store';

/**
 * Called when a game is loaded or its map images change. Where the app
 * downloads map images, finds out what can be downloaded for the game.
 * Otherwise it only notes the folder the shell serves the game's pack from
 * when its layers have remote images, so the map reads their status files
 * and shows the images already there (downloaded by another Atlas app or an
 * earlier version).
 */
export async function loadMapImages(game: LoadedGame): Promise<void> {
  if (__ATLAS_DOWNLOADS__ && downloadsOffered(useAtlas.getState())) {
    await loadDownloads(game);
    return;
  }
  useAtlas.setState({ downloads: { ...NO_DOWNLOADS, packFolder: downloadFolder(game) } });
}
