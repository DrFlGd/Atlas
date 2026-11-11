import { describe, expect, it } from 'vitest';
import { FormatError } from './binary';
import { decodeLz4Block } from './lz4';
import { compressLz4Block } from './testing';

const fromHex = (text: string) => Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16));
const latin1Bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function decode(block: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  decodeLz4Block(block, out, 0, size);
  return out;
}

// Blocks made by another LZ4 implementation (lz4js 0.2.0), so the decoder is
// not only checked against Atlas's own test compressor.
const REFERENCE = (() => {
  const a =
    'levels\\novigrad\\novigrad.w2w levels\\novigrad\\novigrad.w2w levels\\skellige\\skellige.w2w BSVLVLVLBSVLOPVLVLBSVL '.repeat(
      4,
    );
  let letters = '';
  for (let i = 0; i < 300; i++) letters += String.fromCharCode(65 + ((i * 7) % 26));
  const b = letters + 'x'.repeat(400) + 'abcdabcdabcd' + letters;
  return [
    {
      text: a,
      block:
        'f5006c6576656c735c6e6f76696772616409005f2e773277201d001194736b656c6c6967655c0900013a00404253564c0200000800244f500a000f5100120f8b000a0465000f6e00e9504253564c20',
    },
    {
      text: b,
      block:
        'ff0b41484f56434a5158454c535a474e5542495057444b5259464d541a00ff001f780100ff7d446162636404000fae02ff000fcc0302504c535a474e',
    },
  ];
})();

describe('decodeLz4Block', () => {
  it('decodes blocks made by another LZ4 implementation', () => {
    for (const { text, block } of REFERENCE) {
      expect(decode(fromHex(block), text.length)).toEqual(latin1Bytes(text));
    }
  });

  it('decodes into the middle of a buffer', () => {
    const { text, block } = REFERENCE[0]!;
    const out = new Uint8Array(text.length + 10);
    decodeLz4Block(fromHex(block), out, 10, text.length);
    expect(out.subarray(0, 10)).toEqual(new Uint8Array(10));
    expect(out.subarray(10)).toEqual(latin1Bytes(text));
  });

  it('repeats a short pattern when a match overlaps its own output', () => {
    // Literal "ab", then a match of 10 at offset 2.
    const block = Uint8Array.of(0x26, 0x61, 0x62, 0x02, 0x00, 0x10, 0x63);
    expect(decode(block, 13)).toEqual(latin1Bytes('ababababababc'));
  });

  it('refuses blocks that do not hold together', () => {
    const { text, block } = REFERENCE[0]!;
    const bytes = fromHex(block);
    expect(() => decode(bytes, text.length - 1)).toThrow(FormatError);
    expect(() => decode(bytes, text.length + 1)).toThrow(FormatError);
    expect(() => decode(bytes.subarray(0, bytes.length - 3), text.length)).toThrow(FormatError);
    // A match reaching back before the start of the output.
    expect(() => decode(Uint8Array.of(0x10, 0x61, 0x05, 0x00), 10)).toThrow(FormatError);
    expect(() => decode(Uint8Array.of(0x10, 0x61, 0x00, 0x00), 10)).toThrow(FormatError);
    expect(() => decode(new Uint8Array(4), 1)).toThrow(FormatError);
  });
});

describe('compressLz4Block (test writer)', () => {
  it('round-trips text, noise, long runs and empty input', () => {
    let seed = 7;
    const noise = Uint8Array.from({ length: 5000 }, () => {
      seed = (seed * 1103515245 + 12345) >>> 0;
      return seed >>> 24;
    });
    const runs = new Uint8Array(70_000).fill(0x41);
    runs.set(noise.subarray(0, 300), 1000);
    const inputs = [
      latin1Bytes(REFERENCE[0]!.text),
      latin1Bytes(REFERENCE[1]!.text),
      noise,
      runs,
      new Uint8Array(0),
      latin1Bytes('short'),
    ];
    for (const input of inputs) {
      for (const literalsOnly of [false, true]) {
        const block = compressLz4Block(input, literalsOnly);
        expect(decode(block, input.length)).toEqual(input);
      }
    }
    expect(compressLz4Block(runs).length).toBeLessThan(1000);
  });
});
