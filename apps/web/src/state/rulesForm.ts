import {
  KNOWN_LICENCE_NAMES,
  LAYOUT_HIDDEN,
  LAYOUT_LONG_LINES,
  LAYOUT_PICTURES,
  LAYOUT_READS,
  LICENCE_FORMS,
  MENU_FROM,
  READER_DEFAULTS_SUFFIX,
  READING_PAUSE_SECONDS,
  READING_WAYS,
  RULES_READER,
  SITE_RULES_SUFFIX,
  fieldPath,
  licenceFormOf,
  type LayoutPictures,
  type LayoutRead,
  type LicenceBlockForm,
  type MenuFrom,
  type ReadingWay,
} from '@atlas/importer-api';
import { DEFAULT_PAGE_WIDTH, MAX_SITE_WIDTH, MIN_SITE_WIDTH } from '@atlas/schema';
import { scanJson, type JsonSpot } from './jsonText';
import { LICENCE_TYPE_LABELS, LICENCE_TYPE_TEXTS } from './licenceWords';
import { PAGE_WIDTH_NAMES } from './pageWidthNames';

/**
 * The settings of a site rules file, for the rules file editor's settings
 * view (`library/RulesForm.tsx`): the simple choices of a site file's parts
 * or of a reader's defaults as ordinary controls, a second view of the same
 * text as the JSON. Pure: nothing is read or kept here.
 *
 * - {@link readRulesForm} reads the text into groups of settings (the site,
 *   each part, the defaults, the file), each with its value as the text
 *   holds it, and what else the group sets that only the JSON shows.
 * - {@link setInText} writes one setting back into the text: only that
 *   field's text changes, so every other field, its order and its layout
 *   stay as they are, and a new field is written as the editor lays files
 *   out (two spaces).
 * - {@link compareWithShipped} and {@link putBackText} compare a copy with
 *   the shipped file it was copied from, setting by setting.
 *
 * The values each control offers come from the format (`@atlas/importer-api`)
 * and every value is checked by the format's checker, as the JSON is.
 */

/** A field's path, as the checker names fields: keys of objects and indices of lists. */
export type FieldPath = readonly (string | number)[];

/** One choice of a list of choices: the value the file holds, in words. */
export interface ChoiceOption {
  value: string;
  label: string;
}

/** The control a setting is shown with. */
export type SettingControl =
  /** `reading.ways`: one tick box per way; `required` when a file must give them. */
  | { type: 'ways'; required: boolean }
  /** `reading.pause`, in seconds. */
  | { type: 'pause'; min: number; max: number }
  /** A whole number from `min` to `max`, in `unit`, or none (`unset` says what then holds). */
  | { type: 'number'; min: number; max: number; unit: string; unset: string }
  /** One of the values the format allows, or none (`unset` says what then holds). */
  | { type: 'choice'; options: readonly ChoiceOption[]; unset: string }
  /** `true`, `false`, or none. */
  | { type: 'yesNo'; yes: string; no: string; unset: string }
  /** A list of words or hosts. */
  | { type: 'list'; add: string; placeholder: string }
  /** Words; `lines` for a text of several lines; `required` when the file must have it. */
  | { type: 'text'; lines: boolean; required: boolean }
  /** A licence block in one of its forms, or none (`unset` says what then holds). */
  | { type: 'licence'; unset: string };

/** One setting of a group, with its value as the text holds it. */
export interface Setting {
  /** Its field, as the checker names fields: `parts[0].reading.pause`. */
  field: string;
  path: FieldPath;
  label: string;
  /** What it is for, in a sentence, when its label does not say it all. */
  hint?: string;
  control: SettingControl;
  /**
   * The set of settings within its group it belongs to, shown together
   * under a title of their own with a sentence on what they are for (the
   * permission from a site); none for a setting that stands alone.
   */
  within?: SettingSet;
  /** Its value in the text; undefined when the text does not have it. */
  value: unknown;
}

/** A set of settings shown together within a group (see {@link Setting.within}). */
export interface SettingSet {
  title: string;
  hint: string;
}

/** The settings of the permission a site gave (`reading.permission`), in a file of the person's. */
export const PERMISSION_SET: SettingSet = {
  title: 'Permission from the site',
  hint: 'Fill this in only when the site has told you that this app may read these addresses by itself. Name who said so and when.',
};

/** A group of settings: the site, a part, a reader's defaults, or the file itself. */
export interface FormGroup {
  /** `site`, `part`, `defaults` or `file`. */
  kind: 'site' | 'part' | 'defaults' | 'file';
  /** Its field (`parts[1]`), or `''` for the file. */
  field: string;
  base: FieldPath;
  title: string;
  settings: Setting[];
  /** What else this group's part of the file sets, which only the JSON view shows, in words. */
  also: string[];
  /** For a part: its type and reader, to find the same part in another file. */
  type?: unknown;
  reader?: unknown;
}

