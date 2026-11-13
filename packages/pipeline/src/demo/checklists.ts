import {
  makeId,
  type Checklist,
  type ChecklistItem,
  type GuideEntry,
  type PackData,
} from '@atlas/schema';
import { DEMO_GAME_ID } from './content';
import { DEEP_MAP_ID } from './underground';

const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

/** The checklists and listed guides that {@link addChecklists} adds. */
export const DEMO_CHECKLISTS = {
  waystones: id('checklist', 'waystones'),
  story: id('checklist', 'story'),
  lore: id('checklist', 'lore'),
  route: id('checklist', 'route'),
  riddles: id('checklist', 'riddles'),
} as const;

export const DEMO_GUIDES = {
  arrival: id('guide', 'arrival'),
  deep: id('guide', 'deep-walk'),
  tablets: id('guide', 'tablets'),
} as const;

/** The riddles of the ruins, each with its answer, all made up. */
const RIDDLES: readonly [riddle: string, answer: string][] = [
  ['Three valves, one gate, and water that must not rise.', ''],
  ['What runs along the valley yet never leaves its bed?', 'The river'],
  ['What grows lighter the more of it you carry up the hill?', 'A lantern’s oil'],
  ['What has a crown of stone but never ruled?', 'The broken tower'],
  ['What speaks every word you say, and only after you?', 'The echo in the gorge'],
  ['What is cut on the table but never eaten?', 'A deck of cards'],
  ['What wears a coat in winter and none in summer?', 'The old oak'],
  ['What falls every evening and never breaks?', 'Night'],
];

const ofCategory = (data: PackData, category: string) =>
  data.locations.filter((l) => l.categoryId === id('cat', category));

/**
 * Adds the demo's checklists and walkthrough guides to a pack that already
 * has both maps (see `addUnderground`):
 *
 * - "Waystones": one item per waystone, each tied to its location.
 * - "The Sundered Isle story": steps with no place on the map, under chapter
 *   headings, with notes that link to places, checklists and guides.
 * - "Lore of the isle": long and mixed. Every lore tablet region by region,
 *   with a step, a group of elite foes and a camp (which cannot be marked
 *   found) in each region, and items on the second map.
 * - "Treasure hunter’s route": a guide (`kind: 'guide'`, `type: 'route'`)
 *   that is a long list of places across both maps, one place per item, as
 *   importers write them.
 * - "Riddles of the ruins": secrets (`type: 'secrets'`), eight entries that
 *   share one name, each a ruin whose own note asks a riddle and hides the
 *   answer (`||like this||`), with places named in the hidden text; one
 *   answer spans a list.
 * - A note of its own for each lore tablet and chest on the surface, linking
 *   to the nearest waystone.
 * - Three guides that belong to no single location, linking into the app.
 *
 * Everything is made up and derived from the pack, so it is as deterministic
 * as the rest of the demo.
 */
