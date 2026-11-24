import type { Location, Region } from '@atlas/schema';
import { describe, expect, it } from 'vitest';
import { areaTitles, placeTitles, titleOpacity, type TitleOnScreen } from './titles';

const region = (id: string, extra: Partial<Region> = {}): Region => ({
  id,
  mapId: 'm',
  parentId: null,
  name: id,
  ...extra,
});

const location = (id: string, regionId: string | null, x: number, y: number, height?: number) =>
  ({
    id,
    mapId: 'm',
    layerId: 'l',
    x,
    y,
    categoryId: 'c',
    regionId,
    name: id,
    entityIds: [],
    guideId: null,
    since: '1.0.0',
    ...(height === undefined ? {} : { height }),
  }) as Location;

describe('area titles from the pack', () => {
  it('stand at the centre, else the middle of the outline, else the middle of the locations', () => {
    const regions = [
      region('vale', {
        polygon: [
          [0, 0],
          [400, 0],
          [400, 200],
          [0, 200],
        ],
      }),
      region('keep', { parentId: 'vale', center: [100, 50] }),
      region('field', { parentId: 'vale' }),
      region('nowhere', { parentId: 'vale' }),
      region('elsewhere', { mapId: 'n', center: [1, 1] }),
    ];
    const locations = [
      location('a', 'keep', 90, 50, 3),
      location('b', 'keep', 110, 50, 7),
      location('c', 'keep', 100, 60, 4),
      location('d', 'field', 300, 100),
      location('e', 'field', 320, 140),
      location('f', 'vale', 10, 10, -10),
    ];
    const titles = areaTitles(regions, locations, 'm');
    const byId = new Map(titles.map((t) => [t.id, t]));
    expect([...byId.keys()].sort()).toEqual(['field', 'keep', 'vale']);
    expect(byId.get('vale')).toMatchObject({ px: 200, py: 100, depth: 0 });
    expect(byId.get('keep')).toMatchObject({ px: 100, py: 50, depth: 1, height: 4 });
    expect(byId.get('field')).toMatchObject({ px: 310, py: 120, height: null });
    // The valley counts the locations of its places too: the middle height of 3, 4, 7 and -10.
    expect(byId.get('vale')!.height).toBe(3.5);
    // How far each reaches: the outline's corners, else its locations.
    expect(byId.get('vale')!.radius).toBeCloseTo(Math.hypot(200, 100));
    expect(byId.get('keep')!.radius).toBeCloseTo(10);
    // Larger areas first.
    expect(titles[0]!.id).toBe('vale');
  });

  it('read packs made by the Map Maker: an area with its centre, and place names within it', () => {
    const regions = [
      region('area', { center: [500, 500] }),
      region('place', { parentId: 'area', center: [200, 220] }),
    ];
    const locations = [
      location('a', 'place', 190, 210, 12),
      location('b', 'place', 210, 230, 14),
      location('c', 'area', 900, 900, 2),
    ];
    const titles = areaTitles(regions, locations, 'm');
    expect(titles.map((t) => t.id)).toEqual(['area', 'place']);
    expect(titles[1]).toMatchObject({ height: 13, depth: 1 });
  });
});

describe('titles over the view', () => {
  const title = (id: string, x: number, y: number, radius: number, extra = {}): TitleOnScreen => ({
    id,
    x,
    y,
    width: 100,
    height: 24,
    distance: 100,
    radius,
    depth: 1,
    shown: true,
    ...extra,
  });
  const view = { width: 800, height: 600 };

  it('fade with distance, a small area’s sooner than a large one’s', () => {
    expect(titleOpacity(50, 20, 256)).toBe(1);
    expect(titleOpacity(2000, 20, 256)).toBe(0);
    const half = titleOpacity(400, 20, 256);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(1);
    expect(titleOpacity(400, 120, 256)).toBe(1);
    // A large area fades as the view goes down into it.
    expect(titleOpacity(10, 180, 256)).toBe(0);
  });

  it('never overlap: the larger area’s title stays', () => {
    const shown = placeTitles(
      [title('small', 400, 300, 10), title('large', 420, 310, 60), title('apart', 100, 100, 5)],
      view,
      256,
    );
    expect(shown.get('large')).toBe(1);
    expect(shown.get('small')).toBe(0);
    expect(shown.get('apart')).toBe(1);
  });

  it('keep the title with the focus, whatever it meets', () => {
    const shown = placeTitles(
      [title('small', 400, 300, 10), title('large', 420, 310, 60)],
      view,
      256,
      'small',
    );
    expect(shown.get('small')).toBe(1);
    expect(shown.get('large')).toBe(0);
  });

  it('hide titles outside the view, under its tools, behind the camera or cut away', () => {
    const shown = placeTitles(
      [
        title('off', -200, 300, 10),
        title('partly', 30, 300, 10),
        title('under', 700, 100, 10),
        title('behind', 400, 300, 10, { shown: false }),
        title('in', 400, 300, 10),
      ],
      view,
      256,
      null,
      [{ left: 650, top: 50, right: 800, bottom: 200 }],
    );
    expect(shown.get('off')).toBe(0);
    expect(shown.get('partly')).toBe(0);
    expect(shown.get('under')).toBe(0);
    expect(shown.get('behind')).toBe(0);
    expect(shown.get('in')).toBe(1);
  });
});