export type RulesFormRead =
  | {
      ok: true;
      shape: 'site' | 'defaults';
      /** The key the file is known by (`site:<id>`, `reader:<name>`), when the text gives one. */
      key: string | null;
      groups: FormGroup[];
    }
  | { ok: false; why: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The value at a path of a JSON value; undefined where there is none. */
export function valueAt(root: unknown, path: FieldPath): unknown {
  let at = root;
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(at)) return undefined;
      at = at[step];
    } else {
      if (!isObject(at) || !Object.hasOwn(at, step)) return undefined;
      at = at[step];
    }
  }
  return at;
}

/** The text as JSON; undefined when it is not JSON. */
export function parsed(text: string): unknown {
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, '')) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The words of each choice, for each value the format allows

const MENU_FROM_WORDS: Record<MenuFrom, string> = {
  side: 'The side menu only',
  both: 'The main part of the home page, then the side menu',
  main: 'The main part of the home page only',
};

const LAYOUT_READ_WORDS: Record<LayoutRead, string> = {
  seen: 'As the browser shows it',
  stated: 'Only as the page’s HTML states it',
  off: 'Not at all: every page in one column, in reading order',
};

const LAYOUT_PICTURES_WORDS: Record<LayoutPictures, string> = {
  linked: 'Only those that link to a page of the site',
  all: 'Every one',
  none: 'None',
};

const LAYOUT_HIDDEN_WORDS: Record<(typeof LAYOUT_HIDDEN)[number], string> = {
  leaveOut: 'Left out, except tabs, folds and pop-ups the page shows on request',
  keep: 'All kept',
};

const LAYOUT_LONG_LINES_WORDS: Record<(typeof LAYOUT_LONG_LINES)[number], string> = {
  even: 'In lines as even as they go',
  fours: 'In lines of four',
};

const options = <T extends string>(values: readonly T[], words: Record<T, string>) =>
  values.map((value) => ({ value, label: words[value] }));

const widthName = (width: string) =>
  PAGE_WIDTH_NAMES.find((one) => one.width === width)?.name ?? width;

/** The ways of reading, as the Sites screen names them (`WAY_NAMES` of `siteRules.ts`). */
export type WayNames = Record<ReadingWay, string>;

/** The forms of a licence block, in words: the licence step's where it has them. */
export const LICENCE_FORM_WORDS: Record<LicenceBlockForm, { label: string; says: string }> = {
  ask: {
    label: 'Ask me',
    says: 'You are asked once, at the first import, unless a page states its licence.',
  },
  stated: {
    label: 'Only what a page states',
    says: 'Only pages that state their licence themselves are read, and you are not asked.',
  },
  known: { label: LICENCE_TYPE_LABELS.known, says: LICENCE_TYPE_TEXTS.known },
  permission: { label: LICENCE_TYPE_LABELS.permission, says: LICENCE_TYPE_TEXTS.permission },
  blank: { label: LICENCE_TYPE_LABELS.none, says: LICENCE_TYPE_TEXTS.none },
};

/** The forms of a licence block, in the order the format lists them. */
export const LICENCE_FORM_CHOICES: readonly LicenceBlockForm[] = LICENCE_FORMS;

/** The licences a licence block may name, as the format lists them. */
export const KNOWN_LICENCES: readonly string[] = KNOWN_LICENCE_NAMES;

// ---------------------------------------------------------------------------
// What else a group sets, in words

/** Fields of a part, of the site or of the defaults that only the JSON view shows, in words. */
const ALSO_WORDS: Record<string, string> = {
  id: 'the site’s id',
  game: 'the game',
  hosts: 'the site’s hosts',
  about: 'who wrote the file and when',
  start: 'the address it starts at',
  pages: 'which addresses are pages',
  contents: 'where the list of pages comes from',
  article: 'where a page’s text is',
  order: 'the order of the pages',
  mapLinks: 'links to a location of a map',
  options: 'settings only its reader understands',
  pack: 'the id of the game’s pack',
  data: 'where the map’s data is',
  maps: 'the maps and their pictures',
  types: 'the types of location',
  locations: 'where the locations are',
  position: 'how positions are given',
  'game.name': 'where the game’s name is',
  'pictures.other': 'how pictures are found',
  'layout.selectors': 'which blocks are laid out how',
  'layout.hidden': 'which hidden blocks are kept',
  'layout.headings': 'the size and length of lines made headings',
  'menu.headings': 'which elements are the titles of the home page’s blocks',
  'licence.stated': 'where a page states its licence',
};

