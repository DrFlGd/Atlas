import { isOrdered, outlineOf, rowId } from '@atlas/core';
import type { ChecklistItem, OwnHeading, OwnList } from '@atlas/schema';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { UiIcon } from '../../components/icons';
import { MarkdownBody } from '../../components/MarkdownBody';
import { numberFormat } from '../../state/derived';
import { guidesOf, hasGuidePages } from '../../state/guides';
import type { LoadedGame } from '../../state/store';
import {
  changeOpenStep,
  closePanel,
  deleteRow,
  duplicateRow,
  moveBy,
  onLinkPicked,
  openRow,
  renameOpenHeading,
  setPicking,
  useEditor,
} from './editorState';
import { locationDetail, useLocationHits } from './locations';

/**
 * The open step, in the panel on the right of the map: its name, its
 * location (changed with a tap on the map or by name), its note in
 * Markdown with a small toolbar, and for an ordered list whether it is
 * optional. Every change is kept at once (and saved a moment later).
 */
export function StepPanel({
  game,
  list,
  item,
}: {
  game: LoadedGame;
  list: OwnList;
  item: ChecklistItem;
}) {
  const rows = useMemo(() => outlineOf(list), [list]);
  const steps = rows.filter((row) => row.kind === 'step');
  const at = steps.findIndex((row) => rowId(row) === item.id);
  const atRow = rows.findIndex((row) => rowId(row) === item.id);
  const ordered = isOrdered(list.checklist.type ?? 'collection');
  const titleRef = useRef<HTMLHeadingElement>(null);
  const nameId = useId();
  const optionalId = useId();
  const optionalLineId = useId();

  const go = (by: -1 | 1) => {
    const next = steps[at + by];
    if (next) openRow(rowId(next));
  };

  return (
    <aside className="editor-side" aria-labelledby={`${nameId}-title`} data-testid="step-panel">
      <header className="editor-side-head">
        <h2 id={`${nameId}-title`} ref={titleRef} className="editor-side-title" tabIndex={-1}>
          Step {at + 1} of {steps.length}
        </h2>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Previous step"
          disabled={at <= 0}
          onClick={() => {
            go(-1);
          }}
        >
          <UiIcon name="chevronUp" size={22} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Next step"
          disabled={at >= steps.length - 1}
          onClick={() => {
            go(1);
          }}
        >
          <UiIcon name="chevronDown" size={22} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Close the step"
          data-testid="close-step"
          onClick={closePanel}
        >
          <UiIcon name="close" size={22} strokeWidth={1.8} />
        </button>
      </header>
      <div className="editor-side-body">
        <NameField
          id={nameId}
          rowId={item.id}
          label="Name"
          value={item.name}
          testId="step-name"
          onChange={(name) => {
            changeOpenStep(item.id, { name });
          }}
        />
        <LocationField game={game} item={item} />
        <NoteEditor game={game} item={item} />
        {ordered ? (
          <div className="editor-switch-row">
            <span className="editor-switch-text">
              <span id={optionalId} className="editor-switch-label">
                Optional step
              </span>
              <span id={optionalLineId} className="editor-switch-line">
                Next up moves on without it
              </span>
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={item.optional === true}
              aria-labelledby={optionalId}
              aria-describedby={optionalLineId}
              className="editor-switch"
              data-testid="optional-switch"
              onClick={() => {
                changeOpenStep(item.id, { optional: !item.optional });
              }}
            >
              <span className="editor-switch-knob" />
            </button>
          </div>
        ) : null}
      </div>
      <footer className="editor-side-foot">
        <button
          type="button"
          className="own-text-button editor-danger"
          data-testid="delete-step"
          onClick={() => {
            deleteRow(item.id);
            focusSideTitle();
          }}
        >
          Delete step
        </button>
        <span className="own-space" />
        <MoveButtons id={item.id} first={atRow <= 0} last={atRow >= rows.length - 1} />
        <button
          type="button"
          className="own-text-button"
          data-testid="duplicate-step"
          onClick={() => {
            duplicateRow(item.id);
            focusSideTitle();
          }}
        >
          Duplicate
        </button>
      </footer>
    </aside>
  );
}

