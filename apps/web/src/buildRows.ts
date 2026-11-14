import { parseId } from '@atlas/schema';
import { cellKey, isNothing } from './tableSort';

/**
 * "Add to build" on the rows of a guide page's tables: a row whose first
 * cell names something gets a small button of its own at the end of that
 * cell, to add the thing to a Build guide (see `AddToBuild.tsx`). A first
 * cell names something when it links to a page of the game, or holds a
 * name: words that do not start with a number, and are not "N/A", "-" and
 * the like. A table without a heading over each column (a box of facts,
 * say) is left as it is, as are the rows of a table of steps, which start
 * with numbers.
 *
 * It is a way of acting only: the page's Markdown is never changed, and a
 * table sorted keeps the button in its row.
 */

/** The most letters a first cell may have to be a name. */
const MOST_LETTERS = 80;

const PLUS =
  '<svg class="ui-icon" width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M10 4v12M4 10h12"/></svg>';

/** A thing a table row names: its name, and the page its first cell links to. */
export interface RowThing {
  name: string;
  guideId?: string;
}

/** The page of the game a cell links to, if it links to one. */
function pageLinkOf(cell: Element): string | undefined {
  for (const link of cell.querySelectorAll('[data-atlas-target]')) {
    const target = link.getAttribute('data-atlas-target') ?? '';
    if (parseId(target)?.kind === 'guide') return target;
  }
  return undefined;
}

/** What a row's first cell names, or null when it names nothing. */
export function rowThing(row: HTMLTableRowElement): RowThing | null {
  const cell = row.cells[0];
  if (cell?.tagName !== 'TD') return null;
  const name = cellKey(cell);
  const guideId = pageLinkOf(cell);
  if (guideId && name) return { name, guideId };
  if (!name || name.length > MOST_LETTERS || isNothing(name)) return null;
  if (/^[\p{N}+\-−.]/u.test(name) || !/\p{L}/u.test(name)) return null;
  return { name };
}

/** Whether a table has a heading over each of its columns. */
function headedTable(table: HTMLTableElement): boolean {
  const head = table.tHead?.rows[0];
  if (!head || head.cells.length < 2) return false;
  return [...head.cells].every((cell) => cellKey(cell) !== '');
}

/**
 * Gives the rows of `root`'s tables that name something a button to add
 * the thing to a build, each called after what it adds. Done again after
 * the page is shown anew: a table already done is left.
 */
export function enhanceBuildRows(root: Element): void {
  for (const table of root.querySelectorAll('table')) {
    if (table.hasAttribute('data-build-rows') || !headedTable(table)) continue;
    table.setAttribute('data-build-rows', '');
    for (const row of table.tBodies[0]?.rows ?? []) {
      const thing = rowThing(row);
      if (!thing) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'build-row-add';
      button.dataset.buildRow = '';
      button.setAttribute('aria-label', `Add “${thing.name}” to build`);
      button.title = 'Add to build';
      button.innerHTML = PLUS;
      row.cells[0]!.append(button);
    }
  }
}

/** The thing of the row whose button an event happened on, if it did. */
export function buildRowAt(target: EventTarget | null, root: Element): RowThing | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest('[data-build-row]');
  const row = button?.closest('tr');
  if (!button || !(row instanceof HTMLTableRowElement) || !root.contains(row)) return null;
  return rowThing(row);
}
