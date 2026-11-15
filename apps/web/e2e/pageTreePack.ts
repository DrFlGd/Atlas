import type { Page } from '@playwright/test';

/**
 * A made-up wiki whose pages are placed by their links, served as a game
 * with no map: a menu of sections (Equipment, The world, Things) with a
 * few pages, and the pages nothing in the menu names in a section placed
 * by links ("Pages"). Only list pages file pages: the pages a list names
 * go under it, a link in a sentence files nothing. Everything here is
 * invented, its address (example.org) included.
 *
 * - Equipment › Armor › Warden Plate › Warden Helm, with Ash Mail and
 *   Iron Cap beside Warden Plate; Longblade (under Weapons) mentions
 *   Warden Plate too.
 * - Common Ore is mentioned by sixteen pages, among them Warden Plate, and
 *   listed by Materials, which no page lists: it is under Materials, in
 *   Pages.
 * - Things › Catalogue has 450 pages under it.
 * - Stray Note is linked from nothing placed, so it stays in Pages.
 * - Basics › Gear, an index whose table names, beside each blade, the mine
 *   it is found in and the creature that drops it, under a heading that
 *   is a link to Short Blades, which lists the blades too: each blade is
 *   under Short Blades, under Gear. Gear ends with a link to Short Blades,
 *   and each blade's text links back to Gear and on to the next blade.
 *   Its headings are levels of the contents: Short Blades is under the
 *   heading "Weapons", and three charms under the heading "Charms" (Gear ›
 *   Weapons › Short Blades › Dirk); "Care" lists nothing, so is none.
 * - Basics › Field Notes lists three keepsakes (Old Map, Lost Key, Torn
 *   Page) but names more pages in its sentences, so it is no list page:
 *   the keepsakes stay in Pages until the person says it files them.
 */

const g = (local: string) => `demo:guide:${local}`;
const s = (local: string) => `demo:section:${local}`;

interface Guide {
  id: string;
  title: string;
  body: string;
  locationIds: string[];
  source: object;
}

