import { describe, expect, it } from 'vitest';
import {
  mercatorLngLatToPixel,
  pixelToMercatorLngLat,
  pixelToSimpleLatLng,
  pixelToWorld,
  pointInPolygon,
  polygonArea,
  polygonBounds,
  pyramidLevel,
  pyramidMaxZoom,
  pyramidWorldSize,
  simpleLatLngToPixel,
  tileRangeForBounds,
  worldToPixel,
  zoomScale,
} from './coords';

describe('tile pyramid maths', () => {
  it('picks the level at which the image is shown 1:1', () => {
    expect(pyramidMaxZoom(8192, 8192, 256)).toBe(5);
    expect(pyramidMaxZoom(8193, 100, 256)).toBe(6);
    expect(pyramidMaxZoom(256, 256, 256)).toBe(0);
    expect(pyramidMaxZoom(100, 50, 256)).toBe(0);
    expect(pyramidMaxZoom(600, 300, 256)).toBe(2);
  });

  it('computes level sizes and tile grids, rounding partial tiles up', () => {
    expect(pyramidLevel(600, 300, 256, 2, 2)).toEqual({
      zoom: 2,
      width: 600,
      height: 300,
      columns: 3,
      rows: 2,
    });
    expect(pyramidLevel(600, 300, 256, 2, 1)).toEqual({
      zoom: 1,
      width: 300,
      height: 150,
      columns: 2,
      rows: 1,
    });
    expect(pyramidLevel(600, 300, 256, 2, 0)).toMatchObject({ width: 150, height: 75, columns: 1 });
    expect(pyramidLevel(8192, 8192, 256, 5, 3)).toMatchObject({ columns: 8, rows: 8 });
  });

  it('scales by a power of two per level', () => {
    expect(zoomScale(5, 5)).toBe(1);
    expect(zoomScale(3, 5)).toBe(0.25);
    expect(zoomScale(6.5, 5)).toBeCloseTo(2 ** 1.5);
    expect(pyramidWorldSize(256, 5)).toBe(8192);
  });

  it('finds the tiles covering a pixel rectangle', () => {
    const level = pyramidLevel(8192, 8192, 256, 5, 5);
    expect(tileRangeForBounds({ minX: 300, minY: 0, maxX: 800, maxY: 255 }, level, 256, 5)).toEqual(
      { minCol: 1, minRow: 0, maxCol: 3, maxRow: 0 },
    );
    const z0 = pyramidLevel(8192, 8192, 256, 5, 0);
    expect(
      tileRangeForBounds({ minX: -50, minY: -50, maxX: 9000, maxY: 9000 }, z0, 256, 5),
    ).toEqual({ minCol: 0, minRow: 0, maxCol: 0, maxRow: 0 });
    expect(
      tileRangeForBounds({ minX: 9000, minY: 0, maxX: 9500, maxY: 10 }, z0, 256, 5),
    ).toBeNull();
  });
});

describe('CRS.Simple conversion', () => {
  it('maps image pixels so that maxZoom is 1:1 and y points down', () => {
    expect(pixelToSimpleLatLng({ x: 8192, y: 4096 }, 5)).toEqual([-128, 256]);
    expect(simpleLatLngToPixel(-128, 256, 5)).toEqual({ x: 8192, y: 4096 });
  });

  it('round-trips arbitrary points', () => {
    const p = { x: 1234.5, y: 6789.25 };
    const [lat, lng] = pixelToSimpleLatLng(p, 7);
    expect(simpleLatLngToPixel(lat, lng, 7)).toEqual(p);
  });
});

describe('Mercator mapping for the clustering index', () => {
  it('maps the world square to the full longitude range and back', () => {
    const [west, north] = pixelToMercatorLngLat({ x: 0, y: 0 }, 8192);
    const [east, south] = pixelToMercatorLngLat({ x: 8192, y: 8192 }, 8192);
    expect(west).toBe(-180);
    expect(east).toBe(180);
    expect(north).toBeCloseTo(85.0511, 3);
    expect(south).toBeCloseTo(-85.0511, 3);
  });

  it('round-trips points', () => {
    for (const p of [
      { x: 4096, y: 4096 },
      { x: 10, y: 8000 },
      { x: 7777.7, y: 3.3 },
    ]) {
      const [lng, lat] = pixelToMercatorLngLat(p, 8192);
      const back = mercatorLngLatToPixel(lng, lat, 8192);
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });
});

describe('world transform', () => {
  const t = { a: 2, b: 0.5, c: -0.25, d: 3, e: 100, f: -50 };

  it('applies the affine transform', () => {
    expect(pixelToWorld({ x: 10, y: 20 }, t)).toEqual({ x: 115, y: 15 });
  });

  it('inverts it', () => {
    const back = worldToPixel(pixelToWorld({ x: 10, y: 20 }, t), t);
    expect(back.x).toBeCloseTo(10, 9);
    expect(back.y).toBeCloseTo(20, 9);
  });

  it('rejects a singular transform', () => {
    expect(() => worldToPixel({ x: 0, y: 0 }, { a: 1, b: 2, c: 2, d: 4, e: 0, f: 0 })).toThrow();
  });
});

describe('polygons', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ] as const;
  const concave = [
    [0, 0],
    [10, 0],
    [10, 10],
    [5, 5],
    [0, 10],
  ] as const;

  it('tests point containment', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 11, y: 5 }, square)).toBe(false);
    expect(pointInPolygon({ x: 5, y: 8 }, concave)).toBe(false);
    expect(pointInPolygon({ x: 2, y: 3 }, concave)).toBe(true);
  });

  it('measures bounds and area', () => {
    expect(polygonBounds(concave)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(polygonArea(square)).toBe(100);
    expect(polygonArea(concave)).toBe(75);
  });
});
