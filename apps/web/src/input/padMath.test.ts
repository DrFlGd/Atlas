import { describe, expect, it } from 'vitest';
import {
  FINE_PAN,
  PAN_SPEED,
  SNAP_RADIUS,
  ZOOM_RATE,
  glyphStyleFor,
  jumpTarget,
  padContext,
  panStep,
  scrollStep,
  snapTarget,
  stickVector,
  triggerValue,
  zoomStep,
  type ContextFacts,
} from './padMath';

describe('stickVector', () => {
  it('is still inside the dead zone', () => {
    expect(stickVector(0, 0)).toEqual({ x: 0, y: 0 });
    expect(stickVector(0.1, -0.1)).toEqual({ x: 0, y: 0 });
    expect(stickVector(Number.NaN, 0)).toEqual({ x: 0, y: 0 });
  });

  it('reaches full speed at the edge, and grows slowly near the middle', () => {
    expect(stickVector(1, 0).x).toBeCloseTo(1);
    expect(stickVector(0, -1).y).toBeCloseTo(-1);
    const half = stickVector(0.5, 0).x;
    expect(half).toBeGreaterThan(0.1);
    expect(half).toBeLessThan(0.4);
    // Pushed past the edge, as some sticks report on the diagonal.
    const corner = stickVector(1, 1);
    expect(Math.hypot(corner.x, corner.y)).toBeCloseTo(1);
    expect(corner.x).toBeCloseTo(corner.y);
  });
});

describe('triggerValue', () => {
  it('is 0 when let go and 1 when pulled fully', () => {
    expect(triggerValue(0)).toBe(0);
    expect(triggerValue(0.05)).toBe(0);
    expect(triggerValue(1)).toBe(1);
    expect(triggerValue(0.54)).toBeCloseTo(0.5, 1);
  });
});

describe('panStep and zoomStep', () => {
  it('moves the map by the speed and the time of the frame', () => {
    const step = panStep({ x: 1, y: 0 }, { x: 0, y: 0 }, 0.5 / 10, 'normal', false);
    expect(step.x).toBeCloseTo(PAN_SPEED.normal * 0.05);
    expect(step.y).toBe(0);
    expect(panStep({ x: 1, y: 0 }, { x: 0, y: 0 }, 0.05, 'fast', false).x).toBeGreaterThan(step.x);
  });

  it('moves slowly with the right stick, and turns up and down round when asked', () => {
    const fine = panStep({ x: 0, y: 0 }, { x: 0, y: 1 }, 0.05, 'normal', false);
    expect(fine.y).toBeCloseTo(PAN_SPEED.normal * 0.05 * FINE_PAN);
    const inverted = panStep({ x: 0, y: 1 }, { x: 0, y: 0 }, 0.05, 'normal', true);
    expect(inverted.y).toBeLessThan(0);
  });

  it('counts no more than a tenth of a second, so a stall does not throw the map', () => {
    const stall = panStep({ x: 1, y: 0 }, { x: 0, y: 0 }, 3, 'normal', false);
    expect(stall.x).toBeCloseTo(PAN_SPEED.normal * 0.1);
    expect(zoomStep(0, 1, 3)).toBeCloseTo(ZOOM_RATE * 0.1);
  });

  it('zooms in with the right trigger and out with the left', () => {
    expect(zoomStep(0, 1, 0.05)).toBeCloseTo(ZOOM_RATE * 0.05);
    expect(zoomStep(1, 0, 0.05)).toBeCloseTo(-ZOOM_RATE * 0.05);
    expect(zoomStep(1, 1, 0.05)).toBe(0);
    expect(zoomStep(0.02, 0, 0.05)).toBe(0);
  });

  it('scrolls down with the stick pushed down', () => {
    expect(scrollStep(1, 0.05)).toBeGreaterThan(0);
    expect(scrollStep(-1, 0.05)).toBeLessThan(0);
    expect(scrollStep(0, 0.05)).toBe(0);
  });
});

