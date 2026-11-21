import { makeId, type PackData, type Route, type RouteStep } from '@atlas/schema';
import { DEMO_GAME_ID } from './content';
import { DEEP_MAP_ID } from './underground';

const id = (kind: Parameters<typeof makeId>[1], local: string) => makeId(DEMO_GAME_ID, kind, local);

/** The routes that {@link addRoutes} adds. */
export const DEMO_ROUTES = {
  lantern: id('route', 'lantern-path'),
} as const;

/** What the guide says at each step, all made up. */
const STEP_TEXT = [
  'Start at the waystone and touch it, so you can come back here at any time.',
  'Follow the old road to the next waystone. Lanterns hang on the posts along the way.',
  'Leave the road where the lanterns end and cross the meadow to the stone circle.',
  'The next waystone stands on the far side of the ridge. Walk around the ridge, not over it.',
  'Take the cave mouth down into the galleries below.',
  'In the galleries, the last lantern lights the way out.',
];

/**
 * Adds a demo route to a pack that has both maps (see `addUnderground`):
 * "The lantern path", a walkthrough through the first waystones of the
 * surface, a free point between them, a bend in the line around a ridge,
 * and two steps on the second map, so the route crosses maps.
 */
export function addRoutes(data: PackData): PackData {
  const waystones = data.locations.filter(
    (l) => l.categoryId === id('cat', 'waystone') && l.mapId !== DEEP_MAP_ID,
  );
  const deep = data.locations.filter((l) => l.mapId === DEEP_MAP_ID).slice(0, 2);
  if (waystones.length < 3 || deep.length < 2) return data;
  const [first, second, third] = waystones as [
    (typeof waystones)[number],
    (typeof waystones)[number],
    (typeof waystones)[number],
  ];
  const onLocation = (n: number, location: (typeof waystones)[number]): RouteStep => ({
    id: String(n),
    title: location.name,
    text: STEP_TEXT[n - 1]!,
    locationId: location.id,
    mapId: location.mapId,
    x: location.x,
    y: location.y,
  });
  const middle = {
    x: Math.round((second.x + third.x) / 2),
    y: Math.round((second.y + third.y) / 2),
  };
  // The line to the third waystone bends around the ridge: two corners beside the straight way.
  const bend = (t: number, side: number): [number, number] => [
    Math.round(middle.x + (third.x - middle.x) * t + side * (third.y - middle.y) * 0.3),
    Math.round(middle.y + (third.y - middle.y) * t - side * (third.x - middle.x) * 0.3),
  ];
  const steps: RouteStep[] = [
    onLocation(1, first),
    onLocation(2, second),
    {
      id: '3',
      title: 'The stone circle',
      text: STEP_TEXT[2]!,
      mapId: second.mapId,
      x: middle.x,
      y: middle.y,
    },
    { ...onLocation(4, third), via: [bend(0.3, 1), bend(0.7, 1)] },
    { ...onLocation(5, deep[0]!), text: STEP_TEXT[4]! },
    { ...onLocation(6, deep[1]!), text: STEP_TEXT[5]! },
  ];
  const route: Route = {
    id: DEMO_ROUTES.lantern,
    title: 'The lantern path',
    description: 'A short walk from the first waystones down into the galleries.',
    type: 'walkthrough',
    color: '#e0533d',
    order: 0,
    steps,
  };
  return { ...data, routes: [route] };
}
