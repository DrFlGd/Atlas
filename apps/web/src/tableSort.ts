/**
 * Tables of a guide page, sorted by a column as the reader asks: a table
 * with a heading row and at least two rows under it gets headings that
 * are buttons. The first press sorts by that column, smallest first, the
 * second largest first, the third puts the page's own order back; one
 * column at a time. It is a way of looking only: the rows are moved in
 * the page shown, and the guide's Markdown is never changed.
 *
 * A column whose cells start with numbers ("147-279 (230-437)", "+408%",
 * "-13%", "1,200", "10 seconds") is sorted by those numbers; any other by
 * its words, without regard to case, numbers within words in their order
 * ("Level 2" before "Level 10"). A cell with nothing to sort by ("N/A",
 * "-", empty) comes last either way, and cells that are the same keep the
 * page's order. A picture counts as its words. Hidden text that is not
 * shown counts as nothing, so the order never gives it away, and sorting
 * never shows it.
 */

export type SortDirection = 'ascending' | 'descending';

export interface TableSort {
  column: number;
  direction: SortDirection;
}

/** The sorts of a page's tables, by the position of each table in the page. */
export type PageSorts = Map<number, TableSort>;

/** What a cell holds when it holds nothing to sort by. */
const NOTHING = /^(?:|[-–—?…]+|n\/?a|none|unknown)$/iu;

const NUMBER = /^([+\-−]?)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)/u;

/** The number a cell's text starts with, or null when it does not start with one. */
export function leadingNumber(text: string): number | null {
  const match = NUMBER.exec(text.trim());
  if (!match) return null;
  const value = Number(match[2]!.replaceAll(',', ''));
  if (!Number.isFinite(value)) return null;
  return match[1] === '-' || match[1] === '−' ? -value : value;
}

/** Whether a cell's text has nothing to sort by. */
export const isNothing = (text: string): boolean => NOTHING.test(text.trim());

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/**
 * The order of rows sorted by their cells' text in one column: the positions
 * of the rows, in the order to show them.
 */
export function sortedOrder(keys: readonly string[], direction: SortDirection): number[] {
  const texts = keys.map((key) => key.replace(/\s+/gu, ' ').trim());
  const filled = texts.filter((text) => !isNothing(text));
  const numeric = filled.length > 0 && filled.every((text) => leadingNumber(text) !== null);
  const sign = direction === 'ascending' ? 1 : -1;
  return texts
    .map((text, index) => ({ text, index, nothing: isNothing(text) }))
    .sort((a, b) => {
      if (a.nothing !== b.nothing) return a.nothing ? 1 : -1;
      if (a.nothing) return a.index - b.index;
      const by = numeric
        ? leadingNumber(a.text)! - leadingNumber(b.text)!
        : collator.compare(a.text, b.text);
      return by !== 0 ? sign * by : a.index - b.index;
    })
    .map((row) => row.index);
}

// ---------------------------------------------------------------------------
// In the page

/**
 * The words of a cell as it reads now: its text and its pictures' words,
 * without hidden text that is not shown nor the button that shows it.
 */
export function cellKey(cell: Element): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? '';
      return;
    }
    if (!(node instanceof Element)) return;
    if (node.hasAttribute('hidden') || node.classList.contains('hidden-text-show')) return;
    if (node.classList.contains('table-sort-arrow')) return;
    if (node instanceof HTMLImageElement) {
      out += ` ${node.alt} `;
      return;
    }
    if (node.tagName === 'BR') out += ' ';
    node.childNodes.forEach(walk);
  };
  walk(cell);
  return out.replace(/\s+/gu, ' ').trim();
}

const ARROW = 'table-sort-arrow';

/** The tables of `root` that can be sorted: a heading row and two rows or more under it. */
function sortableTables(root: Element): HTMLTableElement[] {
  return [...root.querySelectorAll('table')].filter((table) => {
    const head = table.tHead?.rows[0];
    return (
      head !== undefined &&
      head.querySelector('th') !== null &&
      (table.tBodies[0]?.rows.length ?? 0) >= 2
    );
  });
}

/**
 * Makes the headings of `root`'s tables buttons that sort, and shows each
 * table as `sorts` has it. Done again after the page is shown anew (its
 * pictures arrive, its links come alive): a table already done is left.
 */
export function enhanceTables(root: Element, sorts: PageSorts): void {
  sortableTables(root).forEach((table, position) => {
    if (table.hasAttribute('data-sortable')) return;
    table.setAttribute('data-sortable', String(position));
    [...table.tBodies[0]!.rows].forEach((row, index) => {
      row.dataset.row = String(index);
    });
    [...table.tHead!.rows[0]!.cells].forEach((cell, column) => {
      if (cell.tagName !== 'TH' || cellKey(cell) === '') return;
      const arrow = document.createElement('span');
      arrow.className = ARROW;
      arrow.setAttribute('aria-hidden', 'true');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'table-sort';
      button.dataset.tableSort = String(column);
      if (cell.querySelector('a, button')) {
        // A heading that holds a link keeps it; the button beside it sorts.
        button.classList.add('table-sort-beside');
        button.setAttribute('aria-label', `Sort by ${cellKey(cell)}`);
        button.append(arrow);
        cell.append(button);
      } else {
        button.append(...cell.childNodes, arrow);
        cell.append(button);
      }
    });
    showSort(table, sorts.get(position) ?? null);
  });
}

/** Shows a table in the order of `sort`, or in the page's own order for none. */
function showSort(table: HTMLTableElement, sort: TableSort | null): void {
  const body = table.tBodies[0];
  if (!body) return;
  const rows = [...body.rows].sort((a, b) => Number(a.dataset.row) - Number(b.dataset.row));
  const order = sort
    ? sortedOrder(
        rows.map((row) => {
          const cell = row.cells[sort.column];
          return cell ? cellKey(cell) : '';
        }),
        sort.direction,
      )
    : rows.map((_, index) => index);
  body.append(...order.map((index) => rows[index]!));
  [...table.tHead!.rows[0]!.cells].forEach((cell, column) => {
    if (sort?.column === column) cell.setAttribute('aria-sort', sort.direction);
    else cell.removeAttribute('aria-sort');
  });
}

/**
 * Sorts the table whose heading an event happened in, if it did: the next
 * of smallest first, largest first and the page's order. Returns whether
 * it acted.
 */
export function sortTableAt(target: EventTarget | null, root: Element, sorts: PageSorts): boolean {
  if (!(target instanceof Element)) return false;
  const button = target.closest('[data-table-sort]');
  const table = button?.closest('table[data-sortable]');
  if (!button || !(table instanceof HTMLTableElement) || !root.contains(table)) return false;
  const column = Number(button.getAttribute('data-table-sort'));
  const position = Number(table.getAttribute('data-sortable'));
  const now = sorts.get(position);
  const next: TableSort | null =
    now?.column !== column
      ? { column, direction: 'ascending' }
      : now.direction === 'ascending'
        ? { column, direction: 'descending' }
        : null;
  if (next) sorts.set(position, next);
  else sorts.delete(position);
  showSort(table, next);
  return true;
}