/** The fields the settings show, by the group's kind; anything else is listed as set elsewhere. */
const SHOWN: Record<FormGroup['kind'], ReadonlySet<string>> = {
  site: new Set(['name', 'notice', 'licence']),
  part: new Set([
    'type',
    'reader',
    'name',
    'notes',
    'reading',
    'pictures',
    'licence',
    'layout',
    'menu',
    'pagesInOrder',
  ]),
  defaults: new Set([
    'reader',
    'reading',
    'notice',
    'pictures',
    'licence',
    'layout',
    'menu',
    'pagesInOrder',
  ]),
  file: new Set(['format', 'version', 'site', 'parts', 'readerDefaults', 'notes']),
};

/** What a group's object sets besides what its settings show, in words, each once. */
function alsoOf(kind: FormGroup['kind'], value: Record<string, unknown>): string[] {
  const words: string[] = [];
  let other = false;
  const add = (key: string) => {
    const said = ALSO_WORDS[key];
    if (said) words.push(said);
    else other = true;
  };
  for (const key of Object.keys(value)) {
    if (!SHOWN[kind].has(key)) {
      if (kind === 'part' && key === 'game') add('game.name');
      else add(key);
    }
  }
  if (kind === 'part' || kind === 'defaults') {
    const pictures = value.pictures;
    if (isObject(pictures) && Object.keys(pictures).some((key) => key !== 'hosts')) {
      add('pictures.other');
    }
    const layout = value.layout;
    if (isObject(layout)) {
      const shown = new Set([
        'read',
        'pictures',
        'longLines',
        'pageWidth',
        'siteWidth',
        'hidden',
        'headings',
      ]);
      if (Object.keys(layout).some((key) => !shown.has(key))) add('layout.selectors');
      if (Array.isArray(layout.hidden)) add('layout.hidden');
      if (isObject(layout.headings) && Object.keys(layout.headings).some((k) => k !== 'lines')) {
        add('layout.headings');
      }
    }
    if (isObject(value.menu) && Object.hasOwn(value.menu, 'headings')) add('menu.headings');
    const reading = value.reading;
    const shownReading = ['ways', 'pause', 'keepOff', ...(kind === 'part' ? ['permission'] : [])];
    if (isObject(reading) && Object.keys(reading).some((k) => !shownReading.includes(k))) {
      other = true;
    }
    if (
      kind === 'part' &&
      isObject(reading) &&
      isObject(reading.permission) &&
      Object.keys(reading.permission).some((k) => !['from', 'on', 'allows'].includes(k))
    ) {
      other = true;
    }
  }
  if (kind !== 'file' && isObject(value.licence) && Object.hasOwn(value.licence, 'stated')) {
    add('licence.stated');
  }
  if (other) words.push('other fields');
  return [...new Set(words)];
}

// ---------------------------------------------------------------------------
// Reading a file into settings

const TYPE_WORDS: Record<string, string> = { wiki: 'a wiki', guide: 'a guide', map: 'a map' };

/** A part's title: its number, its type and its reader. */
function partTitle(index: number, part: Record<string, unknown>): string {
  const type =
    typeof part.type === 'string' ? (TYPE_WORDS[part.type] ?? `a ${part.type}`) : 'a part';
  const reader =
    part.reader === RULES_READER
      ? 'read by the selectors it gives (the reader “rules”)'
      : typeof part.reader === 'string'
        ? `read by the reader “${part.reader}”`
        : 'with no reader named';
  return `Part ${index + 1}: ${type}, ${reader}`;
}

