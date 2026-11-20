import { isPagePicture, naturalOrder } from '../state/guidebookData';
import { readRange } from './ranges';

/**
 * CBZ guidebooks: a ZIP of pictures of pages, read in parts (see
 * `ranges.ts`). The central directory is read from the end of the file;
 * the pictures, in natural order of their names, are the pages, and each
 * is read when it is shown, inflated in the browser when it is deflated.
 *
 * Every CBZ is untrusted: the directory, the entries, each picture and the
 * pictures kept at once are bounded, and a file that does not fit gives a
 * sentence.
 */

/** The largest central directory read. */
const MAX_DIRECTORY = 16 * 1024 * 1024;
/** The most entries read, and the most pictures of pages. */
const MAX_ENTRIES = 100_000;
export const MAX_CBZ_PICTURES = 20_000;
/** The largest picture of a page, packed and unpacked. */
const MAX_PICTURE = 64 * 1024 * 1024;
/** The end of central directory record, and its comment, at most. */
const MAX_END = 22 + 0xffff;

const DAMAGED = 'This guidebook’s file is not a CBZ file that can be read. It may be damaged.';

/** A picture of a page in a CBZ file. */
export interface CbzEntry {
  name: string;
  /** 0 stored, 8 deflated. */
  method: number;
  packed: number;
  size: number;
  /** Where its local header starts. */
  offset: number;
}

const u16 = (view: DataView, at: number) => view.getUint16(at, true);
const u32 = (view: DataView, at: number) => view.getUint32(at, true);
const u64 = (view: DataView, at: number) => {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(DAMAGED);
  return Number(value);
};

/**
 * Where the central directory of a ZIP file of `total` bytes is and how many
 * entries it has, from `tail`, the last bytes of the file; `read` reads
 * more of the file for a ZIP64 one.
 */
export async function findDirectory(
  tail: Uint8Array,
  total: number,
  read: (begin: number, end: number) => Promise<Uint8Array>,
): Promise<{ offset: number; size: number; entries: number }> {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tail.length - 22; at >= 0; at--) {
    if (u32(view, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error(DAMAGED);
  let entries = u16(view, end + 10);
  let size = u32(view, end + 12);
  let offset = u32(view, end + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: its locator is just before the record, and says where its own record is.
    const locator = end - 20;
    if (locator < 0 || u32(view, locator) !== 0x07064b50) throw new Error(DAMAGED);
    const at = u64(view, locator + 8);
    if (at + 56 > total) throw new Error(DAMAGED);
    const record = await read(at, at + 56);
    const zip64 = new DataView(record.buffer, record.byteOffset, record.byteLength);
    if (u32(zip64, 0) !== 0x06064b50) throw new Error(DAMAGED);
    entries = u64(zip64, 32);
    size = u64(zip64, 40);
    offset = u64(zip64, 48);
  }
  if (offset + size > total || size === 0) throw new Error(DAMAGED);
  if (size > MAX_DIRECTORY || entries > MAX_ENTRIES) {
    throw new Error('This guidebook’s file holds too many files to be read.');
  }
  return { offset, size, entries };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

/** The pictures of pages a central directory lists, in natural order of their names. */
export function picturesIn(directory: Uint8Array, entries: number, total: number): CbzEntry[] {
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const found: CbzEntry[] = [];
  let at = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > directory.length || u32(view, at) !== 0x02014b50) throw new Error(DAMAGED);
    const flags = u16(view, at + 8);
    const method = u16(view, at + 10);
    let packed = u32(view, at + 20);
    let size = u32(view, at + 24);
    const nameLength = u16(view, at + 28);
    const extraLength = u16(view, at + 30);
    const commentLength = u16(view, at + 32);
    let offset = u32(view, at + 42);
    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directory.length) throw new Error(DAMAGED);
    const nameBytes = directory.subarray(nameStart, extraStart);
    let name: string;
    try {
      name = flags & 0x800 ? utf8.decode(nameBytes) : latin1.decode(nameBytes);
    } catch {
      name = latin1.decode(nameBytes);
    }
    // ZIP64 sizes and offset, in the order the fields that need them come.
    for (let e = extraStart; e + 4 <= extraStart + extraLength;) {
      const id = u16(view, e);
      const length = u16(view, e + 2);
      if (e + 4 + length > extraStart + extraLength) break;
      if (id === 0x0001) {
        let field = e + 4;
        const take = () => {
          if (field + 8 > e + 4 + length) throw new Error(DAMAGED);
          const value = u64(view, field);
          field += 8;
          return value;
        };
        if (size === 0xffffffff) size = take();
        if (packed === 0xffffffff) packed = take();
        if (offset === 0xffffffff) offset = take();
      }
      e += 4 + length;
    }
    at = next;
    const encrypted = (flags & 1) !== 0;
    if (encrypted || (method !== 0 && method !== 8) || !isPagePicture(name)) continue;
    if (size === 0 || size > MAX_PICTURE || packed > MAX_PICTURE || offset + packed > total) {
      continue;
    }
    found.push({ name, method, packed, size, offset });
    if (found.length > MAX_CBZ_PICTURES) {
      throw new Error('This guidebook’s file holds too many pictures to be read.');
    }
  }
  const byName = new Map(found.map((entry) => [entry.name, entry]));
  return naturalOrder([...byName.keys()]).map((name) => byName.get(name)!);
}

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** The bytes of a picture, inflated when it is deflated; throws a sentence when it does not fit. */
async function unpack(entry: CbzEntry, packed: Uint8Array<ArrayBuffer>): Promise<Blob> {
  const type =
    TYPES[entry.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
  if (entry.method === 0) {
    if (packed.length !== entry.size) throw new Error(DAMAGED);
    return new Blob([packed], { type });
  }
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This app cannot unpack the pictures of this guidebook.');
  }
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    let step: ReadableStreamReadResult<Uint8Array>;
    try {
      step = await reader.read();
    } catch {
      throw new Error(DAMAGED);
    }
    if (step.done) break;
    length += step.value.length;
    if (length > entry.size) {
      void reader.cancel();
      throw new Error(DAMAGED);
    }
    parts.push(step.value);
  }
  if (length !== entry.size) throw new Error(DAMAGED);
  return new Blob(parts as BlobPart[], { type });
}

