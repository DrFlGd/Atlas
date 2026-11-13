import { useOwnLists } from '../../state/ownLists';
import { useAtlas } from '../../state/store';
import { useTouch } from '../state';

/** Whether lists can be made and edited here: a tablet on its side, or a computer. */
export function useCanEdit(): boolean {
  const wide = useTouch((s) => s.editorRoom);
  const editable = useOwnLists((s) => s.status === 'ready' && s.readOnly === null);
  const hasGame = useAtlas((s) => s.game !== null);
  return wide && editable && hasGame;
}
