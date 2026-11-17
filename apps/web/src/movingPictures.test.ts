import { describe, expect, it } from 'vitest';
import { gifFrames, gifMotion, isGifAddress } from './movingPictures';

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

/** The looping extension: an application extension named `name`, then 1 and the count, low byte first. */
function looping(count: number, name = 'NETSCAPE2.0'): number[] {
  return [
    0x21,
    0xff,
    11,
    ...Array.from(name, (c) => c.charCodeAt(0)),
    3,
    1,
    count & 0xff,
    count >> 8,
    0,
  ];
}

/** `bytes` with `extension` put where the GIF's blocks begin (after its colours), or before its end. */
function withExtension(bytes: Uint8Array, extension: number[], atEnd = false): Uint8Array {
  const at = atEnd ? bytes.length - 1 : 19;
  return new Uint8Array([...bytes.subarray(0, at), ...extension, ...bytes.subarray(at)]);
}

describe('gifMotion', () => {
  it('tells a GIF that plays for ever from one that plays once or a few times', () => {
    // No looping extension: it plays once.
    expect(gifMotion(gif(3))).toEqual({ moves: true, forever: false });
    expect(gifMotion(withExtension(gif(3), looping(0)))).toEqual({ moves: true, forever: true });
    expect(gifMotion(withExtension(gif(3), looping(3)))).toEqual({ moves: true, forever: false });
    // A count of more than one byte.
    expect(gifMotion(withExtension(gif(2), looping(0x0100)))).toEqual({
      moves: true,
      forever: false,
    });
    // The other name the extension is known by.
    expect(gifMotion(withExtension(gif(2), looping(0, 'ANIMEXTS1.0')))?.forever).toBe(true);
  });

  it('finds the looping extension after the first pictures', () => {
    expect(gifMotion(withExtension(gif(4), looping(0), true))).toEqual({
      moves: true,
      forever: true,
    });
  });

  it('reads past an application extension of another name, and a comment', () => {
    const other = looping(0, 'MADEUPAPP10');
    const comment = [0x21, 0xfe, 5, ...Array.from('quiet', (c) => c.charCodeAt(0)), 0];
    const bytes = withExtension(withExtension(gif(2), comment), other);
    expect(gifMotion(bytes)).toEqual({ moves: true, forever: false });
    expect(gifFrames(bytes)).toBe(2);
  });

  it('tells a GIF that does not move, looping or not', () => {
    expect(gifMotion(gif(1))).toEqual({ moves: false, forever: false });
    expect(gifMotion(withExtension(gif(1), looping(0)))).toEqual({ moves: false, forever: true });
  });

  it('keeps what it found when the bytes end early, and is null for what is no GIF', () => {
    const cut = withExtension(gif(3), looping(0), true);
    // Two pictures read, then the end comes before the extension.
    expect(gifMotion(cut.subarray(0, 19 + 23 * 2 + 4))).toEqual({ moves: true, forever: false });
    expect(gifMotion(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(gifMotion(gif(2).subarray(0, 25))).toBeNull();
    // The extension's count cut off: no count is read.
    const short = withExtension(gif(2), looping(0)).subarray(0, 19 + 17);
    expect(gifMotion(short)).toBeNull();
  });

  it('leaves gifFrames as it was with a looping extension', () => {
    expect(gifFrames(withExtension(gif(1), looping(0)))).toBe(1);
    expect(gifFrames(withExtension(gif(5), looping(0)))).toBe(2);
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