/** The settings of the reading, the menu, the layout and the pictures of a part or of the defaults. */
function readingSettings(
  root: unknown,
  base: FieldPath,
  options_: { waysRequired: boolean; pages: boolean; permission: boolean },
): Omit<Setting, 'value'>[] {
  const at = (...rel: (string | number)[]) => {
    const path = [...base, ...rel];
    return { path, field: fieldPath(path) };
  };
  const settings: Omit<Setting, 'value'>[] = [
    {
      ...at('reading', 'ways'),
      label: 'Ways of reading',
      hint:
        options_.waysRequired || waysIn(valueAt(root, [...base, 'reading', 'ways'])).length > 0
          ? 'At least one stays ticked.'
          : 'Not set: the ways of the reader’s defaults hold until you tick one for this part.',
      control: { type: 'ways', required: options_.waysRequired },
    },
    {
      ...at('reading', 'pause'),
      label: 'The pause between pages, in seconds',
      hint: `From ${READING_PAUSE_SECONDS.min} to ${READING_PAUSE_SECONDS.max} seconds. Leave it empty for the app’s own minimum. The app never pauses less than its own minimum.`,
      control: { type: 'pause', min: READING_PAUSE_SECONDS.min, max: READING_PAUSE_SECONDS.max },
    },
    {
      ...at('reading', 'keepOff'),
      label: 'Addresses this app never opens on its own',
      hint: 'The beginnings of addresses of the site, such as /private/ or /tools/list.php. The app does not open an address that begins with one, by itself or in its window, whatever the site’s robots.txt allows. A page you open as you browse is still kept.',
      control: { type: 'list', add: 'Add an address', placeholder: '/private/' },
    },
  ];
  if (options_.permission) {
    settings.push(
      {
        ...at('reading', 'permission', 'from'),
        label: 'Who gave it',
        hint: 'In your own words, such as the editors of the site, by email.',
        control: { type: 'text', lines: false, required: false },
        within: PERMISSION_SET,
      },
      {
        ...at('reading', 'permission', 'on'),
        label: 'When it was given',
        hint: 'A date written as YYYY-MM-DD, such as 2026-11-16.',
        control: { type: 'text', lines: false, required: false },
        within: PERMISSION_SET,
      },
      {
        ...at('reading', 'permission', 'allows'),
        label: 'Addresses it lets this app read by itself',
        hint: 'The beginnings of the addresses the site allowed, such as /archive/. The app reads them by itself even where the site’s robots.txt does not allow them, and follows robots.txt for every other address.',
        control: { type: 'list', add: 'Add an address', placeholder: '/archive/' },
        within: PERMISSION_SET,
      },
    );
  }
  if (options_.pages) {
    const layout = valueAt(root, [...base, 'layout']);
    const hiddenIsList = isObject(layout) && Array.isArray(layout.hidden);
    settings.push(
      {
        ...at('pagesInOrder'),
        label: 'Pages read in order',
        control: {
          type: 'yesNo',
          yes: 'Yes: the pages are one guide, read in order',
          no: 'No: the pages are a wiki',
          unset: 'Not set: the pages are a wiki',
        },
      },
      {
        ...at('menu', 'from'),
        label: 'Where the menu comes from',
        control: {
          type: 'choice',
          options: options(MENU_FROM, MENU_FROM_WORDS),
          unset: `Not set: ${MENU_FROM_WORDS.side.toLowerCase()}`,
        },
      },
      {
        ...at('menu', 'leaveOut'),
        label: 'Headings left out of the menu',
        hint: 'Blocks and groups of the menu left out, by their heading’s words.',
        control: { type: 'list', add: 'Add a heading', placeholder: 'A heading’s words' },
      },
      {
        ...at('menu', 'keep'),
        label: 'Headings kept in the menu',
        hint: 'Blocks and groups kept whatever the general rules say, by their heading’s words.',
        control: { type: 'list', add: 'Add a heading', placeholder: 'A heading’s words' },
      },
      {
        ...at('layout', 'pageWidth'),
        label: 'Page width',
        hint: 'How wide the pages are shown on a computer or a tablet. Your own choice in Guides wins.',
        control: {
          type: 'choice',
          options: PAGE_WIDTH_NAMES.map((one) => ({
            value: one.width,
            label: `${one.name}: ${one.says}`,
          })),
          unset: `Not set: ${widthName(DEFAULT_PAGE_WIDTH)}`,
        },
      },
      {
        ...at('layout', 'siteWidth'),
        label: 'Width of the site’s own pages',
        hint: 'The width “Original” shows the pages at. Without it, the width is measured on the pages as they are read or built again, with the site’s style sheets.',
        control: {
          type: 'number',
          min: MIN_SITE_WIDTH,
          max: MAX_SITE_WIDTH,
          unit: 'pixels',
          unset: 'Not set: as measured on the pages',
        },
      },
      {
        ...at('layout', 'read'),
        label: 'How a page’s layout is read',
        control: {
          type: 'choice',
          options: options(LAYOUT_READS, LAYOUT_READ_WORDS),
          unset: `Not set: ${LAYOUT_READ_WORDS.seen.toLowerCase()}`,
        },
      },
      {
        ...at('layout', 'pictures'),
        label: 'Pictures of the home page that are kept',
        control: {
          type: 'choice',
          options: options(LAYOUT_PICTURES, LAYOUT_PICTURES_WORDS),
          unset: 'Not set: as the reader keeps them',
        },
      },
      {
        ...at('layout', 'longLines'),
        label: 'More than four blocks on one line',
        control: {
          type: 'choice',
          options: options(LAYOUT_LONG_LINES, LAYOUT_LONG_LINES_WORDS),
          unset: `Not set: ${LAYOUT_LONG_LINES_WORDS.even.toLowerCase()}`,
        },
      },
    );
    if (!hiddenIsList) {
      settings.push({
        ...at('layout', 'hidden'),
        label: 'Blocks the browser does not show',
        control: {
          type: 'choice',
          options: options(LAYOUT_HIDDEN, LAYOUT_HIDDEN_WORDS),
          unset: `Not set: ${LAYOUT_HIDDEN_WORDS.leaveOut.toLowerCase()}`,
        },
      });
    }
    settings.push({
      ...at('layout', 'headings', 'lines'),
      label: 'Lines standing alone, all bold and larger than the text',
      control: {
        type: 'yesNo',
        yes: 'Made headings',
        no: 'Left as they are',
        unset: 'Not set: made headings',
      },
    });
  }
  settings.push({
    ...at('pictures', 'hosts'),
    label: 'Picture hosts',
    hint: 'Other hosts the pictures of the pages come from, such as files.example.org.',
    control: { type: 'list', add: 'Add a host', placeholder: 'files.example.org' },
  });
  return settings;
}