/** A heading, open in the side panel: its title, how many steps it has, and Delete. */
export function HeadingPanel({ list, heading }: { list: OwnList; heading: OwnHeading }) {
  const rows = useMemo(() => outlineOf(list), [list]);
  const at = rows.findIndex((row) => rowId(row) === heading.id);
  let count = 0;
  for (let i = at + 1; i < rows.length && rows[i]!.kind === 'step'; i++) count++;
  const titleId = useId();
  const nameId = useId();
  return (
    <aside className="editor-side" aria-labelledby={titleId} data-testid="heading-panel">
      <header className="editor-side-head">
        <h2 id={titleId} className="editor-side-title" tabIndex={-1}>
          Heading
        </h2>
        <button
          type="button"
          className="touch-icon-button editor-side-icon"
          aria-label="Close the heading"
          onClick={closePanel}
        >
          <UiIcon name="close" size={22} strokeWidth={1.8} />
        </button>
      </header>
      <div className="editor-side-body">
        <NameField
          id={nameId}
          rowId={heading.id}
          label="Title"
          value={heading.title}
          testId="heading-title"
          onChange={(title) => {
            renameOpenHeading(heading.id, title);
          }}
        />
        <p className="editor-side-line">
          {count === 0
            ? 'No steps under it yet. Steps added while it is open go under it.'
            : `${count === 1 ? 'One step is' : `${numberFormat.format(count)} steps are`} under it, up to the next heading.`}
        </p>
      </div>
      <footer className="editor-side-foot">
        <button
          type="button"
          className="own-text-button editor-danger"
          data-testid="delete-heading"
          onClick={() => {
            deleteRow(heading.id);
            focusSideTitle();
          }}
        >
          Delete heading
        </button>
        <span className="own-space" />
        <MoveButtons id={heading.id} first={at <= 0} last={at >= rows.length - 1} />
      </footer>
    </aside>
  );
}

/** Puts the focus on the side panel's title once it shows the next row. */
function focusSideTitle(): void {
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>('.editor-side .editor-side-title')?.focus();
  });
}

function MoveButtons({ id, first, last }: { id: string; first: boolean; last: boolean }) {
  return (
    <span className="editor-move" role="group" aria-label="Move">
      <button
        type="button"
        className="touch-icon-button editor-side-icon"
        aria-label="Move up"
        data-testid="move-up"
        disabled={first}
        onClick={() => {
          moveBy(id, -1);
        }}
      >
        <UiIcon name="arrowUp" size={20} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className="touch-icon-button editor-side-icon"
        aria-label="Move down"
        data-testid="move-down"
        disabled={last}
        onClick={() => {
          moveBy(id, 1);
        }}
      >
        <UiIcon name="arrowDown" size={20} strokeWidth={1.8} />
      </button>
    </span>
  );
}

/**
 * A name kept as it is typed. While the field is empty the old name stays
 * in the list, and comes back when the field is left.
 */
