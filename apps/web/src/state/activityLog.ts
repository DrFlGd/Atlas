import type { LogArea } from '../activityLog';
import { useAtlas } from './store';

/** Opens the activity log dialog (desktop app), on one area or all. */
export function openActivityLog(area: LogArea | 'all' = 'all'): void {
  useAtlas.setState({ logViewer: { area } });
}

export function closeActivityLog(): void {
  useAtlas.setState({ logViewer: null });
}
