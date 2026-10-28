import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetName, targetFor } from './integrity.ts';
import { createAssetDownloader, downloadAndInstall, type AssetDownload } from './install-archive.ts';
import { sha256 } from './operations.ts';

test('download transport enforces HTTPS/host/redirect/size limits without network access', async () => {
  const calls: string[] = [];
  const transport = createAssetDownloader(async (input, options) => {
    const url = String(input); calls.push(url);
    assert.equal(options?.credentials, 'omit'); assert.equal(options?.redirect, 'manual');
    return url.startsWith('https://github.com/') ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/synthetic' } }) : new Response('archive');
  });
  assert.equal(Buffer.from(await transport('https://github.com/example/repo/asset', 10)).toString(), 'archive');
  assert.equal(calls.length, 2);
  const count = calls.length;
  for (const url of ['http://github.com/a', 'https://github.com.evil.example/a', 'https://owner:secret@github.com/a', 'https://github.com:444/a', 'file:///synthetic', 'https://github.com/a#fragment']) await assert.rejects(transport(url, 10));
  assert.equal(calls.length, count);
  const escape = createAssetDownloader(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/payload' } }));
  await assert.rejects(escape('https://github.com/example/repo/asset', 10), /允许/);
  const loop = createAssetDownloader(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } }));
  await assert.rejects(loop('https://github.com/example/repo/asset', 10), /次数/);
  for (const response of [new Response('too big', { headers: { 'content-length': '100' } }), new Response('too big'), new Response('missing', { status: 404 })]) {
    await assert.rejects(createAssetDownloader(async () => response)('https://github.com/example/repo/asset', 3));
  }
});

test('Windows download installation is blocked before contacting any source', async () => {
  let requested = false;
  await assert.rejects(downloadAndInstall({ repository: 'example/repo', prefix: 'unused', dataRoot: 'unused', expected: { target: 'windows-arm64', version: '0.2.0', commit: 'a'.repeat(40) }, sha256: 'b'.repeat(64), download: async () => { requested = true; return new Uint8Array(); } }), /Windows/);
  assert.equal(requested, false);
});

test('explicit archive identity, checksum sidecar and actual digest fail before installation writes', { skip: process.platform === 'win32' ? 'Windows ZIP installation is not implemented' : false }, async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'hub-download-fixture-')));
  try {
    const bytes = Buffer.from('not an archive'), digest = sha256(bytes), name = assetName('0.2.0', targetFor());
    const options = { repository: 'example/repo', prefix: join(scratch, 'prefix'), dataRoot: join(scratch, 'data'), expected: { target: targetFor(), version: '0.2.0', commit: 'a'.repeat(40) }, sha256: digest };
    let calls = 0;
    const wrongSidecar: AssetDownload = async () => { calls++; return Buffer.from(`${'0'.repeat(64)}  ${name}\n`); };
    await assert.rejects(downloadAndInstall({ ...options, download: wrongSidecar }), /旁证/);
    assert.equal(calls, 1);
    const wrongArchive: AssetDownload = async (url) => url.endsWith('.sha256') ? Buffer.from(`${digest}  ${name}\n`) : Buffer.from('different');
    await assert.rejects(downloadAndInstall({ ...options, download: wrongArchive }), /摘要/);
    const invalidArchive: AssetDownload = async (url) => url.endsWith('.sha256') ? Buffer.from(`${digest}  ${name}\n`) : bytes;
    await assert.rejects(downloadAndInstall({ ...options, download: invalidArchive }));
    await assert.rejects(downloadAndInstall({ ...options, repository: '../repo', download: wrongSidecar }), /仓库/);
    assert.equal(existsSync(options.prefix), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
