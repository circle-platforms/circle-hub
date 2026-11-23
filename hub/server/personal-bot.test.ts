import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  channelProfileName,
  chatPath,
  disableBot,
  newChannel,
  readBotProfile,
  setBotProfile,
} from './personal-bot.ts';
import { createTestServer } from './testing.ts';

test('chat authenticates every request, fixes the owner, confines model credentials and checks revocation', async () => {
  const hub = await createTestServer();
  const seen: Record<string, unknown>[] = [];
  const host = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p);
    seen.push(JSON.parse(Buffer.concat(parts).toString()));
    res.end(JSON.stringify({ id: 'synthetic' }));
  });
  try {
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { mode: 0o700 });
    await new Promise<void>((resolve) => host.listen(join(folder, 'host.sock'), resolve));
    const member = await hub.createUser('测试成员');
    const send = (token: string, op: unknown, version = '1.18.1') =>
      fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'bot-client-version': version,
        },
        body: JSON.stringify(op),
      });
    assert.equal((await send('invalid', { action: 'discover' })).status, 401);
    assert.equal((await send(member.token, { action: 'test' })).status, 400);
    assert.equal((await send(member.token, { action: 'discover', owner: hub.admin.principal.id })).status, 400);
    assert.equal((await send(member.token, { action: 'discover' })).status, 200);
    assert.equal(seen[0].owner, member.principal.id);
    const profile = {
      name: '测试机器人',
      protocol: 'openai',
      endpoint: 'http://127.0.0.1:1234',
      model: 'demo',
      key: 'fixture-bot-secret',
    };
    const op = { action: 'send', conversation: randomUUID(), request: randomUUID(), text: '你好' };
    assert.equal((await send(member.token, op)).status, 503);
    await setBotProfile(hub.records.vault, profile);
    await assert.rejects(
      setBotProfile(hub.records.vault, { ...profile, endpoint: 'https://example.invalid/?key=secret' }),
    );
    assert.equal((await readBotProfile(hub.records.vault))?.name, profile.name);
    const response = await send(member.token, op);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(profile.key));
    assert.equal((seen[1].config as typeof profile).key, profile.key);
    assert.equal((seen[1].owner), member.principal.id);
    await disableBot(hub.records.vault);
    assert.equal((await send(member.token, op)).status, 503);
    await hub.records.principals.setDisabled(hub.admin.principal, member.principal.id, true);
    assert.equal((await send(member.token, { action: 'discover' })).status, 401);
    assert.equal(seen.length, 2);
    assert.ok(!hub.logs.join('').includes(profile.key));
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});

test('personal-bot enforces H5 direct bearer, H8/H9 strict SemVer Bot-Client-Version, and D1 removal of reviewer slot', async () => {
  const hub = await createTestServer();
  let hostMode: 'ok' | 'version_mismatch' = 'ok';
  const host = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    if (hostMode === 'version_mismatch') {
      res.statusCode = 409;
      res.end(JSON.stringify({ code: 'version_mismatch', message: 'raw upstream version mismatch secret' }));
      return;
    }
    res.end(JSON.stringify({ id: 'ok' }));
  });
  try {
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { mode: 0o700 });
    await new Promise<void>((resolve) => host.listen(join(folder, 'host.sock'), resolve));

    const user = await hub.createUser('版本成员');
    const client = await hub.records.principals.registerClient('mcp-client', ['http://127.0.0.1:43123/cb']);
    const oauthToken = (
      await hub.records.principals.issueToken(user.principal, user.principal.id, client.name, client.id)
    ).token;

    const oauthRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + oauthToken,
        'content-type': 'application/json',
        'bot-client-version': '1.18.1',
      },
      body: JSON.stringify({ action: 'discover' }),
    });
    assert.equal(oauthRes.status, 403);
    assert.equal(((await oauthRes.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

    const legacyHeaderRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'circle-version': '1.18.1',
      },
      body: JSON.stringify({ action: 'discover' }),
    });
    assert.equal(legacyHeaderRes.status, 400);
    assert.equal(((await legacyHeaderRes.json()) as { code?: string }).code, 'BOT_VERSION_INVALID');

    for (const badVersion of ['1.18', 'v1.18.1', '01.18.1', '1.018.1', '1.18.01', '1.18.1-', '1.18.1+']) {
      const badRes = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'application/json',
          'bot-client-version': badVersion,
        },
        body: JSON.stringify({ action: 'discover' }),
      });
      assert.equal(badRes.status, 400, `expected 400 for ${badVersion}`);
      assert.equal(((await badRes.json()) as { code?: string }).code, 'BOT_VERSION_INVALID');
    }

    const prereleaseRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'bot-client-version': '1.18.1-beta.1+build.42',
      },
      body: JSON.stringify({ action: 'discover' }),
    });
    assert.equal(prereleaseRes.status, 200);

    hostMode = 'version_mismatch';
    const mismatchRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'bot-client-version': '2.0.0',
      },
      body: JSON.stringify({ action: 'discover' }),
    });
    assert.equal(mismatchRes.status, 409);
    const mismatchBody = (await mismatchRes.json()) as { code?: string; message?: string };
    assert.equal(mismatchBody.code, 'BOT_VERSION_MISMATCH');
    assert.ok(!JSON.stringify(mismatchBody).includes('raw upstream'));

    await hub.records.vault.put(
      'personal-bot.reviewer',
      JSON.stringify({
        name: '已废弃审校',
        protocol: 'openai',
        endpoint: 'https://review.example.invalid/v1',
        model: 'demo',
        key: 'unused-reviewer-key',
      }),
    );
    assert.equal(await (readBotProfile as (v: typeof hub.records.vault, r?: boolean) => Promise<unknown>)(hub.records.vault, true), null);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});

