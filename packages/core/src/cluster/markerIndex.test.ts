import { describe, expect, it } from 'vitest';
import { MarkerIndex } from './markerIndex';

const world = { minX: 0, minY: 0, maxX: 8192, maxY: 8192 };

function grid(step: number) {
  const points = [];
  for (let y = step / 2; y < 8192; y += step) {
    for (let x = step / 2; x < 8192; x += step) {
      points.push({ id: `p${points.length}`, x, y });
    }
  }
  return points;
}

const count = (hits: ReturnType<MarkerIndex<{ id: string; x: number; y: number }>['query']>) =>
  hits.reduce((sum, hit) => sum + (hit.kind === 'cluster' ? hit.count : 1), 0);

describe('MarkerIndex', () => {
  const points = grid(256); // 32 x 32 = 1024 points, 256 image px apart
  const index = new MarkerIndex(points, { tileSize: 256, maxZoom: 5 });

  it('stops clustering two levels below 1:1 unless told otherwise', () => {
    // 100 points 16 image px apart: 4 to 8 screen px apart at zooms 3 to 4.
    const dense = Array.from({ length: 100 }, (_, i) => ({
      id: `d${i}`,
      x: 1000 + (i % 10) * 16,
      y: 1000 + Math.floor(i / 10) * 16,
    }));
    const byDefault = new MarkerIndex(dense, { tileSize: 256, maxZoom: 5 });
    expect(byDefault.query(world, 3).some((hit) => hit.kind === 'cluster')).toBe(true);
    expect(byDefault.query(world, 4).every((hit) => hit.kind === 'point')).toBe(true);
    const later = new MarkerIndex(dense, { tileSize: 256, maxZoom: 5, maxClusterZoom: 4 });
    expect(later.query(world, 4).some((hit) => hit.kind === 'cluster')).toBe(true);
  });

  it('accounts for every point at every zoom', () => {
    for (let zoom = 0; zoom <= 7; zoom++) {
      expect(count(index.query(world, zoom))).toBe(points.length);
    }
  });

  it('clusters at low zoom and shows single points at 1:1', () => {
    const low = index.query(world, 0);
    expect(low.length).toBeLessThan(points.length / 10);
    const clustered = low.filter((hit) => hit.kind === 'cluster');
    expect(clustered.length / low.length).toBeGreaterThan(0.9);
    // At zoom 5 the points are 256 screen px apart, far beyond the cluster radius.
    const full = index.query(world, 5);
    expect(full).toHaveLength(points.length);
    expect(full.every((hit) => hit.kind === 'point')).toBe(true);
  });

  it('returns points at their exact image coordinates', () => {
    const hits = index.query({ minX: 0, minY: 0, maxX: 300, maxY: 300 }, 6);
    expect(hits).toContainEqual({ kind: 'point', point: points[0], x: 128, y: 128 });
    expect(hits.every((hit) => hit.x <= 300 + 1 && hit.y <= 300 + 1)).toBe(true);
  });

  it('places clusters in image space and expands them', () => {
    const [cluster] = index.query({ minX: 0, minY: 0, maxX: 1000, maxY: 1000 }, 1);
    expect(cluster?.kind).toBe('cluster');
    if (cluster?.kind !== 'cluster') return;
    expect(cluster.x).toBeGreaterThan(0);
    expect(cluster.x).toBeLessThan(8192);
    expect(index.expansionZoom(cluster.clusterId)).toBeGreaterThan(1);
    expect(index.leaves(cluster.clusterId)).toHaveLength(cluster.count);
  });

  it('can be told not to cluster', () => {
    const flat = new MarkerIndex(points, { tileSize: 256, maxZoom: 5, clustering: false });
    expect(flat.query(world, 0)).toHaveLength(points.length);
    expect(flat.query({ minX: 0, minY: 0, maxX: 256, maxY: 256 }, 0)).toHaveLength(1);
  });

  it('reuses its clusters for restyled points', () => {
    const restyled = points.map((p) => ({ ...p, muted: true }));
    const copy = index.withPoints(restyled);
    const hits = copy.query(world, 5);
    expect(hits.length).toBe(index.query(world, 5).length);
    const firstPoint = hits.find((hit) => hit.kind === 'point');
    expect(firstPoint?.kind === 'point' && (firstPoint.point as { muted?: boolean }).muted).toBe(
      true,
    );
    expect(() => index.withPoints(restyled.slice(1))).toThrow();
  });
});