/** An open CBZ: its pages, and each one's picture as an address to show. */
export interface CbzBook {
  pages: number;
  names: readonly string[];
  /** An address of the picture of a page (from 1), made when first asked for. */
  picture(page: number): Promise<string>;
  close(): void;
}

/** The most pictures kept unpacked at once. */
const KEPT = 16;

/** Opens the CBZ file at `url`, of `bytes` bytes, read in parts. */
export async function openCbz(url: string, bytes: number): Promise<CbzBook> {
  const read = (begin: number, end: number) => readRange(url, begin, end, bytes);
  const tailStart = Math.max(0, bytes - MAX_END - 20);
  const tail = await read(tailStart, bytes);
  const { offset, size, entries } = await findDirectory(tail, bytes, read);
  const directory =
    offset >= tailStart
      ? tail.subarray(offset - tailStart, offset - tailStart + size)
      : await read(offset, offset + size);
  const pictures = picturesIn(directory, entries, bytes);
  if (pictures.length === 0) throw new Error('This guidebook holds no pictures of pages.');
  const kept = new Map<number, Promise<string>>();
  let closed = false;
  const load = async (entry: CbzEntry): Promise<string> => {
    const head = await read(entry.offset, Math.min(bytes, entry.offset + 30));
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    if (head.length < 30 || u32(view, 0) !== 0x04034b50) throw new Error(DAMAGED);
    const start = entry.offset + 30 + u16(view, 26) + u16(view, 28);
    if (start + entry.packed > bytes) throw new Error(DAMAGED);
    const blob = await unpack(entry, await read(start, start + entry.packed));
    return URL.createObjectURL(blob);
  };
  return {
    pages: pictures.length,
    names: pictures.map((entry) => entry.name),
    picture(page) {
      let known = kept.get(page);
      if (known) {
        // Kept the longest when used the latest.
        kept.delete(page);
        kept.set(page, known);
        return known;
      }
      const entry = pictures[page - 1];
      if (!entry || closed) return Promise.reject(new Error(DAMAGED));
      known = load(entry);
      kept.set(page, known);
      known.catch(() => {
        kept.delete(page);
      });
      while (kept.size > KEPT) {
        const [oldest, address] = kept.entries().next().value!;
        kept.delete(oldest);
        void address.then(
          (made) => {
            URL.revokeObjectURL(made);
          },
          () => undefined,
        );
      }
      return known;
    },
    close() {
      closed = true;
      for (const address of kept.values()) {
        void address.then(
          (made) => {
            URL.revokeObjectURL(made);
          },
          () => undefined,
        );
      }
      kept.clear();
    },
  };
}
