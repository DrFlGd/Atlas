import {
  checkPackIntegrity,
  packDataSchema,
  readOwnRoutesFile,
  routesReadSchema,
  writeOwnRoutesFile,
  type Route,
} from '@atlas/schema';
import { makeFixturePack } from '@atlas/schema/testing';
import { describe, expect, it } from 'vitest';
import {
  addRouteCorner,
  addRouteStep,
  cleanRoutes,
  clearRouteCorners,
  copyRoute,
  cornersFromLine,
  moveRouteStep,
  newOwnRoute,
  nextUndone,
  removeRouteStep,
  routeFromList,
  routeLines,
  routeMaps,
  shownSteps,
  stepAt,
} from './routes';

const NOW = new Date('2026-11-21T10:00:00Z');
let counter = 0;
const random = () => `r${String(counter++).padStart(7, '0')}`;

function route(): Route {
  return {
    id: 'demo:route:hall',
    title: 'Hall of Glass',
    type: 'walkthrough',
    steps: [
      { id: '1', title: 'Gate', locationId: 'demo:loc:0001', mapId: 'demo:map:world', x: 1, y: 1 },
      { id: '2', title: 'Bridge', mapId: 'demo:map:world', x: 500, y: 100, via: [[300, 50]] },
      { id: '3', title: 'Cellar', mapId: 'demo:map:cellar', x: 10, y: 10 },
      { id: '4', title: 'Stairs', mapId: 'demo:map:cellar', x: 50, y: 60 },
    ],
  };
}

