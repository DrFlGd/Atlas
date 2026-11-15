import { afterEach, describe, expect, it } from 'vitest';
import { closePicture, fittedSize, MOST_ENLARGED, openPicture, useViewer } from './pictureViewer';
import { opensLarger } from '../pictureLarge';

describe('the larger view of a picture', () => {
  afterEach(() => {
    closePicture();
  });

  it('fits a large picture to the room, keeping its shape, and can show it at real size', () => {
    const fitted = fittedSize({ width: 4000, height: 2000 }, { width: 1000, height: 800 });
    expect(fitted).toMatchObject({ width: 1000, height: 500, zoomable: true });
    const tall = fittedSize({ width: 600, height: 3000 }, { width: 1000, height: 600 });
    expect(tall).toMatchObject({ width: 120, height: 600, zoomable: true });
  });

  it('enlarges a small picture, at most so many times, with nothing more to see at real size', () => {
    const icon = fittedSize({ width: 24, height: 24 }, { width: 1000, height: 800 });
    expect(icon).toMatchObject({
      width: 24 * MOST_ENLARGED,
      height: 24 * MOST_ENLARGED,
      zoomable: false,
    });
    const fits = fittedSize({ width: 700, height: 500 }, { width: 1000, height: 800 });
    expect(fits).toMatchObject({ width: 1000, height: 714, zoomable: false });
    expect(fits.scale).toBeGreaterThan(1);
  });

  it('opens one picture at a time and counts each opening', () => {
    const before = useViewer.getState().opened;
    openPicture({ url: 'a.png', description: 'A gate' });
    openPicture({ url: 'b.png', description: 'A bell' });
    expect(useViewer.getState().shown?.url).toBe('b.png');
    expect(useViewer.getState().opened).toBe(before + 2);
    closePicture();
    expect(useViewer.getState().shown).toBeNull();
  });
});

describe('which pictures of a page open large', () => {
  it('opens a picture whose file is larger than the page shows it, a small icon too', () => {
    expect(opensLarger({ width: 800, height: 600 }, { width: 300, height: 225 })).toBe(true);
    expect(opensLarger({ width: 96, height: 96 }, { width: 24, height: 24 })).toBe(true);
    expect(opensLarger({ width: 200, height: 900 }, { width: 200, height: 300 })).toBe(true);
  });

  it('opens nothing for a picture no larger than shown, one that is a link, or one not loaded', () => {
    expect(opensLarger({ width: 24, height: 24 }, { width: 24, height: 24 })).toBe(false);
    expect(opensLarger({ width: 16, height: 16 }, { width: 32, height: 32 })).toBe(false);
    // Rounding of a size given in CSS pixels is not a larger file.
    expect(opensLarger({ width: 301, height: 226 }, { width: 300, height: 225 })).toBe(false);
    expect(opensLarger({ width: 800, height: 600 }, { width: 300, height: 225 }, true)).toBe(false);
    expect(opensLarger({ width: 0, height: 0 }, { width: 300, height: 225 })).toBe(false);
    expect(opensLarger({ width: 800, height: 600 }, { width: 0, height: 0 })).toBe(false);
  });
});
