import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { extractArchive, parseTar } from './archive.ts';
import { scratchEnvironment, sha256 } from './operations.ts';

type Member = { name: string; type?: string; body?: string | Buffer; link?: string; prefix?: string; size?: number };
function tar(members: Member[]): Buffer {
  return Buffer.concat([...members.flatMap((member) => {
    const header = Buffer.alloc(512), body = typeof member.body === 'string' ? Buffer.from(member.body) : Buffer.from(member.body ?? new Uint8Array());
    header.write(member.name, 0, 100, 'utf8'); header.write('0006755\0', 100, 8);
    header.write((member.size ?? body.length).toString(8).padStart(11, '0') + '\0', 124, 12);
    header.fill(32, 148, 156); header[156] = (member.type ?? '0').charCodeAt(0);
    if (member.link) header.write(member.link, 157, 100);
    header.write('ustar\0', 257, 6); if (member.prefix) header.write(member.prefix, 345, 155);
    const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    return [header, body, Buffer.alloc((512 - body.length % 512) % 512)];
  }), Buffer.alloc(1024)]);
}
function paxRecord(key: string, value: string): string {
  const content = `${key}=${value}\n`; let size = Buffer.byteLength(content) + 3;
  while (Buffer.byteLength(`${size} ${content}`) !== size) size = Buffer.byteLength(`${size} ${content}`);
  return `${size} ${content}`;
}
const roots: Member[] = [{ name: 'circle-hub/', type: '5' }, { name: 'circle-hub/app/', type: '5' }];

