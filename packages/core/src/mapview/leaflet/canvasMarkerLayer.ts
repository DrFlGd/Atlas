import L from 'leaflet';
import { MarkerIndex, type IndexHit } from '../../cluster/markerIndex';
import type { MapMarker } from '../types';

/** Extra canvas area drawn around the viewport, as a fraction of its size, so short pans show no gaps. */
const PADDING = 0.25;
const MARKER_RADIUS = 6;
const HIT_SLOP = 4;

interface Palette {
  outline: string;
  clusterFill: string;
  clusterRing: string;
  clusterText: string;
  selection: string;
}

const FALLBACK_PALETTE: Palette = {
  outline: 'rgba(8, 10, 14, 0.9)',
  clusterFill: 'rgba(32, 40, 56, 0.92)',
  clusterRing: '#e6b450',
  clusterText: '#f2f4f8',
  selection: '#ffffff',
};

/** Reads marker colours from CSS custom properties on the map container, if set. */
function readPalette(element: HTMLElement): Palette {
  const style = getComputedStyle(element);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    outline: read('--atlas-marker-outline', FALLBACK_PALETTE.outline),
    clusterFill: read('--atlas-cluster-fill', FALLBACK_PALETTE.clusterFill),
    clusterRing: read('--atlas-cluster-ring', FALLBACK_PALETTE.clusterRing),
    clusterText: read('--atlas-cluster-text', FALLBACK_PALETTE.clusterText),
    selection: read('--atlas-selection', FALLBACK_PALETTE.selection),
  };
}

function clusterRadius(count: number): number {
  return Math.min(24, 11 + Math.log2(count) * 1.8);
}

interface DrawnItem {
  /** Canvas CSS pixel position. */
  x: number;
  y: number;
  r: number;
  hit: IndexHit<MapMarker>;
}

export interface CanvasMarkerLayerOptions {
  pane: string;
  /** Pyramid level at which the image is shown 1:1. */
  maxZoom: number;
  tileSize: number;
  clustering: boolean;
  /** Called when the user clicks a marker, a cluster or empty map. */
  onPick: (hit: IndexHit<MapMarker> | null) => void;
}

/**
 * Draws many point markers on a single canvas instead of one DOM element each.
 *
 * The canvas covers the viewport plus a margin and sits in a map pane, so it
 * moves with the map while panning. It is redrawn, at most once per animation
 * frame, when a pan uses up half the margin, when the zoom changes and when
 * the map comes to rest. During animated zooms it is scaled with a CSS
 * transform, the same way Leaflet's own vector renderers are. Markers are
 * stamped from one pre-rendered sprite per colour.
 */
export class CanvasMarkerLayer extends L.Layer {
  private readonly settings: CanvasMarkerLayerOptions;
  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private index: MarkerIndex<MapMarker> | null = null;
  private selectedId: string | null = null;
  private drawn: DrawnItem[] = [];
  private topLeft = L.point(0, 0);
  /** Layer point of the container's top-left corner, and the zoom, at the last draw. */
  private drawnOrigin = L.point(0, 0);
  private drawnZoom = Number.NaN;
  private margin = L.point(0, 0);
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private frame = 0;
  private animatingZoom = false;
  private palette = FALLBACK_PALETTE;

  constructor(settings: CanvasMarkerLayerOptions) {
    super();
    // Leaflet classes take options through setOptions, not the constructor.
    L.Util.setOptions(this, { pane: settings.pane });
    this.settings = settings;
  }

  setMarkers(markers: readonly MapMarker[]): void {
    this.index = new MarkerIndex(markers, {
      tileSize: this.settings.tileSize,
      maxZoom: this.settings.maxZoom,
      clustering: this.settings.clustering,
    });
    this.redraw();
  }

  setSelected(markerId: string | null): void {
    this.selectedId = markerId;
    this.redraw();
  }

  expansionZoom(clusterId: number): number {
    return this.index?.expansionZoom(clusterId) ?? this.settings.maxZoom;
  }

