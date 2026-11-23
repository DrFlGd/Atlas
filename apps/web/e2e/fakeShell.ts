import { readFile } from 'node:fs/promises';
import { expect, type Page, type Route } from '@playwright/test';
import { downloadsEnabled } from '../tooling/buildFlags.ts';

/**
 * A stand-in for the desktop shell, for the "Add a map" tests: the page
 * gets a fake `__TAURI_INTERNALS__.invoke` whose import window hands over
 * made-up page data for the made-up demo importer
 * (`packages/importer-api/demo/demo-importer.js`), which the tests serve as
 * the build's one importer. Nothing is opened and no site is asked for
 * anything; the real import window is covered by the desktop tests.
 *
 * The made-up site has, for each world, map pages
 * (`/demo-maps/<world>/<map>`), checklist pages
 * (`/demo-maps/<world>/checklists/<slug>`), guide pages (which the demo
 * importer does not read), a game page (`/demo-maps/<world>`) that links
 * to all of them, and a list of worlds (`/demo-maps`).
 */

/** The app under test was built with map image downloads (run with the build's `ATLAS_ENABLE_DOWNLOADS`). */
export const DOWNLOADS_BUILD = downloadsEnabled(process.env.ATLAS_ENABLE_DOWNLOADS);

export const SITE = 'https://maps.example.com/demo-maps';
const PACKS = 'http://atlas-pack.localhost/';
const IMPORTER = new URL('../../../packages/importer-api/demo/demo-importer.js', import.meta.url);
const WIKI_IMPORTER = new URL(
  '../../../packages/importer-api/demo/example-wiki-importer.js',
  import.meta.url,
);
const OTHER_WIKIS_IMPORTER = new URL(
  '../../../packages/importer-api/demo/other-wikis-importer.js',
  import.meta.url,
);

/** The made-up Example Wiki that `example-wiki-importer.js` reads, answered by `import_fetch`. */
export const WIKI = 'https://wiki.example.org/wiki';

export interface WikiSite {
  /** The contents: each heading's pages, by slug. */
  headings: { title: string; pages: string[] }[];
  /**
   * Every page there is, by slug: its title, its text and the slugs it links
   * to; for a wiki the "Other wikis" importer reads, the deed of the licence
   * the page states, if any.
   */
  pages: Record<
    string,
    {
      title: string;
      body: string;
      links?: string[];
      licence?: string;
      /** A picture the page shows as the person browses it (its alternative text), on the wiki's own site. */
      picture?: string;
      /** The wiki forwards this name to another page, by slug: it answers that page, from its own address. */
      forward?: string;
      /** The page answers this HTML (`text/html`) in place of its title, text and links in JSON. */
      html?: string;
    }
  >;
  /** Slugs the site answers with 503 ("busy, try later"), which stops a go. */
  busy?: string[];
  /**
   * Its pages (not its contents) are shown only to a person: the importer
   * has them opened in a window (`fetch.inWindow`), where the fake shell
   * hands over what the site would have answered.
   */
  inWindow?: boolean;
}

export const EXAMPLE_WIKI: WikiSite = {
  headings: [
    { title: 'Basics', pages: ['Welcome', 'Bells', 'Gates'] },
    { title: 'Sights', pages: ['Harbour', 'Lighthouse', 'Missing'] },
  ],
  pages: {
    Welcome: {
      title: 'Welcome',
      body: 'The isle has [bells](Bells) and [gates](Gates).',
      links: ['Bells', 'Gates', 'Old_bell', 'Rusty_gate'],
    },
    Bells: { title: 'Bells', body: 'Ring every bell once.' },
    Gates: { title: 'Gates', body: 'Gates open at dusk.' },
    // Boats, Oars, Lamp and Keeper are in no contents: reached only through links, two deep.
    Harbour: {
      title: 'Harbour',
      body: '[The boats](example-wiki:guide:boats) leave at dawn.',
      links: ['Boats', 'Welcome'],
    },
    Lighthouse: {
      title: 'Lighthouse',
      body: 'The light turns all night.',
      links: ['Lamp', 'Keeper'],
    },
    Boats: {
      title: 'Boats',
      body: 'Each has [oars](example-wiki:guide:oars).',
      links: ['Oars', 'Harbour'],
    },
    Oars: { title: 'Oars', body: 'Two to a boat.', links: ['Boats'] },
    Lamp: { title: 'Lamp', body: 'It burns oil.' },
    Keeper: { title: 'Keeper', body: 'She lives up the stairs.', links: ['Lighthouse'] },
    Old_bell: { title: 'Old bell', body: 'It is cracked.' },
    Rusty_gate: { title: 'Rusty gate', body: 'It squeaks.' },
  },
};

export interface World {
  name: string;
  maps: Record<string, string>;
  /** Checklist pages: rows name a place (1 or 2) of one of the world's maps. */
  checklists?: Record<
    string,
    { name: string; rows: { map: string; place: number; name: string }[] }
  >;
  /** Guide pages, which the demo importer cannot add. */
  guides?: Record<string, string>;
}

/** The made-up site's worlds, by slug. */
export const WORLDS: Record<string, World> = {
  'test-valley': {
    name: 'Test Valley',
    maps: { 'east-field': 'East Field', 'west-ridge': 'West Ridge' },
    checklists: {
      beacons: {
        name: 'Every beacon',
        rows: [
          { map: 'east-field', place: 1, name: 'East Field beacon' },
          { map: 'west-ridge', place: 1, name: 'West Ridge beacon' },
        ],
      },
    },
    guides: { 'where-to-start': 'Where to start' },
  },
  'test-hills': { name: 'Test Hills', maps: { 'high-pass': 'High Pass' } },
  demo: { name: 'Demo again', maps: { plain: 'Plain' } },
};

interface ShellEvent {
  /**
   * `read`: a poll that handed over the page's data. `browse`: the person
   * went to a page in a window opened for browsing ({@link browseTo}).
   * `source`: the app asked for a page kept with a pack (its address).
   * `save`: the app saved a pack, made from the page at that address.
   * `delete`: the app deleted a pack (its id).
   * `styles`: the app asked for the style sheets kept for a game.
   */
  what:
    | 'open'
    | 'navigate'
    | 'close'
    | 'poll'
    | 'read'
    | 'fetch'
    | 'browse'
    | 'source'
    | 'save'
    | 'delete'
    | 'styles';
  url: string | null;
  at: number;
  purpose?: string;
  /** The window was opened kept for the go's next pages. */
  keep?: boolean;
  /** The window was opened for the person to browse (browse and keep). */
  browse?: boolean;
}

