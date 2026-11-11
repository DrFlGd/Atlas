import { ByteReader, FormatError, hasTag } from '../binary';
import { decodeLz4Block } from '../lz4';

/**
 * The Witcher 3 save container: the save data, cut into chunks of 1 MiB
 * that are each compressed as a raw LZ4 block.
 *
 * ```text
 * "SNFH" "FZLC"                    magic
 * u32 chunkCount, u32 dataStart    dataStart is 3,084 on every known save
 * chunkCount x { u32 compressedSize, u32 unpackedSize, u32 endOffset }
 * ... padding up to dataStart ...
 * chunk data, back to back from dataStart
 * ```
 *
 * The unpacked save is addressed as if it started at `dataStart`: every
 * offset inside it counts the container header too. So the unpacked
 * buffer returned here keeps `dataStart` bytes (zeros) in front of the
 * save data, and the save data begins at `dataStart`. `endOffset` is not
 * needed and is not trusted (the game leaves a stale value in the last
 * record of some saves).
 */

export const CONTAINER_MAGIC = 'SNFHFZLC';
/** More chunks than this is not a save (a late-game save has about 20). */
const MAX_CHUNKS = 4096;
/** A chunk unpacks to 1 MiB; allow some room. */
const MAX_CHUNK_BYTES = 16 << 20;
/** Default refusal size for the unpacked save; real ones are 0.2 to about 30 MB. */
export const DEFAULT_MAX_UNPACKED = 256 << 20;

export interface Unpacked {
  /** The unpacked save, with `dataStart` bytes of zeros in front (see above). */
  data: Uint8Array;
  dataStart: number;
  chunks: number;
}

export function isContainer(bytes: Uint8Array): boolean {
  return hasTag(bytes, 0, CONTAINER_MAGIC);
}

/** Unpacks a save container. Throws {@link FormatError} when it does not hold together. */
export function unpackContainer(bytes: Uint8Array, maxUnpacked = DEFAULT_MAX_UNPACKED): Unpacked {
  const reader = new ByteReader(bytes);
  reader.expect(CONTAINER_MAGIC);
  const chunks = reader.u32();
  const dataStart = reader.u32();
  if (chunks < 1 || chunks > MAX_CHUNKS) throw new FormatError(`${chunks} chunks`);
  if (dataStart < 16 + 12 * chunks || dataStart > bytes.length) {
    throw new FormatError(`data start ${dataStart} does not fit ${chunks} chunks`);
  }
  const records: { packed: number; unpacked: number }[] = [];
  let total = dataStart;
  let packedTotal = 0;
  for (let i = 0; i < chunks; i++) {
    const packed = reader.u32();
    const unpacked = reader.u32();
    reader.u32(); // endOffset: not needed, and stale in the last record of some saves
    if (packed === 0 || unpacked === 0 || unpacked > MAX_CHUNK_BYTES) {
      throw new FormatError(`chunk ${i} has sizes ${packed} and ${unpacked}`);
    }
    total += unpacked;
    packedTotal += packed;
    if (total > maxUnpacked) throw new UnpackedTooLarge(total);
    records.push({ packed, unpacked });
  }
  if (dataStart + packedTotal > bytes.length) {
    throw new FormatError('the chunks run past the end of the file');
  }
  const data = new Uint8Array(total);
  let from = dataStart;
  let to = dataStart;
  for (const record of records) {
    decodeLz4Block(bytes.subarray(from, from + record.packed), data, to, record.unpacked);
    from += record.packed;
    to += record.unpacked;
  }
  return { data, dataStart, chunks };
}

/** The unpacked save would be larger than allowed. */
export class UnpackedTooLarge extends Error {
  override name = 'UnpackedTooLarge';

  constructor(readonly bytes: number) {
    super(`the save unpacks to more than ${bytes} bytes`);
  }
}