const withValues = (root: unknown, settings: readonly Omit<Setting, 'value'>[]): Setting[] =>
  settings.map((setting) => ({ ...setting, value: valueAt(root, setting.path) }));

/** The group of the file's own notes. */
function fileGroup(root: Record<string, unknown>): FormGroup {
  return {
    kind: 'file',
    field: '',
    base: [],
    title: 'The file',
    settings: withValues(root, [
      {
        field: 'notes',
        path: ['notes'],
        label: 'Your notes on this file',
        hint: 'Your own remarks. The importers show them and do nothing else with them.',
        control: { type: 'text', lines: true, required: false },
      },
    ]),
    also: alsoOf('file', root),
  };
}

/**
 * Reads the text of a file into its settings: a site file (`site` and
 * `parts`) or a reader's defaults. Its values need not pass the check:
 * the checker's problems are shown beside the settings they name. Not
 * for a text that is not JSON, a refusal, or anything else, with why in a
 * sentence that points to the JSON view.
 */
export function readRulesForm(text: string): RulesFormRead {
  const root = parsed(text);
  if (root === undefined) {
    return {
      ok: false,
      why: 'The text is not plain JSON, so its settings cannot be shown here: put it right in the JSON view.',
    };
  }
  if (!isObject(root)) {
    return {
      ok: false,
      why: 'The text is not one object between { and }, so its settings cannot be shown here: put it right in the JSON view.',
    };
  }
  if (Object.hasOwn(root, 'refusal')) {
    return {
      ok: false,
      why: 'A refusal file names sites that are not read at all, so it has no settings to choose here: its text is in the JSON view.',
    };
  }
  if (isObject(root.readerDefaults)) {
    const defaults = root.readerDefaults;
    const base = ['readerDefaults'];
    const reader = typeof defaults.reader === 'string' ? defaults.reader : null;
    return {
      ok: true,
      shape: 'defaults',
      key: reader ? `reader:${reader}` : null,
      groups: [
        {
          kind: 'defaults',
          field: 'readerDefaults',
          base,
          title: reader ? `The defaults of the reader “${reader}”` : 'The defaults of the reader',
          settings: withValues(root, [
            ...readingSettings(root, base, { waysRequired: true, pages: true, permission: false }),
            {
              field: 'readerDefaults.notice',
              path: [...base, 'notice'],
              label: 'The notice',
              hint: 'The sentence you see for every site this reader reads.',
              control: { type: 'text', lines: true, required: false },
            },
            {
              field: 'readerDefaults.licence',
              path: [...base, 'licence'],
              label: 'The licence',
              control: { type: 'licence', unset: 'Not set: you are asked' },
            },
          ]),
          also: alsoOf('defaults', defaults),
          reader: defaults.reader,
        },
        fileGroup(root),
      ],
    };
  }
  if (isObject(root.site) && Array.isArray(root.parts)) {
    const site = root.site;
    const id = typeof site.id === 'string' ? site.id : null;
    const groups: FormGroup[] = [
      {
        kind: 'site',
        field: 'site',
        base: ['site'],
        title: 'The site',
        settings: withValues(root, [
          {
            field: 'site.name',
            path: ['site', 'name'],
            label: 'The site’s name',
            control: { type: 'text', lines: false, required: true },
          },
          {
            field: 'site.notice',
            path: ['site', 'notice'],
            label: 'The notice',
            hint: 'One or two sentences you see when the file is added, such as what the site’s terms say about programs.',
            control: { type: 'text', lines: true, required: false },
          },
          {
            field: 'site.licence',
            path: ['site', 'licence'],
            label: 'The licence',
            hint: 'For every part that has no licence of its own.',
            control: { type: 'licence', unset: 'Not set in this file' },
          },
        ]),
        also: alsoOf('site', site),
      },
    ];
    root.parts.forEach((part: unknown, index) => {
      if (!isObject(part)) return;
      const base = ['parts', index];
      const field = fieldPath(base);
      groups.push({
        kind: 'part',
        field,
        base,
        title: partTitle(index, part),
        settings: withValues(root, [
          {
            field: `${field}.name`,
            path: [...base, 'name'],
            label: 'The part’s own name',
            hint: 'Only when it differs from the site’s name.',
            control: { type: 'text', lines: false, required: false },
          },
          ...readingSettings(root, base, {
            waysRequired: part.reader === RULES_READER,
            pages: part.type !== 'map',
            permission: true,
          }),
          {
            field: `${field}.licence`,
            path: [...base, 'licence'],
            label: 'The licence',
            control: { type: 'licence', unset: 'The site’s choice' },
          },
          {
            field: `${field}.notes`,
            path: [...base, 'notes'],
            label: 'Your notes on this part',
            control: { type: 'text', lines: true, required: false },
          },
        ]),
        also: alsoOf('part', part),
        type: part.type,
        reader: part.reader,
      });
    });
    groups.push(fileGroup(root));
    return { ok: true, shape: 'site', key: id ? `site:${id}` : null, groups };
  }
  return {
    ok: false,
    why: 'The settings show a site file with its parts, or a reader’s defaults, and this text is neither: change it in the JSON view.',
  };
}