export interface MockShell {
  events: ShellEvent[];
  /** Slugs (the last part of the address) whose page keeps waiting until taken out of here. */
  hold: string[];
  /** Slugs whose window the person closes. */
  close: string[];
  /** Slugs whose page shows the site's check: no data, and the window asks for attention after a while. */
  check: string[];
  /**
   * A kept window that lags: the first poll after each move hands over the
   * page shown before, with its address, as a shell without its own check
   * would. The app must never take it for the page asked for.
   */
  lag: boolean;
  /** Maps the site has added since, by world: their game page lists them too. */
  extra: Record<string, Record<string, string>>;
  /** The picture files the app asked to write with a pack, by pack id. */
  pictures: Record<string, string[]>;
  /** Milliseconds the shell takes to hand over one page kept with a pack (a slow disk). */
  slowSources: number;
  /** The style sheets kept for each game, by pack id, as `library_style_texts` hands them over. */
  styleTexts: Record<string, { address?: string; text: string }[]>;
  reports: {
    outcome: string;
    message?: string;
    pages?: string[];
    run?: Record<string, number>;
    kinds?: Record<string, number>;
    alreadyAdded?: number;
    games?: number;
    update?: boolean;
  }[];
  /** The Sites folder: its files by name, and which are switched on (`sites.json`). */
  sites: {
    files: Record<string, string>;
    switches: { on: Record<string, string>; off: string[] };
    /** The file the person chooses at the next "Add a rules file…", or null (they close the dialog). */
    pick: { name: string; text: string } | null;
    /** The page the person chooses at the next "Try on a saved page…", or null. */
    page: { name: string; text: string } | null;
    /** What the person saved with "Save the guide…" and "Save the schema…". */
    saved: { what: string; contents: string }[];
  };
  /**
   * The packs folder under "Games in other folders", as the shell's
   * `library/packsfolder.rs` answers it; listed only when `setUp` asks for
   * it (`packsFolder`).
   */
  packsFolder: {
    path: string;
    isDefault: boolean;
    /** The folder is there (not on a drive that is not connected). */
    exists: boolean;
    /** The default packs folder. */
    defaultPath: string;
    /** The pack files in it, and their size in bytes. */
    files: number;
    bytes: number;
    /** The folder the person chooses in the next folder dialog, or null (they close it). */
    pick: string | null;
    /** The next choice is refused with this sentence, if set. */
    refuse: string | null;
    /** The pack files the next move leaves in the old folder, each with why. */
    left: { path: string; reason: string }[];
    /** The commands called, with their arguments, in order. */
    calls: string[];
  };
  /** Settings, "Keep packs for Game Repo up to date" (a build with downloads). */
  keptPacks: {
    /** What `kept_packs_status` answers (`KeptPacksStatus`). */
    status: KeptPacksState;
    /** The folder the person chooses in the next folder dialog, or null (they close it). */
    pick: string | null;
    /** The games listed once it is on. */
    games: Record<string, unknown>[];
    /** The commands called, in order. */
    calls: string[];
  };
  /**
   * Settings, "Atlas in the background" (the app without downloads on
   * Windows), as the shell's `background` module answers it.
   */
  background: {
    /** What `background_state` answers (`BackgroundState`). */
    state: {
      keepRunning: boolean;
      onTop: boolean;
      hotkey: { on: boolean; keys: string; offered: string; problem: string | null };
      startWithSystem: { on: boolean | null; problem: string | null };
    };
    /** Combinations another program uses: the system does not take them. */
    taken: string[];
    /** Writing the entry that starts Atlas with Windows fails with this, if set. */
    startFails: string | null;
    /** The commands called with their arguments, in order. */
    calls: { command: string; args: Record<string, unknown> }[];
  };
  /**
   * "Add a guidebook…" and "Remove this guidebook…", as the shell's
   * `guidebooks` module answers them: what `guidebook_pick` hands over
   * (once), the pack listed after `guidebook_add`, and the calls.
   */
  guidebooks: {
    pick: Record<string, unknown> | null;
    /** Listed (or listed again, by id) once a guidebook is added. */
    added: Record<string, unknown> | null;
    calls: { command: string; args: Record<string, unknown> }[];
  };
  /**
   * Settings, "Atlas in Steam" (the app without downloads on Windows and
   * Linux), as the shell's `steam` module answers it: its status
   * (`SteamStatus`), changed by `steam_set` and `steam_restart` as the
   * shell would change it, and the commands called with their arguments.
   */
  steam: {
    status: Record<string, unknown>;
    calls: { command: string; args: Record<string, unknown> }[];
  };
  /**
   * Updating Atlas itself, as the shell's `updates` module answers it:
   * what `update_check` finds (an `UpdateCheck`), or the sentence it
   * fails with; the sentence the download fails with, if set; and the
   * commands called, in order. `update_install` only notes the call, where
   * the real shell ends Atlas.
   */
  updates: {
    check: Record<string, unknown> | string;
    downloadFails: string | null;
    calls: string[];
  };
}

/** The state of the kept packs, as the shell sends it. */
interface KeptPacksState {
  on: boolean;
  folder: string;
  folderIsDefault: boolean;
  folderDefaultFrom: 'gameRepo' | 'packsFolder';
  folderChosen: boolean;
  schedule: string;
  running: boolean;
  writing: null;
  lastCheckAt: string | null;
  problem: string | null;
  notice: null;
  games: Record<string, unknown>[];
  serial: number;
}

/**
 * Stands in for the shell: the import window's commands, the library and
 * saving. A page of map `never` never hands over data; `broken` hands over
 * data in the wrong shape; the others after two polls, unless held.
 */
