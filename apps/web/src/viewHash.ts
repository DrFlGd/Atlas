/**
 * The URL fragment that records the map view, `#@x,y,zoom` in image pixels,
 * so a view can be bookmarked or shared.
 */

export interface HashView {
  x: number;
  y: number;
  zoom: number;
}

const PATTERN = /^#@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

export function parseViewHash(hash: string): HashView | null {
  const match = PATTERN.exec(hash);
  if (!match) return null;
  const [x, y, zoom] = match.slice(1).map(Number) as [number, number, number];
  return { x, y, zoom };
}

export function formatViewHash(view: HashView): string {
  const zoom = Math.round(view.zoom * 100) / 100;
  return `#@${Math.round(view.x)},${Math.round(view.y)},${zoom}`;
}
