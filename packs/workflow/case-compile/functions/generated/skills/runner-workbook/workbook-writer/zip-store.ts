// Minimal deterministic ZIP32 STORE writer. No extraction, compression library, clock or filesystem.
export function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let k = 0; k < 8; k++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
export function zipStore(entries: readonly { name: string; bytes: Uint8Array }[]): Uint8Array {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  if (!entries.length || entries.length > 65535) throw new Error('ZIP 成员数超出 STORE 子集');
  const names = new Set<string>();
  for (const entry of entries) {
    if (names.has(entry.name) || /[\\\u0000]/.test(entry.name) || entry.name.startsWith('/') || entry.name.split('/').some((v) => !v || v === '.' || v === '..')) throw new Error('ZIP 成员名无效或重复'); names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8'); const bytes = Buffer.from(entry.bytes); const checksum = crc32(bytes);
    if (name.length > 65535 || bytes.length > 0xffffffff) throw new Error('ZIP 成员过大');
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x800, 6); head.writeUInt16LE(0, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(33, 12); head.writeUInt32LE(checksum, 14); head.writeUInt32LE(bytes.length, 18); head.writeUInt32LE(bytes.length, 22); head.writeUInt16LE(name.length, 26);
    const index = Buffer.alloc(46); index.writeUInt32LE(0x02014b50, 0); index.writeUInt16LE(20, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(0x800, 8); index.writeUInt16LE(0, 10); index.writeUInt16LE(0, 12); index.writeUInt16LE(33, 14); index.writeUInt32LE(checksum, 16); index.writeUInt32LE(bytes.length, 20); index.writeUInt32LE(bytes.length, 24); index.writeUInt16LE(name.length, 28); index.writeUInt32LE(offset, 42);
    local.push(head, name, bytes); directory.push(index, name); offset += head.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}
