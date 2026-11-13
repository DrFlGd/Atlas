import { useOwnLists } from '../../state/ownLists';
import { useAtlas } from '../../state/store';
import { useTouch } from '../state';

/** Whether lists can be made and edited here: from a tablet's width up. */
export function useCanEdit(): boolean {
  const wide = useTouch((s) => s.arrangement === 'wide');
  const editable = useOwnLists((s) => s.status === 'ready' && s.readOnly === null);
  const hasGame = useAtlas((s) => s.game !== null);
  return wide && editable && hasGame;
}