// ---------------------------------------------------------------------------
// Writing one setting back into the text

/** The spaces at the start of the line `at` is on. */
function indentAt(text: string, at: number): string {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  return /^[ \t]*/u.exec(text.slice(lineStart))![0];
}

/** A value as JSON at a line's indentation, as the editor lays files out; on one line for an object written on one. */
function serialize(value: unknown, indent: string, inline: boolean): string {
  if (inline) return JSON.stringify(value);
  return JSON.stringify(value, null, 2).split('\n').join(`\n${indent}`);
}

const skipSpaceBack = (text: string, at: number) => {
  let i = at;
  while (i >= 0 && /\s/u.test(text[i]!)) i--;
  return i;
};
const skipSpace = (text: string, at: number) => {
  let i = at;
  while (i < text.length && /\s/u.test(text[i]!)) i++;
  return i;
};

/** Puts `key` with `value` at the end of the object at `spot`. */
function insertInto(text: string, spot: JsonSpot, key: string, value: unknown): string {
  const close = spot.valueEnd - 1;
  const last = skipSpaceBack(text, close - 1);
  const entry = (indent: string, inline: boolean) =>
    `${JSON.stringify(key)}: ${serialize(value, indent, inline)}`;
  if (last === spot.valueStart) {
    // An empty object: laid out on lines unless the whole file is on one.
    const inline = !text.trim().includes('\n');
    if (inline) {
      return `${text.slice(0, spot.valueStart)}{${entry('', true)}}${text.slice(spot.valueEnd)}`;
    }
    const outer = indentAt(text, spot.valueStart);
    const inner = `${outer}  `;
    return `${text.slice(0, spot.valueStart)}{\n${inner}${entry(inner, false)}\n${outer}}${text.slice(spot.valueEnd)}`;
  }
  const inline = !text.slice(spot.valueStart, last).includes('\n');
  if (inline) {
    return `${text.slice(0, last + 1)}, ${entry('', true)}${text.slice(last + 1)}`;
  }
  const indent = indentAt(text, last);
  return `${text.slice(0, last + 1)},\n${indent}${entry(indent, false)}${text.slice(last + 1)}`;
}

/** Takes the field at `path` out of its object, with its comma. */
function removeFrom(text: string, spots: ReadonlyMap<string, JsonSpot>, path: FieldPath): string {
  const spot = spots.get(fieldPath(path))!;
  const before = skipSpaceBack(text, spot.start - 1);
  if (text[before] === ',') return text.slice(0, before) + text.slice(spot.valueEnd);
  const after = skipSpace(text, spot.valueEnd);
  if (text[after] === ',')
    return text.slice(0, spot.start) + text.slice(skipSpace(text, after + 1));
  // The only field of its object.
  const parent = spots.get(fieldPath(path.slice(0, -1)))!;
  return `${text.slice(0, parent.valueStart)}{}${text.slice(parent.valueEnd)}`;
}

/**
 * The text with the field at `path` set to `value`, or taken out for
 * `undefined`. Only that field's text changes: every other field keeps its
 * place, its order and its layout. A new field goes at the end of its
 * object, laid out as the editor lays files out, with the objects around
 * it made where the text has none. An object a field is taken out of that
 * is left empty is taken out too, down to `floor` (the length of the path
 * of the group it is in, which always stays). The text unchanged when it is
 * not JSON.
 */
export function setInText(text: string, path: FieldPath, value: unknown, floor = 0): string {
  const scan = scanJson(text);
  if (!scan.ok || path.length === 0) return text;
  const spots = scan.spots;
  const field = fieldPath(path);
  const spot = spots.get(field);
  if (value === undefined) {
    if (!spot) return text;
    let next = removeFrom(text, spots, path);
    // An object left empty goes too, up to the group.
    for (let up = path.slice(0, -1); up.length > floor; up = up.slice(0, -1)) {
      const rest = parsed(next);
      const there = valueAt(rest, up);
      if (!isObject(there) || Object.keys(there).length > 0) break;
      const again = scanJson(next);
      if (!again.ok) break;
      next = removeFrom(next, again.spots, up);
    }
    return next;
  }
  if (spot) {
    const parentSpot = spots.get(fieldPath(path.slice(0, -1)));
    const inline =
      parentSpot !== undefined && !text.slice(parentSpot.valueStart, spot.start).includes('\n');
    const indent = indentAt(text, spot.start);
    return (
      text.slice(0, spot.valueStart) + serialize(value, indent, inline) + text.slice(spot.valueEnd)
    );
  }
  const parentPath = path.slice(0, -1);
  const key = path.at(-1)!;
  const parent = spots.get(fieldPath(parentPath));
  const root = parsed(text);
  if (parent && isObject(valueAt(root, parentPath)) && typeof key === 'string') {
    return insertInto(text, parent, key, value);
  }
  // No object to put it in: the object is made, with the field in it.
  if (typeof key !== 'string') return text;
  return setInText(text, parentPath, { [key]: value }, floor);
}

