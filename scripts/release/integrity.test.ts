import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventory, verifyDistribution, assertReleaseReady, Target, runtimeFor, targetFor, assetName, type Manifest } from './integrity.ts';

test('six targets are required and current readiness blocks publication', () => {
  assert.equal(Target.options.length, 6);
  for (const target of Target.options) assert.equal(runtimeFor(target).sha256.length, 64);
  assert.equal(targetFor('win32', 'arm64'), 'windows-arm64');
  assert.throws(() => targetFor('linux', 'ia32'));
  assert.equal(assetName('0.2.0', 'windows-arm64'), 'circle-hub-0.2.0-windows-arm64.zip');
  assert.throws(assertReleaseReady, /禁止发布/);
});

test('inventory rejects modified, added and missing files and preserves npm links', () => {
  const root = mkdtempSync(join(tmpdir(), 'hub-distribution-'));
  try {
    for (const dir of ['app/bin', 'app/node_modules/embedded-postgres', 'runtime']) mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, 'app/package.json'), JSON.stringify({ name: 'circle-hub', version: '0.2.0' }));
    for (const path of ['app/bin/circle-hub', 'app/node_modules/embedded-postgres/package.json', 'runtime/node']) writeFileSync(join(root, path), 'synthetic');
    const manifest: Manifest = { schema: 'circle-hub-release/v1', version: '0.2.0', nodeVersion: '24.21.0', target: 'darwin-arm64', commit: 'a'.repeat(40), runtime: { version: '24.21.0', archive: 'node.tar.gz', sha256: 'b'.repeat(64) }, files: inventory(root) };
    writeFileSync(join(root, 'release.json'), JSON.stringify(manifest));
    assert.equal(verifyDistribution(root, manifest).version, '0.2.0');
    assert.throws(() => verifyDistribution(root, { ...manifest, version: '0.2.1' }), /身份/);
    assert.throws(() => verifyDistribution(root, { ...manifest, target: 'linux-x64' }), /身份/);
    assert.throws(() => verifyDistribution(root, { ...manifest, commit: 'c'.repeat(40) }), /身份/);
    assert.throws(() => verifyDistribution(root, { ...manifest, runtime: { ...manifest.runtime, sha256: 'c'.repeat(64) } }), /运行时/);
    writeFileSync(join(root, 'runtime/node'), 'tamper');
    assert.throws(() => verifyDistribution(root, manifest), /逐文件/);
    writeFileSync(join(root, 'runtime/node'), 'synthetic');
    writeFileSync(join(root, 'extra'), 'synthetic');
    assert.throws(() => verifyDistribution(root, manifest), /逐文件/);
    rmSync(join(root, 'extra'));
    rmSync(join(root, 'runtime/node'));
    assert.throws(() => verifyDistribution(root, manifest), /逐文件/);
    writeFileSync(join(root, 'runtime/node'), 'synthetic');
    if (process.platform !== 'win32') {
      symlinkSync('node', join(root, 'runtime/link'));
      assert.deepEqual(inventory(root)['runtime/link'], { kind: 'link', target: 'node' });
      symlinkSync('../../', join(root, 'runtime/escape'));
      assert.throws(() => inventory(root), /越界/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
