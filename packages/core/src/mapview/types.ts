/**
 * The public surface of the map view. These types carry no dependency on the
 * rendering library, so the rest of the app can describe what to show without
 * knowing how it is drawn.
 */

import type { PixelBounds, PixelPoint } from '../geometry/coords';

/** A raster layer to display: the map image's size and where its tiles live. */
export interface MapLayerSpec {
  id: string;
  /** Full-resolution image size in pixels. */
  width: number;
  height: number;
  tileSize: number;
  /** Lowest pyramid level present. */
  minZoom: number;
  /** Pyramid level at which the image is shown 1:1. */
  maxZoom: number;
  /** Absolute tile source URL; for `xyz` a `{z}/{x}/{y}` template. */
  tiles: { type: 'pmtiles' | 'xyz'; url: string };
  /**
   * The levels the tiles actually have, when only part of the pyramid is
   * there (map images being downloaded, or downloaded at less than full
   * detail). Beyond it the map scales the nearest level. A known range also
   * means the tiles exist, so they are not probed.
   */
  nativeZoom?: { min: number; max: number };
  /** HTML attribution shown in the map corner. */
  attribution?: string;
}

/** One point to draw on the map. */
export interface MapMarker {
  id: string;
  /** Image pixel, origin top-left. */
  x: number;
  y: number;
  /** `#rrggbb` colour of the marker badge. */
  color: string;
  /** Glyph name from the icon set drawn on the badge; unknown names draw a pin. */
  icon?: string;
  /** Drawn faded, for locations already found. */
  muted?: boolean;
}

/** The marker under the pointer, and where it sits in container pixels. */
export interface MarkerHover {
  id: string;
  x: number;
  y: number;
}

/** Whether the current layer's tiles could be read; `missing` shows a plain background. */
export interface TileStatus {
  layerId: string;
  status: 'loading' | 'ready' | 'missing';
}

export interface MapViewState {
  zoom: number;
  center: PixelPoint;
  /** Visible part of the image, in image pixels. */
  bounds: PixelBounds;
}

export interface MapViewOptions {
  /** Group nearby markers into clusters at low zoom. Defaults to true. */
  clustering?: boolean;
  /** Levels the user may zoom past the pyramid's 1:1 level. Defaults to 2. */
  overZoom?: number;
}

export interface FlyToTarget {
  x: number;
  y: number;
  /** Target zoom; keeps the current zoom when omitted. */
  zoom?: number;
}

export type Unsubscribe = () => void;

/**
 * An interactive, pannable and zoomable map of one raster layer with a set of
 * point markers. Coordinates are always image pixels.
 */
export interface MapView {
  /**
   * Shows a layer and fits the view to it. Clears the markers if the layer
   * changes. Calling it again for the same layer with another `nativeZoom`
   * only swaps the tiles.
   */
  setLayer(layer: MapLayerSpec): void;
  /**
   * Replaces all markers. When only styling changed (same ids and positions
   * in the same order) the clusters are reused, so this is cheap.
   */
  setMarkers(markers: readonly MapMarker[]): void;
  /** Highlights one marker, or none. Does not notify `onSelect` listeners. */
  setSelected(markerId: string | null): void;
  /** Re-reads theme colours from CSS custom properties and redraws. */
  refreshStyle(): void;
  /**
   * Looks again for tiles of the current layer that were not there before:
   * shows the tiles if the layer had none, and asks again for the ones that
   * failed to load. Tiles already shown, the view and the markers stay.
   * Other layers that had no tiles are looked at again when next shown.
   */
  refreshTiles(): void;
  /** Moves the view, animated unless `animate` is false. */
  flyTo(target: FlyToTarget, options?: { animate?: boolean }): void;
  /** Called with the marker id when the user clicks a marker, or null when they click empty map. */
  onSelect(listener: (markerId: string | null) => void): Unsubscribe;
  /** Called when the pointer moves onto a marker, or off it (null). */
  onHover(listener: (hover: MarkerHover | null) => void): Unsubscribe;
  /** Called when the tile status of the current layer changes. */
  onTileStatus(listener: (status: TileStatus) => void): Unsubscribe;
  /** Called whenever the visible area changes, including during pans and zooms. */
  onViewChange(listener: (state: MapViewState) => void): Unsubscribe;
  /** The current view, or null before a layer is set. */
  getView(): MapViewState | null;
  /** Removes the map from its container and releases its resources. */
  destroy(): void;
}
