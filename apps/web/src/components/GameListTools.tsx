import { useEffect, useId, useRef, useState } from 'react';
import { numberFormat } from '../state/derived';
import { useTitleOf } from '../state/gameGroups';
import {
  addTagGroup,
  loadGameTags,
  MAX_TAG_LENGTH,
  removeTagGroup,
  renameTagGroup,
  sameTags,
  setGamesGrouping,
  setGamesView,
  setHeadingFolded,
  setTags,
  tagFold,
  tidyTag,
  uniqueTags,
  useGameTags,
  useTagsOfGame,
  withoutTagName,
  type GamesView,
  type TaggedRow,
  type TagGroup,
  type TagsByGroup,
  type TagSection,
} from '../state/gameTags';
import { UiIcon } from './icons';

/**
 * What Games and the Library show above and in the list of games: finding
 * a game by its name or a tag, the view (cards or compact rows), grouping
 * under the tags of one group with headings that fold, a game's tags as
 * chips, and choosing a game's tags (see `state/gameTags.ts`, and
 * `state/gamesList.ts` for the rows).
 */

/** "Find a game", the view and the grouping, above the list. */
export function GamesListBar({
  filter,
  onFilter,
  view,
  groupBy,
  tagGroups,
  total,
  shown,
}: {
  filter: string;
  onFilter: (text: string) => void;
  view: GamesView;
  groupBy: TagGroup | null;
  tagGroups: readonly TagGroup[];
  total: number;
  shown: number;
}) {
  const groupId = useId();
  return (
    <div className="games-tools" data-testid="games-tools">
      <div className="games-find">
        <UiIcon name="search" size={16} />
        <input
          type="search"
          className="games-find-input"
          aria-label="Find a game by its name or a tag"
          placeholder="Find a game by its name or a tag"
          autoComplete="off"
          spellCheck={false}
          value={filter}
          data-testid="games-filter"
          onChange={(event) => {
            onFilter(event.target.value);
          }}
        />
      </div>
      <div className="games-choices">
        <div className="games-segmented" role="group" aria-label="View">
          {(['cards', 'compact'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="games-segment"
              aria-pressed={view === value}
              data-testid={`games-view-${value}`}
              title={
                value === 'cards'
                  ? 'Each game as a card with its state'
                  : 'One short row for each game, to see many at once'
              }
              onClick={() => {
                setGamesView(value);
              }}
            >
              <UiIcon name={value === 'cards' ? 'grid' : 'bullets'} size={15} />
              {value === 'cards' ? 'Cards' : 'Compact'}
            </button>
          ))}
        </div>
        <span className="games-choice">
          <label className="games-choice-label" htmlFor={groupId}>
            Group by
          </label>
          <select
            id={groupId}
            className="games-select"
            value={groupBy?.id ?? 'none'}
            data-testid="games-group-by"
            onChange={(event) => {
              setGamesGrouping(event.target.value);
            }}
          >
            <option value="none">None</option>
            {tagGroups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </span>
      </div>
      {filter.trim() !== '' ? (
        <p className="games-found muted small" role="status" data-testid="games-found">
          {shown === 0
            ? `No game has a name or a tag with “${filter.trim()}”.`
            : `${numberFormat.format(shown)} of ${numberFormat.format(total)} ${total === 1 ? 'game' : 'games'}.`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The games, under a heading for each tag of the group they are grouped
 * by: each heading folds and opens, and says how many games are under it.
 * `list` draws the rows of one heading (or of all, ungrouped) as a list.
 */
export function GamesSections({
  sections,
  groupBy,
  shown,
  folded,
  finding,
  list,
}: {
  sections: TagSection<TaggedRow>[] | null;
  groupBy: TagGroup | null;
  shown: TaggedRow[];
  folded: readonly string[];
  finding: boolean;
  list: (items: TaggedRow[], label: string) => React.ReactNode;
}) {
  if (!sections || !groupBy) return <>{list(shown, 'Games')}</>;
  return (
    <>
      {sections.map((section) => {
        const key = `${groupBy.id}:${section.key}`;
        return (
          <TagSectionView
            key={key}
            foldKey={key}
            name={section.name ?? withoutTagName(groupBy)}
            rows={section.rows}
            open={finding || !folded.includes(key)}
            foldable={!finding}
            list={list}
          />
        );
      })}
    </>
  );
}

function TagSectionView({
  foldKey,
  name,
  rows,
  open,
  foldable,
  list,
}: {
  foldKey: string;
  name: string;
  rows: TaggedRow[];
  open: boolean;
  foldable: boolean;
  list: (items: TaggedRow[], label: string) => React.ReactNode;
}) {
  const count = rows.length;
  const counted = `${numberFormat.format(count)} ${count === 1 ? 'game' : 'games'}`;
  const listId = useId();
  const inside = (
    <>
      <span className="games-heading-name">{name}</span>
      <span className="games-heading-count" data-testid="games-heading-count">
        {numberFormat.format(count)}
      </span>
    </>
  );
  return (
    <section
      className="games-section"
      aria-label={name}
      data-testid="games-section"
      data-heading={foldKey}
      data-open={open}
    >
      <h3 className="games-heading">
        {foldable ? (
          <button
            type="button"
            className="games-heading-button"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-label={`${name}, ${counted}`}
            data-testid="games-heading"
            onClick={() => {
              setHeadingFolded(foldKey, open);
            }}
          >
            <UiIcon name={open ? 'chevronDown' : 'chevron'} size={16} strokeWidth={1.9} />
            {inside}
          </button>
        ) : (
          <span className="games-heading-button games-heading-still" data-testid="games-heading">
            {inside}
          </span>
        )}
      </h3>
      {open ? <div id={listId}>{list(rows, name)}</div> : null}
    </section>
  );
}

/**
 * A game's tags as small chips, those of the person's groups (Source and
 * Contents are said in the row's own words): all of them, or the first
 * `limit` and how many more. The tags of the group the games are grouped
 * by are left out: the heading says them.
 */
export function TagChips({
  tags,
  tagGroups,
  skip,
  limit,
  className,
}: {
  tags: TagsByGroup;
  tagGroups: readonly TagGroup[];
  skip: string | null;
  limit?: number;
  className: string;
}) {
  const chips = tagGroups.flatMap((group) =>
    group.auto || group.id === skip
      ? []
      : (tags[group.id] ?? []).map((tag) => ({ group: group.name, tag })),
  );
  if (chips.length === 0) return null;
  const shown = limit === undefined ? chips : chips.slice(0, limit);
  const more = chips.length - shown.length;
  return (
    <span className={className} data-testid="game-tags">
      {shown.map((chip) => (
        <span
          key={`${chip.group}:${chip.tag}`}
          className="game-tag"
          title={`${chip.group}: ${chip.tag}`}
          data-testid="game-tag"
        >
          {chip.tag}
        </span>
      ))}
      {more > 0 ? (
        <span
          className="game-tag game-tag-more"
          title={chips
            .slice(shown.length)
            .map((chip) => `${chip.group}: ${chip.tag}`)
            .join(', ')}
        >
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/**
 * "Tags…": a small dialog with each group of tags, its tags as ticks, a
 * field to add a tag to it, and "Add a group…". The tags of a game shown
 * under a title are the title's. Save keeps the groups whose ticks were
 * changed; a group's own tags are added, renamed and removed at once.
 */
export function TagsDialog(props: { gameId: string; title: string; onClose: () => void }) {
  const ready = useGameTags((s) => s.ready);
  useEffect(() => {
    void loadGameTags();
  }, []);
  return ready ? <TagsDialogBody {...props} /> : null;
}

function TagsDialogBody({
  gameId,
  title,
  onClose,
}: {
  gameId: string;
  title: string;
  onClose: () => void;
}) {
  const { tags, key, tagGroups, known } = useTagsOfGame(gameId);
  const group = useTitleOf(gameId);
  const named = group ? group.title : title;
  const [ticked, setTicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(Object.entries(tags).map(([g, list]) => [g, [...list]])),
  );
  // Tags added here, not yet on any game: shown with the others of their group.
  const [added, setAdded] = useState<Record<string, string[]>>({});
  const [addingGroup, setAddingGroup] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const save = () => {
    const changes = Object.fromEntries(
      tagGroups.flatMap((g) => {
        const now = ticked[g.id] ?? [];
        return sameTags(now, tags[g.id] ?? []) ? [] : [[g.id, now]];
      }),
    );
    void setTags(key, changes, named, known).then(onClose);
  };
  return (
    <dialog
      ref={ref}
      className="dialog tags-dialog"
      aria-labelledby={headingId}
      data-testid="tags-dialog"
      onClose={onClose}
    >
      <form
        className="dialog-body tags-dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <header className="dialog-head">
          <h2 id={headingId} className="wrap-anywhere">
            Tags of {named}
          </h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <UiIcon name="close" />
          </button>
        </header>
        <p className="tags-note">
          {group ? 'These are the tags of the title, for each of its sources. ' : ''}
          Tick the tags of this game, or add new ones. Group by lists your games under the tags of
          one group. Source and Contents are filled in by the app from what each game is.
        </p>
        {tagGroups.map((tagGroup) => (
          <TagGroupChoices
            key={tagGroup.id}
            group={tagGroup}
            options={uniqueTags([
              ...(known[tagGroup.id] ?? []),
              ...(added[tagGroup.id] ?? []),
              ...(ticked[tagGroup.id] ?? []),
            ])}
            ticked={ticked[tagGroup.id] ?? []}
            onTicked={(list) => {
              setTicked({ ...ticked, [tagGroup.id]: list });
            }}
            onAdd={(tag) => {
              const spelled =
                [...(known[tagGroup.id] ?? []), ...(added[tagGroup.id] ?? [])].find(
                  (other) => tagFold(other) === tagFold(tag),
                ) ?? tag;
              setAdded({ ...added, [tagGroup.id]: [...(added[tagGroup.id] ?? []), spelled] });
              const now = ticked[tagGroup.id] ?? [];
              if (!now.some((t) => tagFold(t) === tagFold(spelled))) {
                setTicked({ ...ticked, [tagGroup.id]: [...now, spelled] });
              }
            }}
          />
        ))}
        {addingGroup ? (
          <GroupNameForm
            label="Name of the new group"
            initial=""
            saveLabel="Add the group"
            onSave={async (name) => {
              const made = await addTagGroup(name);
              if (typeof made === 'string') return made;
              setAddingGroup(false);
              return null;
            }}
            onCancel={() => {
              setAddingGroup(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="button tags-add-group"
            data-testid="tags-add-group"
            onClick={() => {
              setAddingGroup(true);
            }}
          >
            <UiIcon name="plus" size={15} />
            Add a group…
          </button>
        )}
        <div className="tags-actions">
          <button type="submit" className="button button-primary" data-testid="tags-save">
            Save
          </button>
          <button type="button" className="button" data-testid="tags-cancel" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** One group of tags in the dialog: its tags as ticks, a field to add one, and for an own group Rename and Remove. */
function TagGroupChoices({
  group,
  options,
  ticked,
  onTicked,
  onAdd,
}: {
  group: TagGroup;
  options: readonly string[];
  ticked: readonly string[];
  onTicked: (list: string[]) => void;
  onAdd: (tag: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const [mode, setMode] = useState<'rename' | 'remove' | null>(null);
  const isTicked = (tag: string) => ticked.some((t) => tagFold(t) === tagFold(tag));
  const add = () => {
    const tag = tidyTag(typed);
    if (!tag) return;
    onAdd(tag);
    setTyped('');
  };
  return (
    <fieldset className="tags-group" data-testid="tags-group" data-group={group.id}>
      <legend className="tags-group-name">{group.name}</legend>
      {group.own && mode === null ? (
        <span className="tags-group-tools">
          <button
            type="button"
            className="link-button"
            data-testid="tags-group-rename"
            onClick={() => {
              setMode('rename');
            }}
          >
            Rename…
          </button>
          <button
            type="button"
            className="link-button tags-danger"
            data-testid="tags-group-remove"
            onClick={() => {
              setMode('remove');
            }}
          >
            Remove…
          </button>
        </span>
      ) : null}
      {mode === 'rename' ? (
        <GroupNameForm
          label={`New name of the group ${group.name}`}
          initial={group.name}
          saveLabel="Rename"
          onSave={async (name) => {
            const problem = await renameTagGroup(group.id, name);
            if (!problem) setMode(null);
            return problem;
          }}
          onCancel={() => {
            setMode(null);
          }}
        />
      ) : null}
      {mode === 'remove' ? (
        <div className="tags-confirm" role="group" aria-label={`Remove the group ${group.name}?`}>
          <p>
            Remove the group {group.name}? Its tags are taken off every game. Your games stay as
            they are.
          </p>
          <span className="tags-confirm-actions">
            <button
              type="button"
              className="button button-danger"
              data-testid="tags-group-remove-confirm"
              onClick={() => void removeTagGroup(group.id)}
            >
              Remove the group
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setMode(null);
              }}
            >
              Keep it
            </button>
          </span>
        </div>
      ) : null}
      {options.length > 0 ? (
        <span className="tags-options">
          {options.map((tag) => (
            <label key={tag} className="tags-option">
              <input
                type="checkbox"
                checked={isTicked(tag)}
                data-testid="tags-option"
                onChange={(event) => {
                  onTicked(
                    event.target.checked
                      ? [...ticked, tag]
                      : ticked.filter((t) => tagFold(t) !== tagFold(tag)),
                  );
                }}
              />
              <span className="wrap-anywhere">{tag}</span>
            </label>
          ))}
        </span>
      ) : (
        <p className="tags-empty">No tag in this group yet.</p>
      )}
      <span className="tags-new">
        <input
          type="text"
          className="tags-input"
          aria-label={`New tag in ${group.name}`}
          placeholder="New tag"
          maxLength={MAX_TAG_LENGTH}
          value={typed}
          data-testid="tags-new"
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter adds the tag; it does not save the dialog.
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="button"
          data-testid="tags-new-add"
          disabled={tidyTag(typed) === null}
          onClick={add}
        >
          Add
        </button>
      </span>
    </fieldset>
  );
}

/** The name of a group, typed: for a new group, or to rename one. */
function GroupNameForm({
  label,
  initial,
  saveLabel,
  onSave,
  onCancel,
}: {
  label: string;
  initial: string;
  saveLabel: string;
  /** Returns why the name cannot be used, or null. */
  onSave: (name: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const save = () => {
    void onSave(name).then(setProblem);
  };
  return (
    <span className="tags-new tags-group-form">
      <input
        ref={input}
        type="text"
        className="tags-input"
        aria-label={label}
        placeholder="Name of the group"
        maxLength={MAX_TAG_LENGTH}
        value={name}
        data-testid="tags-group-name"
        onChange={(event) => {
          setName(event.target.value);
          setProblem(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            save();
          }
        }}
      />
      <button type="button" className="button" data-testid="tags-group-save" onClick={save}>
        {saveLabel}
      </button>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
      {problem ? (
        <span className="tags-problem" role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}