function NameField({
  id,
  rowId,
  label,
  value,
  testId,
  onChange,
}: {
  id: string;
  /** The step or heading named. */
  rowId: string;
  label: string;
  value: string;
  testId: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const focusNameFor = useEditor((s) => s.focusNameFor);
  useEffect(() => {
    // A step or heading just added: its name is ready to be typed over.
    if (focusNameFor !== null && focusNameFor === rowId) {
      input.current?.focus();
      input.current?.select();
      useEditor.setState({ focusNameFor: null });
    }
  }, [focusNameFor, rowId]);
  return (
    <div className="own-field">
      <label htmlFor={id} className="own-label">
        {label}
      </label>
      <input
        ref={input}
        id={id}
        className="own-input"
        type="text"
        autoComplete="off"
        maxLength={200}
        value={draft ?? value}
        data-testid={testId}
        onChange={(event) => {
          setDraft(event.target.value);
          if (event.target.value.trim()) onChange(event.target.value);
        }}
        onBlur={() => {
          setDraft(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The location

function LocationField({ game, item }: { game: LoadedGame; item: ChecklistItem }) {
  const picking = useEditor((s) => s.picking);
  const choosing = picking?.purpose === 'location' && picking.stepId === item.id;
  const labelId = useId();
  const location = item.locationIds
    .map((id) => game.pack.locations.get(id))
    .find((l) => l !== undefined);
  const detail = location ? locationDetail(game, location.id) : null;
  const changeButton = useRef<HTMLButtonElement>(null);

  const choose = (locationId: string) => {
    const next = game.pack.locations.get(locationId);
    if (!next) return;
    // A step named after its location follows it to the new one.
    const named = item.name === 'New step' || item.name === location?.name;
    changeOpenStep(item.id, {
      locationIds: [locationId],
      ...(named ? { name: next.name } : {}),
    });
    setPicking(null);
    requestAnimationFrame(() => changeButton.current?.focus());
  };

  return (
    <div className="own-field" role="group" aria-labelledby={labelId}>
      <div id={labelId} className="own-label">
        Location
      </div>
      <div className="editor-location" data-testid="step-location">
        <UiIcon name="pin" size={20} strokeWidth={1.7} />
        <span className="editor-location-text">
          <span className="editor-location-name">{location ? location.name : 'No location'}</span>
          <span className="editor-location-detail">
            {location ? detail : 'A step of its own, ticked by hand'}
          </span>
        </span>
        {location ? (
          <button
            type="button"
            className="touch-icon-button editor-side-icon"
            aria-label="Remove the location"
            data-testid="remove-location"
            onClick={() => {
              changeOpenStep(item.id, { locationIds: [] });
              setPicking(null);
            }}
          >
            <UiIcon name="close" size={18} strokeWidth={1.8} />
          </button>
        ) : null}
        <button
          ref={changeButton}
          type="button"
          className="own-text-button editor-location-change"
          aria-expanded={choosing}
          data-testid="change-location"
          onClick={() => {
            setPicking(choosing ? null : { purpose: 'location', stepId: item.id });
          }}
        >
          {choosing ? 'Cancel' : location ? 'Change' : 'Choose'}
        </button>
      </div>
      {choosing ? (
        <LocationFinder
          game={game}
          label="Find a location by name"
          hint="Or tap one on the map."
          onChoose={choose}
          onCancel={() => {
            setPicking(null);
            changeButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

/** A field to find a location by name, with what matches under it. */
function LocationFinder({
  game,
  label,
  hint,
  onChoose,
  onCancel,
}: {
  game: LoadedGame;
  label: string;
  hint: string;
  onChoose: (locationId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const hits = useLocationHits(game, query);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <div className="editor-finder">
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <input
        ref={input}
        id={inputId}
        className="own-input"
        type="search"
        autoComplete="off"
        placeholder={label}
        value={query}
        data-testid="location-finder"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && hits[0]) {
            event.preventDefault();
            onChoose(hits[0].id);
          }
        }}
      />
      <p className="editor-side-line">{hint}</p>
      {hits.length > 0 ? (
        <ul className="touch-plain-list editor-finder-hits">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="editor-finder-hit"
                data-testid="location-hit"
                onClick={() => {
                  onChoose(hit.id);
                }}
              >
                <span className="editor-location-name">{hit.title}</span>
                <span className="editor-location-detail">{locationDetail(game, hit.id)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <p className="editor-side-line">No location is called that.</p>
      ) : null}
    </div>
  );
}

/** "Link a guide": the pages of the Guides section by title and text, to link one in a note. */
function GuideFinder({
  game,
  onChoose,
  onCancel,
}: {
  game: LoadedGame;
  onChoose: (guideId: string) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    input.current?.focus();
  }, []);
  const hits = useMemo(() => {
    const text = query.trim();
    return text ? guidesOf(game).search.search(text, 8) : [];
  }, [game, query]);
  return (
    <div className="editor-finder" data-testid="guide-finder">
      <label htmlFor={inputId} className="visually-hidden">
        Find a guide page to link
      </label>
      <input
        ref={input}
        id={inputId}
        className="own-input"
        type="search"
        autoComplete="off"
        placeholder="Find a guide page to link"
        value={query}
        data-testid="guide-finder-input"
        onChange={(event) => {
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === 'Enter' && hits[0]) {
            event.preventDefault();
            onChoose(hits[0].guide.id);
          }
        }}
      />
      <p className="editor-side-line">A guide page opens in Guides when the list is used.</p>
      {hits.length > 0 ? (
        <ul className="touch-plain-list editor-finder-hits">
          {hits.map((hit) => (
            <li key={hit.guide.id}>
              <button
                type="button"
                className="editor-finder-hit"
                data-testid="guide-hit"
                onClick={() => {
                  onChoose(hit.guide.id);
                }}
              >
                <span className="editor-location-name">{hit.guide.title}</span>
                <span className="editor-location-detail">
                  {guidesOf(game)
                    .contents.pathTo(hit.guide.id)
                    .map((section) => section.title)
                    .join(' › ') || 'Guides'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <p className="editor-side-line">No guide page has that.</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The note

/** Markdown link text: brackets and backslashes escaped. */
function linkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

/**
 * The note, in Markdown: a toolbar for bold, a bulleted list, a link to a
 * location or to a guide page, and hidden text (`||like this||`), the text
 * itself, and the note as it will be shown.
 */
function NoteEditor({ game, item }: { game: LoadedGame; item: ChecklistItem }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const picking = useEditor((s) => s.picking);
  const linking = picking?.purpose === 'link' && picking.stepId === item.id;
  const noteId = useId();
  const helpId = useId();
  const note = item.note ?? '';
  // Where the cursor was when "Link a location" (or "Link a guide") was pressed.
  const selection = useRef<[number, number]>([note.length, note.length]);
  // "Link a guide": finding a page of the Guides section to link.
  const [guideLinking, setGuideLinking] = useState(false);
  const pages = hasGuidePages(game);

  const setNote = (next: string, select?: [number, number]) => {
    changeOpenStep(item.id, { note: next });
    if (select) {
      requestAnimationFrame(() => {
        const element = area.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(select[0], select[1]);
      });
    }
  };

  /** Puts marks around the selected text, or around a word to type. */
  const wrap = (mark: string, placeholder: string) => {
    const element = area.current;
    const [start, end] = element
      ? [element.selectionStart, element.selectionEnd]
      : [note.length, note.length];
    const chosen = note.slice(start, end) || placeholder;
    const next = note.slice(0, start) + mark + chosen + mark + note.slice(end);
    setNote(next, [start + mark.length, start + mark.length + chosen.length]);
  };

  const bullets = () => {
    const element = area.current;
    const [start, end] = element
      ? [element.selectionStart, element.selectionEnd]
      : [note.length, note.length];
    const lineStart = note.lastIndexOf('\n', start - 1) + 1;
    const lineEndAt = note.indexOf('\n', end);
    const lineEnd = lineEndAt < 0 ? note.length : lineEndAt;
    const lines = note.slice(lineStart, lineEnd).split('\n');
    const all = lines.every((line) => line.startsWith('- '));
    const changed = lines.map((line) => (all ? line.slice(2) : `- ${line}`)).join('\n');
    const next = note.slice(0, lineStart) + changed + note.slice(lineEnd);
    setNote(next, [lineStart, lineStart + changed.length]);
  };

  const insertLink = (locationId: string) => {
    const location = game.pack.locations.get(locationId);
    if (!location) return;
    const [start, end] = selection.current;
    const text = note.slice(start, end) || location.name;
    const link = `[${linkText(text)}](${location.id})`;
    const next = note.slice(0, start) + link + note.slice(end);
    onLinkPicked(null);
    setPicking(null);
    setNote(next, [start + link.length, start + link.length]);
  };

  const insertGuideLink = (guideId: string) => {
    const guide = guidesOf(game).contents.guide(guideId);
    if (!guide) return;
    const [start, end] = selection.current;
    const text = note.slice(start, end) || guide.title;
    const link = `[${linkText(text)}](${guide.id})`;
    const next = note.slice(0, start) + link + note.slice(end);
    setGuideLinking(false);
    setNote(next, [start + link.length, start + link.length]);
  };

  // The map's tap, while linking, comes here.
  const insertRef = useRef(insertLink);
  useEffect(() => {
    insertRef.current = insertLink;
  });
  useEffect(() => {
    if (!linking) return;
    onLinkPicked((id) => {
      insertRef.current(id);
    });
    return () => {
      onLinkPicked(null);
    };
  }, [linking]);

  return (
    <div className="own-field">
      <label htmlFor={noteId} className="own-label">
        Note
      </label>
      <div className="editor-note">
        <div className="editor-toolbar" role="toolbar" aria-label="Note" aria-controls={noteId}>
          <button
            type="button"
            className="editor-tool"
            aria-label="Bold"
            title="Bold"
            data-testid="note-bold"
            onClick={() => {
              wrap('**', 'bold text');
            }}
          >
            <span className="editor-tool-bold" aria-hidden="true">
              B
            </span>
          </button>
          <button
            type="button"
            className="editor-tool"
            aria-label="Bulleted list"
            title="Bulleted list"
            data-testid="note-bullets"
            onClick={bullets}
          >
            <UiIcon name="bullets" size={18} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="editor-tool editor-tool-wide"
            aria-pressed={linking}
            data-testid="note-link"
            onClick={() => {
              if (linking) {
                setPicking(null);
                return;
              }
              const element = area.current;
              selection.current = element
                ? [element.selectionStart, element.selectionEnd]
                : [note.length, note.length];
              setGuideLinking(false);
              setPicking({ purpose: 'link', stepId: item.id });
            }}
          >
            <UiIcon name="pin" size={16} strokeWidth={1.8} />
            Link a location
          </button>
          {pages ? (
            <button
              type="button"
              className="editor-tool editor-tool-wide"
              aria-pressed={guideLinking}
              data-testid="note-link-guide"
              onClick={() => {
                if (guideLinking) {
                  setGuideLinking(false);
                  return;
                }
                const element = area.current;
                selection.current = element
                  ? [element.selectionStart, element.selectionEnd]
                  : [note.length, note.length];
                if (linking) setPicking(null);
                setGuideLinking(true);
              }}
            >
              <UiIcon name="book" size={16} strokeWidth={1.8} />
              Link a guide
            </button>
          ) : null}
          <button
            type="button"
            className="editor-tool editor-tool-wide"
            data-testid="note-hide"
            onClick={() => {
              wrap('||', 'hidden text');
            }}
          >
            <UiIcon name="eyeOff" size={16} strokeWidth={1.8} />
            Hide
          </button>
        </div>
        {linking ? (
          <LocationFinder
            game={game}
            label="Find a location to link"
            hint="Or tap one on the map."
            onChoose={insertLink}
            onCancel={() => {
              setPicking(null);
              area.current?.focus();
            }}
          />
        ) : null}
        {guideLinking && !linking ? (
          <GuideFinder
            game={game}
            onChoose={insertGuideLink}
            onCancel={() => {
              setGuideLinking(false);
              area.current?.focus();
            }}
          />
        ) : null}
        <textarea
          ref={area}
          id={noteId}
          className="editor-note-text"
          rows={5}
          value={note}
          aria-describedby={helpId}
          data-testid="step-note"
          onChange={(event) => {
            changeOpenStep(item.id, { note: event.target.value });
          }}
        />
        <p id={helpId} className="visually-hidden">
          Markdown: two stars around words make them bold, a dash starts a bullet, and two bars on
          each side hide words until the reader asks for them.
        </p>
      </div>
      {note.trim() ? (
        <div className="editor-note-shown">
          <div className="editor-note-shown-label">As it will be shown</div>
          <MarkdownBody source={note} className="guide-body editor-note-body" />
        </div>
      ) : null}
    </div>
  );
}