test('personal-bot masks vault secrets from echoed host errors, never logs raw host errors or payloads, and verifies bot-runtime directory via lstat', async () => {
  const hub = await createTestServer();
  const echoedKey = 'fixture-secret-model-key-999';
  const channelSecret = 'fixture-channel-secret-888';
  let seenHostCalls = 0;
  const host = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const p of req) parts.push(p);
    seenHostCalls += 1;
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as { config?: { key?: string } };
    res.statusCode = 502;
    res.end(
      JSON.stringify({
        code: 'model_unreachable',
        message: `upstream failed using ${parsed.config?.key ?? ''} and ${channelSecret}`,
      }),
    );
  });
  try {
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { mode: 0o700 });
    await new Promise<void>((resolve) => host.listen(join(folder, 'host.sock'), resolve));

    const user = await hub.createUser('安全成员');
    await setBotProfile(hub.records.vault, {
      name: '安全助手',
      protocol: 'responses',
      endpoint: 'https://model.example.invalid/v1',
      model: 'demo',
      key: echoedKey,
    });
    const chan = newChannel({ bot: 'bot-sec', secret: channelSecret, hub: hub.url + '/' });
    await hub.records.vault.put(channelProfileName, JSON.stringify({ ...chan, enabled: true }));

    const sendRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'bot-client-version': '1.18.1',
      },
      body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '测试秘密遮罩' }),
    });
    assert.equal(sendRes.status, 502);
    const sendBody = (await sendRes.json()) as { code?: string; message?: string };
    assert.equal(sendBody.code, 'BOT_UPSTREAM_UNAVAILABLE');
    const serialized = JSON.stringify(sendBody);
    assert.ok(!serialized.includes(echoedKey), 'member response must never leak model key');
    assert.ok(!serialized.includes(channelSecret), 'member response must never leak channel secret');
    assert.ok(!serialized.includes('upstream failed using'), 'member response must never relay raw host message');

    const callLogPage = await hub.records.callLog.query(hub.admin.principal, { userId: user.principal.id });
    const adminNotes = callLogPage.items.map((row) => row.admin_note ?? '').join('\n');
    const allLogs = hub.logs.join('\n') + '\n' + adminNotes;
    assert.ok(!allLogs.includes(echoedKey), 'admin call_log and stderr logs must mask model key');
    assert.ok(!allLogs.includes(channelSecret), 'admin call_log and stderr logs must mask channel secret');
    assert.ok(adminNotes.includes('[REDACTED]') || hub.logs.some((line) => line.includes('[REDACTED]')));

    // H16: wrong directory permissions (0o755)
    const callsBeforeChmod = seenHostCalls;
    await chmod(folder, 0o755);
    const badPermRes = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'bot-client-version': '1.18.1',
      },
      body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '权限探测' }),
    });
    assert.equal(badPermRes.status, 503);
    assert.equal(((await badPermRes.json()) as { code?: string }).code, 'BOT_UPSTREAM_UNAVAILABLE');
    assert.equal(seenHostCalls, callsBeforeChmod, 'must refuse before connecting or sending secrets to 0o755 dir');
    await chmod(folder, 0o700);

    // H16: symlink check
    const symlinkTarget = join(hub.deps.config.dataDir, 'bot-runtime-target');
    await mkdir(symlinkTarget, { mode: 0o700 });
    const symDataDir = join(hub.deps.config.dataDir, 'sym-data');
    await mkdir(symDataDir, { mode: 0o700 });
    await symlink(symlinkTarget, join(symDataDir, 'bot-runtime'));
    const sockRes = await (await import('./personal-bot.ts')).callBot(symDataDir, {
      action: 'send',
      config: { key: echoedKey },
    });
    assert.equal(sockRes.status, 503);
    assert.equal((sockRes.body as { code?: string }).code, 'BOT_UPSTREAM_UNAVAILABLE');
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});
