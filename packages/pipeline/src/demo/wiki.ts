import {
  makeId,
  type GuideEntry,
  type GuideSource,
  type PackData,
  type Picture,
  type Section,
} from '@atlas/schema';
import sharp from 'sharp';
import { DEMO_GAME_ID } from './content';

/**
 * The demo's wiki: a few pages of a made-up "Example Wiki" about the
 * Sundered Isle, read as pages in the app's Guides section. Everything is
 * invented here: the site, its address (example.org, reserved for
 * examples), the text and the picture. It shows what a wiki read into a
 * pack looks like: a contents of sections, a table wider than a phone,
 * links between pages, hidden text, a picture, and the credit of each page.
 * Its gear pages say where things are in the ways wikis do (a heading, a
 * table column, a box of facts), for the build planner; the maul's page
 * has its box of facts beside its text, as wikis show one, with a picture,
 * a caption and sub-headings. "Getting around"
 * has headings enough for "On this page", a link to a section of its own
 * and one to a section of another page; `wiki-ferry` is another name of it
 * that leads to its section "By boat", as a wiki forwards a name, and the
 * regions link to that name. Its home page (`WIKI_HOME`, the manifest's
 * `homePage`) is a wiki's main page: a welcome line, a picture that leads
 * to a page, and groups of links to the main areas; it is in no section,
 * as Guides shows it on its own.
 */

const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

export const WIKI_SITE = 'Example Wiki';
export const WIKI_URL = 'https://wiki.example.org/';
export const WIKI_LICENSE = {
  name: 'CC BY-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-sa/4.0/',
} as const;

/** The pages of the demo wiki. */
export const WIKI_PAGES = {
  welcome: id('guide', 'wiki-welcome'),
  travel: id('guide', 'wiki-travel'),
  regions: id('guide', 'wiki-regions'),
  waystones: id('guide', 'wiki-waystones'),
  wardens: id('guide', 'wiki-wardens'),
  wolves: id('guide', 'wiki-wolves'),
  blades: id('guide', 'wiki-blades'),
  emberBlade: id('guide', 'wiki-ember-blade'),
  maul: id('guide', 'wiki-stonebreaker-maul'),
  charm: id('guide', 'wiki-tidecaller-charm'),
} as const;

/** The wiki's home page, its main page: in no section of the contents. */
export const WIKI_HOME = id('guide', 'wiki-main-page');

/**
 * Another name of a page, as a wiki forwards a name to a part of a page:
 * the page it is a name of, and the section it leads to there.
 */
export const WIKI_OTHER_NAME = {
  id: id('guide', 'wiki-ferry'),
  page: WIKI_PAGES.travel,
  section: 'by-boat',
} as const;

/** The sections of its contents. */
export const WIKI_SECTIONS = {
  basics: id('section', 'wiki-basics'),
  isle: id('section', 'wiki-isle'),
  foes: id('section', 'wiki-foes'),
  gear: id('section', 'wiki-gear'),
} as const;

export const WIKI_PICTURE = id('picture', 'wiki-waystone');
const PICTURE_FILE = 'pictures/wiki-waystone.png';
const PICTURE_SIZE = { width: 640, height: 400 } as const;
/** The maul's picture, in its box of facts. */
export const WIKI_MAUL_PICTURE = id('picture', 'wiki-maul');
const MAUL_FILE = 'pictures/wiki-maul.png';
const MAUL_SIZE = { width: 320, height: 320 } as const;

const source = (path: string): GuideSource => ({
  url: `${WIKI_URL}wiki/${path}`,
  site: WIKI_SITE,
  license: { ...WIKI_LICENSE },
  credit: 'By the contributors of the Example Wiki',
  readAt: '2026-11-01',
  adapted: true,
});

const page = (key: keyof typeof WIKI_PAGES, title: string, path: string, body: string) =>
  ({
    id: WIKI_PAGES[key],
    title,
    body: body.trim(),
    locationIds: [],
    source: source(path),
  }) satisfies GuideEntry;

const to = (key: keyof typeof WIKI_PAGES, text: string) => `[${text}](${WIKI_PAGES[key]})`;
/** A link to a section of a page, which its title names. */
const toSection = (key: keyof typeof WIKI_PAGES, section: string, text: string) =>
  `[${text}](${WIKI_PAGES[key]} "#${section}")`;

