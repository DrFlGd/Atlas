import { describe, expect, it } from 'vitest';
import {
  cameraOffset,
  ease,
  flightStep,
  frameDistance,
  GO_TO_HEIGHT,
  GO_TO_TILT,
  goToDistance,
  headCut,
  MIN_AREA_RADIUS,
  shortestTurn,
} from './goTo';

describe('the cut above a location', () => {
  it('is at head height above it, 3 m', () => {
    expect(headCut(3.2, 6.75)).toBeCloseTo(6.2);
    expect(headCut(-10, -4)).toBeCloseTo(-7);
  });

  it('is just under its floor’s top when the location is within 3 m of it', () => {
    expect(headCut(5, 6.75)).toBeCloseTo(6.55);
    expect(headCut(6.5, 6.75)).toBeCloseTo(6.55);
  });

  it('keeps a location right under the top in sight', () => {
    // Within the margin under the top: cut at the top itself.
    expect(headCut(6.7, 6.75)).toBe(6.75);
    // Above the top (the highest floor takes what is above it): above its head.
    expect(headCut(12, 10.75)).toBe(15);
  });

  it('is at head height on a map without floors', () => {
    expect(headCut(41.5, null)).toBe(44.5);
  });
});

describe('the view of a location', () => {
  it('looks down from about 26 m above it, tilted by 10°', () => {
    const distance = goToDistance(256);
    const [, up] = cameraOffset(distance, GO_TO_TILT, 0);
    expect(up).toBeCloseTo(GO_TO_HEIGHT);
    expect((GO_TO_TILT * 180) / Math.PI).toBeCloseTo(10);
  });

  it('comes nearer on a small model and stays further on a large one', () => {
    expect(goToDistance(20)).toBeCloseTo(12);
    expect(goToDistance(8000)).toBeCloseTo(80);
    // Never nearer than the view may come.
    expect(goToDistance(20, 15)).toBe(15);
  });

  it('keeps the compass direction: the camera stands on the side it faced', () => {
    const [x, , z] = cameraOffset(100, Math.PI / 2, Math.PI / 2);
    expect(x).toBeCloseTo(100);
    expect(z).toBeCloseTo(0);
  });

  it('frames an area whole, further for a larger one or a narrower view', () => {
    const wide = frameDistance(50, 50, 16 / 9);
    expect(Math.tan((25 * Math.PI) / 180) * wide).toBeGreaterThan(50);
    expect(frameDistance(100, 50, 16 / 9)).toBeCloseTo(wide * 2);
    expect(frameDistance(50, 50, 0.5)).toBeGreaterThan(wide);
    // A tiny area is framed as one of the least size.
    expect(frameDistance(1, 50, 1)).toBeCloseTo(frameDistance(MIN_AREA_RADIUS, 50, 1));
  });
});

describe('a flight', () => {
  it('eases in and out', () => {
    expect(ease(0)).toBe(0);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(1)).toBe(1);
    expect(ease(0.1)).toBeLessThan(0.1);
    expect(ease(0.9)).toBeGreaterThan(0.9);
  });

  it('turns the short way round', () => {
    expect(shortestTurn(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(-0.2);
    expect(shortestTurn(3, -3)).toBeCloseTo(2 * Math.PI - 6);
  });

  it('goes from one view to the other', () => {
    const from = { distance: 200, azimuth: 0.2, polar: 0.9 };
    const to = { distance: 25, azimuth: 0.2, polar: GO_TO_TILT };
    expect(flightStep(from, to, 0)).toMatchObject({ ...from, k: 0 });
    const end = flightStep(from, to, 1);
    expect(end.distance).toBeCloseTo(25);
    expect(end.polar).toBeCloseTo(GO_TO_TILT);
    expect(end.azimuth).toBeCloseTo(0.2);
    // Halfway in scale: the distance changes evenly as the view zooms.
    expect(flightStep(from, to, 0.5).distance).toBeCloseTo(Math.sqrt(200 * 25));
  });
});
