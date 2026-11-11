/**
 * Bounds-checked little-endian reading of a byte array. Every read that
 * would pass the end throws a {@link FormatError}, which the readers turn
 * into a plain "the save could not be read" message.
 */

/** The bytes are not laid out as expected. Internal; readers report it as {@link SaveReadError}. */
export class FormatError extends Error {
  override name = 'FormatError';
}

export class ByteReader {
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
    readonly end = bytes.length,
  ) {
    if (end > bytes.length || pos < 0 || pos > end) {
      throw new FormatError(`range ${pos}..${end} is outside ${bytes.length} bytes`);
    }
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private take(n: number): number {
    if (n < 0 || this.pos + n > this.end) {
      throw new FormatError(`unexpected end of data at ${this.pos} (wanted ${n} bytes)`);
    }
    const at = this.pos;
    this.pos += n;
    return at;
  }

  skip(n: number): void {
    this.take(n);
  }

  u8(): number {
    return this.bytes[this.take(1)]!;
  }

  i8(): number {
    return this.view.getInt8(this.take(1));
  }

  u16(): number {
    return this.view.getUint16(this.take(2), true);
  }

  i16(): number {
    return this.view.getInt16(this.take(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.take(4), true);
  }

  i32(): number {
    return this.view.getInt32(this.take(4), true);
  }

  f32(): number {
    return this.view.getFloat32(this.take(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.take(8), true);
  }

  /** A 64-bit unsigned integer: a number when it is exact, else its decimal text. */
  u64(): number | string {
    const value = this.view.getBigUint64(this.take(8), true);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
  }

  /** A 64-bit signed integer: a number when it is exact, else its decimal text. */
  i64(): number | string {
    const value = this.view.getBigInt64(this.take(8), true);
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    return value <= safe && value >= -safe ? Number(value) : value.toString();
  }

  /** A view of the next `n` bytes (not a copy). */
  bytesView(n: number): Uint8Array {
    const at = this.take(n);
    return this.bytes.subarray(at, at + n);
  }

  /** `n` bytes as Latin-1 text. */
  latin1(n: number): string {
    return latin1(this.bytesView(n));
  }

  /** Reads `tag` (ASCII) or throws. */
  expect(tag: string): void {
    const at = this.pos;
    const found = this.latin1(tag.length);
    if (found !== tag) {
      throw new FormatError(
        `expected ${JSON.stringify(tag)} at ${at}, found ${JSON.stringify(found)}`,
      );
    }
  }
}

/** Latin-1 (each byte is the code point of the same value), in slices to stay within call limits. */
export function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

/** Whether `bytes` holds the ASCII text `tag` at `at`. */
export function hasTag(bytes: Uint8Array, at: number, tag: string): boolean {
  if (at < 0 || at + tag.length > bytes.length) return false;
  for (let i = 0; i < tag.length; i++) {
    if (bytes[at + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

/** Lowercase hexadecimal text of some bytes. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