/** The wiki's home page: a welcome, a picture that leads to a page, and the main areas. */
export function wikiHomePage(): GuideEntry {
  return {
    id: WIKI_HOME,
    title: 'Main Page',
    body: `
Welcome to the **Example Wiki**, the made-up wiki of the Sundered Isle that anyone can edit.
Pick an area below, or start with ${to('welcome', 'the welcome page')}.

[![Waystones](${WIKI_PICTURE} "=320x200")](${WIKI_PAGES.waystones})

## The isle

- ${to('regions', 'Regions')}: from the landing outwards
- ${to('waystones', 'Waystones')}: waking them and travelling between them
- ${to('travel', 'Getting around')}: on foot, by boat and by waystone

## Foes

- ${to('wardens', 'Stone wardens')}
- ${to('wolves', 'Wolves')}

## Gear

- ${to('blades', 'Blades')}: ${to('emberBlade', 'Ember blade')}, ${to('maul', 'Stonebreaker maul')}
- ${to('charm', 'Tidecaller charm')}
`.trim(),
    locationIds: [],
    source: source('Main_Page'),
  };
}

/**
 * The wiki's pages, with their sources. Regions are named after the pack's
 * own, and the gear pages name a location of its map (`shrine`).
 */
export function wikiGuides(
  regionNames: readonly string[],
  shrine = 'Sunken shrine 1',
): GuideEntry[] {
  const regions = regionNames.length > 0 ? regionNames : ['The lowlands'];
  const rows = regions.map((name, i) => {
    const level = 4 + i * 6;
    return `| ${name} | ${level}–${level + 8} | ${['Mild', 'Windy', 'Wet', 'Cold', 'Dry'][i % 5]} | ${i % 2 === 0 ? 'Waystone at the crossroads' : 'Waystone by the old mill'} | ${i % 3 === 0 ? 'Bring rope for the cliffs' : 'Watch for drakes at dusk'} |`;
  });
  return [
    page(
      'welcome',
      'Welcome to the Sundered Isle',
      'Welcome',
      `
The **Sundered Isle** is a made-up island, split by an old quake into
${regions.length} regions. This wiki collects what travellers have learnt about it.

New here? Start with ${to('travel', 'Getting around')}, then read about the
${to('regions', 'regions of the isle')} and the ${to('waystones', 'waystones')} that join them.

## What you will find

- Pages on the isle and its ${to('wardens', 'stone wardens')}.
- Tables you can scroll sideways on a small screen.
- Answers hidden until you ask for them, like this one: ||the warden sleeps at noon||.

Nothing in this wiki is about a real game. It exists to show how Atlas reads one.
`,
    ),
    page(
      'travel',
      'Getting around',
      'Getting_around',
      `
Most of the isle is walked. The ${to('waystones', 'waystones')} let you travel
between the ones you have woken, and every region has at least one.

## On foot

1. Follow the river south from the landing.
2. Cross at the ford; the bridge is down.
3. Climb to the first waystone and touch it.

### At night

> Tip: the ${to('wolves', 'wolves')} of the northern woods hunt along the paths, not the river.

## By boat

The ferry runs between the two largest regions. It does not run at night, so
${toSection('travel', 'on-foot', 'walk')} after dark.

## By waystone

Touch a woken stone to travel to any other woken one.
${toSection('waystones', 'waking-a-waystone', 'Wake each one you pass')}.

See also: ${to('regions', 'Regions')}.
`,
    ),
    page(
      'regions',
      'Regions',
      'Regions',
      `
The isle's regions, from the landing outwards. Levels are what travellers
suggest, not rules.

| Region | Suggested level | Weather | Waystone | Advice |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

Each region has its own ${to('wardens', 'warden')}. Travel between them is
described under ${to('travel', 'Getting around')}; the two largest are also
joined [by boat](${WIKI_OTHER_NAME.id}).
`,
    ),
    page(
      'waystones',
      'Waystones',
      'Waystones',
      `
![A waystone on a hill at dusk](${WIKI_PICTURE})

Waystones are standing stones carved with a ring of marks. Touch one to wake it;
once woken, you can travel to it from any other woken waystone.

## Waking a waystone

| Step | What to do |
| --- | --- |
| 1 | Clear the foes around it. |
| 2 | Touch the stone. |
| 3 | Wait for the marks to glow. |

## The last waystone

||The last waystone is under the lake. Drain it at the old mill first.||

Back to ${to('travel', 'Getting around')}.
`,
    ),
    page(
      'wardens',
      'Stone wardens',
      'Stone_wardens',
      `
Stone wardens guard the heart of each region. They are slow, but every blow
they land is heavy.

## How to beat one

- Keep moving; a warden turns slowly.
- Strike after its slam, while its arms are in the ground.
- ||Its weak point is the crack on its back.||

Wardens are found near the ${to('waystones', 'waystones')} they protect.
`,
    ),
    page(
      'wolves',
      'Wolves',
      'Wolves',
      `
Wolves hunt in packs of three to five in the northern woods.

| Pack size | Where | When |
| --- | --- | --- |
| 3 | Woods' edge | Day |
| 5 | Deep woods | Night |

Fire keeps them back. Read ${to('travel', 'Getting around')} for the safer paths.
`,
    ),
    page(
      'blades',
      'Blades',
      'Blades',
      `
The blades of the isle, from light to heavy. A blade with a page of its own
leads there.

| Blade | Damage | Location |
| --- | --- | --- |
| ${to('emberBlade', 'Ember blade')} | 40 | ${shrine} |
| Saltglass dagger | 22 | A trader on the coast, now and then |
| ${to('maul', 'Stonebreaker maul')} | 55 | See its page |
`,
    ),
    page(
      'emberBlade',
      'Ember blade',
      'Ember_blade',
      `
A short sword that glows like coals. It is one of the ${to('blades', 'blades')} of the isle.

## Where to find

It rests in ${shrine}, past the flooded hall. ||The hall drains when you pull the second chain.||

## Materials

To temper it at a forge:

| Material | Amount |
| --- | --- |
| Moonpetal | 3 |
| Relic shard | 2 |
| Saltleaf | 1 |
`,
    ),
    page(
      'maul',
      'Stonebreaker maul',
      'Stonebreaker_maul',
      `
| Stonebreaker maul | {box} |
| --- | --- |
| ![A stone maul with a bound grip](${WIKI_MAUL_PICTURE} "=160x160") |  |
| *Cut from the arm of a fallen warden.* |  |
| Type | Heavy weapon |
| Weight | Heavy |
| Price | 1250 [gold]{color=#c9a227} |
| **Damage** |  |
| Damage | 55 |
| Slam | 80^\\[a\\]^ |
| Combo | Two swings<br>then a slam |
| **Where** |  |
| Found in | ${to('wardens', 'Stone wardens')} |

The **Stonebreaker maul** is a weapon too heavy for most. Stone wardens carry it,
and drop it when beaten.

## Using it

Swing it only when a foe is open: a swing takes a long time, and nothing stops it
once it starts. The slam at the end of a combo breaks shields and stuns small foes.

- Pair it with a light blade for quick foes.
- Its slam reaches foes behind a low wall.

## Notes

- \\[a\\] The slam deals more against stone foes.
- A maul dropped by a warden of the northern woods is no heavier than any other.
`,
    ),
    page(
      'charm',
      'Tidecaller charm',
      'Tidecaller_charm',
      `
A charm that hums when the sea is near.

## How to get

Bought from a travelling merchant, who turns up at random.
`,
    ),
  ];
}

