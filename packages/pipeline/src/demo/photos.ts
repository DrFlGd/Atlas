import {
  makeId,
  type Checklist,
  type ChecklistItem,
  type PackData,
  type Picture,
} from '@atlas/schema';
import sharp from 'sharp';
import { DEMO_GAME_ID } from './content';
import { DEEP_MAP_ID } from './underground';

/**
 * Photos of locations in the demo: a few pictures drawn here, shown on the
 * cards of three waystones and on the entries of a Photo guide, "Views of
 * the isle". Everything is made up: the pictures are simple drawn scenes,
 * not screenshots of anything. One photo of a location and one of the
 * guide are marked as spoilers, so they stay blurred until asked for.
 */

const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

export const DEMO_PHOTO_GUIDE = id('checklist', 'views');

/** The drawn scenes, by picture local id: what stands in them, and the colours of the hour. */
type Landmark = 'stone' | 'tower' | 'arch' | 'tree' | 'boat' | 'cave';

interface Scene {
  local: string;
  landmark: Landmark;
  /** Sky top and bottom, far and near ground. */
  colours: [string, string, string, string];
  caption: string;
}

const PHOTO_SIZE = { width: 800, height: 500 } as const;

const PALETTES: [string, string, string, string][] = [
  ['#1d2b53', '#e3875c', '#3f5a3a', '#26391f'],
  ['#5d8fc9', '#cfe6f2', '#6f8f4e', '#4a6a35'],
  ['#2b1f45', '#a35d8c', '#34404f', '#1f2733'],
  ['#3a7bbf', '#f4e1b0', '#9a8a55', '#6e6236'],
  ['#0f1a2e', '#38507a', '#22314a', '#141e2e'],
  ['#7fb2d9', '#fbe7c6', '#5f8a6a', '#3b5f45'],
];

const VIEW_SCENES: readonly Omit<Scene, 'colours'>[] = [
  { local: 'view-tower', landmark: 'tower', caption: 'The broken tower at dusk' },
  { local: 'view-arch', landmark: 'arch', caption: 'The stone arch from the south' },
  { local: 'view-tree', landmark: 'tree', caption: 'The old oak on the ridge' },
  { local: 'view-boat', landmark: 'boat', caption: 'The wreck below the cliffs' },
  { local: 'view-cave', landmark: 'cave', caption: 'The cave mouth, seen from the path' },
  { local: 'view-stone', landmark: 'stone', caption: 'A waystone on the high road' },
];

const WAYSTONE_SCENES: readonly Omit<Scene, 'colours'>[] = [
  { local: 'waystone-1', landmark: 'stone', caption: 'The waystone from the road' },
  { local: 'waystone-2', landmark: 'stone', caption: 'The waystone after the climb' },
  { local: 'waystone-3', landmark: 'stone', caption: 'The waystone at night' },
];

const withColours = (scenes: readonly Omit<Scene, 'colours'>[], offset: number): Scene[] =>
  scenes.map((scene, i) => ({ ...scene, colours: PALETTES[(i + offset) % PALETTES.length]! }));

const SCENES: readonly Scene[] = [
  ...withColours(VIEW_SCENES, 0),
  ...withColours(WAYSTONE_SCENES, 3),
];

const fileOf = (local: string) => `pictures/${local}.webp`;

/** The landmark of a scene, drawn in the middle of the picture. */
function landmark(kind: Landmark): string {
  switch (kind) {
    case 'stone':
      return `<path d="M370 380 L380 190 Q400 160 420 190 L430 380Z" fill="#5c6270"/>
  ${[0, 1, 2, 3, 4].map((i) => `<rect x="${i % 2 ? 392 : 384}" y="${215 + i * 30}" width="${i % 2 ? 16 : 32}" height="6" rx="3" fill="#9fe3ff"/>`).join('')}`;
    case 'tower':
      return `<path d="M340 390 L350 150 L372 140 L380 120 L400 150 L420 135 L440 160 L450 390Z" fill="#4a4752"/>
  <rect x="385" y="220" width="20" height="34" rx="10" fill="#f2c46d"/>`;
    case 'arch':
      return `<path d="M290 390 L290 230 Q400 120 510 230 L510 390 L470 390 L470 250 Q400 175 330 250 L330 390Z" fill="#6a6258"/>`;
    case 'tree':
      return `<rect x="390" y="250" width="22" height="140" fill="#4b3424"/>
  <circle cx="400" cy="220" r="80" fill="#2f5d34"/><circle cx="350" cy="250" r="50" fill="#356b3b"/><circle cx="455" cy="245" r="55" fill="#2a5330"/>`;
    case 'boat':
      return `<path d="M280 360 Q400 420 520 350 L500 330 L300 340Z" fill="#5a3b26" transform="rotate(-8 400 360)"/>
  <path d="M400 340 L400 200 L470 320Z" fill="#d9d2c0" opacity="0.8"/>`;
    case 'cave':
      return `<path d="M250 400 Q260 220 400 200 Q540 220 550 400Z" fill="#3b3a36"/>
  <path d="M330 400 Q340 290 400 280 Q460 290 470 400Z" fill="#0b0b0d"/>`;
  }
}

