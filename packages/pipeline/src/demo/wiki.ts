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
} as const;

/** The sections of its contents. */
export const WIKI_SECTIONS = {
  basics: id('section', 'wiki-basics'),
  isle: id('section', 'wiki-isle'),
  foes: id('section', 'wiki-foes'),
} as const;

export const WIKI_PICTURE = id('picture', 'wiki-waystone');
const PICTURE_FILE = 'pictures/wiki-waystone.png';
const PICTURE_SIZE = { width: 640, height: 400 } as const;

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

/** The wiki's pages, with their sources. Regions are named after the pack's own. */
export function wikiGuides(regionNames: readonly string[]): GuideEntry[] {
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

### On foot

1. Follow the river south from the landing.
2. Cross at the ford; the bridge is down.
3. Climb to the first waystone and touch it.

### By boat

The ferry runs between the two largest regions. It does not run at night.

> Tip: the ${to('wolves', 'wolves')} of the northern woods hunt along the paths, not the river.

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
described under ${to('travel', 'Getting around')}.
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
  ];
}

/** The contents: two sections at the top, the second holding a third. */
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
  ];
}

/** Adds the wiki's pages, contents and picture, and credits the wiki. */
export function addWiki(data: PackData): PackData {
  const regionNames = data.regions.filter((r) => r.parentId !== null).map((r) => r.name);
  return {
    ...data,
    manifest: {
      ...data.manifest,
      attribution: [
        ...data.manifest.attribution,
        { name: WIKI_SITE, url: WIKI_URL, license: WIKI_LICENSE.name },
      ],
    },
    guides: [...data.guides, ...wikiGuides(regionNames.slice(0, 5))],
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
  return new Map([[PICTURE_FILE, png]]);
}
