import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { runPlatformCommand } from './cli.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import { newSettingsFile, writeSettingsFile } from './settings.ts';
import { captureIo, removeDir, tempDir } from './test-support.ts';
import { certificateHosts, tlsPaths } from './tls.ts';

let parent: string;
let root: string;

before(async () => {
  parent = await tempDir();
  root = join(parent, 'root');
  const layout = layoutAt(root);
  await ensureLayout(layout);
  await writeSettingsFile(layout, newSettingsFile({ environment: 'shared', port: 7420, httpsHost: '192.0.2.10', httpsPort: 7443, allowedHosts: ['192.0.2.10', 'hub.example'] }));
});

after(() => removeDir(parent));

const run = async (...argv: string[]) => {
  const captured = captureIo({ CIRCLE_HUB_DATA_DIR: root }, parent);
  const code = await runPlatformCommand(argv, captured.io, { platform: 'darwin' });
  return { code, out: captured.out.join('\n'), err: captured.err.join('\n') };
};

test('tls status, issue and init: a server certificate needs an authority, init creates one, issue keeps it', async () => {
  const before = await run('tls', 'status');
  assert.equal(before.code, 3);
  assert.match(before.out, /内置 HTTPS：https:\/\/192\.0\.2\.10:7443/);
  assert.match(before.out, /证书颁发机构：没有/);

  const early = await run('tls', 'issue');
  assert.equal(early.code, 1);
  assert.match(early.err, /还没有证书颁发机构[\s\S]*circle-hub tls init/);

  const init = await run('tls', 'init');
  assert.equal(init.code, 0, init.err);
  assert.match(init.out, /已建立证书颁发机构/);
  assert.match(init.out, /trust_cert_files/);
  const paths = tlsPaths(root);
  const fingerprint = new X509Certificate(await readFile(paths.authorityCert, 'utf8')).fingerprint256;
  assert.ok(init.out.includes(fingerprint), 'the fingerprint to check before trusting is printed');
  assert.deepEqual(certificateHosts(new X509Certificate(await readFile(paths.serverCert, 'utf8'))).slice(0, 2), ['192.0.2.10', 'hub.example']);
  assert.doesNotMatch(init.out + init.err, /PRIVATE KEY/);

  const issued = await run('tls', 'issue');
  assert.equal(issued.code, 0, issued.err);
  assert.match(issued.out, /沿用已有的证书颁发机构/);
  assert.equal(new X509Certificate(await readFile(paths.authorityCert, 'utf8')).fingerprint256, fingerprint);

  const status = await run('tls', 'status');
  assert.equal(status.code, 0);
  assert.match(status.out, /服务器证书：192\.0\.2\.10、hub\.example、localhost、127\.0\.0\.1/);
  assert.doesNotMatch(status.out, /没有覆盖/);

  const renewed = await run('tls', 'init', '--renew-authority');
  assert.equal(renewed.code, 0);
  assert.notEqual(new X509Certificate(await readFile(paths.authorityCert, 'utf8')).fingerprint256, fingerprint);
});

test('tls usage errors are refused before anything is read', async () => {
  assert.equal((await run('tls')).code, 2);
  assert.equal((await run('tls', 'explode')).code, 2);
  assert.equal((await run('tls', 'issue', '--renew-authority')).code, 2);
  assert.equal((await run('tls', 'status', 'extra')).code, 2);
});