const source = (local: string) => ({
  url: `https://wiki.example.org/wiki/${local}`,
  site: 'Example Wiki',
  license: { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  readAt: '2026-11-14',
  adapted: true,
});

/** A page: a sentence (which may mention pages), then a list of the pages it lists. */
function page(local: string, title: string, text: string, listed: [string, string][]): Guide {
  const list = listed.map(([to, name]) => `- [${name}](${g(to)})`).join('\n');
  return {
    id: g(local),
    title,
    body: `${text}\n\n${list}`.trim(),
    locationIds: [],
    source: source(local),
  };
}

/** A sentence that mentions a page. */
const mention = (local: string, name: string) => `[${name}](${g(local)})`;

const ORE_FROM = Array.from({ length: 13 }, (_, i) => `mine-${i + 1}`);
const BLADES: [string, string][] = [
  ['dirk', 'Dirk'],
  ['kris', 'Kris'],
  ['shiv', 'Shiv'],
  ['stiletto', 'Stiletto'],
  ['cutter', 'Cutter'],
  ['needle', 'Needle'],
  ['fang', 'Fang'],
  ['sliver', 'Sliver'],
];
const CHARMS: [string, string][] = [
  ['bone-charm', 'Bone Charm'],
  ['tin-charm', 'Tin Charm'],
  ['reed-charm', 'Reed Charm'],
];
const KEEPSAKES: [string, string][] = [
  ['old-map', 'Old Map'],
  ['lost-key', 'Lost Key'],
  ['torn-page', 'Torn Page'],
];
const CREATURES: [string, string][] = [
  ['marsh-toad', 'Marsh Toad'],
  ['cave-bat', 'Cave Bat'],
];

/** Gear, Short Blades and the blades (see the top of this file). */
function gearGuides(): Guide[] {
  const rows = BLADES.map(
    ([id, name], i) =>
      `| ${mention(id, name)} | A quick blade of fair weight. | Deep in ${mention(ORE_FROM[i]!, `Mine ${i + 1}`)} | ${mention(...CREATURES[i % 2]!)} |`,
  );
  const care = Array.from(
    { length: 8 },
    (_, i) =>
      `Care, part ${i + 1}. Keep each blade dry and oiled, and its edge keen. A blade left wet in the mines rusts within a week, and a dull one slips off a hide.`,
  );
  return [
    {
      id: g('gear'),
      title: 'Gear',
      body: [
        'All the gear of the isle, by type.',
        '',
        '## Weapons',
        '',
        'Arms of every reach.',
        '',
        `### ${mention('short-blades', 'Short Blades')}`,
        '',
        '| Name | Description | Found at | Dropped by |',
        '| --- | --- | --- | --- |',
        ...rows,
        '',
        '## Charms',
        '',
        ...CHARMS.map(([id, name]) => `- ${mention(id, name)}`),
        '',
        '## Care',
        '',
        ...care.flatMap((text) => [text, '']),
        `Back to the ${mention('short-blades', 'short blades')}.`,
      ].join('\n'),
      locationIds: [],
      source: source('gear'),
    },
    page(
      'short-blades',
      'Short Blades',
      'The short blades, quick and light.',
      BLADES.map(([id, name]) => [id, name]),
    ),
    ...CHARMS.map(([id, name]) => page(id, name, `A charm worn at the neck.`, [])),
    ...BLADES.map(([id, name], i) => {
      const [nextId, nextName] = BLADES[(i + 1) % BLADES.length]!;
      return page(
        id,
        name,
        `The ${name} is one of the ${mention('gear', 'gear')} of the isle. Next to it lies the ${mention(nextId, nextName)}.`,
        [],
      );
    }),
  ];
}
const ITEMS = Array.from({ length: 450 }, (_, i) => `item-${String(i + 1).padStart(3, '0')}`);

export function pageTreeGuides(): Guide[] {
  const ore = mention('common-ore', 'Common Ore');
  return [
    page('armor', 'Armor', 'Every set of armour in the game.', [
      ['warden-plate', 'Warden Plate'],
      ['ash-mail', 'Ash Mail'],
      ['iron-cap', 'Iron Cap'],
    ]),
    page('weapons', 'Weapons', 'Blades and bows.', [
      ['longblade', 'Longblade'],
      ['short-bow', 'Short Bow'],
      ['hand-axe', 'Hand Axe'],
    ]),
    page('bestiary', 'Bestiary', 'The creatures of the isle.', [
      ['marsh-toad', 'Marsh Toad'],
      ['cave-bat', 'Cave Bat'],
      ['mines', 'Mines'],
    ]),
    page('warden-plate', 'Warden Plate', `Heavy plate worn by the wardens, forged from ${ore}.`, [
      ['warden-helm', 'Warden Helm'],
      ['warden-boots', 'Warden Boots'],
      ['warden-gloves', 'Warden Gloves'],
    ]),
    page(
      'warden-helm',
      'Warden Helm',
      `The helm of the ${mention('warden-plate', 'warden set')}.`,
      [],
    ),
    page('warden-boots', 'Warden Boots', 'The boots of the warden set.', []),
    page('warden-gloves', 'Warden Gloves', 'The gloves of the warden set.', []),
    page('ash-mail', 'Ash Mail', `Light mail from the ash fields, of ${ore}.`, []),
    page('iron-cap', 'Iron Cap', 'A plain cap.', []),
    page(
      'longblade',
      'Longblade',
      `A long blade of ${ore}. Pairs well with ${mention('warden-plate', 'Warden Plate')}.`,
      [],
    ),
    page('short-bow', 'Short Bow', 'A short bow.', []),
    page('hand-axe', 'Hand Axe', 'A hand axe.', []),
    page('marsh-toad', 'Marsh Toad', 'A toad of the marsh.', []),
    page('cave-bat', 'Cave Bat', 'A bat of the caves.', []),
    page(
      'mines',
      'Mines',
      'The mines of the isle.',
      ORE_FROM.map((id, i) => [id, `Mine ${i + 1}`]),
    ),
    ...ORE_FROM.map((id, i) =>
      page(id, `Mine ${i + 1}`, `Mine number ${i + 1} yields ${ore}.`, []),
    ),
    page('materials', 'Materials', 'What things are made of.', [
      ['common-ore', 'Common Ore'],
      ['rare-ore', 'Rare Ore'],
      ['gem-dust', 'Gem Dust'],
    ]),
    page('common-ore', 'Common Ore', 'Found everywhere.', []),
    page('rare-ore', 'Rare Ore', 'Found deep down.', []),
    page('gem-dust', 'Gem Dust', 'Ground gems.', []),
    page(
      'catalogue',
      'Catalogue',
      'Every thing, in one list.',
      ITEMS.map((id, i) => [id, `Item ${String(i + 1).padStart(3, '0')}`]),
    ),
    ...ITEMS.map((id, i) =>
      page(id, `Item ${String(i + 1).padStart(3, '0')}`, `Thing number ${i + 1}.`, []),
    ),
    page('stray-note', 'Stray Note', 'Nothing links here.', []),
    page(
      'field-notes',
      'Field Notes',
      `Notes from the field. ${ORE_FROM.slice(0, 5)
        .map((id, i) => `The way to ${mention(id, `Mine ${i + 1}`)} is marked.`)
        .join(' ')}`,
      KEEPSAKES,
    ),
    ...KEEPSAKES.map(([id, name]) => page(id, name, `A keepsake: the ${name}.`, [])),
    ...gearGuides(),
  ];
}

export function pageTreeSections(): object[] {
  const loose = pageTreeGuides()
    .map((guide) => guide.id)
    .filter(
      (id) =>
        ![
          g('armor'),
          g('weapons'),
          g('bestiary'),
          g('catalogue'),
          g('gear'),
          g('field-notes'),
        ].includes(id) && id !== g('stray-note'),
    );
  return [
    { id: s('equipment'), title: 'Equipment', items: [g('armor'), g('weapons')] },
    { id: s('the-world'), title: 'The world', items: [g('bestiary')] },
    { id: s('things'), title: 'Things', items: [g('catalogue')] },
    { id: s('basics'), title: 'Basics', items: [g('gear'), g('field-notes')] },
    { id: s('pages'), title: 'Pages', items: [...loose, g('stray-note')], placeByLinks: true },
  ];
}

/** Serves the made-up wiki as the only game. */
export async function servePageTree(page: Page): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({ json: { packs: [{ id: 'demo', url: 'packs/tree/', title: 'Example Wiki' }] } }),
  );
  await page.route('**/packs/tree/**', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/packs/tree/')[1] ?? '';
    if (name === 'manifest.json') {
      return route.fulfill({
        json: {
          schemaVersion: 2,
          gameId: 'demo',
          title: 'Example Wiki',
          packVersion: '1.0.0',
          gamePatch: 'wiki',
          attribution: [
            { name: 'Example Wiki', url: 'https://wiki.example.org/', license: 'CC BY-SA 4.0' },
          ],
          idMigrations: {},
        },
      });
    }
    if (name === 'guides.json') return route.fulfill({ json: pageTreeGuides() });
    if (name === 'sections.json') return route.fulfill({ json: pageTreeSections() });
    return route.fulfill({ status: 404, body: 'not found' });
  });
}
