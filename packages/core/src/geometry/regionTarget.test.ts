import { describe, expect, it } from 'vitest';
import {
  REGION_CENTER_ZOOM_OUT,
  hasRegionTarget,
  regionTarget,
  viewportSize,
} from './regionTarget';

// A made-up layer: a 4096 px image in 256 px tiles, levels 0 to 4.
const layer = { minZoom: 0, maxZoom: 4 };
const viewport = { width: 1000, height: 800 };
/** A 1000 x 400 px outline whose middle is (1500, 1200). */
const outline: [number, number][] = [
  [1000, 1000],
  [2000, 1000],
  [2000, 1400],
  [1000, 1400],
];

describe('regionTarget', () => {
  it('goes to the centre, fitting the outline around it, when the region has both', () => {
    const target = regionTarget({ polygon: outline, center: [1250, 1200] }, layer, viewport);
    // Centred on x = 1250 the view must reach x = 2000: 1500 px wide in 900 screen px.
    expect(target).toEqual({ x: 1250, y: 1200, zoom: 3.25 });
    const shown = (1000 * 0.9) / 2 ** (target!.zoom - layer.maxZoom);
    expect(shown).toBeGreaterThanOrEqual(1500);
  });

  it('goes to the middle of the outline and fits it when there is no centre', () => {
    const target = regionTarget({ polygon: outline }, layer, viewport);
    // 1000 px in 900 screen px: just under 1:1, rounded down to a quarter step.
    expect(target).toEqual({ x: 1500, y: 1200, zoom: 3.75 });
  });

  it('uses a fixed zoom below the 1:1 level for a centre without an outline', () => {
    expect(regionTarget({ center: [300, 400] }, layer, viewport)).toEqual({
      x: 300,
      y: 400,
      zoom: layer.maxZoom - REGION_CENTER_ZOOM_OUT,
    });
    expect(regionTarget({ center: [300, 400] }, { minZoom: 3, maxZoom: 4 }, viewport)?.zoom).toBe(
      3,
    );
  });

  it('returns null for a region with neither centre nor outline', () => {
    expect(hasRegionTarget({})).toBe(false);
    expect(hasRegionTarget({ center: [1, 2] })).toBe(true);
    expect(hasRegionTarget({ polygon: outline })).toBe(true);
    expect(regionTarget({}, layer, viewport)).toBeNull();
    expect(regionTarget({ polygon: undefined, center: undefined }, layer, viewport)).toBeNull();
  });

  it('keeps the zoom within the layer for very small and very large outlines', () => {
    const tiny: [number, number][] = [
      [10, 10],
      [12, 10],
      [12, 12],
    ];
    expect(regionTarget({ polygon: tiny }, layer, viewport)?.zoom).toBe(layer.maxZoom);
    const huge: [number, number][] = [
      [0, 0],
      [400_000, 0],
      [400_000, 400_000],
    ];
    expect(regionTarget({ polygon: huge }, layer, viewport)?.zoom).toBe(layer.minZoom);
  });

  it('shows a zero-size outline, or one in an unknown map area, like a centre', () => {
    const point: [number, number][] = [
      [50, 60],
      [50, 60],
      [50, 60],
    ];
    expect(regionTarget({ polygon: point }, layer, viewport)).toEqual({ x: 50, y: 60, zoom: 2 });
    expect(regionTarget({ polygon: outline }, layer, { width: 0, height: 0 })?.zoom).toBe(2);
  });
});

describe('viewportSize', () => {
  it('turns the visible image pixels into screen pixels', () => {
    const view = { zoom: 3, bounds: { minX: 100, minY: 200, maxX: 2100, maxY: 1800 } };
    expect(viewportSize(view, 4)).toEqual({ width: 1000, height: 800 });
  });
});
