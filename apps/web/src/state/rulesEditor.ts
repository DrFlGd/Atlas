import {
  REFUSAL_SUFFIX,
  SITE_RULES_SUFFIX,
  checkSiteRules,
  fieldInWords,
  parseSiteRules,
  problemText,
  type SiteRules,
  type SiteRulesProblem,
} from '@atlas/importer-api';
import { create } from 'zustand';
import { lineAndColumnOf, scanJson, spotOfField, type JsonSpot } from './jsonText';
import { copyForSite, type NewSite } from './rulesCopy';
import {
  canonicalAddressOf,
  closeTrial,
  importerNotesOf,
  partTypeOfReader,
  rulesTextOf,
  trialPageNow,
  type SiteEntry,
} from './siteRules';

/**
 * The rules file editor, opened from Settings, "Sites": a site rules file
 * as JSON on one side, checked as the person types, and on the other what
 * the reader makes of an example page with the file as it stands (see
 * `library/RulesEditor.tsx`). It is opened on a file of the person's
 * ("Edit…"), on a copy of a shipped file ("Edit a copy…", which never
 * changes the shipped file) or on a new file from a template or from a copy
 * of any file listed, made for another site ("New rules file…", and "Start
 * again from another template…" in the editor). Saving keeps the file in
 * the Sites folder as "Add a rules file…" does (`saveRulesText` in
 * `siteRules.ts`).
 *
 * The example pages the person picks are kept in memory, for the time the
 * editor is open on that file only: nothing of them is written anywhere or
 * sent anywhere, and a page is only ever handed to the reader as text.
 */

/** A saved page the editor opens with, as an example page (from "Try on a saved page…"). */
export interface StartPage {
  name: string;
  /** The page's HTML, or the text of a map's saved data file. */
  text: string;
  data: boolean;
  address: string | null;
}

/**
 * How the file is shown: its settings as ordinary controls (`form`, from
 * "Settings…"), or its text as JSON (`json`, from "Edit…").
 */
export type RulesEditorView = 'form' | 'json';

/** What the editor is opened on. */
export type RulesEditorStart =
  | { kind: 'new' }
  /** A file of the person's, by its name in the Sites folder. */
  | {
      kind: 'own';
      name: string;
      title: string;
      text: string;
      page?: StartPage;
      view?: RulesEditorView;
    }
  /** A copy of a shipped file: its name, and the title of the importer it comes with. */
  | {
      kind: 'copy';
      name: string;
      title: string;
      importer: string;
      text: string;
      page?: StartPage;
      view?: RulesEditorView;
    };

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

/**
 * "Edit…" on a file of the person's, and "Edit a copy…" on a shipped file,
 * with an example page to start with; "Settings…" opens either on its
 * settings (`view` `form`), on a copy for a shipped file as "Edit a copy…".
 */
export async function editRulesFile(
  entry: Pick<SiteEntry, 'key' | 'name' | 'title' | 'own' | 'importer'>,
  page?: StartPage,
  view: RulesEditorView = 'json',
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
  const withPage = page ? { page } : {};
  open(
    entry.own
      ? { kind: 'own', name: entry.name, title: entry.title, text, view, ...withPage }
      : {
          kind: 'copy',
          name: entry.name,
          title: entry.title,
          importer: entry.importer ?? 'an importer',
          text,
          view,
          ...withPage,
        },
  );
}

/**
 * "Open in the editor" on the card of "Try on a saved page…": the editor on
 * the file (a copy, for a shipped file), with the page tried as its first
 * example page, and the card closed.
 */
export async function openTrialInEditor(
  entry: Pick<SiteEntry, 'key' | 'name' | 'title' | 'own' | 'importer'>,
): Promise<void> {
  const tried = trialPageNow(entry.key);
  const page: StartPage | undefined = tried
    ? {
        name: tried.name,
        text: tried.data ?? tried.html,
        data: tried.data !== undefined,
        address:
          tried.data !== undefined ? null : (tried.address ?? canonicalAddressOf(tried.html)),
      }
    : undefined;
  await editRulesFile(entry, page);
  if (useRulesEditor.getState().start) closeTrial();
}

// ---------------------------------------------------------------------------
// Starting from a copy of another file

/** The files a new file can start from a copy of: every file listed whose form is right. */
export const copySources = (entries: readonly SiteEntry[]): SiteEntry[] =>
  entries.filter((entry) => entry.readable && entry.editable && entry.reads !== '');

/** The name a copy of `entry` with the id `id` is saved under. */
export const copyNameOf = (entry: Pick<SiteEntry, 'refusal'>, id: string): string =>
  `${id}${entry.refusal !== null ? REFUSAL_SUFFIX : SITE_RULES_SUFFIX}`;

/**
 * What the person is told of the id of a copy before it is made, in a
 * sentence: when a file listed already has the name the copy would be saved
 * under. Null when none has.
 */
export function copyIdNote(
  entry: Pick<SiteEntry, 'refusal'>,
  id: string,
  entries: readonly SiteEntry[],
): string | null {
  const name = copyNameOf(entry, id);
  const there = entries.filter((other) => other.name === name);
  const shipped = there.find((other) => !other.own);
  if (shipped) {
    return `The file ${name} comes with ${shipped.importer ?? 'an importer'}: a copy saved with this id takes its place while your copy is switched on. To keep both, give another id.`;
  }
  if (there.length > 0) {
    return `A file of yours is named ${name}: saving the copy puts it in that file’s place. To keep both, give another id.`;
  }
  return null;
}

/**
 * The text of a new file copied from `entry` for another site (see
 * `copyForSite`), laid out with two spaces; or why it cannot be made, in
 * sentences: what the copy lacks for the new site among them.
 */
export async function copyTextFor(
  entry: Pick<SiteEntry, 'key' | 'name'>,
  site: NewSite,
): Promise<{ text: string } | { problems: string[] }> {
  const text = await rulesTextOf(entry.key).catch(() => null);
  if (text === null)
    return { problems: [`${entry.name} could not be read, so it cannot be copied.`] };
  const parsed = parseSiteRules(text);
  if (!parsed.ok) {
    return {
      problems: [
        `${entry.name} has problems, so it cannot be copied. Open it with Edit… and put them right first.`,
      ],
    };
  }
  const copy = copyForSite(parsed.rules, site, entry.name, partTypeOfReader);
  // What the copy lacks for the new site, such as the game's name a part read by rules needs.
  const checked = checkSiteRules(copy);
  if (!checked.ok) return { problems: checked.problems.map(problemText) };
  return { text: `${JSON.stringify(copy, null, 2)}\n` };
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
