import {
  applySiteRules,
  checkSiteRules,
  isReaderDefaults,
  isRefusal,
  isSiteFile,
  parseSiteRules,
  problemText,
  readByRules,
  RULES_READER,
  siteRulesFileName,
  siteRulesHosts,
  siteRulesKey,
  siteRulesProblemsOf,
  siteRulesWideningsOf,
  trySitePage,
  type AppliedSiteRules,
  type AtlasImporter,
  type ReadingWay,
  type SiteRules,
  type SiteFile,
  type SiteRulesProblem,
  type SiteMapTrial,
  type SiteMapTrialFound,
  type SiteTrial,
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
 * whenever the person changes them. A refusal file names no reader, so
 * every importer with site rules files reads it. Nothing in a file is run:
 * an importer only reads what it says.
 *
 * A file states the limits of reading its site (the ways, the pause, a
 * refusal), and the person checks each file before it is switched on: a
 * file of theirs may widen the limits of a file an importer comes with, as
 * when a site's owner gave permission, and the screen lists what it widens
 * (`siteRulesWideningsOf`) before it is on and on its row. What no file
 * can change stays in the app and the importers.
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
  /** The notice of a refusal file: the hosts it names are never read. Null for any other file. */
  refusal: string | null;
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
  /** What a file of the person's widens against the files the importers come with, in plain words. */
  widens: string[];
  /** It can be tried on a saved page: it has a wiki or guide part read by `rules`, and an importer tries it. */
  tryable: boolean;
}

/** A file of the person's that was just checked and kept, waiting to be switched on. */
export interface SiteToSwitchOn {
  key: string;
  name: string;
  title: string;
  hosts: string[];
  /** What it widens against the files the importers come with, in plain words. */
  widens: string[];
  /** It was just added (rather than switched on from the list). */
  added: boolean;
}

/** "Try on a saved page": one file, one page, and what the reader understood of it. */
export interface SiteTrying {
  /** The file's key and title. */
  key: string;
  title: string;
  /** The saved page's file name. */
  page: string;
  /**
   * `address`: the page has no canonical link, and the person is asked for
   * its address; `trying`; `done` with {@link result}; `failed` with
   * {@link error}.
   */
  phase: 'address' | 'trying' | 'done' | 'failed';
  /** The page's address, once known. */
  address: string | null;
  result: SiteTrial | null;
  error: string | null;
}

