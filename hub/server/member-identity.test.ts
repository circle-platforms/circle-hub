import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { identityIssuer, identityProfileName } from './personal-bot.ts';
import { createTestServer, testConsoleCredentials } from './testing.ts';

test('QR binding requires both identities; callbacks are one-time and disabled members cannot sign in', async () => {
  const hub = await createTestServer();
  const member = await hub.createUser('扫码成员');
  const other = await hub.createUser('其他成员');
  const adapter = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p);
    const input = JSON.parse(Buffer.concat(parts).toString());
    res.end(
      JSON.stringify(
        input.action === 'qr'
          ? { location: 'https://login.example.invalid/?state=' + input.state }
          : { subject: 'platform-member' },
      ),
    );
  });
  const send = (path: string, options: RequestInit = {}) => fetch(hub.url + path, { redirect: 'manual', ...options });
  const post = (path: string, cookie: string, data: Record<string, string>) =>
    send(path, { method: 'POST', headers: { origin: hub.url, cookie }, body: new URLSearchParams(data) });
  const firstCookie = (r: Response) => r.headers.getSetCookie()[0].split(';')[0];
  const csrf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)![1];
  try {
    const dir = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(dir, { mode: 0o700 });
    await new Promise<void>((r) => adapter.listen(join(dir, 'channel.sock'), r));
    await hub.records.vault.put(
      identityProfileName,
      JSON.stringify({ tenant: 'demo', application: 'app', secret: 'test-app-secret' }),
    );
    const login = await send('/console/login');
    const signed = await post('/console/login', firstCookie(login), {
      ...testConsoleCredentials(member.token),
      csrf: csrf(await login.text()),
    });
    const cookie = firstCookie(signed);
    const page = await send('/console/settings', { headers: { cookie } });
    const pageText = await page.text();
    assert.match(pageText, /扫码绑定本人身份/);
    assert.equal((await post('/console/identity/bind', cookie, { csrf: 'forged' })).status, 403);
    const begin = await post('/console/identity/bind', cookie, { csrf: csrf(pageText) });
    assert.equal(begin.status, 303);
    const callback = (r: Response) =>
      '/console/identity/callback?code=one-test-code&state=' +
      new URL(r.headers.get('location')!).searchParams.get('state');
    assert.equal((await send(callback(begin))).status, 403);
    assert.equal((await send(callback(begin), { headers: { cookie: firstCookie(begin) } })).status, 303);
    assert.equal((await send(callback(begin), { headers: { cookie: firstCookie(begin) } })).status, 403);
    const issuer = identityIssuer('demo');
    assert.equal((await hub.records.principals.externalMember(issuer, 'platform-member'))?.id, member.principal.id);
    await assert.rejects(hub.records.principals.bindExternalIdentity(other.principal, issuer, 'platform-member'));
    await assert.rejects(hub.records.principals.bindExternalIdentity(member.principal, issuer, 'other-subject'));
    const signIn = async () => {
      const begin = await send('/console/identity/login');
      return send(callback(begin), { headers: { cookie: firstCookie(begin) } });
    };
    const returned = await signIn();
    assert.equal(returned.status, 303);
    assert.ok(returned.headers.getSetCookie().some((value) => value.startsWith('circle_hub_session=')));
    await hub.records.principals.setDisabled(hub.admin.principal, member.principal.id, true);
    assert.equal((await signIn()).status, 403);
    assert.equal(await hub.records.principals.externalMember(issuer, 'platform-member'), null);
  } finally {
    await new Promise<void>((r) => adapter.close(() => r()));
    await hub.close();
  }
});