describe('routes', () => {
  it('stands a step on its location where the location is now', () => {
    const pack = makeFixturePack();
    const steps = shownSteps(route(), (id) => pack.locations.find((l) => l.id === id));
    expect(steps[0]).toMatchObject({ number: 1, x: 120, y: 80, mapId: 'demo:map:world' });
    expect(steps[0]!.location?.id).toBe('demo:loc:0001');
    expect(steps[1]).toMatchObject({ number: 2, x: 500, y: 100, location: null });
  });

  it('joins steps on one map through their corners, and never across maps', () => {
    const steps = shownSteps(route(), () => undefined);
    expect(routeLines(steps, 'demo:map:world')).toEqual([
      [
        { x: 1, y: 1 },
        { x: 300, y: 50 },
        { x: 500, y: 100 },
      ],
    ]);
    expect(routeLines(steps, 'demo:map:cellar')).toEqual([
      [
        { x: 10, y: 10 },
        { x: 50, y: 60 },
      ],
    ]);
    expect(routeMaps(steps)).toEqual(['demo:map:world', 'demo:map:cellar']);
  });

  it('splits a line through the steps into the corners between them', () => {
    const steps = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(
      cornersFromLine(steps, [
        { x: 0, y: 0 },
        { x: 5, y: 2 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([undefined, [[5, 2]], undefined]);
    // A line that misses a step gives no corners.
    expect(
      cornersFromLine(steps, [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
      ]),
    ).toEqual([undefined, undefined, undefined]);
  });

  it('makes a pack route safe to show', () => {
    const pack = makeFixturePack();
    const cleaned = cleanRoutes({
      ...pack,
      routes: [
        {
          ...route(),
          steps: [
            ...route().steps,
            {
              id: '5',
              title: 'Lost',
              locationId: 'demo:loc:gone',
              mapId: 'demo:map:world',
              x: 5000,
              y: -5,
            },
          ],
        },
        { id: 'demo:route:empty', title: 'Empty', steps: [] },
      ],
    });
    expect(cleaned.routes).toHaveLength(1);
    const steps = cleaned.routes![0]!.steps;
    // The steps on the map the pack does not have are left out.
    expect(steps.map((step) => step.id)).toEqual(['1', '2', '5']);
    expect(steps[2]).toEqual({ id: '5', title: 'Lost', mapId: 'demo:map:world', x: 1000, y: 0 });
    expect(checkPackIntegrity(cleaned)).toEqual([]);
  });

  it('checks a pack route strictly and reads one tolerantly', () => {
    const pack = { ...makeFixturePack(), routes: [route()] };
    expect(checkPackIntegrity(pack).map((issue) => issue.path)).toEqual([
      'routes[0].steps[2].mapId',
      'routes[0].steps[3].mapId',
    ]);
    expect(packDataSchema.safeParse({ ...pack, routes: [{ ...route(), extra: 1 }] }).success).toBe(
      false,
    );
    const read = routesReadSchema.parse([
      { ...route(), type: 'speedrun', extra: 1 },
      { id: 'bad' },
    ]);
    expect(read).toHaveLength(1);
    expect(read[0]!.type).toBeUndefined();
  });

  it('makes and changes a route of the person’s own', () => {
    const pack = makeFixturePack();
    const location = pack.locations[0]!;
    let own = newOwnRoute('demo', 'My way', NOW, random);
    own = addRouteStep(own, stepAt(own, { kind: 'location', location }, random), NOW);
    own = addRouteStep(
      own,
      stepAt(own, { kind: 'point', mapId: 'demo:map:world', x: 400, y: 300 }, random),
      NOW,
    );
    const [first, second] = own.steps;
    expect(first).toMatchObject({ title: location.name, locationId: location.id });
    expect(second).toMatchObject({ title: 'New step', x: 400, y: 300 });
    own = addRouteCorner(own, second!.id, { x: 200, y: 250 }, NOW);
    expect(own.steps[1]!.via).toEqual([[200, 250]]);
    // Moving the step loses the corners that led to it from the step before.
    const moved = moveRouteStep(own, second!.id, -1, NOW);
    expect(moved.steps.map((step) => step.id)).toEqual([second!.id, first!.id]);
    expect(moved.steps[0]!.via).toBeUndefined();
    expect(clearRouteCorners(own, second!.id, NOW).steps[1]!.via).toBeUndefined();
    expect(removeRouteStep(own, first!.id, NOW).steps).toHaveLength(1);

    const text = writeOwnRoutesFile('demo', [own], NOW);
    const read = readOwnRoutesFile(JSON.parse(text));
    expect(read.ok && read.file.routes).toEqual([own]);
  });

  it('starts a route from a list in order and copies a pack route', () => {
    const pack = makeFixturePack();
    const items = [
      {
        id: 'demo:checkitem:b',
        checklistId: 'demo:checklist:herbs',
        name: 'Second',
        order: 2,
        locationIds: ['demo:loc:0002'],
        entityIds: [],
        note: 'Look up.',
      },
      {
        id: 'demo:checkitem:a',
        checklistId: 'demo:checklist:herbs',
        name: 'First',
        order: 1,
        locationIds: ['demo:loc:0001'],
        entityIds: [],
      },
      {
        id: 'demo:checkitem:c',
        checklistId: 'demo:checklist:herbs',
        name: 'Nowhere',
        order: 3,
        locationIds: [],
        entityIds: [],
      },
    ];
    const made = routeFromList(
      'demo',
      { id: 'demo:checklist:herbs', name: 'Herbs' },
      items,
      (id) => pack.locations.find((l) => l.id === id),
      NOW,
      random,
    );
    expect(made.steps.map((step) => [step.title, step.locationId, step.text])).toEqual([
      ['First', 'demo:loc:0001', undefined],
      ['Second', 'demo:loc:0002', 'Look up.'],
    ]);
    expect(made.fromList).toBe('demo:checklist:herbs');
    const copy = copyRoute('demo', route(), NOW, random);
    expect(copy.id.startsWith('demo:route:own.')).toBe(true);
    expect(copy.steps).toEqual(route().steps);
  });

  it('finds the next step not done', () => {
    const steps = shownSteps(route(), () => undefined);
    expect(nextUndone(steps, (s) => s.number <= 2)).toBe(2);
    expect(nextUndone(steps, () => true)).toBe(-1);
  });
});
