/**
 * Reading a guidebook's file in parts, through the pack protocol's range
 * requests (`Range: bytes=a-b`, answered `206` with `Content-Range`): a
 * guidebook can be gigabytes, and is never read whole. Each answer is
 * checked to be the part asked for, of a file of the size expected.
 */

/** The most bytes asked for at once. */
export const RANGE_PIECE = 1024 * 1024;

const UNREADABLE = 'This guidebook’s file could not be read.';

/**
 * The bytes from `begin` up to (not with) `end` of the file at `url`, which
 * must be `total` bytes long. Throws a sentence when they cannot be read.
 */
export async function readRange(
  url: string,
  begin: number,
  end: number,
  total: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (begin < 0 || end <= begin || end > total) throw new Error(UNREADABLE);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Range: `bytes=${begin}-${end - 1}` } });
  } catch {
    throw new Error(UNREADABLE);
  }
  if (response.status === 404) {
    throw new Error('This guidebook’s file cannot be found any more.');
  }
  if (response.status !== 206) throw new Error(UNREADABLE);
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '');
  if (!range || Number(range[1]) !== begin || Number(range[2]) !== end - 1) {
    throw new Error(UNREADABLE);
  }
  if (Number(range[3]) !== total) {
    throw new Error('This guidebook’s file is not the size its pack says. It may be damaged.');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== end - begin) throw new Error(UNREADABLE);
  return bytes;
}
