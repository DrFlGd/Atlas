import { UiIcon } from '../components/icons';
import { useAtlas } from '../state/store';
import { useGuideOnMap } from './guideMap';
import { clearPageOnMap, openListOf, placesOf, setOnlyOnMap, useLists } from './listViews';
import { useTouch } from './state';

/**
 * Over the map while a list is open: whether only its places are shown.
 * Pressed, it shows the list alone; pressed again, every place the filters
 * let through, as before.
 */
export function ListOnlyChip() {
  const entry = useAtlas(openListOf);
  const on = useLists((s) => s.onlyOnMap);
  const wide = useTouch((s) => s.arrangement === 'wide');
  if (!entry) return <PageOnlyChip />;
  if (placesOf(entry).size === 0) return null;
  const name = entry.checklist.name;
  return (
    <button
      type="button"
      className="touch-chip touch-chip-float touch-list-only-chip"
      aria-pressed={on}
      aria-label={`Only ${name} on the map`}
      title={`Only ${name} on the map`}
      data-testid="list-only-chip"
      onClick={() => {
        setOnlyOnMap(!on);
      }}
    >
      {on ? (
        <UiIcon name="check" size={18} strokeWidth={2.2} />
      ) : (
        <UiIcon name="checklist" size={18} />
      )}
      <span className="touch-chip-text">{wide ? 'Only this list' : `Only ${name}`}</span>
    </button>
  );
}

/**
 * Over the map while a guide page's locations are shown alone (from "Show
 * on the map" on the page): pressed, every location is shown again.
 */
function PageOnlyChip() {
  const title = useGuideOnMap((s) => s.title);
  const places = useGuideOnMap((s) => s.places);
  const applied = useAtlas((s) => places !== null && s.listOnly === places);
  if (!applied) return null;
  return (
    <button
      type="button"
      className="touch-chip touch-chip-float touch-list-only-chip"
      aria-pressed="true"
      aria-label={`Only ${title} on the map. Show every location`}
      title={`Only ${title} on the map. Press to show every location`}
      data-testid="page-only-chip"
      onClick={clearPageOnMap}
    >
      <UiIcon name="check" size={18} strokeWidth={2.2} />
      <span className="touch-chip-text">Only {title}</span>
      <UiIcon name="close" size={16} strokeWidth={2} />
    </button>
  );
}
