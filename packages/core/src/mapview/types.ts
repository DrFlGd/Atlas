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
  /**
   * The part of the image the map shows first, in image pixels; the whole
   * image when absent. For an image that reaches well beyond what is on it.
   */
  focus?: PixelBounds;
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
  /**
   * How far outside a marker's badge a click or tap still picks it, in CSS
   * pixels. Defaults to 3; a touch screen wants more, since a finger covers
   * the badge.
   */
  hitSlop?: number;
  /** Show the + and − zoom buttons. Defaults to true. */
  zoomControl?: boolean;
}

export interface FlyToTarget {
  x: number;
  y: number;
  /** Target zoom; keeps the current zoom when omitted. */
  zoom?: number;
}

/** Where the player stood in a game save: drawn above the markers, as an arrow when the facing is known. */
export interface PlayerMarker {
  /** Image pixel, origin top-left. */
  x: number;
  y: number;
  /** Facing in degrees clockwise from up on the map; null draws a dot. */
  heading: number | null;
  /** Shown as the marker's tooltip and accessible name. */
  label: string;
}

/**
 * A point of a list drawn over the markers, with its number: a step of the
 * list being edited (`step`), the step open in the editor (`current`), an
 * optional step (`optional`), or a location picked to be added (`pick`).
 */
export interface OverlayPoint {
  /** Image pixel, origin top-left. */
  x: number;
  y: number;
  /** The step's number; empty for a picked location. */
  label: string;
  style: 'step' | 'current' | 'optional' | 'pick';
}

/** The points of a list over the map; the steps joined in order by a line when `joined`. */
export interface MapOverlay {
  points: readonly OverlayPoint[];
  joined: boolean;
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
  /** Shows the player's position from a game save, or hides it (null). */
  setPlayer(player: PlayerMarker | null): void;
  /**
   * Draws a list's points over the markers (the list editor's), or nothing
   * (null). They are drawn only: a click on one goes to the marker under it.
   */
  setOverlay(overlay: MapOverlay | null): void;
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
  /**
   * Called with the marker id when the user presses and holds a marker
   * (about half a second, without moving and with one finger or button).
   * The click that may follow the press does not select the marker. While
   * nobody listens, pressing and holding does nothing special.
   */
  onLongPress(listener: (markerId: string) => void): Unsubscribe;
  /**
   * Called with the marker id when the user right-clicks a marker (or
   * holds a finger on it where a touch screen opens the context menu that
   * way, as Windows does). While someone listens,
   * the page's own menu does not open over a marker or a cluster; over the
   * plain map it still does.
   */
  onMarkerMenu(listener: (markerId: string) => void): Unsubscribe;
  /** Called with the image pixel of every click on the map, on a marker or not. */
  onMapClick(listener: (point: PixelPoint) => void): Unsubscribe;
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