// Temporary synthetic archives exercise parser behavior; no business data or release success receipt is produced.
test('USTAR, local PAX and GNU long-name members preserve internal links without privilege bits', { skip: process.platform === 'win32' ? 'Windows ZIP extraction is blocked' : false }, () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hub-archive-')));
  try {
    const long = `circle-hub/app/${'x'.repeat(120)}`;
    const raw = tar([...roots,
      { name: 'file', prefix: 'circle-hub/app', body: 'content' },
      { name: 'circle-hub/app/__proto__', body: 'special' },
      { name: 'circle-hub/app/link', type: '2', link: '../app/file' },
      { name: 'circle-hub/app/directory-link', type: '2', link: '.' },
      { name: 'pax', type: 'x', body: paxRecord('path', long) + paxRecord('size', '3') },
      { name: 'ignored', size: 0, body: 'pax' },
      { name: 'long', type: 'L', body: `circle-hub/app/gnu-${'g'.repeat(110)}\0` },
      { name: 'ignored', body: 'gnu' },
    ]);
    const bytes = gzipSync(raw), root = extractArchive(bytes, sha256(bytes), join(scratch, 'unpacked'), 'darwin-arm64');
    assert.equal(readFileSync(join(root, 'app/file'), 'utf8'), 'content');
    assert.equal(readFileSync(join(root, 'app/__proto__'), 'utf8'), 'special');
    assert.equal(readlinkSync(join(root, 'app/link')), '../app/file');
    assert.equal(readlinkSync(join(root, 'app/directory-link')), '.');
    assert.equal(readFileSync(join(scratch, 'unpacked', long), 'utf8'), 'pax');
    assert.equal(parseTar(raw).filter((item) => item.kind === 'file').length, 4);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('adversarial member, header and link graphs fail before any output directory is created', () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hub-archive-adversarial-')));
  try {
    const outside = join(scratch, 'outside'); writeFileSync(outside, 'preserved');
    const cases: Member[][] = [
      [{ name: '../outside', body: 'bad' }], [{ name: '/outside', body: 'bad' }], [{ name: 'circle-hub/../outside', body: 'bad' }],
      [{ name: 'circle-hub\\app\\escape', body: 'bad' }], [{ name: 'other/file', body: 'bad' }], [{ name: 'circle-hub/app:stream', body: 'bad' }],
      [{ name: 'circle-hub/app/file' }, { name: 'circle-hub/app/file' }],
      [{ name: 'circle-hub/app/file' }, { name: 'circle-hub/app/file/child' }],
      [{ name: 'circle-hub/app/hard', type: '1', link: '../outside' }],
      ...['3', '4', '6', 'S'].map((type) => [{ name: 'circle-hub/app/special', type }]),
      [{ name: 'circle-hub/app/link', type: '2', link: '/outside' }],
      [{ name: 'circle-hub/app/link', type: '2', link: '../../outside' }],
      [{ name: 'circle-hub/app/link', type: '2', link: 'missing' }],
      [{ name: 'circle-hub/app/a', type: '2', link: 'b' }, { name: 'circle-hub/app/b', type: '2', link: 'a' }],
      [{ name: 'circle-hub/app/a', type: '2', link: 'a/..' }],
      [{ name: 'circle-hub/app/a', type: '2', link: 'b' }, { name: 'circle-hub/app/b', type: '2', link: '../../outside' }],
      [{ name: 'circle-hub/app/link', type: '2', link: '.' }, { name: 'circle-hub/app/link/child' }],
      [{ name: 'pax', type: 'x', body: paxRecord('path', '../outside') }, { name: 'ignored' }],
      [{ name: 'pax', type: 'g', body: paxRecord('path', 'circle-hub/app/file') }, { name: 'ignored' }],
      [{ name: 'pax', type: 'x', body: paxRecord('linkpath', '/outside') }, { name: 'circle-hub/app/link', type: '2' }],
      [{ name: 'pax', type: 'x', body: paxRecord('path', 'circle-hub/app/a') + paxRecord('path', 'circle-hub/app/b') }, { name: 'ignored' }],
      [{ name: 'long', type: 'L', body: '../outside\0' }, { name: 'ignored' }],
      [{ name: 'long', type: 'K', body: '/outside\0' }, { name: 'circle-hub/app/link', type: '2' }],
    ];
    for (let index = 0; index < cases.length; index++) {
      const bytes = gzipSync(tar([...roots, ...cases[index]!])), destination = join(scratch, `case-${index}`);
      assert.throws(() => extractArchive(bytes, sha256(bytes), destination, 'linux-arm64'), `case ${index}`);
      assert.equal(existsSync(destination), false, `case ${index} wrote output`);
    }
    const valid = tar([...roots, { name: 'circle-hub/app/file', body: 'valid' }]);
    const checksum = Buffer.from(valid); checksum[0] = 0;
    for (const raw of [checksum, valid.subarray(0, valid.length - 1024), Buffer.concat([valid, Buffer.alloc(512, 1)])]) assert.throws(() => parseTar(raw));
    const bytes = gzipSync(valid);
    assert.throws(() => extractArchive(bytes, '0'.repeat(64), join(scratch, 'digest'), 'linux-arm64'), /摘要/);
    assert.throws(() => extractArchive(bytes, sha256(bytes), join(scratch, 'windows'), 'windows-arm64'), /Windows/);
    assert.equal(readFileSync(outside, 'utf8'), 'preserved');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('native tar creates a synthetic long-path and symlink archive accepted by this restricted parser', { skip: process.platform === 'win32' ? 'Windows ZIP extraction is blocked' : false }, () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hub-native-tar-')));
  try {
    const source = join(scratch, 'source'), folder = join(source, 'circle-hub/app', 'long-'.repeat(25));
    mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'file.txt'), 'synthetic native tar');
    symlinkSync('file.txt', join(folder, 'link'));
    for (const format of ['default', 'ustar', 'pax', process.platform === 'darwin' ? 'gnutar' : 'gnu']) {
      const archive = join(scratch, `${format}.tar.gz`);
      const result = spawnSync('tar', [...(format === 'default' ? [] : [`--format=${format}`]), '-czf', archive, '-C', source, 'circle-hub'], { encoding: 'utf8', env: scratchEnvironment(scratch), timeout: 10_000 });
      assert.equal(result.status, 0, `native tar ${format} failed`);
      const bytes = readFileSync(archive), root = extractArchive(bytes, sha256(bytes), join(scratch, format), 'darwin-arm64');
      assert.equal(readFileSync(join(root, 'app', 'long-'.repeat(25), 'link'), 'utf8'), 'synthetic native tar');
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
