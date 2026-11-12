/**
 * How the touch layout is arranged in a window of a given size.
 *
 * - compact (phones, and tablets held upright): the map fills the screen,
 *   with a bar of sections at the bottom and sheets that rise from it;
 * - wide (tablets on their side, and phones on their side): a rail of
 *   sections on the left, a panel beside it and the map in the rest.
 */
export type Arrangement = 'compact' | 'wide';

/** Wide from 840 px across, or on its side from 600 px across. */
export function arrangementFor(width: number, height: number): Arrangement {
  return width >= 840 || (width > height && width >= 600) ? 'wide' : 'compact';
}

/** A phone on its side: little height, so the panel is narrower. */
export function panelWidthFor(width: number, height: number): number {
  return width > height && height < 520 ? 320 : 360;
}