// ---------------------------------------------------------------------------
// The licence block

/** The form of a licence value as the settings show it: one of the five, or none. */
export function licenceFormIn(value: unknown): LicenceBlockForm | null {
  const form = licenceFormOf(value);
  return form === 'several' ? null : form;
}

/**
 * A licence block in another form: what the old block holds that the new
 * form takes is kept (its credit, the words filled in, the selector of
 * `ask`), and a value the person must choose is left empty for the check
 * to ask for. Undefined for none.
 */
export function licenceInForm(
  old: unknown,
  form: LicenceBlockForm | null,
): Record<string, unknown> | undefined {
  if (form === null) return undefined;
  const was = isObject(old) ? old : {};
  const credit = typeof was.credit === 'string' ? { credit: was.credit } : {};
  switch (form) {
    case 'ask':
      return {
        ask: true,
        ...(was.ask === true && 'stated' in was ? { stated: was.stated } : {}),
        ...credit,
      };
    case 'stated':
      return { ask: false, ...credit };
    case 'known':
      return { known: typeof was.known === 'string' ? was.known : '', ...credit };
    case 'permission': {
      const kept = Object.fromEntries(
        ['from', 'on', 'address', 'note'].filter((key) => key in was).map((key) => [key, was[key]]),
      );
      return {
        permission: typeof was.permission === 'string' ? was.permission : '',
        ...kept,
        ...credit,
      };
    }
    case 'blank':
      return { blank: true, ...credit };
  }
}

/**
 * A licence block with one of its words changed: `key` set to `words`, or
 * taken out when they are empty and the field may be left out.
 */
export function licenceWith(old: unknown, key: string, words: string): Record<string, unknown> {
  const was = isObject(old) ? { ...old } : {};
  const needed = key === 'permission' || key === 'known';
  if (words === '' && !needed) {
    const { [key]: _gone, ...rest } = was;
    return rest;
  }
  return { ...was, [key]: words };
}

// ---------------------------------------------------------------------------
// Against the shipped file

/** Whether two JSON values are the same, whatever the order of an object's fields (a list's order counts). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index]))
    );
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
    );
  }
  return a === b;
}

/**
 * Which part of the shipped file each part of the copy is: the part at the
 * same place when its type and reader are the same, else the first part
 * of that type and reader not taken yet; null for a part the shipped file
 * has none like.
 */
function matchParts(parts: readonly unknown[], shipped: readonly unknown[]): (number | null)[] {
  const taken = new Set<number>();
  const like = (a: unknown, b: unknown) =>
    isObject(a) && isObject(b) && a.type === b.type && a.reader === b.reader;
  const found = parts.map((part, index) => {
    if (like(part, shipped[index]) && !taken.has(index)) {
      taken.add(index);
      return index;
    }
    return null;
  });
  return found.map((match, index) => {
    if (match !== null) return match;
    const other = shipped.findIndex((s, i) => !taken.has(i) && like(parts[index], s));
    if (other < 0) return null;
    taken.add(other);
    return other;
  });
}

/**
 * The name a file of the person's with the key `key` (`site:<id>`,
 * `reader:<name>`) is kept under in the Sites folder: the name its contents
 * give it, as a copy of the shipped file of that key is saved. Null for
 * another key.
 */
export function ownNameOfKey(key: string): string | null {
  const site = /^site:(.+)$/u.exec(key)?.[1];
  if (site) return `${site}${SITE_RULES_SUFFIX}`;
  const reader = /^reader:(.+)$/u.exec(key)?.[1];
  return reader ? `${reader}${READER_DEFAULTS_SUFFIX}` : null;
}

/** One setting against the shipped file. */
export interface ShippedSetting {
  /** The shipped file's value of it; undefined where the shipped file has none. */
  shipped: unknown;
  changed: boolean;
}

/**
 * Each setting of `form` against the shipped file `shipped` (its JSON
 * value), by field: the shipped value, and whether the copy's differs. A
 * part the shipped file has none like has no entry, and neither does a
 * file of another shape.
 */
