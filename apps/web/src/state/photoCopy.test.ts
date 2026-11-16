import { describe, expect, it } from 'vitest';
import type { Picture } from '@atlas/schema';
import { cardCopyFile } from './photoCopy';

const picture = (fields: Partial<Picture>): Picture => ({
  id: 'demo:picture:view',
  file: 'pictures/view.jpg',
  shareable: false,
  ...fields,
});

describe('cardCopyFile', () => {
  it('names the copy for cards of a photo to be fetched later', () => {
    expect(cardCopyFile(picture({ remote: 'https://pictures.example.com/view.jpg' }))).toBe(
      'pictures/view.page.jpg',
    );
  });

  it('uses the copy for pages a picture names', () => {
    expect(
      cardCopyFile(
        picture({
          remote: 'https://pictures.example.com/view.jpg',
          pageCopy: { file: 'pictures/view.small.jpg', width: 200 },
        }),
      ),
    ).toBe('pictures/view.small.jpg');
  });

  it('has none for a picture of the pack itself or one with a copy shown', () => {
    expect(cardCopyFile(picture({}))).toBeUndefined();
    expect(
      cardCopyFile(
        picture({
          remote: 'https://pictures.example.com/view.jpg',
          shownAt: 'https://pictures.example.com/small/view.jpg',
        }),
      ),
    ).toBeUndefined();
  });

  it('has none where the name would be too long', () => {
    const file = `pictures/${'a'.repeat(118)}.png`;
    expect(cardCopyFile(picture({ file, remote: 'https://pictures.example.com/a.png' }))).toBe(
      undefined,
    );
    const short = `pictures/${'a'.repeat(115)}.png`;
    expect(
      cardCopyFile(picture({ file: short, remote: 'https://pictures.example.com/a.png' })),
    ).toBe(`pictures/${'a'.repeat(115)}.page.png`);
  });
});
