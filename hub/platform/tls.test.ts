import assert from 'node:assert/strict';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  RENEW_WITHIN_DAYS,
  SERVER_VALIDITY_DAYS,
  certificateHosts,
  createAuthority,
  daysLeft,
  initTls,
  issueServerCertificate,
  readServerTls,
  readTlsState,
  serverHosts,
  tlsPaths,
} from './tls.ts';

async function scratch(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'circle-hub-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** GET / over TLS to a server on loopback, trusting `ca` (or nothing); resolves to the status or rejects with the TLS error. */
function get(port: number, servername: string, ca?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', servername: servername.includes(':') || /^[0-9.]+$/.test(servername) ? undefined : servername, headers: { host: servername }, ...(ca ? { ca } : {}), agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

test('the authority is a CA limited to signing certificates, the server certificate a leaf it signed for the given names', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const authority = createAuthority(now, 'test');
  const ca = new X509Certificate(authority.cert);
  assert.equal(ca.ca, true);
  assert.match(ca.subject, /CN=circle-hub 本地证书颁发机构 test/);
  assert.ok(ca.checkIssued(ca), 'self-signed');
  assert.ok(ca.verify(ca.publicKey));
  assert.ok(ca.checkPrivateKey(createPrivateKey(authority.key)));

  const server = issueServerCertificate(authority, ['hub.example.test', '192.0.2.10', '2001:db8::7'], now);
  const leaf = new X509Certificate(server.cert);
  assert.equal(leaf.ca, false);
  assert.ok(leaf.checkIssued(ca));
  assert.ok(leaf.verify(ca.publicKey));
  assert.ok(leaf.checkPrivateKey(createPrivateKey(server.key)));
  assert.deepEqual(certificateHosts(leaf), ['hub.example.test', '192.0.2.10', '2001:DB8:0:0:0:0:0:7', 'localhost', '127.0.0.1', '0:0:0:0:0:0:0:1']);
  assert.equal(leaf.checkHost('hub.example.test'), 'hub.example.test');
  assert.equal(leaf.checkIP('192.0.2.10'), '192.0.2.10');
  assert.equal(leaf.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(leaf.checkHost('other.example.test'), undefined);
  assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(daysLeft(leaf, now), SERVER_VALIDITY_DAYS);
});

test('names are kept once each, and an IPv6 authority loses its brackets', () => {
  assert.deepEqual(serverHosts(['[::1]', 'localhost', 'hub.example.test']), ['::1', 'localhost', 'hub.example.test', '127.0.0.1']);
});

test('a server certificate never outlives its authority', () => {
  const now = new Date('2026-10-31T00:00:00Z');
  const authority = createAuthority(new Date(now.getTime() - (3650 - 100) * 24 * 60 * 60 * 1000), 'old');
  const leaf = new X509Certificate(issueServerCertificate(authority, ['hub.example.test'], now).cert);
  assert.ok(new Date(leaf.validTo).getTime() <= new Date(new X509Certificate(authority.cert).validTo).getTime());
});

test('a real TLS handshake succeeds for a client that trusts the authority and fails for one that does not', async (t) => {
  const authority = createAuthority();
  const server = issueServerCertificate(authority, ['hub.example.test']);
  const listener = createServer({ cert: server.cert, key: server.key }, (_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  const { port } = listener.address() as AddressInfo;
  assert.equal(await get(port, 'hub.example.test', authority.cert), 200);
  assert.equal(await get(port, '127.0.0.1', authority.cert), 200);
  await assert.rejects(get(port, 'hub.example.test'), (error: NodeJS.ErrnoException) => /UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER|SELF_SIGNED/.test(`${error.code} ${error.message}`));
  await assert.rejects(get(port, 'other.example.test', authority.cert), (error: NodeJS.ErrnoException) => /ERR_TLS_CERT_ALTNAME_INVALID/.test(String(error.code)));
});

test('init writes owner-only keys, keeps the authority on the next issue, and serve reads a pairing certificate', async (t) => {
  const root = await scratch(t);
  const first = await initTls(root, ['192.0.2.10']);
  assert.equal(first.createdAuthority, true);
  const paths = tlsPaths(root);
  assert.equal((await lstat(paths.dir)).mode & 0o777, 0o700);
  assert.equal((await lstat(paths.authorityKey)).mode & 0o077, 0);
  assert.equal((await lstat(paths.serverKey)).mode & 0o077, 0);
  const authorityBefore = await readFile(paths.authorityCert, 'utf8');

  const second = await initTls(root, ['192.0.2.10', 'hub.example.test']);
  assert.equal(second.createdAuthority, false);
  assert.equal(await readFile(paths.authorityCert, 'utf8'), authorityBefore, 'the authority clients trust stays the same');
  assert.equal(second.authorityFingerprint, first.authorityFingerprint);

  const tls = await readServerTls(root);
  assert.deepEqual(certificateHosts(tls.certificate).slice(0, 2), ['192.0.2.10', 'hub.example.test']);
  const state = await readTlsState(root);
  assert.ok(state.server !== null && state.authority !== null && state.server.checkIssued(state.authority));

  const renewed = await initTls(root, ['192.0.2.10'], { renewAuthority: true });
  assert.equal(renewed.createdAuthority, true);
  assert.notEqual(renewed.authorityFingerprint, first.authorityFingerprint);
});

test('serve refuses missing, wide-open, linked, mismatched and expired material, each with the command that fixes it', async (t) => {
  const root = await scratch(t);
  await assert.rejects(readServerTls(root), /没有服务器证书或私钥[\s\S]*/);
  await initTls(root, ['192.0.2.10']);
  const paths = tlsPaths(root);

  await chmod(paths.serverKey, 0o644);
  await assert.rejects(readServerTls(root), /权限过宽/);
  await chmod(paths.serverKey, 0o600);

  const key = await readFile(paths.serverKey, 'utf8');
  await rm(paths.serverKey);
  await writeFile(join(paths.dir, 'elsewhere.key'), key, { mode: 0o600 });
  await symlink(join(paths.dir, 'elsewhere.key'), paths.serverKey);
  await assert.rejects(readServerTls(root), /不是普通文件/);
  await rm(paths.serverKey);

  await writeFile(paths.serverKey, createAuthority().key, { mode: 0o600 });
  await assert.rejects(readServerTls(root), /不配对/);

  await initTls(root, ['192.0.2.10']);
  const later = new Date(Date.now() + (SERVER_VALIDITY_DAYS + 1) * 24 * 60 * 60 * 1000);
  await assert.rejects(readServerTls(root, later), /已于 .* 到期/);
});

test('an authority close to its end is not used for a new server certificate', async (t) => {
  const root = await scratch(t);
  await initTls(root, ['192.0.2.10'], { now: new Date(Date.now() - (3650 - RENEW_WITHIN_DAYS + 1) * 24 * 60 * 60 * 1000) });
  await assert.rejects(initTls(root, ['192.0.2.10']), /快到期或已到期/);
});
