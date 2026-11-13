import { GuideView } from '../components/ChecklistsPane';
import { isOwnId } from '@atlas/schema';
import { useOwnLists } from '../state/ownLists';
import { useAtlas, type ChecklistPage, type LoadedGame } from '../state/store';
import { AreaScreen } from './ListAreas';
import { ListFrame } from './ListFrame';
import { PageBack } from './ListRows';
import { ListsHome } from './ListsHome';
import { listById } from './listViews';

const INDEX: ChecklistPage = { kind: 'index' };

/**
 * Lists: the game's lists and guides (`ListsHome`), one list in a view of
 * its choice (`ListFrame`), one area of a list (`AreaScreen`), or one guide.
 * Each is a page of the checklists screen's history, so Back closes them
 * one at a time: an area, then its list, then the lists.
 */
export function ListsScreen() {
  const game = useAtlas((s) => s.game)!;
  const page = useAtlas((s) => s.checklistPages.at(-1) ?? INDEX);
  // An own list is shown as it is now, while it is edited too.
  const ownStatus = useOwnLists((s) => s.status);
  useOwnLists((s) => s.lists);
  if (page.kind === 'guide') return <GuideScreen key={page.id} game={game} id={page.id} />;
  if (page.kind === 'index') return <ListsHome game={game} />;
  const entry = listById(game, page.id);
  if (!entry) return <MissingList loading={isOwnId(page.id) && ownStatus === 'loading'} />;
  if (page.area !== undefined) {
    return (
      <AreaScreen key={`${page.id}|${page.area}`} game={game} entry={entry} area={page.area} />
    );
  }
  return <ListFrame key={page.id} game={game} entry={entry} />;
}

function MissingList({ loading }: { loading: boolean }) {
  return (
    <div className="touch-page">
      <header className="touch-page-head touch-page-head-back">
        <PageBack />
      </header>
      <p className="touch-empty">
        {loading ? 'Reading your lists…' : 'This list is not in the pack.'}
      </p>
    </div>
  );
}

/** One guide, as the guide pages show it. */
function GuideScreen({ game, id }: { game: LoadedGame; id: string }) {
  return (
    <div className="touch-page" data-testid="guide-screen">
      <header className="touch-page-head touch-page-head-back">
        <div className="touch-page-head-row">
          <PageBack />
          <p className="touch-page-kicker">Guide</p>
        </div>
      </header>
      <div className="touch-scroll touch-page-body touch-guide" data-scroll-root>
        <GuideView game={game} id={id} back={false} />
      </div>
    </div>
  );
}