/** The contents: three sections at the top, the second holding a fourth. */
export function wikiSections(): Section[] {
  return [
    {
      id: WIKI_SECTIONS.basics,
      title: 'Basics',
      items: [WIKI_PAGES.welcome, WIKI_PAGES.travel],
    },
    {
      id: WIKI_SECTIONS.isle,
      title: 'The isle',
      items: [WIKI_PAGES.regions, WIKI_PAGES.waystones, WIKI_SECTIONS.foes],
    },
    {
      id: WIKI_SECTIONS.foes,
      title: 'Foes',
      items: [WIKI_PAGES.wardens, WIKI_PAGES.wolves],
    },
    {
      id: WIKI_SECTIONS.gear,
      title: 'Gear',
      items: [WIKI_PAGES.blades, WIKI_PAGES.emberBlade, WIKI_PAGES.maul, WIKI_PAGES.charm],
    },
  ];
}

export function wikiPictures(): Picture[] {
  return [
    {
      id: WIKI_PICTURE,
      file: PICTURE_FILE,
      caption: 'A woken waystone',
      credit: 'Drawn by the Atlas pipeline',
      license: { ...WIKI_LICENSE },
      source: `${WIKI_URL}wiki/File:Waystone.png`,
      shareable: true,
      ...PICTURE_SIZE,
    },
    {
      id: WIKI_MAUL_PICTURE,
      file: MAUL_FILE,
      caption: 'A stone maul',
      credit: 'Drawn by the Atlas pipeline',
      license: { ...WIKI_LICENSE },
      source: `${WIKI_URL}wiki/File:Stonebreaker_maul.png`,
      shareable: true,
      ...MAUL_SIZE,
    },
  ];
}

