// Plain HTTP to a non-loopback Hub is refused unless the user names exactly that host when enabling sharing.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION, execute, scratch } from './operation-support.ts';
import { normalizeHubUrl } from '../tools/operation-capture/lib/common.ts';
import { sessionDirectory } from '../tools/operation-capture/lib/common.ts';

const LAN = 'http://192.0.2.10:7420/mcp';

test('a non-loopback http address is refused by default, accepted for the one host the user names, and https and loopback are unchanged', () => {
  assert.throws(() => normalizeHubUrl(LAN), /invalid_hub_url|HTTPS/);
  assert.throws(() => normalizeHubUrl(LAN, '192.0.2.11'), /HTTPS/, 'another host is not allowed');
  assert.equal(normalizeHubUrl(LAN, '192.0.2.10').hostname, '192.0.2.10');
  assert.equal(normalizeHubUrl('https://hub.example.invalid/mcp').protocol, 'https:');
  assert.equal(normalizeHubUrl('http://localhost:7420/mcp').hostname, '127.0.0.1');
  assert.throws(() => normalizeHubUrl('http://user:pw@192.0.2.10:7420/mcp', '192.0.2.10'), /凭据/, 'credentials in the address stay refused');
  assert.throws(() => normalizeHubUrl('ftp://192.0.2.10/mcp', '192.0.2.10'), /HTTPS/);
});

test('enable refuses a LAN http hub without the flag and records the named host with it, which later reads accept', async t => {
  const local = await scratch(t);
  const refused = await execute(process.execPath, [local.entry, 'enable', '--session', SESSION, '--hub', LAN, '--token-file', local.tokenFile], local.env);
  assert.notEqual(refused.code, 0);
  assert.match(refused.err + refused.out, /invalid_hub_url|HTTPS/);
  const mismatched = await execute(process.execPath, [local.entry, 'enable', '--session', SESSION, '--hub', LAN, '--token-file', local.tokenFile, '--allow-plaintext-host', '192.0.2.99'], local.env);
  assert.notEqual(mismatched.code, 0);
  const ok = await execute(process.execPath, [local.entry, 'enable', '--session', SESSION, '--hub', LAN, '--token-file', local.tokenFile, '--allow-plaintext-host', '192.0.2.10'], local.env);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /明文 HTTP/);
  const settings = JSON.parse(await readFile(join(sessionDirectory(SESSION, local.env), 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(settings.plaintext_host, '192.0.2.10');
  const status = await execute(process.execPath, [local.entry, 'status', '--session', SESSION], local.env);
  assert.equal(status.code, 0, status.err);
  assert.equal((JSON.parse(status.out) as { enabled: boolean }).enabled, true);
});

test('the flag on an https or loopback address records nothing and old settings without the field still read', async t => {
  const local = await scratch(t);
  const ok = await execute(process.execPath, [local.entry, 'enable', '--session', SESSION, '--hub', 'https://hub.example.invalid/mcp', '--token-file', local.tokenFile, '--allow-plaintext-host', 'hub.example.invalid'], local.env);
  assert.equal(ok.code, 0, ok.err);
  const settings = JSON.parse(await readFile(join(sessionDirectory(SESSION, local.env), 'settings.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(settings, 'plaintext_host'), false);
});
