import { describe, expect, it } from 'vitest';
import { pickShown } from './showRequests';

describe('a game another program asks for', () => {
  const request = {
    packs: ['keep-map', 'valley', 'keep-wiki', 'keep-old'],
    groups: [{ id: 'keep', members: ['keep-wiki', 'keep-map'] }],
  };

  it('shows the game shown last when it is one of those found', () => {
    expect(pickShown(request, 'keep-old', {})).toBe('keep-old');
    expect(pickShown(request, 'keep-old', { keep: 'keep-wiki' })).toBe('keep-old');
  });

  it('else the first found, or the source of its title used last', () => {
    expect(pickShown(request, null, {})).toBe('keep-map');
    expect(pickShown(request, 'other', {})).toBe('keep-map');
    expect(pickShown(request, null, { keep: 'keep-wiki' })).toBe('keep-wiki');
    // A source used last that was not found, or of another title.
    expect(pickShown(request, null, { keep: 'keep-gone' })).toBe('keep-map');
    expect(pickShown(request, null, { other: 'valley' })).toBe('keep-map');
  });

  it('shows the one game a pack id names, and nothing when none is named', () => {
    expect(pickShown({ packs: ['valley'], groups: [] }, 'keep-map', {})).toBe('valley');
    expect(pickShown({ packs: [], groups: [] }, 'keep-map', {})).toBeNull();
  });
});
