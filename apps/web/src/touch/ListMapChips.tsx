import { UiIcon } from '../components/icons';
import { useAtlas } from '../state/store';
import { openListOf, placesOf, setOnlyOnMap, useLists } from './listViews';
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
  if (!entry || placesOf(entry).size === 0) return null;
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
