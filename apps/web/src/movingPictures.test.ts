import { describe, expect, it } from 'vitest';
import { gifFrames, isGifAddress } from './movingPictures';

/** A GIF of `frames` pictures of 1 × 1 pixel, with a table of two colours. */
function gif(frames: number, version = '89a'): Uint8Array {
  const picture = [
    // How long it is shown.
    0x21, 0xf9, 4, 0, 10, 0, 0, 0,
    // Where it goes, then its codes.
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0,
  ];
  return new Uint8Array([
    ...Array.from(`GIF${version}`, (c) => c.charCodeAt(0)),
    1,
    0,
    1,
    0,
    0x80,
    0,
    0,
    0,
    0,
    0,
    0xff,
    0xff,
    0xff,
    ...Array.from({ length: frames }, () => picture).flat(),
    0x3b,
  ]);
}

describe('gifFrames', () => {
  it('tells a GIF that moves from one that does not', () => {
    expect(gifFrames(gif(1))).toBe(1);
    expect(gifFrames(gif(1, '87a'))).toBe(1);
    expect(gifFrames(gif(2))).toBe(2);
    // Counts no further than two.
    expect(gifFrames(gif(5))).toBe(2);
  });

  it('reads a picture with colours of its own', () => {
    const own = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0, 0, 0, 1, 1, 1, 2, 2, 0x44, 1, 0];
    const bytes = gif(1);
    const moving = new Uint8Array([...bytes.subarray(0, -1), ...own, 0x3b]);
    expect(gifFrames(moving)).toBe(2);
  });

  it('is null for what is no GIF, or ends too soon', () => {
    expect(gifFrames(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(gifFrames(gif(2).subarray(0, 12))).toBeNull();
    expect(gifFrames(gif(2).subarray(0, 25))).toBeNull();
  });
});

describe('isGifAddress', () => {
  it('looks at the path of the address only', () => {
    expect(isGifAddress('atlas-pack://localhost/isle/pictures/torch.gif')).toBe(true);
    expect(isGifAddress('/packs/demo/pictures/TORCH.GIF?1')).toBe(true);
    expect(isGifAddress('/packs/demo/pictures/torch.png')).toBe(false);
    expect(isGifAddress('/packs/demo/pictures/torch.png?name=a.gif')).toBe(false);
  });
});