function installFakeShell({
  worlds,
  downloads,
  wiki,
  others,
  pages,
  listed,
  background,
  packsFolder,
  steamLaunch,
  steam,
  exit,
  updates,
}: {
  worlds: Record<string, World>;
  downloads: boolean;
  wiki: WikiSite | null;
  others: Record<string, WikiSite>;
  pages: Record<string, string>;
  listed: Record<string, unknown>[];
  background: boolean;
  packsFolder: boolean;
  steamLaunch: Record<string, string> | null;
  steam: Record<string, unknown> | null;
  exit: boolean;
  updates: { way: Record<string, unknown>; platform: string } | null;
}) {
  const shell: MockShell = {
    events: [],
    hold: [],
    close: [],
    check: [],
    lag: false,
    extra: {},
    pictures: {},
    slowSources: 0,
    styleTexts: {},
    reports: [],
    sites: { files: {}, switches: { on: {}, off: [] }, pick: null, page: null, saved: [] },
    packsFolder: {
      path: '/home/test/.local/share/atlas/packs',
      isDefault: true,
      exists: true,
      defaultPath: '/home/test/.local/share/atlas/packs',
      files: 2,
      bytes: 3_400_000,
      pick: null,
      refuse: null,
      left: [],
      calls: [],
    },
    keptPacks: {
      status: {
        on: false,
        folder: '/maps/packs',
        folderIsDefault: true,
        folderDefaultFrom: 'packsFolder',
        folderChosen: false,
        schedule: 'start',
        running: false,
        writing: null,
        lastCheckAt: null,
        problem: null,
        notice: null,
        games: [],
        serial: 1,
      },
      pick: null,
      games: [],
      calls: [],
    },
    background: {
      state: {
        keepRunning: false,
        onTop: false,
        hotkey: { on: false, keys: 'Ctrl+Alt+M', offered: 'Ctrl+Alt+M', problem: null },
        startWithSystem: { on: false, problem: null },
      },
      taken: [],
      startFails: null,
      calls: [],
    },
    guidebooks: { pick: null, added: null, calls: [] },
    steam: { status: steam ?? {}, calls: [] },
    updates: { check: { state: 'upToDate', version: '0.26.0' }, downloadFails: null, calls: [] },
  };
  /** The kept packs' state after a change: listed when on, with a new serial. */
  const keptPacks = () => {
    const kept = shell.keptPacks;
    kept.status.serial += 1;
    kept.status.games = kept.status.on ? kept.games : [];
    kept.status.lastCheckAt = kept.status.on ? '2026-11-12T10:00:00Z' : kept.status.lastCheckAt;
    return structuredClone(kept.status);
  };
  (window as unknown as { __mockShell: MockShell }).__mockShell = shell;
  const write = (
    window as unknown as { __writePack: (id: string, files: unknown) => Promise<void> }
  ).__writePack;
  let current: {
    url: string;
    polls: number;
    keep: boolean;
    previous: string | null;
    /** Opened for the person to browse: each page they go to is handed over once. */
    browse?: boolean;
    read?: boolean;
  } | null = null;
  // The person goes to another page in a window opened for browsing (see `browseTo`).
  (window as unknown as { __browseTo: (url: string) => void }).__browseTo = (url) => {
    if (!current?.browse) throw new Error('No window is open for browsing.');
    current = { ...current, url, polls: 0, read: false };
    shell.events.push({ what: 'browse', url, at: Date.now() });
  };
  const packs: Record<string, unknown>[] = structuredClone(listed);
  const sources: Record<
    string,
    { key: string; url: string; importedAt: string; mapId?: string; data: string }[]
  > = {};
  // What each pack written holds, and the pages it was made from, for the Library's facts.
  const contents: Record<string, Record<string, number>> = {};
  const written: Record<string, { url: string; mapId?: string; importedAt?: string }[]> =
    Object.fromEntries(
      listed.flatMap((pack) =>
        Array.isArray(pack.pages) && pack.pages.length > 0
          ? [[pack.id as string, pack.pages as { url: string }[]]]
          : [],
      ),
    );
  /** The packs folder the person picked and has not confirmed yet. */
  let pendingPacksFolder: string | null = null;
  /** What changing the packs folder to `path` would do, or the sentence that refuses it. */
  const packsFolderChoice = (path: string) => {
    const folder = shell.packsFolder;
    if (folder.refuse) {
      const refusal = folder.refuse;
      folder.refuse = null;
      // Tauri rejects with the command's error value, a string.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw refusal;
    }
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (path === folder.path) throw 'That is the packs folder already.';
    pendingPacksFolder = path;
    return {
      path,
      current: folder.path,
      isDefault: path === folder.defaultPath,
      files: folder.files,
      bytes: folder.bytes,
      sameDrive: !path.startsWith('/media/'),
    };
  };
  const listing = () => ({
    mapsFolder: { path: '/maps', isDefault: true, exists: true },
    ...(packsFolder
      ? {
          packsFolder: {
            path: shell.packsFolder.path,
            exists: shell.packsFolder.exists,
            isDefault: shell.packsFolder.isDefault,
          },
        }
      : {}),
    packs: structuredClone(packs),
    hidden: [],
    locations: [],
    busy: [],
  });
  const mapsOf = (world: string) => ({ ...worlds[world]?.maps, ...shell.extra[world] });
  const mapData = (world: string, map: string) => {
    const site = worlds[world];
    const maps = mapsOf(world);
    const slug = map === 'broken' ? (Object.keys(maps)[0] ?? map) : map;
    const name = maps[slug];
    if (!site || !name || map === 'never') return null;
    return {
      world: { slug: world, name: site.name },
      map: {
        slug,
        name,
        width: 512,
        height: 512,
        maxZoom: 1,
        tiles: `https://tiles.example.com/${slug}/{z}/{x}/{y}.png`,
      },
      places:
        map === 'broken'
          ? [{ id: 'one', name: '', kind: 1, x: 'a', y: null }]
          : [
              { id: 1, name: `${name} beacon`, kind: 'beacon', x: 100, y: 120 },
              { id: 2, name: `${name} camp`, kind: 'camp', x: 400, y: 300 },
            ],
    };
  };
  const pageData = (address: string) => {
    const url = new URL(address);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'demo-maps') return null;
    const [, world = '', second, third] = parts;
    const site = worlds[world];
    const base = `${url.origin}/demo-maps`;
    if (parts.length === 1) {
      // The list of worlds: a world with one map links straight to it.
      return {
        heading: 'Demo map site',
        links: [
          ...Object.entries(worlds).map(([slug, other]) => {
            const maps = Object.keys(other.maps);
            return {
              href: maps.length === 1 ? `${base}/${slug}/${maps[0]}` : `${base}/${slug}`,
              text: other.name,
            };
          }),
          { href: 'https://elsewhere.example.org/demo-maps/far-away', text: 'Far away' },
        ],
      };
    }
    if (!site) return null;
    if (parts.length === 2) {
      // A game page: its maps, checklists and guides, and a link to another world.
      return {
        heading: site.name,
        links: [
          { href: `${base}/test-hills`, text: 'Test Hills' },
          ...Object.keys(site.guides ?? {}).map((slug) => ({
            href: `${base}/${world}/guides/${slug}`,
            text: site.guides![slug]!,
          })),
          ...Object.entries(mapsOf(world)).map(([slug, name]) => ({
            href: `${base}/${world}/${slug}`,
            text: name,
          })),
          ...Object.entries(site.checklists ?? {}).map(([slug, list]) => ({
            href: `${base}/${world}/checklists/${slug}/`,
            text: list.name,
          })),
          // The same map twice, as sites do.
          ...Object.keys(mapsOf(world))
            .slice(0, 1)
            .map((slug) => ({ href: `${base}/${world}/${slug}?from=menu`, text: '' })),
        ],
      };
    }
    if (second === 'checklists' && third) {
      const list = site.checklists?.[third];
      return list
        ? { world: { slug: world, name: site.name }, checklist: { slug: third, ...list } }
        : null;
    }
    return parts.length === 3 && second ? mapData(world, second) : null;
  };
  /**
   * What the made-up wiki answers for an address: robots.txt, its contents
   * and its pages, as JSON (a page given as HTML, as HTML).
   */
  const wikiAnswer = (address: string) => {
    const answer = (status: number, body: unknown) => ({
      url: address,
      finalUrl: address,
      status,
      contentType: 'application/json',
      text: typeof body === 'string' ? body : JSON.stringify(body),
      retryAfter: null,
    });
    const at = new URL(address);
    // A made-up page of a test's own (`pages`), as HTML; its site's robots.txt allows all.
    const own = Object.keys(pages).some((key) => new URL(key).origin === at.origin);
    if (own) {
      if (at.pathname === '/robots.txt') return answer(200, 'User-agent: *\nAllow: /');
      const html = pages[`${at.origin}${at.pathname}${at.search}`];
      return html === undefined
        ? answer(404, 'Not found')
        : { ...answer(200, html), contentType: 'text/html' };
    }
    // The Example Wiki, or a wiki only the "Other wikis" importer reads.
    const site = at.origin === 'https://wiki.example.org' ? wiki : (others[at.hostname] ?? null);
    if (!site || at.protocol !== 'https:') return null;
    if (at.pathname === '/robots.txt') return answer(200, 'User-agent: *\nDisallow: /private/');
    const slug = at.pathname.replace(/^\/wiki\//, '');
    if (slug === 'Contents') {
      return answer(200, {
        headings: site.headings.map((heading) => ({
          title: heading.title,
          pages: heading.pages.map((page) => ({
            slug: page,
            title: site.pages[page]?.title ?? page.replaceAll('_', ' '),
          })),
        })),
      });
    }
    if (site.busy?.includes(slug)) return answer(503, 'Busy');
    const page = site.pages[slug];
    // Forwarded: the page it leads to, answered from its own address.
    const forward = page?.forward;
    if (forward) {
      const to = site.pages[forward];
      const finalUrl = `${at.origin}/wiki/${forward}`;
      return to ? { ...answer(200, to), finalUrl } : { ...answer(404, 'Not found'), finalUrl };
    }
    if (page?.html !== undefined) return { ...answer(200, page.html), contentType: 'text/html' };
    return page ? answer(200, page) : answer(404, 'Not found');
  };
  /** A wiki page as a window shows it: what its reader would read, in the shape of a fetched page. */
  const wikiWindowData = (address: string) => {
    const answer = wikiAnswer(address);
    if (!answer) return null;
    const { retryAfter: _, ...page } = answer;
    return { fetched: [page] };
  };
  /** A made-up PNG's bytes in base64: the PNG signature and a few bytes. */
  const PNG = btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3));
  /**
   * A page as the browse reader would read it from a window the person
   * browses: an article page of a wiki, with the picture it shows; null for
   * anything else (a page the wiki does not have), as the reader returns.
   */
  const browsedData = (address: string) => {
    const data = wikiWindowData(address);
    const at = new URL(address);
    const site = others[at.hostname] ?? (at.origin === 'https://wiki.example.org' ? wiki : null);
    const slug = at.pathname.replace(/^\/wiki\//, '');
    if (!data || data.fetched[0]?.status !== 200) return null;
    const picture = site?.pages[slug]?.picture;
    return picture ? { ...data, shown: [{ alt: picture, type: 'image/png', data: PNG }] } : data;
  };
  /**
   * "Atlas in the background", as the shell's `background` module answers
   * it: the same sentences for what this stand-in refuses. Not offered: the
   * shell's answer of an app that does not offer it.
   */
  const answerBackground = (command: string, args: Record<string, unknown>) => {
    const kept = shell.background;
    kept.calls.push({ command, args });
    // Tauri rejects with the command's error value, a string.
    /* eslint-disable @typescript-eslint/only-throw-error */
    if (!background) throw 'Atlas runs in the background only on Windows for now.';
    const state = kept.state;
    const taken = (keys: string) =>
      `Another program uses ${keys} already, so Atlas cannot. Choose another combination.`;
    if (command === 'background_set') {
      const on = args.on === true;
      switch (args.setting) {
        case 'keepRunning':
          state.keepRunning = on;
          break;
        case 'onTop':
          state.onTop = on;
          break;
        case 'hotkey':
          if (on && kept.taken.includes(state.hotkey.keys)) throw taken(state.hotkey.keys);
          state.hotkey.on = on;
          state.hotkey.problem = null;
          break;
        case 'startWithSystem':
          if (kept.startFails) throw kept.startFails;
          state.startWithSystem.on = on;
          break;
        default:
          throw 'Atlas has no such setting.';
      }
    }
    if (command === 'background_set_hotkey') {
      const press = args.keys as {
        code: string;
        ctrl: boolean;
        alt: boolean;
        shift: boolean;
        win: boolean;
      };
      const key = /^Key([A-Z])$|^Digit(\d)$|^(F\d{1,2})$/.exec(press.code);
      if (!key)
        throw 'Atlas cannot use this key for the hotkey. Press a letter, a digit or a function key with it.';
      if (!press.ctrl && !press.alt && !press.shift && !press.win) {
        throw 'Press at least one of Ctrl, Alt, Shift or the Windows key together with one other key.';
      }
      const keys = [
        press.ctrl ? 'Ctrl+' : '',
        press.alt ? 'Alt+' : '',
        press.shift ? 'Shift+' : '',
        press.win ? 'Win+' : '',
        key[1] ?? key[2] ?? key[3],
      ].join('');
      if (keys === 'Alt+F4') throw 'Windows keeps Alt+F4 for itself. Choose another combination.';
      if (state.hotkey.on && kept.taken.includes(keys)) throw taken(keys);
      state.hotkey.keys = keys;
    }
    /* eslint-enable @typescript-eslint/only-throw-error */
    return structuredClone(state);
  };
  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case 'desktop_info':
        return {
          name: 'Atlas',
          version: updates ? '0.26.0' : '0.0.0',
          platform: updates?.platform ?? (steamLaunch || exit ? 'linux' : 'test'),
          downloads,
          sites: downloads,
          ...(background ? { background: true } : {}),
          ...(steamLaunch ? { steamLaunch } : {}),
          ...(steam ? { steam: true } : {}),
          ...(exit ? { exit: true } : {}),
          ...(updates ? { updates: updates.way } : {}),
        };
      case 'update_check': {
        const kept = shell.updates;
        kept.calls.push(command);
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (typeof kept.check === 'string') throw kept.check;
        return structuredClone(kept.check);
      }
      case 'update_download': {
        const kept = shell.updates;
        kept.calls.push(command);
        // Half, then all of a made-up 120 MB, a moment apart.
        await new Promise((resolve) => setTimeout(resolve, 600));
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (kept.downloadFails) throw kept.downloadFails;
        await new Promise((resolve) => setTimeout(resolve, 600));
        return null;
      }
      case 'update_progress':
        return shell.updates.calls.includes('update_download')
          ? { state: 'downloading', received: 60_000_000, total: 120_000_000 }
          : { state: 'idle' };
      case 'update_install':
        // The real shell ends Atlas here and starts the new version; the stand-in only notes the call.
        shell.updates.calls.push(command);
        return null;
      case 'app_exit':
        // The real shell ends the app here; the stand-in only notes the call.
        shell.background.calls.push({ command, args });
        return null;
      case 'steam_status':
        return structuredClone(shell.steam.status);
      case 'steam_set': {
        // Written at once while Steam is closed; else it waits.
        const kept = shell.steam;
        kept.calls.push({ command, args });
        const status = kept.status;
        const on = args.on === true;
        if (typeof args.user === 'string') status.user = args.user;
        status.wanted = on;
        status.waiting = status.running === true;
        status.inSteam = on && status.running !== true;
        return structuredClone(status);
      }
      case 'steam_restart': {
        // The helper closes Steam, writes and starts it again.
        const kept = shell.steam;
        kept.calls.push({ command, args });
        kept.status.waiting = false;
        kept.status.inSteam = kept.status.wanted;
        return null;
      }
      case 'background_state':
      case 'background_set':
      case 'background_set_hotkey':
      case 'background_pause_hotkey':
        return answerBackground(command, args);
      case 'sites_list':
        return {
          folder: '/maps/Sites',
          files: Object.keys(shell.sites.files)
            .sort()
            .map((name) => ({ name, text: shell.sites.files[name] })),
          switches: structuredClone(shell.sites.switches),
        };
      case 'sites_pick': {
        const picked = shell.sites.pick;
        shell.sites.pick = null;
        return picked;
      }
      case 'sites_pick_page': {
        const picked = shell.sites.page;
        shell.sites.page = null;
        return picked;
      }
      case 'sites_add':
        shell.sites.files[args.name as string] = args.text as string;
        return null;
      case 'sites_remove': {
        const name = args.name as string;
        const had = name in shell.sites.files;
        /* eslint-disable @typescript-eslint/no-dynamic-delete */
        delete shell.sites.files[name];
        delete shell.sites.switches.on[args.key as string];
        /* eslint-enable @typescript-eslint/no-dynamic-delete */
        return had;
      }
      case 'sites_switch':
        shell.sites.switches = structuredClone(
          args.switches as { on: Record<string, string>; off: string[] },
        );
        return structuredClone(shell.sites.switches);
      case 'sites_save': {
        const what = args.what as string;
        shell.sites.saved.push({ what, contents: args.contents as string });
        return { name: what === 'guide' ? 'atlas-site-rules.md' : 'atlas-site-rules.schema.json' };
      }
      case 'library_list':
        return listing();
      case 'library_free_space':
        // A made-up drive with 3 GB free.
        return 3_000_000_000;
      case 'guidebook_pick': {
        shell.guidebooks.calls.push({ command, args });
        const picked = shell.guidebooks.pick;
        shell.guidebooks.pick = null;
        return picked;
      }
      case 'guidebook_forget_picked':
        shell.guidebooks.calls.push({ command, args });
        return null;
      case 'guidebook_add': {
        shell.guidebooks.calls.push({ command, args: structuredClone(args) });
        const added = structuredClone(shell.guidebooks.added);
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (!added) throw 'Pick the guidebook’s file again.';
        const at = packs.findIndex((pack) => pack.id === added.id);
        if (at >= 0) packs[at] = added;
        else packs.push(added);
        const request = args.request as { title: string; gameTitle: string };
        return {
          packId: added.id,
          message: `${request.title} was added to the guidebooks of ${request.gameTitle}. Its pack file is in the packs folder.`,
          listing: listing(),
        };
      }
      case 'guidebook_remove': {
        shell.guidebooks.calls.push({ command, args: structuredClone(args) });
        const at = packs.findIndex((pack) => pack.id === args.packId);
        if (at >= 0) packs.splice(at, 1);
        return { packId: args.packId, message: 'The guidebook was removed.', listing: listing() };
      }
      case 'library_choose_packs_folder': {
        const folder = shell.packsFolder;
        folder.calls.push(command);
        const picked = folder.pick;
        folder.pick = null;
        return picked === null ? null : packsFolderChoice(picked);
      }
      case 'library_default_packs_folder':
        shell.packsFolder.calls.push(command);
        return packsFolderChoice(shell.packsFolder.defaultPath);
      case 'library_apply_packs_folder': {
        const folder = shell.packsFolder;
        const moveFiles = args.moveFiles === true;
        folder.calls.push(`${command} ${moveFiles ? 'move' : 'leave'}`);
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        if (pendingPacksFolder === null) throw 'Choose the new folder first.';
        const target = pendingPacksFolder;
        pendingPacksFolder = null;
        const left = moveFiles ? folder.left : [];
        const moved = moveFiles ? folder.files - left.length : 0;
        folder.path = target;
        folder.isDefault = target === folder.defaultPath;
        folder.files = moved;
        folder.left = [];
        return {
          folder: target,
          moved,
          renamed: moved > 1 ? [{ from: 'a.atlaspack', to: `${target}/a (2).atlaspack` }] : [],
          left,
        };
      }
      case 'import_open':
        current = {
          url: args.url as string,
          polls: 0,
          keep: args.keep === true,
          previous: null,
          ...(args.browse === true ? { browse: true, read: false } : {}),
        };
        shell.events.push({
          what: 'open',
          url: current.url,
          at: Date.now(),
          ...(typeof args.purpose === 'string' ? { purpose: args.purpose } : {}),
          ...(current.keep ? { keep: true } : {}),
          ...(current.browse ? { browse: true } : {}),
        });
        return null;
      case 'import_navigate': {
        // The person closed the window: nothing is opened.
        if (!current) return 'closed';
        if (current.browse) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'The person browses in this window, so this app does not move it.';
        }
        if (!current.keep) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'The page window is not kept for the next page.';
        }
        current = { url: args.url as string, polls: 0, keep: true, previous: current.url };
        shell.events.push({ what: 'navigate', url: current.url, at: Date.now() });
        return 'navigated';
      }
      case 'import_poll': {
        if (!current) return { state: 'failed', message: 'No page is open.' };
        current.polls++;
        shell.events.push({ what: 'poll', url: current.url, at: Date.now() });
        const slug = new URL(current.url).pathname.split('/').filter(Boolean).pop() ?? '';
        if (shell.close.includes(slug)) {
          current = null;
          return { state: 'closed' };
        }
        if (current.browse) {
          // Each page the person opens, once it has loaded, once; never while it shows a check.
          const browsed = browsedData(current.url);
          if (current.read || current.polls < 2 || shell.check.includes(slug) || !browsed) {
            return { state: 'waiting', loading: current.polls < 2, note: null };
          }
          current.read = true;
          shell.events.push({ what: 'read', url: current.url, at: Date.now() });
          return { state: 'ready', data: JSON.stringify(browsed), address: current.url };
        }
        if (shell.lag && current.previous && current.polls === 1) {
          // Still the page before, handed over as if it were the new one.
          return {
            state: 'ready',
            data: JSON.stringify(wikiWindowData(current.previous) ?? pageData(current.previous)),
            address: current.previous,
          };
        }
        if (shell.check.includes(slug)) {
          return { state: 'waiting', loading: false, note: null, attention: current.polls > 3 };
        }
        const data = wikiWindowData(current.url) ?? pageData(current.url);
        if (!data || shell.hold.includes(slug) || current.polls < 2) {
          return { state: 'waiting', loading: current.polls < 2, note: null };
        }
        shell.events.push({ what: 'read', url: current.url, at: Date.now() });
        return {
          state: 'ready',
          data: JSON.stringify(data),
          ...(current.keep ? { address: current.url } : {}),
        };
      }
      case 'import_fetch': {
        // The made-up wiki: robots.txt, its contents and its pages.
        const address = args.url as string;
        shell.events.push({ what: 'fetch', url: address, at: Date.now() });
        const answer = wikiAnswer(address);
        if (!answer) {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'The site could not be reached.';
        }
        return answer;
      }
      case 'import_close':
        if (current) shell.events.push({ what: 'close', url: current.url, at: Date.now() });
        current = null;
        return null;
      case 'import_report':
        shell.reports.push(args.report as MockShell['reports'][number]);
        return null;
      case 'library_style_texts':
        shell.events.push({ what: 'styles', url: null, at: Date.now() });
        return structuredClone(shell.styleTexts[args.packId as string] ?? []);
      case 'library_import_sources':
        return (sources[args.packId as string] ?? []).map((source) => ({ ...source }));
      case 'library_import_source_list':
        return (sources[args.packId as string] ?? []).map(({ data: _, ...page }) => page);
      case 'library_import_source': {
        const asked = (sources[args.packId as string] ?? []).find((s) => s.key === args.key);
        shell.events.push({ what: 'source', url: asked?.url ?? null, at: Date.now() });
        if (shell.slowSources > 0) {
          await new Promise((resolve) => setTimeout(resolve, shell.slowSources));
        }
        const one = (sources[args.packId as string] ?? []).find((s) => s.key === args.key);
        return one ? { ...one } : null;
      }
      case 'library_save_import': {
        const request = args.request as {
          packId: string;
          importer: { id: string; title: string };
          sourceKey: string;
          pageUrl: string;
          importedAt: string;
          mapId?: string;
          pageData: string;
          files: Record<string, string>;
          pictures?: Record<string, string>;
        };
        shell.events.push({ what: 'save', url: request.pageUrl, at: Date.now() });
        await write(request.packId, request.files);
        if (request.pictures) {
          (shell.pictures[request.packId] ??= []).push(...Object.keys(request.pictures));
        }
        const kept = (sources[request.packId] ??= []);
        const at = kept.findIndex((source) => source.key === request.sourceKey);
        const source = {
          key: request.sourceKey,
          url: request.pageUrl,
          importedAt: request.importedAt,
          ...(request.mapId ? { mapId: request.mapId } : {}),
          data: request.pageData,
        };
        if (at >= 0) kept[at] = source;
        else kept.push(source);
        const manifest = JSON.parse(request.files['manifest.json']!) as {
          title: string;
          packVersion: string;
          source?: { pages: { url: string; mapId?: string; importedAt?: string }[] };
          personalUse?: unknown;
        };
        written[request.packId] = manifest.source?.pages ?? [];
        const listed = {
          id: request.packId,
          title: manifest.title,
          url: `http://atlas-pack.localhost/${request.packId}/`,
          origin: 'maps-folder',
          path: `/maps/${request.packId}`,
          packVersion: manifest.packVersion,
          bundled: false,
          imported: { importerId: request.importer.id, importerTitle: request.importer.title },
          pages: (manifest.source?.pages ?? []).map((page) => ({
            url: page.url,
            mapId: page.mapId ?? null,
          })),
          // As the shell reads it: only `true` marks the game kept for personal use.
          personalUse: manifest.personalUse === true,
        };
        const count = (file: string) => {
          try {
            return (JSON.parse(request.files[file] ?? '[]') as unknown[]).length;
          } catch {
            return 0;
          }
        };
        contents[request.packId] = {
          maps: count('maps.json'),
          layers: count('layers.json'),
          locations: count('locations.json'),
          categories: count('categories.json'),
          regions: count('regions.json'),
          checklists: count('checklists.json'),
          guides: count('guides.json'),
        };
        const index = packs.findIndex((pack) => pack.id === request.packId);
        if (index >= 0) packs[index] = listed;
        else packs.push(listed);
        return listing();
      }
      case 'library_images_info':
        return { files: 0, bytes: 0, downloading: false };
      case 'library_delete_pack': {
        // The pack and everything kept with it go.
        const id = args.id as string;
        shell.events.push({ what: 'delete', url: id, at: Date.now() });
        const index = packs.findIndex((pack) => pack.id === id);
        if (index >= 0) packs.splice(index, 1);
        /* eslint-disable @typescript-eslint/no-dynamic-delete */
        delete sources[id];
        delete contents[id];
        delete written[id];
        delete shell.pictures[id];
        /* eslint-enable @typescript-eslint/no-dynamic-delete */
        return { complete: true };
      }
      case 'library_pack_details': {
        // The demo pack that comes with the app, or a pack written here.
        const id = args.id as string;
        return {
          pack: { id, title: id, packVersion: '1.0.0', schemaVersion: 1, attribution: [] },
          source: written[id]
            ? { kind: 'web-pages', pages: written[id] }
            : { kind: 'app', pages: [] },
          contents: contents[id] ?? {
            maps: 2,
            layers: 3,
            locations: 5000,
            categories: 4,
            regions: 0,
            checklists: 1,
            guides: 1,
          },
          layers: [],
          detail: null,
          imagesAt: null,
          archive: false,
          packFile: null,
        };
      }
      case 'packfile_options': {
        // Export is not offered here: this stand-in writes no pack files.
        const listed = packs.find((pack) => pack.id === args.id);
        return {
          packId: args.id,
          title: listed?.title ?? '',
          exportable: false,
          reason: 'This stand-in shell writes no pack files.',
          details: [],
          wholeLayers: [],
          defaultNames: { overview: '', standard: '', full: '' },
          downloading: false,
        };
      }
      case 'kept_packs_status':
        shell.keptPacks.calls.push(command);
        return structuredClone(shell.keptPacks.status);
      case 'kept_packs_choose_folder': {
        const kept = shell.keptPacks;
        kept.calls.push(command);
        if (!kept.pick) return null;
        Object.assign(kept.status, {
          on: true,
          folder: kept.pick,
          folderIsDefault: false,
          folderChosen: true,
        });
        return keptPacks();
      }
      case 'kept_packs_set': {
        const choice = args.choice as { on: boolean; schedule: string };
        shell.keptPacks.calls.push(`${command} ${choice.on ? 'on' : 'off'} ${choice.schedule}`);
        Object.assign(shell.keptPacks.status, choice);
        return keptPacks();
      }
      case 'kept_packs_write_again': {
        const kept = shell.keptPacks;
        kept.calls.push(`${command} ${String(args.id)}`);
        kept.games = kept.games.map((game) =>
          game.id === args.id ? { ...game, state: 'up-to-date', reason: null } : game,
        );
        return keptPacks();
      }
      case 'kept_packs_write_all':
      case 'kept_packs_cancel':
        shell.keptPacks.calls.push(command);
        return keptPacks();
      case 'kept_packs_reveal':
        shell.keptPacks.calls.push(command);
        return null;
      case 'library_old_folders':
        // The settings of an app without downloads: no old folders here.
        return { mapsFolder: '/maps', siteReader: false, folders: [], madeHere: [] };
      case 'made_pack_mine_offer':
        // No pack file of a map made in the app here: never an offer.
        return null;
      case 'made_pack_plan':
      case 'made_pack_write':
      case 'made_pack_open_plan':
      case 'made_pack_open':
      case 'made_pack_close':
      case 'made_pack_mine_take':
      case 'made_pack_mine_choose':
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'This stand-in shell writes no pack files.';
      default:
        // Tauri rejects with the command's error value, a string.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw `Unknown command ${command}`;
    }
  };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke };
}

