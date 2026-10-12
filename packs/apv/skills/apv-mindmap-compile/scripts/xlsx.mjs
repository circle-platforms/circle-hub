// A small .xlsx writer and reader with Node built-ins only. One sheet, inline strings,
// fixed zip timestamps: the same rows always give the same bytes.
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// 1980-01-01 00:00, the earliest zip time: no clock in the bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const file = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, file, packed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(file.length, 28);
    header.writeUInt32LE(offset, 42);
    central.push(header, file);
    offset += 30 + file.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function unzip(bytes) {
  const files = new Map();
  let end = bytes.length - 22;
  while (end >= 0 && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(at) !== 0x02014b50) throw new Error('bad zip directory');
    const method = bytes.readUInt16LE(at + 10);
    const size = bytes.readUInt32LE(at + 20);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extra = bytes.readUInt16LE(at + 30);
    const comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + size);
    files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

const escape = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot carry are dropped rather than written broken.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const column = (index) => String.fromCharCode(65 + index);

// rows: arrays of up to 26 cells; a cell is a string, a number or null. Column A is
// written as text; hidden lists 1-based row numbers to hide.
export function writeXlsx({ sheet, rows, hidden = [], widths = {} }) {
  const lines = rows.map((cells, r) => {
    const number = r + 1;
    const attributes = hidden.includes(number) ? ' hidden="1"' : '';
    const body = cells
      .map((value, c) => {
        if (value === null || value === undefined || value === '') return '';
        const ref = `${column(c)}${number}`;
        if (typeof value === 'number' && c !== 0) return `<c r="${ref}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"${c === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
      })
      .join('');
    return `<row r="${number}"${attributes}>${body}</row>`;
  });
  const cols = Object.entries(widths)
    .map(([letter, width]) => {
      const n = letter.charCodeAt(0) - 64;
      return `<col min="${n}" max="${n}" width="${width}" customWidth="1"/>`;
    })
    .join('');
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${lines.join('')}</sheetData></worksheet>`;
  return zip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ],
    [
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escape(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ],
    [
      'xl/styles.xml',
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
    ],
    ['xl/worksheets/sheet1.xml', sheetXml],
  ]);
}

const unescape = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

// Reads back what writeXlsx writes: the sheet name, hidden rows and every row's cells.
export function readXlsx(bytes) {
  const files = unzip(bytes);
  const workbook = files.get('xl/workbook.xml')?.toString('utf8') ?? '';
  const sheet = unescape(/<sheet name="([^"]*)"/.exec(workbook)?.[1] ?? '');
  const xml = files.get('xl/worksheets/sheet1.xml')?.toString('utf8') ?? '';
  const rows = [];
  const hidden = [];
  for (const match of xml.matchAll(/<row r="(\d+)"([^>]*)>(.*?)<\/row>/gs)) {
    const number = Number(match[1]);
    if (/hidden="1"/.test(match[2])) hidden.push(number);
    const cells = [];
    for (const cell of match[3].matchAll(/<c r="([A-Z])\d+"[^>]*>(.*?)<\/c>/gs)) {
      const index = cell[1].charCodeAt(0) - 65;
      const text = /<t[^>]*>(.*?)<\/t>/s.exec(cell[2])?.[1];
      const value = /<v>(.*?)<\/v>/s.exec(cell[2])?.[1];
      cells[index] = text !== undefined ? unescape(text) : value !== undefined ? Number(value) : null;
    }
    rows[number - 1] = cells;
  }
  return { sheet, hidden, rows: Array.from(rows, (row) => row ?? []) };
}
