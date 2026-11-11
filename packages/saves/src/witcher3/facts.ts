import { ByteReader, FormatError } from '../binary';
import { readPackedString } from './values';

/**
 * The facts database: quest and world flags such as
 * `q103_botchling_saved`. It is the `SS` stream inside the top-level block
 * `facts`:
 *
 * ```text
 * "SXAP" i32 i32 i32            the header's version numbers again
 * "SBDF" u32 count
 * count x { packed string name, u16 timed, u16 n, n x { i16 value, f32 time, f32 expiry } }
 * "EBDF"
 * ```
 *
 * A fact is a list of records; the game adds them up. Records with an
 * expiry of 0 or more are short-lived timers (combat, tutorials) and are
 * left out of the value here; `-1` is permanent.
 */

export interface FactsResult {
  facts: Record<string, number>;
  /** The count the stream declares, and how many facts were read. */
  declared: number;
  read: number;
}

export function readFacts(stream: Uint8Array): FactsResult {
  const reader = new ByteReader(stream);
  reader.expect('SXAP');
  reader.skip(12);
  reader.expect('SBDF');
  const declared = reader.u32();
  const facts: Record<string, number> = Object.create(null) as Record<string, number>;
  let read = 0;
  try {
    for (; read < declared; read++) {
      const name = readPackedString(reader);
      reader.u16();
      const records = reader.u16();
      let value = 0;
      for (let r = 0; r < records; r++) {
        const recordValue = reader.i16();
        reader.f32();
        const expiry = reader.f32();
        if (expiry < 0) value += recordValue;
      }
      facts[name] = value;
    }
    reader.expect('EBDF');
  } catch (error) {
    // Some older saves hold a second structure after part of the facts; keep what was read.
    if (!(error instanceof FormatError)) throw error;
  }
  return { facts, declared, read };
}
