import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/** The scroll container a list is in. */
const SCROLL_ROOT = '.pane-body, [data-scroll-root]';

/** How far beyond the visible part of the list rows are rendered, in pixels. */
const OVERSCAN = 600;

export interface VirtualListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** Height of a row before it has been measured. */
  estimate: number;
  renderItem: (item: T, index: number) => React.ReactNode;
  className?: string;
  testId?: string;
  /** Whether the list can be seen; while it cannot, nothing is measured. */
  visible: boolean;
  /** A row to scroll into view; a new `seq` asks again. */
  reveal?: { index: number; seq: number } | null;
  /** Called once the row asked for is in view, with its element. */
  onRevealed?: (element: HTMLElement, seq: number) => void;
}

interface Viewport {
  /** The scroll container's scroll position, its height, and where the list starts in it. */
  scrollTop: number;
  height: number;
  listTop: number;
}

/**
 * A list that renders only the rows near the visible part of its scroll
 * container (the nearest `.pane-body` or `[data-scroll-root]`), so a checklist of thousands of
 * items opens and scrolls at once. Rows may differ in height: each is
 * measured once rendered, and rows not measured yet count as `estimate`.
 * Spacers above and below stand in for the rows that are not rendered, so
 * the scroll bar reflects the whole list. Focus moving to a row near the
 * edge (with Tab) scrolls it into view, which renders the rows after it.
 */
export function VirtualList<T>({
  items,
  getKey,
  estimate,
  renderItem,
  className,
  testId,
  visible,
  reveal,
  onRevealed,
}: VirtualListProps<T>) {
  const listRef = useRef<HTMLUListElement>(null);
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [viewport, setViewport] = useState<Viewport>({
    scrollTop: 0,
    height: typeof window === 'undefined' ? 800 : window.innerHeight,
    listTop: 0,
  });

  // Follows the scroll container: scrolling, resizing, and being shown.
  useEffect(() => {
    const list = listRef.current;
    const parent = list?.closest<HTMLElement>(SCROLL_ROOT);
    if (!list || !parent) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const listTop =
        list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
      const next = { scrollTop: parent.scrollTop, height: parent.clientHeight, listTop };
      setViewport((prev) =>
        prev.scrollTop === next.scrollTop &&
        prev.height === next.height &&
        prev.listTop === next.listTop
          ? prev
          : next,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    parent.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(parent);
    return () => {
      parent.removeEventListener('scroll', schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  // Measures rendered rows; a changed height re-lays the list once per frame.
  const [resizeObserver] = useState(() =>
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries) => {
          const sizes: [string, number][] = [];
          for (const entry of entries) {
            const element = entry.target as HTMLElement;
            const key = element.dataset.key;
            const height = entry.borderBoxSize[0]?.blockSize ?? element.offsetHeight;
            if (key !== undefined && height > 0) sizes.push([key, height]);
          }
          setHeights((prev) => {
            if (sizes.every(([key, height]) => prev.get(key) === height)) return prev;
            const next = new Map(prev);
            for (const [key, height] of sizes) next.set(key, height);
            return next;
          });
        }),
  );
  useEffect(
    () => () => {
      resizeObserver?.disconnect();
    },
    [resizeObserver],
  );

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const offsets = useMemo(() => {
    const result = new Float64Array(keys.length + 1);
    for (let i = 0; i < keys.length; i++) {
      result[i + 1] = result[i]! + (heights.get(keys[i]!) ?? estimate);
    }
    return result;
  }, [keys, estimate, heights]);

  const total = offsets[keys.length]!;
  const from = viewport.scrollTop - viewport.listTop - OVERSCAN;
  const to = viewport.scrollTop - viewport.listTop + Math.max(viewport.height, 200) + OVERSCAN;
  const start = Math.max(0, upperBound(offsets, from) - 1);
  const end = Math.min(keys.length, Math.max(start + 1, lowerBound(offsets, to)));

  // Rows are observed while rendered.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !resizeObserver) return;
    const rows = [...list.children].filter((c) => (c as HTMLElement).dataset.key !== undefined);
    for (const row of rows) resizeObserver.observe(row);
    return () => {
      for (const row of rows) resizeObserver.unobserve(row);
    };
  });

  // Brings a row into view: scroll to where it should be, wait for it to be
  // rendered (the scroll event re-renders the list), then centre it.
  const revealed = useRef(0);
  useEffect(() => {
    // Shown again (a sheet reopened): the row is brought back into view.
    if (!visible) revealed.current = 0;
  }, [visible]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const parent = list?.closest<HTMLElement>(SCROLL_ROOT);
    if (!reveal || !visible || !list || !parent || revealed.current === reveal.seq) return;
    if (reveal.index < 0 || reveal.index >= keys.length) return;
    const row = list.querySelector<HTMLElement>(`:scope > [data-index="${reveal.index}"]`);
    if (row) {
      revealed.current = reveal.seq;
      row.scrollIntoView({ block: 'center' });
      onRevealed?.(row, reveal.seq);
      return;
    }
    parent.scrollTop = viewport.listTop + offsets[reveal.index]! - parent.clientHeight / 2;
  });

  const rendered = [];
  for (let i = start; i < end; i++) {
    rendered.push(
      <li
        key={keys[i]}
        data-key={keys[i]}
        data-index={i}
        aria-setsize={keys.length}
        aria-posinset={i + 1}
        className="virtual-row"
      >
        {renderItem(items[i]!, i)}
      </li>,
    );
  }
  return (
    <ul
      ref={listRef}
      className={className}
      data-testid={testId}
      data-rendered={end - start}
      style={{ paddingTop: offsets[start], paddingBottom: total - offsets[end]! }}
    >
      {rendered}
    </ul>
  );
}

/** The first index whose value is greater than `value`. */
function upperBound(values: Float64Array, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** The first index whose value is at least `value`. */
function lowerBound(values: Float64Array, value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! < value) low = mid + 1;
    else high = mid;
  }
  return low;
}