export function compareWithShipped(
  form: Extract<RulesFormRead, { ok: true }>,
  shipped: unknown,
): Map<string, ShippedSetting> {
  const compared = new Map<string, ShippedSetting>();
  if (!isObject(shipped)) return compared;
  const shippedShape = isObject(shipped.readerDefaults) ? 'defaults' : 'site';
  if (shippedShape !== form.shape) return compared;
  const parts = form.groups.filter((group) => group.kind === 'part');
  const matched = matchParts(
    parts.map((group) => ({ type: group.type, reader: group.reader })),
    Array.isArray(shipped.parts) ? shipped.parts : [],
  );
  for (const group of form.groups) {
    let shippedBase: FieldPath | null = group.base;
    if (group.kind === 'part') {
      const match = matched[parts.indexOf(group)];
      shippedBase = match === null || match === undefined ? null : ['parts', match];
    }
    if (!shippedBase) continue;
    for (const setting of group.settings) {
      const rel = setting.path.slice(group.base.length);
      const value = valueAt(shipped, [...shippedBase, ...rel]);
      compared.set(setting.field, { shipped: value, changed: !sameValue(setting.value, value) });
    }
  }
  return compared;
}

/** The text with one setting put back to the shipped file's value (taken out where it has none). */
export function putBackText(
  text: string,
  group: FormGroup,
  setting: Setting,
  shipped: ShippedSetting,
): string {
  return setInText(text, setting.path, shipped.shipped, group.base.length);
}

// ---------------------------------------------------------------------------
// Values in words

/** What holds when a setting is not set, as "Shipped: …" says it: `Not set: X` as `not set (X)`. */
const unsetInWords = (unset: string) => {
  const holds = /^Not set: (.+)$/u.exec(unset)?.[1];
  return holds ? `not set (${holds})` : unset;
};

const quoted = (words: string) =>
  `“${words.length > 80 ? `${words.slice(0, 79).trimEnd()}…` : words}”`;

/** A setting's value in plain words, for "Shipped: …". */
export function valueInWords(setting: Setting, value: unknown, ways: WayNames): string {
  const control = setting.control;
  switch (control.type) {
    case 'ways':
      if (!Array.isArray(value) || value.length === 0) return 'The ways of the reader’s defaults';
      return value
        .map((way) =>
          typeof way === 'string' && way in ways ? ways[way as ReadingWay] : String(way),
        )
        .join(', ');
    case 'pause':
      if (typeof value !== 'number') return 'The app’s own minimum';
      return value === 1 ? '1 second' : `${value.toLocaleString('en')} seconds`;
    case 'number':
      if (typeof value !== 'number') return unsetInWords(control.unset);
      return `${value.toLocaleString('en')} ${control.unit}`;
    case 'choice':
      if (value === undefined) return unsetInWords(control.unset);
      return (
        control.options.find((option) => option.value === value)?.label ?? JSON.stringify(value)
      );
    case 'yesNo':
      return value === true
        ? control.yes
        : value === false
          ? control.no
          : unsetInWords(control.unset);
    case 'list':
      return Array.isArray(value) && value.length > 0 ? value.map(String).join(', ') : 'None';
    case 'text':
      return typeof value === 'string' && value !== '' ? quoted(value) : 'None';
    case 'licence': {
      const form = licenceFormIn(value);
      if (value === undefined || form === null) return unsetInWords(control.unset);
      const label = LICENCE_FORM_WORDS[form].label;
      const block = value as Record<string, unknown>;
      if (form === 'known' && typeof block.known === 'string') return `${label}, ${block.known}`;
      if (form === 'permission' && typeof block.permission === 'string') {
        return `${label}: ${quoted(block.permission)}`;
      }
      return label;
    }
  }
}

/** Whether a problem of the checker, by its field, belongs beside a setting. */
export function problemIsFor(setting: Setting, problemField: string | null): boolean {
  if (problemField === null) return false;
  const field = setting.field;
  if (problemField === field) return true;
  if (problemField.startsWith(`${field}.`) || problemField.startsWith(`${field}[`)) return true;
  // A reading block that is missing, or wrong as a whole, is the ways' problem.
  return setting.control.type === 'ways' && problemField === fieldPath(setting.path.slice(0, -1));
}

/** The ways a value names, in its order (the first is the one offered first). */
export const waysIn = (value: unknown): ReadingWay[] =>
  Array.isArray(value)
    ? value.filter((way): way is ReadingWay => (READING_WAYS as readonly unknown[]).includes(way))
    : [];

/**
 * The ways with one ticked or unticked: those already there keep their
 * order, and a way ticked comes after them.
 */
export function waysWith(value: unknown, way: ReadingWay, ticked: boolean): ReadingWay[] {
  const now = waysIn(value);
  if (ticked) return now.includes(way) ? now : [...now, way];
  return now.filter((one) => one !== way);
}

/** The ways in the format's order. */
export const ALL_WAYS: readonly ReadingWay[] = READING_WAYS;
