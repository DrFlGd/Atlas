import {
  applySiteRules,
  checkSiteRules,
  isReaderDefaults,
  parseSiteRules,
  problemText,
  readByRules,
  siteRulesFileName,
  siteRulesHosts,
  siteRulesKey,
  siteRulesProblemsOf,
  type AppliedSiteRules,
  type AtlasImporter,
  type ReadingWay,
  type SiteRules,
  type SiteRulesProblem,
} from '@atlas/importer-api';
import guideText from '@atlas/importer-api/site-rules/atlas-site-rules.md?raw';
import schemaText from '@atlas/importer-api/site-rules/atlas-site-rules.schema.json?raw';
import { create } from 'zustand';
import { desktop, type SiteSwitches, type SitesListing } from '../desktop';
import { sitesOffered } from '../features';
import { notify } from './actions';
import { useAtlas } from './store';

/**
 * The site rules files the importers read sites by (the format and its
 * guide are in `@atlas/importer-api`, `siteRules.ts`), for Settings,
 * "Sites", in a build with downloads:
 *
 * - the files an importer comes with (`sites.files` of the importer), each
 *   switched on until the person switches it off;
 * - the person's own files, in the Sites folder the shell keeps beside the
 *   maps folder. A file is checked before it is added, and is added
 *   switched off: the person switches it on once they have seen the hosts
 *   it names. It counts as switched on only while its text is the one that
 *   was switched on, so a file changed outside the app is off again.
 *
 * Which files are on is kept by the shell in the Sites folder, `sites.json`
 * ({@link SiteSwitches}), by these keys: `own/<file name>` for a file of
 * the person's, `<importer id>/<file name>` for a file an importer comes
 * with. A file of the person's that is switched on takes the place of the
 * file an importer comes with that has its key (`siteRulesKey`: the same
 * `site.id`, or the defaults of the same reader); removing it, or
 * switching it off, brings that file back.
 *
 * The app hands each importer the files switched on that it can read
 * (`applySiteRules`) once it is loaded, before anything else, and again
 * whenever the person changes them. Nothing in a file is run: an importer
 * only reads what it says.
 */

/** A file's key in `sites.json`. */
export const ownKey = (name: string) => `own/${name}`;
export const builtInKey = (importerId: string, name: string) => `${importerId}/${name}`;

/** The ways of reading, as the Sites screen names them. */
export const WAY_NAMES: Record<ReadingWay, string> = {
  fetch: 'By itself',
  window: 'In a window',
  browse: 'As I browse',
};

const TYPE_NAMES: Record<string, string> = { wiki: 'Wiki', guide: 'Guide', map: 'Map' };

/** One file as the Sites screen shows it. */
export interface SiteEntry {
  /** Its key in `sites.json`. */
  key: string;
  /** Its file name. */
  name: string;
  /** The person added it; otherwise it comes with {@link importer}. */
  own: boolean;
  /** The title of the importer it comes with, for a file that comes with one. */
  importer: string | null;
  /** The site's name, or the reader whose defaults it holds; the file name when it cannot be read. */
  title: string;
  /** Whether it holds a reader's defaults rather than a site. */
  defaults: boolean;
  /** Its form is right, so it can be switched on (a file that comes with an importer always). */
  readable: boolean;
  /** The types of its parts, in words, each once. */
  types: string[];
  /** Every host it names. */
  hosts: string[];
  /** The ways of reading it offers, in its order; empty when it leaves them to its reader. */
  ways: ReadingWay[];
  /** Switched on. */
  on: boolean;
  /** A file of the person's switched on that takes this one's place (its name), for a file that comes with an importer. */
  replacedBy: string | null;
  /** Takes the place of a file an importer comes with (that importer's title), for a file of the person's switched on. */
  replaces: string | null;
  /** What is wrong with it, in plain words: what cannot be read is not read. */
  problems: string[];
}

/** A file of the person's that was just checked and kept, waiting to be switched on. */
export interface SiteToSwitchOn {
  key: string;
  name: string;
  title: string;
  hosts: string[];
  /** It was just added (rather than switched on from the list). */
  added: boolean;
}

export const useSites = create<{
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  folder: string | null;
  entries: SiteEntry[];
  error: string | null;
  /** The problems of a file the person chose that could not be added. */
  refused: { name: string; problems: string[] } | null;
  confirm: SiteToSwitchOn | null;
}>(() => ({
  phase: 'idle',
  folder: null,
  entries: [],
  error: null,
  refused: null,
  confirm: null,
}));