/** A drawn scene as SVG: sky, sun or moon, two layers of hills, and the landmark. */
function sceneSvg(scene: Scene): string {
  const { width, height } = PHOTO_SIZE;
  const [top, bottom, far, near] = scene.colours;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#sky)"/>
  <circle cx="620" cy="120" r="44" fill="#fff3d6" opacity="0.85"/>
  <path d="M0 330 Q200 260 400 310 T800 290 V500 H0Z" fill="${far}"/>
  ${landmark(scene.landmark)}
  <path d="M0 400 Q240 360 480 395 T800 385 V500 H0Z" fill="${near}"/>
</svg>`;
}

/** Every photo's file, by path in the pack. */
export async function photoFiles(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const scene of SCENES) {
    const webp = await sharp(Buffer.from(sceneSvg(scene)))
      .webp({ quality: 80 })
      .toBuffer();
    files.set(fileOf(scene.local), webp);
  }
  return files;
}

const picture = (scene: Scene): Picture => ({
  id: id('picture', scene.local),
  file: fileOf(scene.local),
  caption: scene.caption,
  credit: 'Drawn for the Atlas demo',
  shareable: true,
  width: PHOTO_SIZE.width,
  height: PHOTO_SIZE.height,
});

const NOTES = [
  'Climb the stair on the east side; the view opens at the top.',
  'Best seen from the south path, where the arch frames the sea.',
  'Follow the ridge from the waystone; the oak stands alone.',
  'Only at low tide. Walk along the sand under the cliffs.',
  'The path down starts behind the camp. Bring a light.',
  'Where the high road bends north, look back towards the hills.',
];

/**
 * Adds the photos: three waystones on the surface get a photo each (the
 * second marked as a spoiler), and the Photo guide "Views of the isle"
 * gets one entry per drawn view, each at a location of a different area
 * where it can, with a photo (the fourth a spoiler) and a note.
 */
export function addPhotos(data: PackData): PackData {
  const surface = data.locations.filter((l) => l.mapId !== DEEP_MAP_ID);
  const waystones = surface.filter((l) => l.categoryId === id('cat', 'waystone')).slice(0, 3);
  const photoOf = new Map<string, Picture>();
  const waystoneScenes = SCENES.filter((s) => s.local.startsWith('waystone-'));
  waystones.forEach((location, i) => {
    photoOf.set(location.id, picture(waystoneScenes[i]!));
  });

  // One spot per view, in different areas where the pack has them.
  const wanted = ['ruin', 'ruin', 'camp', 'cavemouth', 'cavemouth', 'waystone'];
  const usedAreas = new Set<string | null>();
  const usedPlaces = new Set(waystones.map((l) => l.id));
  const viewScenes = SCENES.filter((s) => s.local.startsWith('view-'));
  const spots = viewScenes.map((_, i) => {
    const kind = id('cat', wanted[i]!);
    const of = surface.filter((l) => l.categoryId === kind && !usedPlaces.has(l.id));
    const spot = of.find((l) => !usedAreas.has(l.regionId)) ?? of[0] ?? surface[i]!;
    usedAreas.add(spot.regionId);
    usedPlaces.add(spot.id);
    return spot;
  });
  const checklist: Checklist = {
    id: DEMO_PHOTO_GUIDE,
    name: 'Views of the isle',
    description: 'Six views worth the walk, each with a photo of what you will see.',
    order: 5,
    type: 'photos',
  };
  const items: ChecklistItem[] = spots.map((spot, order) => ({
    id: id('checkitem', `view-${order + 1}`),
    checklistId: DEMO_PHOTO_GUIDE,
    name: viewScenes[order]!.caption,
    order,
    locationIds: [spot.id],
    entityIds: [],
    note: NOTES[order]!,
    photos: [
      {
        picture: id('picture', viewScenes[order]!.local),
        ...(order === 3 ? { spoiler: true } : {}),
      },
    ],
  }));

  return {
    ...data,
    locations: data.locations.map((location) => {
      const shot = photoOf.get(location.id);
      if (!shot) return location;
      const index = waystones.findIndex((w) => w.id === location.id);
      return {
        ...location,
        photos: [{ picture: shot.id, ...(index === 1 ? { spoiler: true } : {}) }],
      };
    }),
    checklists: [...data.checklists, checklist],
    checklistItems: [...data.checklistItems, ...items],
    pictures: [...(data.pictures ?? []), ...SCENES.map(picture)],
  };
}