describe('snapTarget', () => {
  const center = { x: 100, y: 100 };
  it('holds the nearest location within its reach', () => {
    const points = [
      { x: 130, y: 100 },
      { x: 110, y: 105 },
      { x: 100, y: 300 },
    ];
    expect(snapTarget(center, points)).toBe(1);
  });

  it('holds nothing beyond its reach', () => {
    expect(snapTarget(center, [{ x: 100 + SNAP_RADIUS + 1, y: 100 }])).toBe(-1);
    expect(snapTarget(center, [{ x: 100 + SNAP_RADIUS, y: 100 }])).toBe(0);
    expect(snapTarget(center, [])).toBe(-1);
  });

  it('keeps the first of two as near', () => {
    expect(
      snapTarget(center, [
        { x: 110, y: 100 },
        { x: 90, y: 100 },
      ]),
    ).toBe(0);
  });
});

describe('jumpTarget', () => {
  const from = { x: 0, y: 0 };
  const points = [
    { x: 100, y: 0 }, // 0: right
    { x: 40, y: 60 }, // 1: below, to the right
    { x: -50, y: 10 }, // 2: left
    { x: 0, y: -200 }, // 3: far up
    { x: 0, y: 0 }, // 4: where it is
    { x: 30, y: -90 }, // 5: up, a little to the right
  ];

  it('goes to the nearest location that way', () => {
    expect(jumpTarget(from, 'right', points, 4)).toBe(0);
    expect(jumpTarget(from, 'left', points, 4)).toBe(2);
    expect(jumpTarget(from, 'down', points, 4)).toBe(1);
    expect(jumpTarget(from, 'up', points, 4)).toBe(5);
  });

  it('prefers one straight ahead to a nearer one far beside', () => {
    expect(
      jumpTarget(from, 'right', [
        { x: 30, y: 50 },
        { x: 80, y: 0 },
      ]),
    ).toBe(1);
  });

  it('finds nothing where nothing lies that way', () => {
    expect(jumpTarget(from, 'left', [{ x: 10, y: 0 }])).toBe(-1);
    // Far more beside than ahead: not that way.
    expect(jumpTarget(from, 'right', [{ x: 10, y: 100 }])).toBe(-1);
    expect(jumpTarget(from, 'up', [], -1)).toBe(-1);
  });
});

describe('glyphStyleFor', () => {
  it('gives shapes to controllers with them, by vendor id or name', () => {
    expect(glyphStyleFor('Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')).toBe(
      'shapes',
    );
    expect(glyphStyleFor('054c-09cc-Wireless Controller')).toBe('shapes');
    expect(glyphStyleFor('DualSense Wireless Controller')).toBe('shapes');
  });

  it('gives letters to every other controller, and when none is known', () => {
    expect(glyphStyleFor('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('letters');
    expect(glyphStyleFor('Steam Virtual Gamepad (Vendor: 28de Product: 11ff)')).toBe('letters');
    expect(glyphStyleFor('Pro Controller (Vendor: 057e)')).toBe('letters');
    expect(glyphStyleFor(null)).toBe('letters');
    expect(glyphStyleFor('')).toBe('letters');
  });
});

describe('padContext', () => {
  const base: ContextFacts = {
    reader: false,
    overlay: false,
    section: 'map',
    mapShown: true,
    focus: 'none',
  };

  it('moves the map on the map section with nothing else focused', () => {
    expect(padContext(base)).toBe('map');
    expect(padContext({ ...base, focus: 'map' })).toBe('map');
    // The classic layout has no sections.
    expect(padContext({ ...base, section: null })).toBe('map');
  });

  it('gives way to what has the focus or lies over the map', () => {
    expect(padContext({ ...base, focus: 'other' })).toBe('menus');
    expect(padContext({ ...base, focus: 'card' })).toBe('card');
    expect(padContext({ ...base, overlay: true })).toBe('menus');
    expect(padContext({ ...base, overlay: true, reader: true })).toBe('reading');
    expect(padContext({ ...base, mapShown: false })).toBe('menus');
  });

  it('reads in Guides, and is in a list in Lists', () => {
    expect(padContext({ ...base, section: 'guides' })).toBe('reading');
    expect(padContext({ ...base, section: 'lists' })).toBe('lists');
    expect(padContext({ ...base, section: 'settings' })).toBe('menus');
  });
});
