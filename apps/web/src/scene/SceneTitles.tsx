import { useEffect, useMemo, useRef } from 'react';
import type { SceneEngine } from './engine';
import { placeTitles, type AreaTitle, type ViewBox } from './titles';

/** What lies over the 3D view, which titles keep clear of: its tools, the bars and cards over the map. */
const OVER_THE_VIEW =
  '.scene-side > *, .touch-map-top > *, .touch-map-bottom > *, .place-sheet, .marker-tooltip';
/** How long the boxes of what lies over the view are kept before they are measured again. */
const COVER_MS = 300;

/**
 * The names of the areas over the 3D view (see `titles.ts`): buttons that
 * follow the view as it moves, faded with distance and never over one
 * another. Pressing one shows the whole area. They are outside the view's
 * own box, so the keyboard and a controller's focus reach them as any
 * other button.
 *
 * They are placed after each frame the view draws (`listen`), by writing
 * their position straight to the page, not by drawing them again.
 */
export function SceneTitles({
  engine,
  titles,
  listen,
  onPress,
}: {
  engine: SceneEngine;
  titles: readonly AreaTitle[];
  /** Calls the function given after each frame drawn; null stops. */
  listen: (update: (() => void) | null) => void;
  onPress: (title: AreaTitle) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const depths = useMemo(() => new Map(titles.map((t) => [t.id, t.depth] as const)), [titles]);

  useEffect(() => {
    // Each title's size, measured once: they only change with their names.
    const sizes = new Map<string, { width: number; height: number }>();
    let covered: ViewBox[] = [];
    let coveredAt = -Infinity;
    const update = () => {
      const root = layer.current;
      if (!root || engine.gone) return;
      const now = performance.now();
      if (now - coveredAt > COVER_MS) {
        coveredAt = now;
        const own = root.getBoundingClientRect();
        covered = [...document.querySelectorAll(OVER_THE_VIEW)].flatMap((element) => {
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return [];
          return [
            {
              left: box.left - own.left,
              top: box.top - own.top,
              right: box.right - own.left,
              bottom: box.bottom - own.top,
            },
          ];
        });
      }
      const buttons = new Map(
        [...root.querySelectorAll<HTMLButtonElement>('[data-title-id]')].map(
          (button) => [button.dataset.titleId!, button] as const,
        ),
      );
      const points = engine.titlesOnScreen();
      const onScreen = points.map((point) => {
        let size = sizes.get(point.id);
        if (!size) {
          const button = buttons.get(point.id);
          size = { width: button?.offsetWidth ?? 0, height: button?.offsetHeight ?? 0 };
          if (size.width > 0) sizes.set(point.id, size);
        }
        return { ...point, ...size, depth: depths.get(point.id) ?? 0 };
      });
      const active = document.activeElement;
      const keep = active instanceof HTMLElement ? (active.dataset.titleId ?? null) : null;
      const shown = placeTitles(onScreen, engine.viewSize(), engine.size, keep, covered);
      for (const point of points) {
        const button = buttons.get(point.id);
        if (!button) continue;
        const opacity = shown.get(point.id) ?? 0;
        if (opacity <= 0) {
          button.style.visibility = 'hidden';
          continue;
        }
        button.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -100%)`;
        button.style.opacity = opacity.toFixed(2);
        button.style.visibility = 'visible';
      }
    };
    listen(update);
    update();
    return () => {
      listen(null);
    };
  }, [engine, depths, listen]);

  if (titles.length === 0) return null;
  return (
    <div
      ref={layer}
      className="scene-titles"
      role="group"
      aria-label="Areas"
      data-testid="scene-titles"
    >
      {titles.map((title) => (
        <button
          key={title.id}
          type="button"
          className="scene-title"
          data-title-id={title.id}
          data-testid="scene-title"
          title={`Show all of ${title.name}`}
          onClick={() => {
            onPress(title);
          }}
        >
          {title.name}
        </button>
      ))}
    </div>
  );
}
