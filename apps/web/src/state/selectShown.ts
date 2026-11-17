/**
 * "Tick all" and "Tick none" above a list of pages or games to tick:
 * what each would change. They act on everything the list shows under its
 * filter or search, whether or not its row is on the screen (a long list
 * shows its rows a step at a time, and a heading may be closed), and never
 * on what the filter or search hides.
 */
export interface ShownSelection {
  /** How many the list shows that can be ticked. */
  shown: number;
  /** How many of those are ticked. */
  ticked: number;
  /** What "Tick all" ticks: those shown and not ticked yet. */
  toTick: string[];
  /** What "Tick none" unticks: those shown and ticked. */
  toUntick: string[];
}

/**
 * `shown` is the keys the list shows that can be ticked, in order; a key
 * that comes twice (a page under two headings) counts once. `ticked` is
 * every key ticked, shown or not.
 */
export function selectShown(
  shown: Iterable<string>,
  ticked: ReadonlySet<string> | readonly string[],
): ShownSelection {
  const tickedKeys: ReadonlySet<string> = ticked instanceof Set ? ticked : new Set(ticked);
  const seen = new Set<string>();
  const toTick: string[] = [];
  const toUntick: string[] = [];
  for (const key of shown) {
    if (seen.has(key)) continue;
    seen.add(key);
    (tickedKeys.has(key) ? toUntick : toTick).push(key);
  }
  return { shown: seen.size, ticked: toUntick.length, toTick, toUntick };
}

/**
 * "12 pages to tick, 3 of them ticked": how many a list shows to tick and
 * how many of those are ticked, for the sentence beside the buttons.
 */
export function shownCount(
  selection: Pick<ShownSelection, 'shown' | 'ticked'>,
  one: string,
  many: string,
): string {
  const { shown, ticked } = selection;
  const what = `${shown.toLocaleString('en')} ${shown === 1 ? one : many} to tick`;
  const state =
    shown === 1
      ? ticked === 1
        ? 'and it is ticked'
        : 'not ticked yet'
      : ticked === 0
        ? 'none of them ticked'
        : ticked === shown
          ? 'all of them ticked'
          : `${ticked.toLocaleString('en')} of them ticked`;
  return `${what}, ${state}`;
}