/** Lists the demo importer in `config.json`, serves it, and serves the packs the fake shell writes. */
export async function setUp(
  page: Page,
  downloads = DOWNLOADS_BUILD,
  {
    wiki = null,
    others = null,
    listed = [],
    background = false,
    packsFolder = false,
    served = {},
    steamLaunch = null,
    steam = null,
    exit = false,
    pages = {},
    importers = [],
    updates = null,
  }: {
    wiki?: WikiSite | null;
    /** Wikis no importer knows, by host, read by the "Other wikis" importer (a general reader). */
    others?: Record<string, WikiSite> | null;
    /** Packs the shell lists from the start, as it lists packs in the maps folder (`ListedPack`). */
    listed?: Record<string, unknown>[];
    /** The shell offers "Atlas in the background" (the app without downloads on Windows). */
    background?: boolean;
    /** The shell lists the packs folder, which can be changed (see {@link MockShell.packsFolder}). */
    packsFolder?: boolean;
    /**
     * The shell runs on Linux and gives the Steam launch line it built
     * (`DesktopInfo::steam_launch`, see the shell's `linux.rs`).
     */
    steamLaunch?: Record<string, string> | null;
    /**
     * The shell offers "Atlas in Steam" (`DesktopInfo::steam`), and this is
     * what `steam_status` answers first (a `SteamStatus`).
     */
    steam?: Record<string, unknown> | null;
    /** The shell offers "Exit Atlas" whatever the settings (`DesktopInfo::exit`, on Linux). */
    exit?: boolean;
    /**
     * Files the pack protocol serves, by pack id (or `_picked/<token>`) and
     * name, read in parts as the shell serves them (`Range`, `206`).
     */
    served?: Record<string, Record<string, Buffer | string>>;
    /** Made-up pages answered as HTML by `import_fetch`, by address (no fragment), on sites of their own. */
    pages?: Record<string, string>;
    /** More made-up importers the build lists, each module's source given. */
    importers?: { id: string; title: string; source: string }[];
    /**
     * How the shell says this copy updates (`DesktopInfo::updates`), and the
     * system it runs on; see {@link MockShell.updates} for its answers.
     */
    updates?: { way: Record<string, unknown>; platform: string } | null;
  } = {},
) {
  const packs: Record<string, Record<string, string>> = {};
  await page.exposeFunction('__writePack', (id: string, files: Record<string, string>) => {
    packs[id] = files;
  });
  const importer = await readFile(IMPORTER, 'utf8');
  const wikiImporter = wiki?.inWindow
    ? windowedWikiImporter(await readFile(WIKI_IMPORTER, 'utf8'))
    : await readFile(WIKI_IMPORTER, 'utf8');
  const otherWikis = await readFile(OTHER_WIKIS_IMPORTER, 'utf8');
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      json: {
        ...config,
        importers: [
          {
            id: 'demo-maps',
            title: 'Demo map site',
            description: 'Reads the made-up demo map site.',
            version: '1.0.0',
            module: 'importers/demo-maps.js',
          },
          ...(wiki
            ? [
                {
                  id: 'example-wiki',
                  title: 'Example Wiki',
                  description: 'Reads the made-up Example Wiki.',
                  version: '1.0.0',
                  module: 'importers/example-wiki.js',
                },
              ]
            : []),
          ...importers.map(({ id, title }) => ({
            id,
            title,
            description: `Reads made-up pages (${title}).`,
            version: '1.0.0',
            module: `importers/${id}.js`,
          })),
          ...(others
            ? [
                {
                  id: 'other-wikis',
                  title: 'Other wikis',
                  description: 'Reads made-up wikis this app does not know.',
                  version: '1.0.0',
                  module: 'importers/other-wikis.js',
                },
              ]
            : []),
        ],
      },
    });
  });
  await page.route('**/importers/demo-maps.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: importer }),
  );
  await page.route('**/importers/example-wiki.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: wikiImporter }),
  );
  await page.route('**/importers/other-wikis.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: otherWikis }),
  );
  for (const { id, source } of importers) {
    await page.route(`**/importers/${id}.js`, (route) =>
      route.fulfill({ contentType: 'text/javascript', body: source }),
    );
  }
  await page.route(`${PACKS}**`, (route) => {
    const [, id = '', name = ''] =
      /^\/([^/]+)\/(.+)$/.exec(new URL(route.request().url()).pathname) ?? [];
    const path = new URL(route.request().url()).pathname;
    const file = Object.entries(served).find(([pack]) => path.startsWith(`/${pack}/`));
    if (file) return serveFile(route, file[1][path.slice(file[0].length + 2)]);
    const body = packs[id]?.[name];
    const headers = { 'access-control-allow-origin': '*' };
    return body === undefined
      ? route.fulfill({ status: 404, headers, body: 'not found' })
      : route.fulfill({ headers, contentType: 'application/json', body });
  });
  await page.clock.install();
  await page.addInitScript(installFakeShell, {
    worlds: WORLDS,
    downloads,
    wiki,
    others: others ?? {},
    pages,
    listed,
    background,
    packsFolder,
    steamLaunch,
    steam,
    exit,
    updates,
  });
  await page.goto('./');
  await expect(page.getByTestId('marker-count')).toHaveText('5,000');
}

