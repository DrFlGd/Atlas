import {
  fieldInWords,
  parseSiteRules,
  problemText,
  type SiteRules,
  type SiteRulesProblem,
} from '@atlas/importer-api';
import { create } from 'zustand';
import { lineAndColumnOf, scanJson, spotOfField, type JsonSpot } from './jsonText';
import { importerNotesOf, rulesTextOf, type SiteEntry } from './siteRules';

/**
 * The rules file editor, opened from Settings, "Sites": a site rules file
 * as JSON on one side, checked as the person types, and on the other what
 * the reader makes of an example page with the file as it stands (see
 * `library/RulesEditor.tsx`). It is opened on a file of the person's
 * ("Edit…"), on a copy of a shipped file ("Edit a copy…", which never
 * changes the shipped file) or on a new file from a template ("New rules
 * file…"). Saving keeps the file in the Sites folder as "Add a rules file…"
 * does (`saveRulesText` in `siteRules.ts`).
 *
 * The example pages the person picks are kept in memory, for the time the
 * editor is open on that file only: nothing of them is written anywhere or
 * sent anywhere, and a page is only ever handed to the reader as text.
 */

/** What the editor is opened on. */
export type RulesEditorStart =
  | { kind: 'new' }
  /** A file of the person's, by its name in the Sites folder. */
  | { kind: 'own'; name: string; title: string; text: string }
  /** A copy of a shipped file: its name, and the title of the importer it comes with. */
  | { kind: 'copy'; name: string; title: string; importer: string; text: string };

export const useRulesEditor = create<{
  start: RulesEditorStart | null;
  /** Counts each opening, so that the editor starts afresh on each. */
  opened: number;
  /** Why a file could not be opened. */
  error: string | null;
}>(() => ({ start: null, opened: 0, error: null }));

const open = (start: RulesEditorStart) => {
  useRulesEditor.setState((s) => ({ start, opened: s.opened + 1, error: null }));
};

/** "New rules file…": the editor, starting with the choice of a template. */
export function newRulesFile(): void {
  open({ kind: 'new' });
}

/** "Edit…" on a file of the person's, and "Edit a copy…" on a shipped file. */
export async function editRulesFile(
  entry: Pick<SiteEntry, 'key' | 'name' | 'title' | 'own' | 'importer'>,
): Promise<void> {
  let text: string | null;
  try {
    text = await rulesTextOf(entry.key);
  } catch (error) {
    text = null;
    useRulesEditor.setState({ error: error instanceof Error ? error.message : String(error) });
  }
  if (text === null) {
    useRulesEditor.setState((s) => ({
      error: s.error ?? `${entry.name} could not be read, so it cannot be edited.`,
    }));
    return;
  }
  open(
    entry.own
      ? { kind: 'own', name: entry.name, title: entry.title, text }
      : {
          kind: 'copy',
          name: entry.name,
          title: entry.title,
          importer: entry.importer ?? 'an importer',
          text,
        },
  );
}

export function closeRulesEditor(): void {
  useRulesEditor.setState({ start: null });
}

// ---------------------------------------------------------------------------
// Checking the text

/** One problem of the text, at its place in it. */
export interface EditorProblem {
  /** Its field, as `checkSiteRules` names fields; null for a text that is not JSON. */
  field: string | null;
  /** The problem as one sentence for the person. */
  words: string;
  /** Where the cursor goes for it: its field's name, or where the text stops being JSON. */
  at: number;
  /** The end of what is selected for it (its field's value); `at` for no selection. */
  end: number;
  /** The line it is on, from 1. */
  line: number;
}

/** The text as last checked. */
export interface EditorCheck {
  text: string;
  /** The file, when its form is right. */
  rules: SiteRules | null;
  /** What is wrong with it: its form, or where it stops being JSON. */
  problems: EditorProblem[];
  /** What the importers say of a file whose form is right (a part no importer reads, and so on). */
  notes: EditorProblem[];
}

/** A problem placed at its field in the text. */
function placed(text: string, spots: ReadonlyMap<string, JsonSpot>, problem: SiteRulesProblem) {
  const spot: JsonSpot | null = spotOfField(spots, problem.field);
  const at = spot?.start ?? 0;
  // A field that is there is selected whole; for a missing one, the cursor goes into its object.
  const exact = spots.has(problem.field);
  const end = exact ? (spot?.valueEnd ?? at) : at;
  return {
    field: problem.field,
    words: problemText(problem),
    at,
    end,
    line: lineAndColumnOf(text, at).line,
  };
}

/**
 * Checks the text of a file as the Sites screen checks one it adds
 * (`parseSiteRules`), with each problem at its field; and, for a file whose
 * form is right, what the importers say of it.
 */
export function checkEditorText(
  text: string,
  notesOf: (rules: SiteRules) => SiteRulesProblem[] = importerNotesOf,
): EditorCheck {
  const scan = scanJson(text);
  if (!scan.ok) {
    const { line, column } = lineAndColumnOf(text, scan.at);
    return {
      text,
      rules: null,
      problems: [
        {
          field: null,
          words: `The text is not plain JSON: at line ${line}, column ${column}, ${scan.message}.`,
          at: scan.at,
          end: scan.at,
          line,
        },
      ],
      notes: [],
    };
  }
  const checked = parseSiteRules(text);
  if (!checked.ok) {
    return {
      text,
      rules: null,
      problems: checked.problems.map((problem) => placed(text, scan.spots, problem)),
      notes: [],
    };
  }
  const notes = [
    ...new Map(
      notesOf(checked.rules).map((note) => {
        const one = placed(text, scan.spots, note);
        return [one.words, one] as const;
      }),
    ).values(),
  ];
  return { text, rules: checked.rules, problems: [], notes };
}

/** Where a field stands in a text, to move the cursor to it: null when the text is not JSON. */
export function fieldSpot(text: string, field: string): { at: number; end: number } | null {
  const scan = scanJson(text);
  if (!scan.ok) return null;
  const spot = spotOfField(scan.spots, field);
  if (!spot) return null;
  return { at: spot.start, end: scan.spots.has(field) ? spot.valueEnd : spot.start };
}

/** A field in words for the person, as the problems name fields. */
export const fieldWords = (field: string): string => fieldInWords(field);

// ---------------------------------------------------------------------------
// Example pages

/** A saved page or data file the person picked to try the file on, kept in memory only. */
export interface ExamplePage {
  id: number;
  /** Its file name. */
  name: string;
  /** A map's saved data file (`.json`) rather than a page. */
  data: boolean;
  text: string;
  /** The address a page was saved from: its canonical link, or the one the person gave. */
  address: string | null;
}