/** The shell's Sites folder; only asked for where Sites is offered, which is in the desktop app. */
function shellSites() {
  if (!desktop) throw new Error('Only the desktop app keeps site rules files.');
  return desktop.sites;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------
// The files

/** A file of the person's, read from the Sites folder. */
interface OwnFile {
  name: string;
  key: string;
  /** Checked: its rules, or its problems. */
  rules: SiteRules | null;
  problems: string[];
  /** The digest of its text, to tell whether it is the text switched on. */
  digest: string | null;
}

/** The Sites folder as last read: its files, checked, and the switches. */
interface SitesState {
  folder: string;
  own: OwnFile[];
  switches: SiteSwitches;
}

let current: Promise<SitesState> | null = null;

/** The hex SHA-256 digest of a file's text. */
async function digestOf(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function stateOf(listing: SitesListing): Promise<SitesState> {
  const own = await Promise.all(
    listing.files.map(async (file): Promise<OwnFile> => {
      const key = ownKey(file.name);
      if (file.text === undefined) {
        return {
          name: file.name,
          key,
          rules: null,
          problems: [file.problem ?? 'Could not be read.'],
          digest: null,
        };
      }
      const checked = parseSiteRules(file.text);
      const digest = await digestOf(file.text);
      if (!checked.ok) {
        return {
          name: file.name,
          key,
          rules: null,
          problems: checked.problems.map(problemText),
          digest,
        };
      }
      const expected = siteRulesFileName(checked.rules);
      const problems =
        expected === file.name
          ? []
          : [
              `Is named ${file.name}, and a file with what it says is named ${expected}. Add it again to keep it under its name.`,
            ];
      return {
        name: file.name,
        key,
        rules: problems.length ? null : checked.rules,
        problems,
        digest,
      };
    }),
  );
  return { folder: listing.folder, own, switches: listing.switches };
}

/** The Sites folder, read once and then kept until it changes. */
function sitesState(): Promise<SitesState> {
  if (!current) {
    current = shellSites().list().then(stateOf);
    current.catch(() => {
      current = null;
    });
  }
  return current;
}

const isOn = (file: OwnFile, switches: SiteSwitches) =>
  file.rules !== null && file.digest !== null && switches.on[file.key] === file.digest;

/** The readers a file names. */
function readersOf(rules: SiteRules): string[] {
  return isReaderDefaults(rules)
    ? [rules.readerDefaults.reader]
    : [...new Set(rules.parts.map((part) => part.reader))];
}

/** Whether an importer has a reader a file of the person's names. */
const readsFile = (importer: AtlasImporter, rules: SiteRules) =>
  readersOf(rules).some((reader) => importer.sites?.readers.includes(reader));

/** The files an importer comes with, checked: those whose form is wrong are left out. */
function builtInFiles(importer: AtlasImporter): { name: string; rules: SiteRules }[] {
  return (importer.sites?.files ?? []).flatMap((file) => {
    const checked = checkSiteRules(file.rules);
    return checked.ok ? [{ name: file.name, rules: checked.rules }] : [];
  });
}

/**
 * The files switched on that an importer reads by, in the order they
 * count: the person's (by name), then its own that no file of the
 * person's takes the place of.
 */
function filesFor(importer: AtlasImporter, state: SitesState): AppliedSiteRules[] {
  const own = state.own.filter(
    (file): file is OwnFile & { rules: SiteRules } =>
      isOn(file, state.switches) && readsFile(importer, file.rules!),
  );
  const replaced = new Set(
    state.own.filter((file) => isOn(file, state.switches)).map((file) => siteRulesKey(file.rules!)),
  );
  const off = new Set(state.switches.off);
  return [
    ...own.map((file) => ({ name: file.name, own: true, rules: file.rules })),
    ...builtInFiles(importer)
      .filter(
        (file) =>
          !off.has(builtInKey(importer.id, file.name)) && !replaced.has(siteRulesKey(file.rules)),
      )
      .map((file) => ({ name: file.name, own: false, rules: file.rules })),
  ];
}

/**
 * Hands an importer the files switched on, once it is loaded (see the
 * module's description). Nothing happens for an importer without site
 * rules files, or in an app without the Sites folder: the importer then
 * reads by the files it comes with. Never throws.
 */
export async function applySitesTo(importer: AtlasImporter): Promise<void> {
  if (!__ATLAS_DOWNLOADS__ || !importer.sites || !sitesOffered(useAtlas.getState())) return;
  try {
    applySiteRules(importer, filesFor(importer, await sitesState()));
  } catch (error) {
    console.error(error);
  }
}

// ---------------------------------------------------------------------------
// The screen

/** A part read by `rules`, in this version: its form is checked, and it is not read yet. */
const RULES_NOT_YET = 'This version cannot read a part read by rules yet.';

function describe(rules: SiteRules | null, name: string) {
  if (!rules) return { title: name, defaults: false, types: [], hosts: [], ways: [] };
  if (isReaderDefaults(rules)) {
    return {
      title: `Defaults of the reader “${rules.readerDefaults.reader}”`,
      defaults: true,
      types: [],
      hosts: siteRulesHosts(rules),
      ways: rules.readerDefaults.reading.ways,
    };
  }
  return {
    title: rules.site.name,
    defaults: false,
    types: [...new Set(rules.parts.map((part) => TYPE_NAMES[part.type] ?? part.type))],
    hosts: siteRulesHosts(rules),
    ways: [...new Set(rules.parts.flatMap((part) => part.reading?.ways ?? []))],
  };
}

/** The problems a file has that no importer would say: parts no importer has a reader for. */
function readerProblems(rules: SiteRules, importers: readonly AtlasImporter[]): string[] {
  const has = (reader: string) => importers.some((i) => i.sites?.readers.includes(reader));
  if (isReaderDefaults(rules)) {
    const reader = rules.readerDefaults.reader;
    return has(reader)
      ? []
      : [`No importer of this app has the reader “${reader}”, so nothing reads by this file.`];
  }
  return rules.parts.flatMap((part, index) => {
    if (has(part.reader)) return [];
    const words = readByRules(part)
      ? RULES_NOT_YET
      : `no importer of this app has the reader “${part.reader}”, so this part is not read.`;
    return [problemText({ field: `parts[${index}]`, message: words })];
  });
}

/** Problems an importer answered, in plain words, each once. */
const inWords = (problems: readonly SiteRulesProblem[]) => problems.map(problemText);

function entriesOf(state: SitesState, importers: readonly AtlasImporter[]): SiteEntry[] {
  const onOwn = state.own.filter((file) => isOn(file, state.switches));
  const ownByKey = new Map(onOwn.map((file) => [siteRulesKey(file.rules!), file.name]));
  // What each importer answers for the files switched on, by key.
  const answers = new Map<string, string[]>();
  for (const importer of importers) {
    if (!importer.sites) continue;
    const files = filesFor(importer, state);
    applySiteRules(importer, files).forEach((problems, index) => {
      const file = files[index]!;
      const key = file.own ? ownKey(file.name) : builtInKey(importer.id, file.name);
      answers.set(key, [...(answers.get(key) ?? []), ...inWords(problems)]);
    });
  }
  const checked = (key: string, rules: SiteRules, readers: readonly AtlasImporter[]) =>
    answers.get(key) ??
    readers.flatMap((importer) => inWords(siteRulesProblemsOf(importer, rules)));

  const own = state.own.map((file): SiteEntry => {
    const on = isOn(file, state.switches);
    const rules = file.rules;
    const replacing = rules
      ? importers.find((importer) =>
          builtInFiles(importer).some((b) => siteRulesKey(b.rules) === siteRulesKey(rules)),
        )
      : undefined;
    const problems = rules
      ? [
          ...readerProblems(rules, importers),
          ...checked(
            file.key,
            rules,
            importers.filter((importer) => readsFile(importer, rules)),
          ),
        ]
      : file.problems;
    return {
      key: file.key,
      name: file.name,
      own: true,
      importer: null,
      ...describe(rules, file.name),
      readable: rules !== null,
      on,
      replacedBy: null,
      replaces: on && replacing ? replacing.title : null,
      problems: [...new Set(problems)],
    };
  });
  const builtIn = importers.flatMap((importer) =>
    builtInFiles(importer).map((file): SiteEntry => {
      const key = builtInKey(importer.id, file.name);
      const replacedBy = ownByKey.get(siteRulesKey(file.rules)) ?? null;
      const on = !state.switches.off.includes(key);
      return {
        key,
        name: file.name,
        own: false,
        importer: importer.title,
        ...describe(file.rules, file.name),
        readable: true,
        on,
        replacedBy,
        replaces: null,
        problems: replacedBy
          ? []
          : [
              ...new Set([
                ...readerProblems(file.rules, importers),
                ...checked(key, file.rules, [importer]),
              ]),
            ],
      };
    }),
  );
  const byTitle = (a: SiteEntry, b: SiteEntry) =>
    Number(a.defaults) - Number(b.defaults) || a.title.localeCompare(b.title);
  return [...own.sort(byTitle), ...builtIn.sort(byTitle)];
}

let screenImporters: readonly AtlasImporter[] = [];

/** Reads the Sites folder (again) and shows its files and the importers' with what each says. */
export async function loadSites(importers: readonly AtlasImporter[]): Promise<void> {
  screenImporters = importers;
  useSites.setState((s) => ({ phase: s.phase === 'ready' ? 'ready' : 'loading', error: null }));
  try {
    const state = await sitesState();
    useSites.setState({
      phase: 'ready',
      folder: state.folder,
      entries: entriesOf(state, importers),
    });
  } catch (error) {
    useSites.setState({ phase: 'failed', error: errorText(error) });
  }
}

/** After a change in the Sites folder: reads it again and hands every importer what is on now. */
async function reload(): Promise<void> {
  current = null;
  await loadSites(screenImporters);
}

/** The switches on, without the one of `key`. */
const without = (on: Record<string, string>, key: string) =>
  Object.fromEntries(Object.entries(on).filter(([k]) => k !== key));

/** Switches a file on or off. A file of the person's is switched on through {@link askSwitchOn}. */
export async function switchSite(key: string, on: boolean): Promise<void> {
  try {
    const state = await sitesState();
    const switches: SiteSwitches = {
      on: without(state.switches.on, key),
      off: [...state.switches.off],
    };
    const own = state.own.find((file) => file.key === key);
    if (own) {
      if (on && own.rules && own.digest) switches.on[key] = own.digest;
    } else {
      switches.off = on
        ? switches.off.filter((k) => k !== key)
        : [...new Set([...switches.off, key])];
    }
    await shellSites().switch(switches);
  } catch (error) {
    notify(`Could not switch the site: ${errorText(error)}`, 'error');
  }
  useSites.setState({ confirm: null });
  await reload();
}

/** Asks the person to switch a file of theirs on, showing the hosts it names first. */
export function askSwitchOn(
  entry: Pick<SiteEntry, 'key' | 'name' | 'title' | 'hosts'>,
  added = false,
): void {
  useSites.setState({
    confirm: { key: entry.key, name: entry.name, title: entry.title, hosts: entry.hosts, added },
  });
}

export function closeSwitchOn(): void {
  useSites.setState({ confirm: null });
}

/**
 * "Add a rules file…": the person chooses a file, the app checks it, and a
 * file without problems of form is kept in the Sites folder under the name
 * its contents give it, switched off, and the person is asked to switch it
 * on once they have seen its hosts. A file with problems is not kept: its
 * problems are shown.
 */
export async function addSiteFile(): Promise<void> {
  useSites.setState({ refused: null, confirm: null });
  let picked: { name: string; text: string } | null;
  try {
    picked = await shellSites().pick();
  } catch (error) {
    useSites.setState({ refused: { name: 'The file', problems: [errorText(error)] } });
    return;
  }
  if (!picked) return;
  const checked = parseSiteRules(picked.text);
  if (!checked.ok) {
    useSites.setState({
      refused: { name: picked.name, problems: checked.problems.map(problemText) },
    });
    return;
  }
  const name = siteRulesFileName(checked.rules);
  try {
    const state = await sitesState();
    // A file of that name was switched on: the new text is off until switched on again.
    if (state.switches.on[ownKey(name)]) {
      await shellSites().switch({
        on: without(state.switches.on, ownKey(name)),
        off: state.switches.off,
      });
    }
    await shellSites().add(name, picked.text);
  } catch (error) {
    useSites.setState({ refused: { name: picked.name, problems: [errorText(error)] } });
    return;
  }
  await reload();
  const { title, hosts } = describe(checked.rules, name);
  askSwitchOn({ key: ownKey(name), name, title, hosts }, true);
}

/** Removes a file of the person's: a file an importer comes with that it took the place of counts again. */
export async function removeSiteFile(name: string): Promise<void> {
  try {
    await shellSites().remove(name, ownKey(name));
    notify(`Removed ${name}.`);
  } catch (error) {
    notify(`Could not remove ${name}: ${errorText(error)}`, 'error');
  }
  await reload();
}

/**
 * The guide to writing a site rules file, as the person saves it: the
 * format's (public) and what each importer says of its readers.
 */
export function siteRulesGuide(importers: readonly AtlasImporter[]): string {
  const notes = importers.flatMap((importer) => {
    const guide = importer.sites?.guide?.trim();
    return guide ? [guide] : [];
  });
  return [guideText.trimEnd(), ...notes].join('\n\n') + '\n';
}

/** "Save the guide…" and "Save the schema…". */
export async function saveSiteRulesFile(what: 'guide' | 'schema'): Promise<void> {
  try {
    const saved = await shellSites().save(
      what,
      what === 'guide' ? siteRulesGuide(screenImporters) : schemaText,
    );
    if (saved) notify(`Saved ${saved.name}.`);
  } catch (error) {
    notify(`Could not save the ${what}: ${errorText(error)}`, 'error');
  }
}
