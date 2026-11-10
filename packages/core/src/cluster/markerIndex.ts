import Supercluster from 'supercluster';
import {
  mercatorLngLatToPixel,
  pixelToMercatorLngLat,
  pyramidWorldSize,
  type PixelBounds,
  type PixelPoint,
} from '../geometry/coords';

/** The minimum a marker needs to be indexed. */
export interface IndexedPoint {
  id: string;
  x: number;
  y: number;
}

export interface MarkerIndexOptions {
  tileSize: number;
  /** Pyramid level at which the image is shown 1:1. */
  maxZoom: number;
  /** Cluster radius in screen pixels. */
  radius?: number;
  /**
   * Highest zoom at which points are still clustered; above it every point is
   * shown. Defaults to two levels below 1:1.
   */
  maxClusterZoom?: number;
  /** Turn clustering off and always return individual points. */
  clustering?: boolean;
}

export type IndexHit<T> =
  | { kind: 'point'; point: T; x: number; y: number }
  | { kind: 'cluster'; clusterId: number; count: number; x: number; y: number };

interface PointProps {
  index: number;
}

/**
 * A spatial index over map points that answers "what should be drawn in this
 * rectangle at this zoom", grouping nearby points into clusters.
 *
 * Supercluster expects longitude/latitude, so points are fed through a Web
 * Mercator inverse that keeps image space linear. With `extent` equal to the
 * tile size, Supercluster's zoom levels line up with the map's zoom levels.
 */
export class MarkerIndex<T extends IndexedPoint> {
  readonly points: readonly T[];
  private readonly worldSize: number;
  private readonly cluster: Supercluster<PointProps> | null;

  constructor(points: readonly T[], options: MarkerIndexOptions) {
    this.points = points;
    this.worldSize = pyramidWorldSize(options.tileSize, options.maxZoom);
    if (options.clustering === false) {
      this.cluster = null;
      return;
    }
    this.cluster = new Supercluster<PointProps>({
      radius: options.radius ?? 36,
      extent: options.tileSize,
      minZoom: 0,
      maxZoom: Math.max(0, options.maxClusterZoom ?? options.maxZoom - 2),
    });
    this.cluster.load(
      points.map((point, index) => ({
        type: 'Feature' as const,
        properties: { index },
        geometry: {
          type: 'Point' as const,
          coordinates: pixelToMercatorLngLat(point, this.worldSize),
        },
      })),
    );
  }

  /** Points and clusters to draw inside `bounds` (image pixels) at `zoom`. */
  query(bounds: PixelBounds, zoom: number): IndexHit<T>[] {
    if (!this.cluster) {
      const hits: IndexHit<T>[] = [];
      for (const point of this.points) {
        if (
          point.x >= bounds.minX &&
          point.x <= bounds.maxX &&
          point.y >= bounds.minY &&
          point.y <= bounds.maxY
        ) {
          hits.push({ kind: 'point', point, x: point.x, y: point.y });
        }
      }
      return hits;
    }
    const [west, north] = pixelToMercatorLngLat(
      clampToWorld(bounds.minX, bounds.minY, this.worldSize),
      this.worldSize,
    );
    const [east, south] = pixelToMercatorLngLat(
      clampToWorld(bounds.maxX, bounds.maxY, this.worldSize),
      this.worldSize,
    );
    const features = this.cluster.getClusters(
      [west, south, east, north],
      Math.max(0, Math.floor(zoom)),
    );
    return features.map((feature): IndexHit<T> => {
      const [lng, lat] = feature.geometry.coordinates as [number, number];
      const { x, y } = mercatorLngLatToPixel(lng, lat, this.worldSize);
      const props = feature.properties;
      if ('cluster' in props) {
        return { kind: 'cluster', clusterId: props.cluster_id, count: props.point_count, x, y };
      }
      const point = this.points[props.index]!;
      return { kind: 'point', point, x: point.x, y: point.y };
    });
  }

  /** The zoom at which a cluster splits into more than one item. */
  expansionZoom(clusterId: number): number {
    if (!this.cluster) throw new Error('clustering is disabled');
    return this.cluster.getClusterExpansionZoom(clusterId);
  }

  /** Every point inside a cluster. */
  leaves(clusterId: number): T[] {
    if (!this.cluster) throw new Error('clustering is disabled');
    return this.cluster.getLeaves(clusterId, Infinity).map((f) => this.points[f.properties.index]!);
  }
}

function clampToWorld(x: number, y: number, worldSize: number): PixelPoint {
  return {
    x: Math.min(worldSize, Math.max(0, x)),
    y: Math.min(worldSize, Math.max(0, y)),
  };
}