/** Adds the wiki's pages, contents and picture, and credits the wiki. */
export function addWiki(data: PackData): PackData {
  const regionNames = data.regions.filter((r) => r.parentId !== null).map((r) => r.name);
  // A ruin of the map, named on the gear pages as where a blade is.
  const shrine = data.locations.find((l) => /^Sunken shrine \d+$/u.test(l.name))?.name;
  return {
    ...data,
    manifest: {
      ...data.manifest,
      attribution: [
        ...data.manifest.attribution,
        { name: WIKI_SITE, url: WIKI_URL, license: WIKI_LICENSE.name },
      ],
      // The other name of a page, and the section it leads to.
      idMigrations: { ...data.manifest.idMigrations, [WIKI_OTHER_NAME.id]: WIKI_OTHER_NAME.page },
      idSections: {
        ...data.manifest.idSections,
        [WIKI_OTHER_NAME.id]: WIKI_OTHER_NAME.section,
      },
      // The page Guides opens on.
      homePage: WIKI_HOME,
    },
    guides: [...data.guides, ...wikiGuides(regionNames.slice(0, 5), shrine), wikiHomePage()],
    sections: [...(data.sections ?? []), ...wikiSections()],
    pictures: [...(data.pictures ?? []), ...wikiPictures()],
  };
}

/** The wiki's picture files, by path in the pack: a waystone on a hill, drawn here. */
export async function wikiPictureFiles(): Promise<Map<string, Buffer>> {
  const { width, height } = PICTURE_SIZE;
  const marks = Array.from({ length: 7 }, (_, i) => {
    const y = 175 + i * 22;
    return `<rect x="${i % 2 === 0 ? 300 : 312}" y="${y}" width="${i % 2 === 0 ? 40 : 16}" height="6" rx="3" fill="#9fe3ff"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#28335e"/><stop offset="0.6" stop-color="#c06f5a"/><stop offset="1" stop-color="#f2b66d"/>
    </linearGradient>
    <linearGradient id="stone" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#6d7380"/><stop offset="1" stop-color="#3d424c"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="500" cy="250" r="46" fill="#ffd9a0" opacity="0.9"/>
  <path d="M0 300 Q160 230 320 280 T640 260 V400 H0Z" fill="#3f5a3a"/>
  <path d="M0 340 Q200 300 400 330 T640 320 V400 H0Z" fill="#2c4229"/>
  <path d="M280 300 L290 150 Q320 120 350 150 L360 300Z" fill="url(#stone)"/>
  ${marks}
  <ellipse cx="320" cy="302" rx="70" ry="10" fill="#1f2f1d" opacity="0.7"/>
</svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return new Map([
    [PICTURE_FILE, png],
    [MAUL_FILE, await maulPicture()],
  ]);
}

/** The maul of the maul's page: a stone head on a bound haft, on a dark ground. */
async function maulPicture(): Promise<Buffer> {
  const { width, height } = MAUL_SIZE;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 320 320">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.6">
      <stop offset="0" stop-color="#3b3350"/><stop offset="1" stop-color="#16141f"/>
    </radialGradient>
    <linearGradient id="head" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9aa1ab"/><stop offset="1" stop-color="#4b515b"/>
    </linearGradient>
  </defs>
  <rect width="320" height="320" fill="url(#glow)"/>
  <g transform="rotate(-35 160 160)">
    <rect x="150" y="110" width="20" height="170" rx="6" fill="#6b4a2f"/>
    <rect x="148" y="210" width="24" height="10" rx="3" fill="#c9a227"/>
    <rect x="148" y="232" width="24" height="10" rx="3" fill="#c9a227"/>
    <path d="M92 70 L228 70 L240 96 L228 130 L92 130 L80 96 Z" fill="url(#head)"/>
    <path d="M110 84 L130 116 M150 80 L160 120 M196 82 L184 118" stroke="#2b2f36" stroke-width="5" stroke-linecap="round"/>
    <circle cx="160" cy="100" r="9" fill="#9fe3ff"/>
  </g>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}
