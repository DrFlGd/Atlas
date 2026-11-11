import type { SaveMatch, SaveSummary } from '@atlas/saves';
import { describe, expect, it } from 'vitest';
import { mapStateText, nothingExplained, nothingNotice } from './explain';

const match = (parts: Partial<SaveMatch>): SaveMatch => ({
  current: null,
  worlds: [],
  player: null,
  found: [],
  categories: [],
  unmatched: [],
  calibrated: {},
  needsCalibration: false,
  unplaced: 0,
  nothingBecause: null,
  ...parts,
});

describe('why a save marks nothing', () => {
  it('says a new game has found nothing yet, without implying a failure', () => {
    const fresh = match({ nothingBecause: 'nothing-done' });
    expect(nothingNotice(fresh)).toBe('The save has not discovered any places yet.');
    expect(nothingExplained(fresh)).toContain('expected near the start of the game');
  });

  it('says the places are named by tag only, and Atlas has no table of them yet', () => {
    const tagged = match({ nothingBecause: 'no-tag-table', unplaced: 12 });
    expect(nothingNotice(tagged)).toBe(
      'The save names 12 discovered places by the game’s own tags only, and Atlas has no table yet of where those are.',
    );
    expect(nothingExplained(tagged)).toContain('lists 12 places as discovered or cleared');
    expect(nothingExplained(tagged)).toContain('Nothing is wrong with the save.');
    expect(nothingNotice(match({ nothingBecause: 'no-tag-table', unplaced: 1 }))).toContain(
      '1 discovered place by',
    );
  });

  it('says nothing when there is nothing to explain', () => {
    expect(nothingNotice(match({}))).toBeNull();
    expect(nothingExplained(match({}))).toBeNull();
    expect(nothingNotice(match({ nothingBecause: 'no-map' }))).toBe(
      'The save’s map could not be read.',
    );
  });

  it('counts what the save’s own map holds', () => {
    const summary = {
      map: { known: 1, discovered: 0, disabled: 3, visited: [], lists: {} },
    } as unknown as SaveSummary;
    expect(mapStateText(summary)).toBe(
      'On the save’s own map: 0 places discovered, 3 cleared, 1 known of.',
    );
    expect(mapStateText({ map: null } as unknown as SaveSummary)).toBeNull();
  });
});
