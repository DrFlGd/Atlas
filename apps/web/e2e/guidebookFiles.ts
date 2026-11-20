import { deflateRawSync, deflateSync } from 'node:zlib';

/**
 * Guidebooks made here for the tests, never downloaded: a small PDF with
 * text on each page, an outline and links, and a CBZ of tiny pictures.
 * Every name in them is made up.
 */

/** A PDF of `pages.length` pages, each with its lines of text, and an outline of `outline` (title, page). */
export function makePdf(
  pages: readonly string[][],
  outline: readonly [string, number][] = [],
  links: { page: number; to: number | string }[] = [],
): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const tree = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const lines of pages) {
    const text = lines
      .map((line, i) => `BT /F1 16 Tf 40 ${340 - i * 24} Td (${escape(line)}) Tj ET`)
      .join('\n');
    const contents = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    pageIds.push(add(`PAGE ${contents}`));
  }
  pageIds.forEach((id, index) => {
    const contents = objects[id - 1]!.slice(5);
    const annots = links
      .filter((link) => link.page === index + 1)
      .map((link) =>
        add(
          typeof link.to === 'number'
            ? `<< /Type /Annot /Subtype /Link /Rect [40 40 200 80] /Border [0 0 0] /Dest [${pageIds[link.to - 1]} 0 R /Fit] >>`
            : `<< /Type /Annot /Subtype /Link /Rect [40 40 200 80] /Border [0 0 0] /A << /S /URI /URI (${escape(link.to)}) >> >>`,
        ),
      );
    objects[id - 1] =
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 400 400] /Contents ${contents} 0 R ` +
      `/Resources << /Font << /F1 ${font} 0 R >> >>` +
      (annots.length > 0 ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : '') +
      ' >>';
  });
  objects[tree - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let outlineRef = '';
  if (outline.length > 0) {
    const root = add('');
    const items = outline.map(() => add(''));
    outline.forEach(([title, page], i) => {
      const parts = [
        `/Title (${escape(title)})`,
        `/Parent ${root} 0 R`,
        `/Dest [${pageIds[page - 1]} 0 R /Fit]`,
      ];
      if (i > 0) parts.push(`/Prev ${items[i - 1]} 0 R`);
      if (i < items.length - 1) parts.push(`/Next ${items[i + 1]} 0 R`);
      objects[items[i]! - 1] = `<< ${parts.join(' ')} >>`;
    });
    objects[root - 1] =
      `<< /Type /Outlines /First ${items[0]} 0 R /Last ${items.at(-1)} 0 R /Count ${items.length} >>`;
    outlineRef = ` /Outlines ${root} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R${outlineRef} >>`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const escape = (text: string) => text.replace(/[\\()]/g, (c) => `\\${c}`);

/** A CBZ of pictures (deflated, as most are), each a tiny PNG of one colour, named in the given order. */
export function makeCbz(names: readonly string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  names.forEach((name, i) => {
    const data = png(40 + i * 4, 60);
    const packed = deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A PNG of one colour. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x9c)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table: Uint32Array | null = null;

function crc32(data: Buffer): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
