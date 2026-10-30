import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { UploadError, boundaryOf, parseMultipart, unpackZip } from './upload.ts';

function multipart(boundary: string, parts: { name: string; filename?: string; body: Buffer | string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.filename === undefined ? '' : 'Content-Type: application/zip\r\n'}\r\n`));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test('a multipart body gives its fields and its file; a malformed one is refused', () => {
  const boundary = '----synthetic-boundary-7MA4YWxk';
  assert.equal(boundaryOf(`multipart/form-data; boundary=${boundary}`), boundary);
  assert.equal(boundaryOf(`multipart/form-data; boundary="${boundary}"`), boundary);
  assert.equal(boundaryOf('application/x-www-form-urlencoded'), null);
  assert.equal(boundaryOf('multipart/form-data'), null);
  const file = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
  const parsed = parseMultipart(multipart(boundary, [{ name: 'csrf', body: 'synthetic-csrf' }, { name: 'archive', filename: 'pack.zip', body: file }]), boundary);
  assert.equal(parsed.fields.get('csrf'), 'synthetic-csrf');
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].field, 'archive');
  assert.deepEqual(parsed.files[0].bytes, file);
  assert.throws(() => parseMultipart(Buffer.from('no boundary here'), boundary), UploadError);
  assert.throws(() => parseMultipart(multipart(boundary, [{ name: 'a', body: '1' }, { name: 'a', body: '2' }]), boundary), /给了两次/);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, body: 'x' }));
  assert.throws(() => parseMultipart(multipart(boundary, many), boundary), /字段太多/);
});

test('a zip unpacks into a private directory; a single top folder becomes the pack directory; macOS metadata is skipped', async (t) => {
  const zip = Buffer.from(zipSync({
    'synthetic-pack/pack.json': strToU8('{"id":"synthetic"}'),
    'synthetic-pack/functions/check.ts': strToU8('export default () => 1;\n'),
    '__MACOSX/synthetic-pack/._pack.json': strToU8('metadata'),
    'synthetic-pack/.DS_Store': strToU8('finder'),
  }));
  const { root, dir } = await unpackZip(zip);
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(dir, join(root, 'tree', 'synthetic-pack'));
  assert.equal(await readFile(join(dir, 'pack.json'), 'utf8'), '{"id":"synthetic"}');
  assert.deepEqual((await readdir(dir)).sort(), ['functions', 'pack.json']);

  const flat = await unpackZip(Buffer.from(zipSync({ 'pack.json': strToU8('{}'), 'README.md': strToU8('x') })));
  t.after(() => rm(flat.root, { recursive: true, force: true }));
  assert.equal(flat.dir, join(flat.root, 'tree'));
});

test('traversal, absolute paths, symlinks, lying sizes, corrupted content and non-zips are refused', async () => {
  await assert.rejects(unpackZip(Buffer.from(zipSync({ '../escape.txt': strToU8('x') }))), /不安全的路径/);
  await assert.rejects(unpackZip(Buffer.from(zipSync({ 'a/../../escape.txt': strToU8('x') }))), /不安全的路径/);
  await assert.rejects(unpackZip(Buffer.from(zipSync({ '/etc/escape.txt': strToU8('x') }))), /不安全的路径/);
  await assert.rejects(unpackZip(Buffer.from(zipSync({ 'link': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }))), /符号链接/);
  await assert.rejects(unpackZip(Buffer.from('this is not a zip archive at all, just text')), /不是 zip 文件/);

  // A deflated entry that declares fewer bytes than it inflates to: maxOutputLength stops it.
  const big = Buffer.from(zipSync({ 'big.txt': new Uint8Array(1024 * 1024).fill(97) }, { level: 9 }));
  const central = big.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  big.writeUInt32LE(16, central + 24);
  await assert.rejects(unpackZip(big), /比声明的大|校验值不符/);

  // A stored entry whose bytes no longer match its CRC.
  const stored = Buffer.from(zipSync({ 'data.txt': strToU8('synthetic content') }, { level: 0 }));
  const at = stored.indexOf(Buffer.from('synthetic content'));
  stored[at] ^= 0xff;
  await assert.rejects(unpackZip(stored), /校验值不符/);

  await assert.rejects(unpackZip(Buffer.from(zipSync({ 'empty/': new Uint8Array(0) }))), /没有文件/);
  await assert.rejects(unpackZip(Buffer.from(zipSync({ 'a.txt': strToU8('x'), 'b.txt': strToU8('y') })), { maxEntries: 1, maxTotalBytes: 1024 }), /文件太多/);
  await assert.rejects(unpackZip(Buffer.from(zipSync({ 'a.txt': new Uint8Array(4096) })), { maxEntries: 10, maxTotalBytes: 1024 }), /太大/);
});
