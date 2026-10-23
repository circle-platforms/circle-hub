// All archives and workbooks are generated here from synthetic XML; no binary fixtures or spreadsheet libraries.
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { ParseError, ParseLimitError } from '../parser.ts';
import { readXlsxArchive, XLSX_ZIP_LIMITS } from './xlsx.ts';

type Member = { name: string; text?: string; bytes?: Buffer; method?: number; flags?: number; size?: number; crc?: number; extra?: Buffer; attributes?: number; descriptor?: boolean; compressed?: Buffer };
function zip(members: Member[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name); const bytes = member.bytes ?? Buffer.from(member.text ?? '<synthetic/>');
    const method = member.method ?? 0; const flags = member.flags ?? 0x800; const extra = member.extra ?? Buffer.alloc(0);
    const compressed = member.compressed ?? (method === 8 ? deflateRawSync(bytes) : bytes);
    const crc = member.crc ?? crc32(bytes); const size = member.size ?? bytes.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt16LE(extra.length, 30); directory.writeUInt32LE(member.attributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    const descriptor = member.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (member.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); header.fill(0, 14, 26); }
    local.push(header, name, extra, compressed, descriptor); central.push(directory, name, extra); offset += 30 + name.length + extra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function refuses(bytes: Uint8Array, pattern: RegExp): void {
  assert.throws(() => readXlsxArchive(bytes), (error: unknown) => error instanceof ParseError && error.parser === 'xlsx@1' && pattern.test(error.message));
}

test('ZIP stored and deflated members preserve bytes without writing files', () => {
  for (const method of [0, 8]) {
    const archive = readXlsxArchive(zip([{ name: 'synthetic.xml', text: '<text>合成 &amp; text</text>', method }]));
    assert.equal(Buffer.from(archive.get('synthetic.xml')!).toString(), '<text>合成 &amp; text</text>');
  }
});
test('ZIP input bytes, member count, declared expansion and compression ratio have separate reasons', () => {
  assert.throws(() => readXlsxArchive(Buffer.alloc(XLSX_ZIP_LIMITS.maxBytes + 1)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes');
  refuses(zip(Array.from({ length: XLSX_ZIP_LIMITS.maxMembers + 1 }, (_, i) => ({ name: `member-${i}.xml` }))), /成员数/);
  refuses(zip([{ name: 'large.xml', size: XLSX_ZIP_LIMITS.maxExpandedBytes + 1 }]), /解压后的总量/);
  refuses(zip([{ name: 'bomb.xml', bytes: Buffer.alloc(1024 * 1024, 65), method: 8 }]), /解压比/);
});
test('ZIP rejects unsafe paths, encryption, duplicate members and symbolic links', () => {
  for (const name of ['/absolute.xml', '../escape.xml', 'a/../escape.xml', 'C:/escape.xml', 'a\\escape.xml', 'a//b.xml', './a.xml', 'a\0.xml']) refuses(zip([{ name }]), /路径/);
  for (const flags of [1, 0x40, 0x2000]) refuses(zip([{ name: 'a.xml', flags }]), /加密/);
  refuses(zip([{ name: 'a.xml' }, { name: 'a.xml' }]), /重复/);
  refuses(zip([{ name: 'a.xml', attributes: (0xa000 << 16) >>> 0 }]), /链接|普通文件|特殊文件/);
});
test('ZIP rejects invalid methods, malformed descriptors and multi-disk records', () => {
  refuses(zip([{ name: 'a.xml', method: 99 }]), /压缩方法/);
  refuses(zip([{ name: 'a.xml', flags: 8 }]), /描述符|附加/);
  assert.equal(readXlsxArchive(zip([{ name: 'a.xml', extra: Buffer.alloc(4) }])).size, 1);
  const multi = zip([{ name: 'a.xml' }]); multi.writeUInt16LE(1, multi.length - 18); refuses(multi, /分卷/);
  const zip64 = zip([{ name: 'a.xml', size: 0xffffffff }]); refuses(zip64, /ZIP64/);
});
test('ZIP verifies local headers, central directory, CRC, output size and complete compressed streams', () => {
  refuses(zip([{ name: 'a.xml', crc: 0 }]), /CRC/);
  const mismatch = zip([{ name: 'a.xml' }]); mismatch[6] ^= 1; refuses(mismatch, /加密|不一致/);
  refuses(zip([{ name: 'a.xml', text: 'abc', size: 4 }]), /大小/);
  refuses(zip([{ name: 'a.xml', text: 'abc', method: 8, size: 2 }]), /解压|大小/);
  for (const length of [0, 10, 21, 30]) refuses(zip([{ name: 'a.xml' }]).subarray(0, length), /ZIP/);
  const central = zip([{ name: 'a.xml' }]); central.writeUInt32LE(0xffffffff, central.length - 6); refuses(central, /ZIP64|目录/);
  const offset = zip([{ name: 'a.xml' }]); const start = offset.readUInt32LE(offset.length - 6); offset.writeUInt32LE(1, start + 42); refuses(offset, /本地|连续/);
  refuses(Buffer.concat([zip([{ name: 'a.xml' }]), Buffer.from('trailing')]), /ZIP/);
});


test('ZIP accepts comments, timestamp extras, data descriptors and bounded ZIP64 directories', () => {
  const bytes = zip([{ name: 'a.xml', text: '<synthetic/>', flags: 0x808, method: 8, descriptor: true }]);
  assert.equal(readXlsxArchive(bytes).size, 1);
  const commented = zip([{ name: 'a.xml' }]); commented.writeUInt16LE(7, commented.length - 2);
  assert.equal(readXlsxArchive(Buffer.concat([commented, Buffer.from('comment')])).size, 1);
  const base = zip([{ name: 'a.xml' }]); const end = base.subarray(-22); const at = base.length - 22;
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32); record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(at), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  assert.equal(readXlsxArchive(Buffer.concat([base.subarray(0, -22), record, locator, end])).size, 1);
});
test('ZIP bounds single and cumulative declarations before allocating expanded output', () => {
  refuses(zip([{ name: 'single.xml', size: XLSX_ZIP_LIMITS.maxMemberBytes + 1 }]), /单个成员解压量/);
  refuses(zip(Array.from({ length: 3 }, (_, i) => ({ name: `large-${i}.xml`, bytes: Buffer.alloc(128 * 1024), size: 12 * 1024 * 1024 }))), /解压后的总量/);
  refuses(zip([{ name: 'a.xml', method: 8, text: 'abc', compressed: Buffer.concat([deflateRawSync(Buffer.from('abc')), Buffer.from('garbage')]) }]), /未消费/);
});