export function addChecklists(data: PackData): PackData {
  const waystones = ofCategory(data, 'waystone').filter((l) => l.mapId !== DEEP_MAP_ID);
  const firstWaystone = waystones[0];
  const camps = ofCategory(data, 'camp');
  const herbs = ofCategory(data, 'herb');
  const deep = data.locations.filter((l) => l.mapId === DEEP_MAP_ID);
  const deepDoors = deep.filter((l) => l.categoryId === id('cat', 'door'));
  const deepKeys = deep.filter((l) => l.categoryId === id('cat', 'key'));
  const deepLowerRelic = deep.find(
    (l) => l.categoryId === id('cat', 'relic') && l.layerId === id('layer', 'deep-lower'),
  );
  const childRegions = data.regions.filter((r) => r.parentId !== null);
  const firstRegion = childRegions[0];
  const link = (text: string, target: string | undefined) =>
    target ? `[${text}](${target})` : text;

  const checklists: Checklist[] = [
    ...data.checklists.map((c) =>
      c.id === DEMO_CHECKLISTS.waystones
        ? {
            ...c,
            description:
              'Attune every waystone on the Sundered Isle. An item is done when its waystone is marked found.',
          }
        : c,
    ),
    {
      id: DEMO_CHECKLISTS.story,
      name: 'The Sundered Isle story',
      description:
        'The main story, step by step. Steps are not locations, so you tick them yourself.',
      order: 1,
    },
    {
      id: DEMO_CHECKLISTS.lore,
      name: 'Lore of the isle',
      description: 'Every lore tablet, region by region, with a few tasks along the way.',
      order: 2,
    },
  ];

  // The story: steps only.
  const story: [section: string, name: string, note?: string][] = [
    [
      'Prologue',
      'Wake on the shore',
      `Start near ${link('the first waystone', firstWaystone?.id)}.`,
    ],
    ['Prologue', 'Speak with the ferryman'],
    [
      'Prologue',
      'Light the beacon',
      `The beacon stands in ${link(firstRegion?.name ?? 'the west', firstRegion?.id)}.`,
    ],
    ['Chapter 1: The broken crown', 'Recover the first crown shard'],
    ['Chapter 1: The broken crown', 'Win the trust of the lantern wardens'],
    [
      'Chapter 1: The broken crown',
      'Read the arrival notes',
      `See ${link('Arriving on the isle', DEMO_GUIDES.arrival)}.`,
    ],
    [
      'Chapter 2: Below the isle',
      'Find the way into the Hollow Deep',
      `Look for ${link('the Hollow Deep', DEEP_MAP_ID)} below a cave entrance.`,
    ],
    [
      'Chapter 2: Below the isle',
      'Open a sealed door',
      `Any ${link('sealed door', deepDoors[0]?.id)} will do.`,
    ],
    ['Chapter 2: Below the isle', 'Face the Hollow king'],
    ['Epilogue', 'Return the crown to the ferryman'],
  ];
  const storyItems: ChecklistItem[] = story.map(([section, name, note], order) => ({
    id: id('checkitem', `story-${order + 1}`),
    checklistId: DEMO_CHECKLISTS.story,
    name,
    order,
    locationIds: [],
    entityIds: [],
    section,
    ...(note ? { note } : {}),
  }));

  // Lore: tablets by region, with mixed items in between.
  const loreItems: ChecklistItem[] = [];
  const lore = (item: Omit<ChecklistItem, 'id' | 'checklistId' | 'order' | 'entityIds'>) => {
    const order = loreItems.length;
    loreItems.push({
      id: id('checkitem', `lore-${String(order + 1).padStart(3, '0')}`),
      checklistId: DEMO_CHECKLISTS.lore,
      order,
      entityIds: [],
      ...item,
    });
  };
  const tablets = ofCategory(data, 'tablet');
  const elites = ofCategory(data, 'elite');
  for (const region of childRegions) {
    const section = region.name;
    for (const tablet of tablets.filter((t) => t.regionId === region.id)) {
      lore({ name: `Read ${tablet.name}`, locationIds: [tablet.id], section });
    }
    const regionElites = elites.filter((e) => e.regionId === region.id).slice(0, 3);
    if (regionElites.length > 1) {
      lore({
        name: `Defeat ${regionElites.length} elite foes in ${region.name}`,
        locationIds: regionElites.map((e) => e.id),
        section,
      });
    }
    const camp = camps.find((c) => c.regionId === region.id);
    if (camp) lore({ name: `Rest at ${camp.name}`, locationIds: [camp.id], section });
    lore({ name: `Tell the archivist about ${region.name}`, locationIds: [], section });
  }
  const keyOfEach = ['Rusted key', 'Bone key', 'Glass key'].flatMap(
    (kind) => deepKeys.find((k) => k.name.startsWith(kind)) ?? [],
  );
  if (keyOfEach.length > 0) {
    lore({
      name: 'Collect one key of each kind',
      locationIds: keyOfEach.map((k) => k.id),
      section: 'The Hollow Deep',
      note: `Keys open the sealed doors; ${link('the guide', DEMO_GUIDES.deep)} explains.`,
    });
  }
  if (deepLowerRelic) {
    lore({
      name: 'Find a relic shard in the lower galleries',
      locationIds: [deepLowerRelic.id],
      section: 'The Hollow Deep',
    });
  }
  lore({ name: 'Copy the archivist’s map', locationIds: [], section: 'The Hollow Deep' });

  // A long guide that is a list of places, as importers write them: one
  // place per item, named after it, across both maps, plus two steps.
  const surfaceRegionOrder = new Map(childRegions.map((r, i) => [r.id, i]));
  const routePlaces = data.locations
    .filter((l) => ['relic', 'chest', 'key'].some((c) => l.categoryId === id('cat', c)))
    .map((l, i) => ({ l, i }))
    .sort(
      (a, b) =>
        Number(a.l.mapId === DEEP_MAP_ID) - Number(b.l.mapId === DEEP_MAP_ID) ||
        (surfaceRegionOrder.get(a.l.regionId ?? '') ?? 99) -
          (surfaceRegionOrder.get(b.l.regionId ?? '') ?? 99) ||
        a.i - b.i,
    )
    .map(({ l }) => l);
  const routeItems: ChecklistItem[] = [
    { name: 'Buy a bigger satchel', locationIds: [] as string[] },
    ...routePlaces.map((l) => ({ name: l.name, locationIds: [l.id] })),
    { name: 'Sell the spare keys', locationIds: [] as string[] },
  ].map((item, order) => ({
    id: id('checkitem', `route-${String(order + 1).padStart(4, '0')}`),
    checklistId: DEMO_CHECKLISTS.route,
    order,
    entityIds: [],
    ...item,
  }));
  checklists.push({
    id: DEMO_CHECKLISTS.route,
    name: 'Treasure hunter’s route',
    description: 'Every relic shard, chest and old key, on both maps.',
    order: 3,
    kind: 'guide',
    type: 'route',
  });

  // Secrets: entries that share a name, told apart by their notes, which
  // hide their answers. The notes are the places' own, as importers write.
  const ruins = ofCategory(data, 'ruin').filter((l) => l.mapId !== DEEP_MAP_ID);
  const riddlePlaces = ruins
    .filter((_, i) => i % Math.max(1, Math.floor(ruins.length / RIDDLES.length)) === 0)
    .slice(0, RIDDLES.length);
  const riddleItems: ChecklistItem[] = riddlePlaces.map((l, order) => ({
    id: id('checkitem', `riddle-${order + 1}`),
    checklistId: DEMO_CHECKLISTS.riddles,
    name: 'Carved riddle',
    order,
    locationIds: [l.id],
    entityIds: [],
  }));
  checklists.push({
    id: DEMO_CHECKLISTS.riddles,
    name: 'Riddles of the ruins',
    description: 'A riddle is carved at eight ruins. The answers are hidden until you ask.',
    order: 4,
    type: 'secrets',
  });

  // Each lore tablet and each chest on the surface gets a note of its own,
  // as imported packs have, pointing at the nearest waystone.
  const nearestWaystone = (x: number, y: number) => {
    let best: (typeof waystones)[number] | undefined;
    let distance = Infinity;
    for (const w of waystones) {
      const d = Math.hypot(w.x - x, w.y - y);
      if (d < distance) {
        distance = d;
        best = w;
      }
    }
    return best;
  };
  const NOTE_OPENINGS = [
    'Half buried under roots; look for the broken arch.',
    'Behind a waterfall. The path in starts on the left bank.',
    'On a ledge that is only reachable from above.',
    'Inside a hollow log. It glows faintly after dark.',
    'Guarded by two wolves that wander off at dawn.',
  ];
  const notes: GuideEntry[] = [];
  const noted = new Map<string, string>();
  data.locations
    .filter(
      (l) =>
        l.mapId !== DEEP_MAP_ID &&
        (l.categoryId === id('cat', 'tablet') || l.categoryId === id('cat', 'chest')),
    )
    .forEach((l, n) => {
      const waystone = nearestWaystone(l.x, l.y);
      const noteId = id('guide', `note-${l.id.split(':')[2]}`);
      noted.set(l.id, noteId);
      notes.push({
        id: noteId,
        title: l.name,
        body: [
          NOTE_OPENINGS[n % NOTE_OPENINGS.length]!,
          waystone ? `Nearest waystone: ${link(waystone.name, waystone.id)}.` : '',
          n % 7 === 0
            ? '\nA second, longer paragraph for the few places that need it: bring a rope, ' +
              'wait for low tide, climb the eastern face and do not look down. The wind picks ' +
              'up in the afternoon, so go early.'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
        locationIds: [l.id],
      });
    });
  riddlePlaces.forEach((l, n) => {
    const waystone = nearestWaystone(l.x, l.y);
    const there = waystone ? link(waystone.name, waystone.id) : 'the nearest waystone';
    const [riddle, answer] = RIDDLES[n]!;
    const noteId = id('guide', `note-${l.id.split(':')[2]}`);
    noted.set(l.id, noteId);
    notes.push({
      id: noteId,
      title: l.name,
      body:
        n === 0
          ? [
              `${riddle} Solution: ||Turn the valves in this order:`,
              '',
              '1. The valve by the door',
              '2. The valve under the stair',
              '3. The valve in the well',
              '',
              `Then walk to ${there}; the gate there opens.||`,
            ].join('\n')
          : `${riddle} Answer: ||${answer}. The reward waits by ${there}.||`,
      locationIds: [l.id],
    });
  });
  const locations = data.locations.map((l) => {
    const noteId = noted.get(l.id);
    return noteId ? { ...l, guideId: noteId } : l;
  });

  const guides: GuideEntry[] = [
    ...data.guides,
    ...notes,
    {
      id: DEMO_GUIDES.arrival,
      title: 'Arriving on the isle',
      order: 1,
      body: [
        'You wake on the western shore with nothing but a lantern.',
        '',
        `1. Walk to ${link('the first waystone', firstWaystone?.id)} and attune it. The ${link('waystones checklist', DEMO_CHECKLISTS.waystones)} keeps track of the others.`,
        `2. Follow ${link('the story', DEMO_CHECKLISTS.story)}, starting with ${link('Wake on the shore', storyItems[0]!.id)}.`,
        `3. Herbs are everywhere; ${link('Gathering herbs', id('guide', 'herbs'))} says where to look.`,
        '',
        `When you are ready to go below, read ${link('Into the Hollow Deep', DEMO_GUIDES.deep)}.`,
      ].join('\n'),
      locationIds: [firstWaystone, camps[0], herbs[0]].flatMap((l) => (l ? [l.id] : [])),
    },
    {
      id: DEMO_GUIDES.deep,
      title: 'Into the Hollow Deep',
      order: 2,
      body: [
        `${link('The Hollow Deep', DEEP_MAP_ID)} is a cave system with two levels.`,
        '',
        `- Every ${link('sealed door', deepDoors[0]?.id)} opens with one old key.`,
        `- ${link('A rusted key', keyOfEach[0]?.id)} is a good place to start.`,
        `- The ${link('Lore of the isle', DEMO_CHECKLISTS.lore)} checklist lists the keys too.`,
        '',
        `Back to ${link('Arriving on the isle', DEMO_GUIDES.arrival)}.`,
      ].join('\n'),
      locationIds: deepDoors.slice(0, 3).map((l) => l.id),
    },
    {
      id: DEMO_GUIDES.tablets,
      title: 'Reading the lore tablets',
      order: 3,
      body: [
        'Lore tablets tell the story of the isle before it was sundered.',
        '',
        `Read them in any order. ${link('Lore of the isle', DEMO_CHECKLISTS.lore)} lists them by region, and ticking one there marks its tablet found on the map.`,
        '',
        tablets[0] ? `One of them is ${link(tablets[0].name, tablets[0].id)}.` : '',
      ].join('\n'),
      locationIds: [],
    },
  ];

  return {
    ...data,
    locations,
    checklists,
    checklistItems: [
      ...data.checklistItems,
      ...storyItems,
      ...loreItems,
      ...routeItems,
      ...riddleItems,
    ],
    guides,
  };
}