  override onAdd(map: L.Map): this {
    const canvas = L.DomUtil.create('canvas', 'atlas-marker-canvas leaflet-zoom-animated');
    canvas.style.pointerEvents = 'none';
    map.getPane(this.settings.pane)?.appendChild(canvas);
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.palette = readPalette(map.getContainer());
    this.sprites.clear();
    this.redraw();
    return this;
  }

  override onRemove(): this {
    cancelAnimationFrame(this.frame);
    this.canvas?.remove();
    this.canvas = null;
    this.context = null;
    this.drawn = [];
    return this;
  }

  override getEvents(): Record<string, L.LeafletEventHandlerFn> {
    return {
      move: this.onMove,
      moveend: this.redrawNow,
      zoomend: this.onZoomEnd,
      viewreset: this.redrawNow,
      resize: this.redrawNow,
      zoomanim: this.onZoomAnim as L.LeafletEventHandlerFn,
      click: this.onClick as L.LeafletEventHandlerFn,
      mousemove: this.onMouseMove as L.LeafletEventHandlerFn,
    };
  }

  /** Finds the topmost drawn marker or cluster under a container point. */
  hitTest(containerPoint: L.Point): IndexHit<MapMarker> | null {
    const map = this._map as L.Map | undefined;
    if (!map) return null;
    const p = map.containerPointToLayerPoint(containerPoint).subtract(this.topLeft);
    let best: DrawnItem | null = null;
    let bestDistance = Infinity;
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const item = this.drawn[i]!;
      const distance = Math.hypot(item.x - p.x, item.y - p.y);
      if (distance <= item.r + HIT_SLOP && distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best?.hit ?? null;
  }

  private readonly onMove = () => {
    const map = this._map as L.Map | undefined;
    if (!map) return;
    const shift = map.containerPointToLayerPoint([0, 0]).subtract(this.drawnOrigin);
    if (
      map.getZoom() !== this.drawnZoom ||
      Math.abs(shift.x) > this.margin.x / 2 ||
      Math.abs(shift.y) > this.margin.y / 2
    ) {
      this.scheduleRedraw();
    }
  };

  private readonly scheduleRedraw = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.animatingZoom) this.draw();
    });
  };

  private readonly redrawNow = () => {
    if (!this.animatingZoom) this.draw();
  };

  private readonly onZoomEnd = () => {
    this.animatingZoom = false;
    this.draw();
  };

  private readonly onZoomAnim = (event: L.ZoomAnimEvent) => {
    const map = this._map as L.Map | undefined;
    if (!map || !this.canvas) return;
    this.animatingZoom = true;
    // A point at container position C ends the animation at
    // (C - Cc) * scale + size / 2, where Cc is the target centre's current
    // container position. The map pane does not move during the animation.
    const scale = map.getZoomScale(event.zoom, map.getZoom());
    const panePosition = map.containerPointToLayerPoint([0, 0]).multiplyBy(-1);
    const targetCenter = map.latLngToContainerPoint(event.center);
    const offset = this.topLeft
      .add(panePosition)
      .subtract(targetCenter)
      .multiplyBy(scale)
      .add(map.getSize().divideBy(2))
      .subtract(panePosition);
    L.DomUtil.setTransform(this.canvas, offset, scale);
  };

  private readonly onClick = (event: L.LeafletMouseEvent) => {
    this.settings.onPick(this.hitTest(event.containerPoint));
  };

  private readonly onMouseMove = (event: L.LeafletMouseEvent) => {
    const map = this._map as L.Map | undefined;
    if (!map) return;
    map
      .getContainer()
      .classList.toggle('atlas-marker-hover', this.hitTest(event.containerPoint) !== null);
  };

  /** A pre-rendered marker of one colour at the given device pixel ratio. */
  private sprite(color: string, ratio: number): HTMLCanvasElement {
    const key = `${color}@${ratio}`;
    let sprite = this.sprites.get(key);
    if (sprite) return sprite;
    const lineWidth = 1.5;
    const size = Math.ceil((MARKER_RADIUS + lineWidth) * 2 + 2);
    sprite = document.createElement('canvas');
    sprite.width = Math.ceil(size * ratio);
    sprite.height = Math.ceil(size * ratio);
    const ctx = sprite.getContext('2d');
    if (ctx) {
      ctx.scale(ratio, ratio);
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, MARKER_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = lineWidth;
      ctx.strokeStyle = this.palette.outline;
      ctx.stroke();
    }
    this.sprites.set(key, sprite);
    return sprite;
  }

  private redraw(): void {
    if (this._map as L.Map | undefined) this.redrawNow();
  }

  private draw(): void {
    const map = this._map as L.Map | undefined;
    const canvas = this.canvas;
    const ctx = this.context;
    if (!map || !canvas || !ctx) return;
    const started = performance.now();

    const size = map.getSize();
    const padX = Math.round(size.x * PADDING);
    const padY = Math.round(size.y * PADDING);
    const width = size.x + 2 * padX;
    const height = size.y + 2 * padY;
    const ratio = window.devicePixelRatio || 1;

    this.topLeft = map.containerPointToLayerPoint([-padX, -padY]).round();
    this.drawnOrigin = map.containerPointToLayerPoint([0, 0]);
    this.drawnZoom = map.getZoom();
    this.margin = L.point(padX, padY);
    L.DomUtil.setPosition(canvas, this.topLeft);
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    this.drawn = [];

    if (!this.index) {
      canvas.dataset.drawnMarkers = '0';
      canvas.dataset.drawnClusters = '0';
      return;
    }

    // Under CRS.Simple an image pixel p projects to p * scale at the current
    // zoom; subtracting the pixel origin gives the layer point, and
    // subtracting the canvas position gives canvas coordinates.
    const zoom = map.getZoom();
    const scale = 2 ** (zoom - this.settings.maxZoom);
    const origin = map.getPixelOrigin();
    const offsetX = -origin.x - this.topLeft.x;
    const offsetY = -origin.y - this.topLeft.y;
    const hits = this.index.query(
      {
        minX: -offsetX / scale,
        minY: -offsetY / scale,
        maxX: (width - offsetX) / scale,
        maxY: (height - offsetY) / scale,
      },
      zoom,
    );

    const pointsByColor = new Map<string, number[]>();
    const clusters: DrawnItem[] = [];
    let selected: DrawnItem | null = null;
    let markerCount = 0;
    for (const hit of hits) {
      const x = hit.x * scale + offsetX;
      const y = hit.y * scale + offsetY;
      if (hit.kind === 'cluster') {
        clusters.push({ x, y, r: clusterRadius(hit.count), hit });
        continue;
      }
      markerCount++;
      const item = { x, y, r: MARKER_RADIUS, hit };
      this.drawn.push(item);
      if (hit.point.id === this.selectedId) selected = item;
      const list = pointsByColor.get(hit.point.color);
      if (list) list.push(x, y);
      else pointsByColor.set(hit.point.color, [x, y]);
    }

    for (const [color, coords] of pointsByColor) {
      const sprite = this.sprite(color, ratio);
      const size = sprite.width / ratio;
      const half = size / 2;
      for (let i = 0; i < coords.length; i += 2) {
        ctx.drawImage(
          sprite,
          Math.round(coords[i]! - half),
          Math.round(coords[i + 1]! - half),
          size,
          size,
        );
      }
    }

    if (clusters.length > 0) {
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const item of clusters) {
        if (item.hit.kind !== 'cluster') continue;
        ctx.beginPath();
        ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2);
        ctx.fillStyle = this.palette.clusterFill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = this.palette.clusterRing;
        ctx.stroke();
        ctx.fillStyle = this.palette.clusterText;
        ctx.fillText(String(item.hit.count), item.x, item.y + 0.5);
        this.drawn.push(item);
      }
    }

    if (selected) {
      ctx.beginPath();
      ctx.arc(selected.x, selected.y, MARKER_RADIUS + 4, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = this.palette.selection;
      ctx.stroke();
    }

    // Exposed for diagnostics and performance tests.
    canvas.dataset.drawnMarkers = String(markerCount);
    canvas.dataset.drawnClusters = String(clusters.length);
    canvas.dataset.drawMs = (performance.now() - started).toFixed(2);
  }
}
