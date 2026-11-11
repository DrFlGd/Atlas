import { FormatError } from './binary';

/**
 * Decodes one raw LZ4 block (the block format, without the frame around
 * it) into `dst` at `dstStart`, which must leave room for exactly
 * `expectedSize` bytes. Returns the number of bytes written, which is
 * always `expectedSize`; anything else is a {@link FormatError}.
 *
 * A block is a run of sequences: a token (high four bits: literal length,
 * low four bits: match length minus 4), more length bytes when a nibble is
 * 15, the literals, a little-endian 16-bit offset back into the output,
 * and more match length bytes. The last sequence has literals only.
 * Matches may overlap the bytes they produce (an offset shorter than the
 * match repeats a pattern), so they are copied byte by byte.
 */
export function decodeLz4Block(
  src: Uint8Array,
  dst: Uint8Array,
  dstStart: number,
  expectedSize: number,
): number {
  const dstEnd = dstStart + expectedSize;
  if (dstEnd > dst.length) throw new FormatError('LZ4 output does not fit');
  let s = 0;
  let d = dstStart;
  const srcEnd = src.length;

  const readLength = (base: number): number => {
    let length = base;
    if (base === 15) {
      for (;;) {
        if (s >= srcEnd) throw new FormatError('LZ4 length runs past the block');
        const byte = src[s++]!;
        length += byte;
        if (byte !== 255) break;
      }
    }
    return length;
  };

  while (s < srcEnd) {
    const token = src[s++]!;
    const literals = readLength(token >>> 4);
    if (s + literals > srcEnd) throw new FormatError('LZ4 literals run past the block');
    if (d + literals > dstEnd) throw new FormatError('LZ4 literals run past the output');
    dst.set(src.subarray(s, s + literals), d);
    s += literals;
    d += literals;
    if (s === srcEnd) break; // the last sequence has no match
    if (s + 2 > srcEnd) throw new FormatError('LZ4 match offset runs past the block');
    const offset = src[s]! | (src[s + 1]! << 8);
    s += 2;
    if (offset === 0 || d - offset < dstStart) throw new FormatError('LZ4 match offset is invalid');
    const length = readLength(token & 15) + 4;
    if (d + length > dstEnd) throw new FormatError('LZ4 match runs past the output');
    let from = d - offset;
    if (offset >= length) {
      dst.copyWithin(d, from, from + length);
      d += length;
    } else {
      for (let i = 0; i < length; i++) dst[d++] = dst[from++]!;
    }
  }
  if (d !== dstEnd) {
    throw new FormatError(`LZ4 block gave ${d - dstStart} bytes, expected ${expectedSize}`);
  }
  return expectedSize;
}