export const useSites = create<{
  phase: 'idle' | 'loading' | 'ready' | 'failed';
  folder: string | null;
  entries: SiteEntry[];
  error: string | null;
  /** The problems of a file the person chose that could not be added. */
  refused: { name: string; problems: string[] } | null;
  confirm: SiteToSwitchOn | null;
  trying: SiteTrying | null;
}>(() => ({
  phase: 'idle',
  folder: null,
  entries: [],
  error: null,
  refused: null,
  confirm: null,
  trying: null,
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

/** The readers a file names; none for a refusal file. */
function readersOf(rules: SiteRules): string[] {
  if (isRefusal(rules)) return [];
  return isReaderDefaults(rules)
    ? [rules.readerDefaults.reader]
    : [...new Set(rules.parts.map((part) => part.reader))];
}

/**
 * Whether an importer reads a file of the person's: it has a reader the
 * file names, or the file is a refusal, which every importer with site
 * rules files reads.
 */
const readsFile = (importer: AtlasImporter, rules: SiteRules) =>
  isRefusal(rules)
    ? importer.sites !== undefined
    : readersOf(rules).some((reader) => importer.sites?.readers.includes(reader));

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

/** A part read by `rules` that no importer reads: its form is checked, and it is not read. */
const RULES_NOT_YET = 'no importer of this app reads parts by rules yet, so this part is not read.';

function describe(rules: SiteRules | null, name: string) {
  const none = { defaults: false, refusal: null, types: [] as string[], ways: [] as ReadingWay[] };
  if (!rules) return { ...none, title: name, hosts: [] };
  if (isReaderDefaults(rules)) {
    return {
      ...none,
      title: `Defaults of the reader “${rules.readerDefaults.reader}”`,
      defaults: true,
      hosts: siteRulesHosts(rules),
      ways: rules.readerDefaults.reading.ways,
    };
  }
  if (isRefusal(rules)) {
    return {
      ...none,
      title: rules.refusal.name,
      refusal: rules.refusal.notice,
      hosts: siteRulesHosts(rules),
    };
  }
  return {
    ...none,
    title: rules.site.name,
    types: [...new Set(rules.parts.map((part) => TYPE_NAMES[part.type] ?? part.type))],
    hosts: siteRulesHosts(rules),
    ways: [...new Set(rules.parts.flatMap((part) => part.reading?.ways ?? []))],
  };
}

/**
 * Whether a file has a part read by `rules`, which can be tried on a saved
 * page, or for a map part on a saved data file.
 */
const hasRulesPage = (rules: SiteRules | null): rules is SiteFile =>
  rules !== null && isSiteFile(rules) && rules.parts.some((part) => readByRules(part));

/**
 * The address a saved data file is tried at: the start of the file's first
 * map part read by `rules`, on the site's first host. Null when it has none.
 */
function mapStartOf(rules: SiteFile): string | null {
  const part = rules.parts.find((p) => readByRules(p) && p.type === 'map');
  if (!part || !('start' in part) || typeof part.start !== 'string') return null;
  try {
    return new URL(part.start, `https://${rules.site.hosts[0]}/`).href;
  } catch {
    return null;
  }
}

/** Whether a picked file is a saved data file (`.json`), not a saved page. */
const isDataFile = (name: string) => /\.json$/iu.test(name);

/** The importer that tries a file on a saved page: one that reads by `rules` and tries pages. */
const trierOf = (importers: readonly AtlasImporter[]) =>
  importers.find(
    (importer) => importer.sites?.tryPage && importer.sites.readers.includes(RULES_READER),
  );

/** What a file of the person's widens, in plain words, by each importer that reads it. */
function wideningsOf(rules: SiteRules, importers: readonly AtlasImporter[]): string[] {
  return [
    ...new Set(
      importers
        .filter((importer) => readsFile(importer, rules))
        .flatMap((importer) => siteRulesWideningsOf(importer, rules).map(problemText)),
    ),
  ];
}

/** The problems a file has that no importer would say: parts no importer has a reader for. */
function readerProblems(rules: SiteRules, importers: readonly AtlasImporter[]): string[] {
  const has = (reader: string) => importers.some((i) => i.sites?.readers.includes(reader));
  if (isRefusal(rules)) {
    return importers.some((importer) => importer.sites)
      ? []
      : ['No importer of this app reads sites by site rules files, so nothing reads by this file.'];
  }
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
      widens: rules ? wideningsOf(rules, importers) : [],
      tryable: hasRulesPage(rules) && trierOf(importers) !== undefined,
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
        widens: [],
        tryable: hasRulesPage(file.rules) && trierOf(importers) !== undefined,
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
  entry: Pick<SiteEntry, 'key' | 'name' | 'title' | 'hosts' | 'widens'>,
  added = false,
): void {
  useSites.setState({
    confirm: {
      key: entry.key,
      name: entry.name,
      title: entry.title,
      hosts: entry.hosts,
      widens: entry.widens,
      added,
    },
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
  const widens = wideningsOf(checked.rules, screenImporters);
  askSwitchOn({ key: ownKey(name), name, title, hosts, widens }, true);
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

// ---------------------------------------------------------------------------
// Try on a saved page

/** The rules of a file on the screen, by its key: a file of the person's or one an importer comes with. */
async function rulesOfKey(key: string): Promise<SiteRules | null> {
  const state = await sitesState();
  const own = state.own.find((file) => file.key === key);
  if (own) return own.rules;
  for (const importer of screenImporters) {
    const file = builtInFiles(importer).find((b) => builtInKey(importer.id, b.name) === key);
    if (file) return file.rules;
  }
  return null;
}

/**
 * The address a saved page gives itself: its canonical link, when it is a
 * whole `https` address. Null when it has none, and the person is asked.
 */
export function canonicalAddressOf(html: string): string | null {
  // DOMParser runs nothing of the page: no script, no request.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const rels = (link.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u);
    if (!rels.includes('canonical')) continue;
    return httpsAddress(link.getAttribute('href') ?? '');
  }
  return null;
}

/** A whole `https` address, without its fragment; null for anything else. */
export function httpsAddress(text: string): string | null {
  try {
    const url = new URL(text.trim());
    if (url.protocol !== 'https:' || !url.hostname) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/** The page the person picked, kept only while the trial is on the screen. */
let trialPage: { key: string; html: string; data?: string } | null = null;

/**
 * "Try on a saved page…" on a file's row: the person picks one page they
 * saved from the site, the app takes its address from its canonical link
 * (or asks for it), and the importer that reads by `rules` tries the file
 * on it and says what it understood. A saved data file (`.json`) is tried
 * on the file's map part, at the map part's start. Nothing is kept and
 * nothing is fetched.
 */
export async function trySavedPage(entry: Pick<SiteEntry, 'key' | 'title'>): Promise<void> {
  trialPage = null;
  useSites.setState({ trying: null });
  let picked: { name: string; text: string } | null;
  try {
    picked = await shellSites().pickPage();
  } catch (error) {
    useSites.setState({
      trying: {
        key: entry.key,
        title: entry.title,
        page: 'The page',
        phase: 'failed',
        address: null,
        result: null,
        error: errorText(error),
      },
    });
    return;
  }
  if (!picked) return;
  if (isDataFile(picked.name)) {
    trialPage = { key: entry.key, html: '', data: picked.text };
    const rules = await rulesOfKey(entry.key).catch(() => null);
    const start = hasRulesPage(rules) ? mapStartOf(rules) : null;
    useSites.setState({
      trying: {
        key: entry.key,
        title: entry.title,
        page: picked.name,
        phase: start ? 'trying' : 'failed',
        address: null,
        result: null,
        error: start
          ? null
          : 'This file has no map part read by rules, so a data file cannot be tried on it. Choose a page saved from the site instead.',
      },
    });
    if (start) await runTrial(start);
    return;
  }
  trialPage = { key: entry.key, html: picked.text };
  const address = canonicalAddressOf(picked.text);
  useSites.setState({
    trying: {
      key: entry.key,
      title: entry.title,
      page: picked.name,
      phase: address ? 'trying' : 'address',
      address,
      result: null,
      error: null,
    },
  });
  if (address) await runTrial(address);
}

/** The address the person gave for a saved page without a canonical link. */
export async function tryWithAddress(text: string): Promise<boolean> {
  const address = httpsAddress(text);
  if (!address) return false;
  await runTrial(address);
  return true;
}

async function runTrial(address: string): Promise<void> {
  const trying = useSites.getState().trying;
  const page = trialPage;
  if (!trying || page?.key !== trying.key) return;
  const settle = (patch: Partial<SiteTrying>) => {
    const now = useSites.getState().trying;
    // The person may have closed it, or started another, meanwhile.
    if (now?.key === trying.key && now.page === trying.page) {
      useSites.setState({ trying: { ...now, ...patch } });
    }
  };
  // A data file is tried at the map part's start, which is not where it was saved from.
  settle({
    phase: 'trying',
    address: page.data === undefined ? address : null,
    result: null,
    error: null,
  });
  try {
    const rules = await rulesOfKey(trying.key);
    const importer = trierOf(screenImporters);
    if (!hasRulesPage(rules) || !importer) {
      settle({
        phase: 'failed',
        error: 'This file has no part read by rules that an importer of this app can try.',
      });
      return;
    }
    const result = await trySitePage(importer, {
      rules,
      url: address,
      html: page.html,
      ...(page.data === undefined ? {} : { data: page.data }),
    });
    if (result) settle({ phase: 'done', result });
    else settle({ phase: 'failed', error: 'The importer could not try the file on this page.' });
  } catch (error) {
    settle({ phase: 'failed', error: errorText(error) });
  }
}

export function closeTrial(): void {
  trialPage = null;
  useSites.setState({ trying: null });
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

/** What the reader understood of a saved page, in plain sentences, in the order the screen shows them. */
export function trialInWords(trial: SiteTrial): string[] {
  if (trial.part === null) return [];
  if (trial.map) return mapTrialInWords(trial.part, trial.game, trial.map);
  const lines: string[] = [];
  const type = trial.type === 'guide' ? 'a guide' : 'a wiki';
  lines.push(`Part ${trial.part + 1} of the file read it, as a page of ${type}.`);
  if (trial.title) lines.push(`Its title is “${trial.title}”.`);
  if (trial.game) lines.push(`The game is “${trial.game}”.`);
  lines.push(
    `It has ${plural(trial.headings, 'heading')}, ${plural(trial.pictures, 'picture')} and ${plural(trial.tables, 'table')}.`,
  );
  if (trial.pictures > 0) {
    lines.push(
      trial.fullPictures === trial.pictures
        ? trial.pictures === 1
          ? 'The picture has the address of its full-size file.'
          : 'Every picture has the address of its full-size file.'
        : `${plural(trial.fullPictures, 'picture')} of ${trial.pictures.toLocaleString('en')} ${trial.fullPictures === 1 ? 'has' : 'have'} the address of a full-size file.`,
    );
  }
  if (trial.chapters > 0) lines.push(`It is split into ${plural(trial.chapters, 'chapter')}.`);
  if (trial.contents) {
    const { count, groups, first } = trial.contents;
    const inGroups = groups.length > 0 ? ` in ${plural(groups.length, 'group')}` : '';
    lines.push(`The contents it shows list ${plural(count, 'page')}${inGroups}.`);
    if (first.length > 0) {
      lines.push(
        `The first: ${first.map((entry) => (entry.group ? `${entry.title} (${entry.group})` : entry.title)).join(', ')}.`,
      );
    }
  }
  if (trial.next) lines.push(`The next page is ${trial.next}.`);
  else if (trial.type === 'guide') lines.push('No next page was found.');
  if (trial.credit) lines.push(`The credit line reads “${trial.credit}”.`);
  if (trial.licence) lines.push(`Licence: ${trial.licence}`);
  return lines;
}

/** Which types can be ticked as found, in one line; null when there are no types. */
function foundInWords({ can, cannot, byName }: SiteMapTrialFound): string | null {
  if (can.length === 0 && cannot.length === 0) return null;
  const which =
    cannot.length === 0
      ? `Every type can be ticked as found: ${can.join(', ')}.`
      : can.length === 0
        ? `None of the types can be ticked as found: ${cannot.join(', ')}.`
        : `Can be ticked as found: ${can.join(', ')}. Cannot: ${cannot.join(', ')}.`;
  return byName
    ? `${which} The file does not say which (types.found), so the reader chose from each type’s name.`
    : which;
}

/** What the reader found in a saved data file, in plain sentences. */
function mapTrialInWords(part: number, game: string | undefined, map: SiteMapTrial): string[] {
  const lines = [`Part ${part + 1} of the file read it, as the data of a map.`];
  if (game) lines.push(`The game is “${game}”.`);
  const { maps, types, locations } = map;
  lines.push(
    `It has ${plural(maps.count, 'map')}, ${plural(types.count, 'type')} of location and ${plural(locations.count, 'location')}.`,
  );
  for (const one of maps.listed) {
    const floor = one.group ? ` It is a floor of “${one.group}”.` : '';
    const has = [
      plural(one.described, 'description'),
      plural(one.linked, 'link'),
      plural(one.pictured, 'picture'),
    ].join(', ');
    const outside =
      one.outside > 0
        ? ` ${plural(one.outside, 'location')} ${one.outside === 1 ? 'falls' : 'fall'} outside it.`
        : '';
    lines.push(
      `“${one.name}”, ${one.width.toLocaleString('en')} × ${one.height.toLocaleString('en')} pixels: ${plural(one.locations, 'location')}, with ${has}.${floor}${outside}`,
    );
    if (one.image) lines.push(`One image of “${one.name}”: ${one.image}`);
  }
  if (maps.listed.length < maps.count) {
    lines.push(
      `${plural(maps.count - maps.listed.length, 'other map')} ${maps.count - maps.listed.length === 1 ? 'is' : 'are'} not listed here.`,
    );
  }
  if (types.first.length > 0) {
    lines.push(`The first types: ${types.first.join(', ')}.`);
  }
  if (types.found) {
    const line = foundInWords(types.found);
    if (line) lines.push(line);
  }
  if (locations.first.length > 0) {
    lines.push(
      `The first locations: ${locations.first.map((l) => `${l.name} (${l.type}) on “${l.map}” at ${l.x.toLocaleString('en')}, ${l.y.toLocaleString('en')}`).join('; ')}.`,
    );
  }
  const outside = maps.listed.reduce((sum, one) => sum + one.outside, 0);
  lines.push(
    outside === 0
      ? 'Every position falls inside its map.'
      : 'Not every position falls inside its map: the maps above say how many fall outside.',
  );
  return lines;
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
