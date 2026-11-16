import { describe, expect, it } from 'vitest';
import { pageExcerpt } from './pageExcerpt';

describe('pageExcerpt', () => {
  it('never shows a marker line of a layout form, and reads its blocks in order', () => {
    const body = [
      '::: side 1:3',
      '::: card',
      '### Menu',
      '- Bells',
      '::: end',
      '::: next',
      '::: centred',
      'The waystone wakes at **dusk**.',
      '::: end',
      '::: end',
      '## More',
      'Later text.',
    ].join('\n\n');
    expect(pageExcerpt(body)).toBe('Menu Bells The waystone wakes at dusk.');
    expect(pageExcerpt('::: centred\n\nIn the middle.\n\n::: end')).toBe('In the middle.');
    // A marker that is no marker is text, as the page shows it.
    expect(pageExcerpt('::: card\n\nNever closed.')).toBe('::: card Never closed.');
  });
});