/** Answers a request for a file the pack protocol serves, a part of it when a range is asked for. */
function serveFile(route: Route, file: Buffer | string | undefined) {
  const headers: Record<string, string> = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Accept-Ranges, Content-Length, Content-Range',
    'accept-ranges': 'bytes',
  };
  if (route.request().method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: { ...headers, 'access-control-allow-headers': 'Range' },
    });
  }
  if (file === undefined) return route.fulfill({ status: 404, headers, body: 'not found' });
  const body = typeof file === 'string' ? Buffer.from(file) : file;
  const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
  if (!range) return route.fulfill({ headers, body });
  const start = Number(range[1]);
  const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
  if (start > end) {
    return route.fulfill({
      status: 416,
      headers: { ...headers, 'content-range': `bytes */${body.length}` },
    });
  }
  return route.fulfill({
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${body.length}` },
    body: body.subarray(start, end + 1),
  });
}

/** Changes the stand-in of "Atlas in the background" (see {@link MockShell.background}). */
export const setBackground = (
  page: Page,
  change: { taken?: string[]; startFails?: string | null },
) =>
  page.evaluate((change) => {
    Object.assign((window as unknown as { __mockShell: MockShell }).__mockShell.background, change);
  }, change);

export const mock = (page: Page) =>
  page.evaluate(() => (window as unknown as { __mockShell: MockShell }).__mockShell);

/**
 * The Example Wiki's importer with its pages (not its contents) opened in a
 * window (`fetch.inWindow`), as for a site that shows its pages only to a
 * person. The fake shell hands over the data itself, so the reader is never run.
 */
function windowedWikiImporter(source: string): string {
  const fetchPart = `  fetch: {
    addresses: (url) => (isPage(url) ? [url.trim()] : []),
  },`;
  if (!source.includes(fetchPart))
    throw new Error('The Example Wiki importer changed: update fakeShell.ts.');
  return source.replace(
    fetchPart,
    `  fetch: {
    addresses: (url) => (isPage(url) ? [url.trim()] : []),
    inWindow: (url) => isPage(url),
  },
  pageReader: '() => null',`,
  );
}

/** The person goes to `url` in the window opened for browsing, as they would by a link. */
export const browseTo = (page: Page, url: string) =>
  page.evaluate((url) => {
    (window as unknown as { __browseTo: (url: string) => void }).__browseTo(url);
  }, url);

/** The file the person chooses at the next "Add a rules file…". */
export const pickSiteFile = (page: Page, file: { name: string; text: string }) =>
  page.evaluate((file) => {
    (window as unknown as { __mockShell: MockShell }).__mockShell.sites.pick = file;
  }, file);

/** The page the person chooses at the next "Try on a saved page…". */
export const pickSavedPage = (page: Page, saved: { name: string; text: string }) =>
  page.evaluate((saved) => {
    (window as unknown as { __mockShell: MockShell }).__mockShell.sites.page = saved;
  }, saved);

/** Changes the stand-in of the packs folder (see {@link MockShell.packsFolder}). */
export const setPacksFolder = (page: Page, change: Partial<MockShell['packsFolder']>) =>
  page.evaluate((change) => {
    Object.assign(
      (window as unknown as { __mockShell: MockShell }).__mockShell.packsFolder,
      change,
    );
  }, change);

/** The folder the person chooses in the next folder dialog of the kept packs, and the games listed. */
export const setKeptPacks = (
  page: Page,
  {
    status,
    ...kept
  }: {
    pick?: string | null;
    games?: Record<string, unknown>[];
    /** Changes to what `kept_packs_status` answers, sent with the next answer. */
    status?: Partial<KeptPacksState>;
  },
) =>
  page.evaluate(
    ({ kept, status }) => {
      const shell = (window as unknown as { __mockShell: MockShell }).__mockShell.keptPacks;
      Object.assign(shell, kept);
      Object.assign(shell.status, status ?? {});
    },
    { kept, status },
  );

export const setMock = (
  page: Page,
  patch: Partial<
    Pick<MockShell, 'hold' | 'close' | 'check' | 'lag' | 'extra' | 'slowSources' | 'styleTexts'>
  >,
) =>
  page.evaluate((patch) => {
    Object.assign((window as unknown as { __mockShell: MockShell }).__mockShell, patch);
  }, patch);

export const url = (world: string, map: string) => `${SITE}/${world}/${map}`;

export async function paste(page: Page, text: string) {
  await page.getByTestId('add-map-button').click();
  await page.getByTestId('add-map-url').fill(text);
}

export const rows = (page: Page) => page.getByTestId('add-map-run-page');

export async function expectStates(page: Page, states: string[]) {
  await expect(rows(page)).toHaveCount(states.length);
  for (const [i, state] of states.entries()) {
    await expect(rows(page).nth(i)).toHaveAttribute('data-state', state);
  }
}

/** The pages opened, in order, and checks that each was closed before the next opened, with the pause between. */
export async function openedPages(page: Page): Promise<string[]> {
  const { events } = await mock(page);
  const opened: string[] = [];
  let lastClose: number | null = null;
  let open: string | null = null;
  for (const event of events) {
    if (event.what === 'open') {
      expect(open, `${event.url} opened while ${open} was open`).toBeNull();
      if (lastClose !== null) expect(event.at - lastClose).toBeGreaterThanOrEqual(3000);
      open = event.url;
      opened.push(event.url!);
    } else if (event.what === 'close' && open) {
      lastClose = event.at;
      open = null;
    }
  }
  return opened;
}

/** Errors on the page, other than packs the fake shell has not written. */
export const realErrors = (errors: string[]) =>
  errors.filter((e) => !/Failed to load resource.*404/.test(e));
