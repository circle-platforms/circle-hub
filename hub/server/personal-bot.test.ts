import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  callBot,
  channelProfileName,
  chatPath,
  disableBot,
  ensureBotRuntimeDir,
  identityIssuer,
  identityProfileName,
  inspectBotRuntimeDir,
  maskVaultSecrets,
  newChannel,
  readBotConfigState,
  readBotProfile,
  refreshHost,
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
    await mkdir(folder, { recursive: true, mode: 0o700 });
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
    assert.equal(seen[0].config, null);
    assert.equal(seen[0].configVersion, 0);
    assert.deepEqual(await readBotConfigState(hub.records.vault), { config: null, configVersion: 0 });
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
    assert.equal((await readBotConfigState(hub.records.vault)).configVersion, 1);
    await assert.rejects(
      setBotProfile(hub.records.vault, { ...profile, endpoint: 'https://example.invalid/?key=secret' }),
    );
    assert.equal((await readBotProfile(hub.records.vault))?.name, profile.name);
    const refreshOk = await refreshHost(hub.deps.config.dataDir, hub.records.vault);
    assert.deepEqual(refreshOk, { notified: true, configVersion: 1 });
    const configureFrame = seen.at(-1) as {
      owner?: unknown;
      op?: { action?: string };
      config?: typeof profile;
      configVersion?: number;
    };
    assert.equal(configureFrame.owner, '_hub');
    assert.deepEqual(configureFrame.op, { action: 'configure' });
    assert.equal(configureFrame.config?.key, profile.key);
    assert.equal(configureFrame.configVersion, 1);

    const response = await send(member.token, op);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(profile.key));
    assert.equal((seen.at(-1)!.config as typeof profile).key, profile.key);
    assert.equal(seen.at(-1)!.configVersion, 1);
    assert.equal((seen.at(-1)!.owner), member.principal.id);

    await disableBot(hub.deps);
    const disableFrame = seen.at(-1) as { owner?: unknown; op?: { action?: string }; configVersion?: number };
    assert.equal(disableFrame.owner, '_hub');
    assert.deepEqual(disableFrame.op, { action: 'disable' });
    assert.equal(disableFrame.configVersion, 2);
    assert.deepEqual(await readBotConfigState(hub.records.vault), { config: null, configVersion: 2 });
    assert.equal((await send(member.token, { action: 'discover' })).status, 200);
    assert.equal(seen.at(-1)!.config, null);
    assert.equal(seen.at(-1)!.configVersion, 2);
    assert.equal((await send(member.token, op)).status, 503);
    // Offline refreshHost never throws when host.sock does not exist, returns { notified: false } and logs masked detail
    const offlineLogs: string[] = [];
    const offlineRes = await refreshHost(
      join(hub.deps.config.dataDir, 'no-such-dir'),
      hub.records.vault,
      (line) => offlineLogs.push(line),
    );
    assert.equal(offlineRes.notified, false);
    assert.equal(offlineRes.configVersion, 2);
    assert.equal(offlineLogs.length, 1);
    assert.match(offlineLogs[0]!, /^通知机器人宿主配置变更失败（版本 2）：/);
    await hub.records.principals.setDisabled(hub.admin.principal, member.principal.id, true);
    assert.equal((await send(member.token, { action: 'discover' })).status, 401);
    assert.equal(seen.length, 5);
    assert.ok(!hub.logs.join('').includes(profile.key));

    // Legacy model without personal-bot.model-version defaults to configVersion=1 and increments to 2
    await hub.records.vault.remove('personal-bot.model-version');
    await hub.records.vault.put('personal-bot.model', JSON.stringify(profile));
    assert.equal((await readBotConfigState(hub.records.vault)).configVersion, 1);
    await setBotProfile(hub.records.vault, { ...profile, name: '升级机器人' });
    assert.equal((await readBotConfigState(hub.records.vault)).configVersion, 2);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});

test('personal-bot enforces H5 direct bearer, H8/H9 strict SemVer Bot-Client-Version, and D1 removal of reviewer slot', async () => {
  const hub = await createTestServer();
  let hostMode: 'ok' | 'version_mismatch' | 'version_mismatch_400' = 'ok';
  const host = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    if (hostMode === 'version_mismatch' || hostMode === 'version_mismatch_400') {
      res.statusCode = hostMode === 'version_mismatch_400' ? 400 : 409;
      res.end(JSON.stringify({ code: 'version_mismatch', message: 'raw upstream version mismatch secret' }));
      return;
    }
    res.end(JSON.stringify({ id: 'ok' }));
  });
  try {
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { recursive: true, mode: 0o700 });
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

    // T2: OAuth token on action: 'send' with text/plain MUST be refused at requireDirectAccessBearer (403) before mediaTypeOf (415)
    const oauthTextPlain = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + oauthToken,
        'content-type': 'text/plain',
        'bot-client-version': '1.18.1',
      },
      body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: 'oauth' }),
    });
    assert.equal(oauthTextPlain.status, 403);
    assert.equal(((await oauthTextPlain.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

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

    for (const badVersion of ['1.18', 'v1.18.1', '01.18.1', '1.018.1', '1.18.01', '1.2.3-01', '1.2.3-01.alpha', '1.18.1-', '1.18.1+']) {
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
    assert.equal(mismatchRes.status, 400);
    const mismatchBody = (await mismatchRes.json()) as { code?: string; message?: string };
    assert.equal(mismatchBody.code, 'BOT_VERSION_MISMATCH');
    assert.match(mismatchBody.message ?? '', /^参数无效：/);
    assert.ok(!JSON.stringify(mismatchBody).includes('raw upstream'));

    hostMode = 'version_mismatch_400';
    const mismatch400Res = await fetch(hub.url + chatPath, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + user.token,
        'content-type': 'application/json',
        'bot-client-version': '2.0.0',
      },
      body: JSON.stringify({ action: 'discover' }),
    });
    assert.equal(mismatch400Res.status, 400);
    const mismatch400Body = (await mismatch400Res.json()) as { code?: string; message?: string };
    assert.equal(mismatch400Body.code, 'BOT_VERSION_MISMATCH');
    assert.match(mismatch400Body.message ?? '', /^参数无效：/);

    // S8: setBotProfile and disableBot remove stranded legacy reviewer slot
    const putLegacyReviewer = () =>
      hub.records.vault.put(
        'personal-bot.reviewer',
        JSON.stringify({
          name: '已废弃审校',
          protocol: 'openai',
          endpoint: 'https://review.example.invalid/v1',
          model: 'demo',
          key: 'unused-reviewer-key',
        }),
      );
    await putLegacyReviewer();
    assert.equal(await readBotProfile(hub.records.vault), null);
    await setBotProfile(hub.records.vault, {
      name: '清理测试机器人',
      protocol: 'openai',
      endpoint: 'https://model.example.invalid/v1',
      model: 'demo',
      key: 'cleanup-key',
    });
    assert.equal(await hub.records.vault.has('personal-bot.reviewer'), false);
    await putLegacyReviewer();
    await disableBot(hub.records.vault);
    assert.equal(await hub.records.vault.has('personal-bot.reviewer'), false);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});

test(
  'R6/R7/H10b/H10c/H16/S5/S10: enforces JSON size caps, reflected-key 502, masks before slice(512), maps 404 BOT_NOT_FOUND, and inspects bot-runtime without connecting through symlinks',
  { timeout: 30_000 },
  async () => {
    const hub = await createTestServer();
    const echoedKey = 'fixture-secret-model-key-999999';
    const channelSecret = 'fixture-channel-secret-888';
    let seenHostCalls = 0;
    const seenHostBodies: Array<Record<string, unknown>> = [];
    let hostReply: { status: number; body: unknown } = {
      status: 502,
      body: {
        code: 'model_unreachable',
        message: 'x'.repeat(498) + echoedKey + ' tail',
      },
    };
    const host = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      seenHostBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      seenHostCalls += 1;
      res.statusCode = hostReply.status;
      res.end(JSON.stringify(hostReply.body));
    });
    let symConnected = false;
    const symlinkTarget = join(hub.deps.config.dataDir, 'bot-runtime-target');
    const symHost = createServer(async (req, res) => {
      symConnected = true;
      for await (const _ of req) {
        // drain
      }
      res.end(JSON.stringify({ id: 'should-not-reach' }));
    });
    try {
      const folder = join(hub.deps.config.dataDir, 'bot-runtime');
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await new Promise<void>((resolve) => host.listen(join(folder, 'host.sock'), resolve));

      const user = await hub.createUser('安全成员');
      await setBotProfile(hub.records.vault, {
        name: '安全机器人',
        protocol: 'responses',
        endpoint: 'https://model.example.invalid/v1',
        model: 'demo',
        key: echoedKey,
      });
      const chan = newChannel({ bot: 'bot-sec', secret: channelSecret, hub: hub.url + '/' });
      await hub.records.vault.put(channelProfileName, JSON.stringify({ ...chan, enabled: true }));

      // H5: non-JSON Content-Type -> 415 BOT_INVALID_REQUEST
      const badContentType = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'text/plain',
          'bot-client-version': '1.18.1',
        },
        body: '{}',
      });
      assert.equal(badContentType.status, 415);
      assert.equal(((await badContentType.json()) as { code?: string }).code, 'BOT_INVALID_REQUEST');

      // H10b: JSON body > 72 KiB -> 413 BOT_INVALID_REQUEST (never BOT_QUOTA_EXCEEDED)
      const hugeJson = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: JSON.stringify({ action: 'discover', pad: 'a'.repeat(73 * 1024) }),
      });
      assert.equal(hugeJson.status, 413);
      const hugeJsonBody = (await hugeJson.json()) as { code?: string; message?: string };
      assert.equal(hugeJsonBody.code, 'BOT_INVALID_REQUEST');
      assert.ok(!String(hugeJsonBody.message).includes('个人助手'));

      // S5: secret spanning past index 512 in host error message must be masked BEFORE .slice(0, 512)
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
      assert.match(sendBody.message ?? '', /^暂时不可用：/);
      assert.ok(!String(sendBody.message).includes('个人助手'));
      const serialized = JSON.stringify(sendBody);
      assert.ok(!serialized.includes(echoedKey), 'member response must never leak model key');
      assert.ok(!serialized.includes(channelSecret), 'member response must never leak channel secret');
      assert.ok(!serialized.includes('x'.repeat(20)), 'member response must never relay raw host message');

      const maskedDirect = await maskVaultSecrets(hub.records.vault, `a=${echoedKey}, b=${channelSecret}`);
      assert.equal(maskedDirect, 'a=[REDACTED], b=[REDACTED]');

      const callLogPage = await hub.records.callLog.query(hub.admin.principal, { userId: user.principal.id });
      const adminNotes = callLogPage.items.map((row) => row.admin_note ?? '').join('\n');
      assert.ok(!adminNotes.includes(echoedKey.slice(0, 8)), 'secret spanning index 512 must be masked before slicing');
      assert.ok(adminNotes.includes('[REDACTED]'));

      // H10c: 200 response reflecting model secret key -> 502 BOT_UPSTREAM_UNAVAILABLE
      hostReply = { status: 200, body: { reply: `oops ${echoedKey}` } };
      const reflectedRes = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '回显检测' }),
      });
      assert.equal(reflectedRes.status, 502);
      const reflectedBody = (await reflectedRes.json()) as { code?: string; message?: string };
      assert.equal(reflectedBody.code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.ok(!JSON.stringify(reflectedBody).includes(echoedKey));

      // H10c (non-model vault secrets): 200 response reflecting channel/vault secret via maskVaultSecrets -> 502 BOT_UPSTREAM_UNAVAILABLE
      hostReply = { status: 200, body: { reply: `leak ${channelSecret}` } };
      const reflectedChannelRes = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '通道密钥回显检测' }),
      });
      assert.equal(reflectedChannelRes.status, 502);
      const reflectedChannelBody = (await reflectedChannelRes.json()) as { code?: string };
      assert.equal(reflectedChannelBody.code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.ok(!JSON.stringify(reflectedChannelBody).includes(channelSecret));

      // R6: host 404 -> 404 BOT_NOT_FOUND
      hostReply = { status: 404, body: { code: 'not_found', message: 'unknown conversation' } };
      const missingConv = await fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '未知会话' }),
      });
      assert.equal(missingConv.status, 404);
      const missingConvBody = (await missingConv.json()) as { code?: string; message?: string };
      assert.equal(missingConvBody.code, 'BOT_NOT_FOUND');
      assert.match(missingConvBody.message ?? '', /^不存在：/);

      // R6 route.source = 'client' + S14 host error mappings (429 BOT_BUSY, 503 BOT_DISABLED, 413/422 BOT_INVALID_REQUEST)
      await hub.records.vault.put(
        identityProfileName,
        JSON.stringify({ tenant: 'client-route-tenant', application: 'client-app', secret: 'app-route-sec' }),
      );
      const routeIssuer = identityIssuer('client-route-tenant');
      await hub.records.principals.bindExternalIdentity(user.principal, routeIssuer, 'ext-client-route');

      for (const s14Case of [
        {
          hostStatus: 429,
          hostBody: { code: 'bot_busy', message: 'queue full' },
          expectStatus: 429,
          expectCode: 'BOT_BUSY',
          expectPattern: /^暂时不可用：.*当前机器人会话排队消息已满/,
        },
        {
          hostStatus: 503,
          hostBody: { code: 'bot_not_enabled', message: 'not enabled' },
          expectStatus: 503,
          expectCode: 'BOT_DISABLED',
          expectPattern: /^暂时不可用：.*机器人尚未配置启用/,
        },
        {
          hostStatus: 413,
          hostBody: { code: 'payload_too_large', message: 'too big' },
          expectStatus: 413,
          expectCode: 'BOT_INVALID_REQUEST',
          expectPattern: /^参数无效：.*机器人请求体超过允许大小上限/,
        },
        {
          hostStatus: 422,
          hostBody: { code: 'attachment_integrity_failed', message: 'bad digest' },
          expectStatus: 422,
          expectCode: 'BOT_INVALID_REQUEST',
          expectPattern: /^参数无效：.*机器人私聊附件完整性校验未通过/,
        },
        {
          hostStatus: 422,
          hostBody: { code: 'invalid_request', message: 'bad attachment' },
          expectStatus: 422,
          expectCode: 'BOT_INVALID_REQUEST',
          expectPattern: /^参数无效：.*机器人私聊附件完整性校验未通过/,
        },
      ]) {
        hostReply = { status: s14Case.hostStatus, body: s14Case.hostBody };
        const s14Res = await fetch(hub.url + chatPath, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + user.token,
            'content-type': 'application/json',
            'bot-client-version': '1.18.1',
          },
          body: JSON.stringify({ action: 'send', conversation: randomUUID(), request: randomUUID(), text: '宿主错误映射测试' }),
        });
        assert.equal(s14Res.status, s14Case.expectStatus);
        const s14Body = (await s14Res.json()) as { code?: string; message?: string };
        assert.equal(s14Body.code, s14Case.expectCode);
        assert.match(s14Body.message ?? '', s14Case.expectPattern);
        assert.deepEqual(seenHostBodies.at(-1)?.route, {
          source: 'client',
          issuer: routeIssuer,
          subject: 'ext-client-route',
        });
      }

      // S10: wrong directory permissions (0o755) -> member gets generic 503 while call_log gets exact adminDetail
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
      const badPermBody = (await badPermRes.json()) as { code?: string; message?: string };
      assert.equal(badPermBody.code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.ok(!String(badPermBody.message).includes('0755'), 'member response must never disclose filesystem mode');
      assert.equal(seenHostCalls, callsBeforeChmod, 'must refuse before connecting or sending secrets to 0o755 dir');
      const afterPermLogs = (await hub.records.callLog.query(hub.admin.principal, { userId: user.principal.id })).items;
      assert.ok(afterPermLogs.some((row) => (row.admin_note ?? '').includes('权限为 0755（须为 0700）')));
      await chmod(folder, 0o700);

      // S10 + H16: symlink pointing to LIVE listening socket -> 503 with connected === false and adminDetail
      await mkdir(symlinkTarget, { mode: 0o700 });
      await new Promise<void>((resolve) => symHost.listen(join(symlinkTarget, 'host.sock'), resolve));
      const symDataDir = join(hub.deps.config.dataDir, 'sym-data');
      await mkdir(symDataDir, { mode: 0o700 });
      await symlink(symlinkTarget, join(symDataDir, 'bot-runtime'));
      const sockRes = await callBot(symDataDir, { action: 'send', config: { key: echoedKey } });
      assert.equal(sockRes.status, 503);
      assert.equal((sockRes.body as { code?: string }).code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.equal(sockRes.socketAbsent, false);
      assert.equal(symConnected, false, 'must NEVER connect through symlinked bot-runtime');
      assert.match(sockRes.adminDetail ?? '', /是符号链接/);

      // S10 + S3 + M2: inspectBotRuntimeDir, ensureBotRuntimeDir, and callBot socketAbsent checks
      const shortRoot = await mkdtemp(join(tmpdir(), 'pb-'));
      try {
        const missingDir = join(shortRoot, 'm');
        await mkdir(missingDir, { mode: 0o700 });
        assert.deepEqual(await inspectBotRuntimeDir(missingDir), {
          ok: false,
          path: join(missingDir, 'bot-runtime'),
          reason: '不存在',
          missing: true,
        });
        assert.equal((await callBot(missingDir, { action: 'discover' })).socketAbsent, true);
        await ensureBotRuntimeDir(missingDir);
        assert.deepEqual(await inspectBotRuntimeDir(missingDir), {
          ok: true,
          path: join(missingDir, 'bot-runtime'),
        });
        assert.equal(((await lstat(join(missingDir, 'bot-runtime'))).mode & 0o777), 0o700);
        assert.equal((await callBot(missingDir, { action: 'discover' })).socketAbsent, true);

        const fileDataDir = join(shortRoot, 'f');
        await mkdir(fileDataDir, { mode: 0o700 });
        await writeFile(join(fileDataDir, 'bot-runtime'), 'not-a-dir');
        const fileInspect = await inspectBotRuntimeDir(fileDataDir);
        assert.equal(fileInspect.ok, false);
        assert.equal(fileInspect.ok ? '' : fileInspect.reason, '不是普通目录');
        assert.equal(fileInspect.ok ? true : fileInspect.missing, false);
        assert.equal((await callBot(fileDataDir, { action: 'discover' })).socketAbsent, false);

        // ensureBotRuntimeDir never chmods a pre-existing wrong-mode directory
        const wrongModeDataDir = join(shortRoot, 'w');
        await mkdir(join(wrongModeDataDir, 'bot-runtime'), { recursive: true, mode: 0o755 });
        await chmod(join(wrongModeDataDir, 'bot-runtime'), 0o755);
        await ensureBotRuntimeDir(wrongModeDataDir);
        assert.equal(((await lstat(join(wrongModeDataDir, 'bot-runtime'))).mode & 0o777), 0o755);
        const wrongModeInspect = await inspectBotRuntimeDir(wrongModeDataDir);
        assert.equal(wrongModeInspect.ok ? true : wrongModeInspect.missing, false);
        assert.equal((await callBot(wrongModeDataDir, { action: 'discover' })).socketAbsent, false);

        // M2: HTTP 500, invalid JSON, and ECONNREFUSED all report socketAbsent: false
        hostReply = { status: 500, body: { message: 'boom' } };
        const err500 = await callBot(hub.deps.config.dataDir, { action: 'discover' });
        assert.equal(err500.status, 500);
        assert.equal(err500.socketAbsent, false);

        const badJsonDir = join(shortRoot, 'j');
        await mkdir(join(badJsonDir, 'bot-runtime'), { recursive: true, mode: 0o700 });
        const badJsonSock = createServer((_req, res) => res.end('not-json'));
        await new Promise<void>((resolve) => badJsonSock.listen(join(badJsonDir, 'bot-runtime', 'host.sock'), resolve));
        const badJsonRes = await callBot(badJsonDir, { action: 'discover' });
        assert.equal(badJsonRes.status, 503);
        assert.equal(badJsonRes.socketAbsent, false);
        await new Promise<void>((resolve) => badJsonSock.close(() => resolve()));

        // Stale unix socket file left on disk produces ECONNREFUSED -> socketAbsent: false
        const staleSockDir = join(shortRoot, 's');
        await mkdir(join(staleSockDir, 'bot-runtime'), { recursive: true, mode: 0o700 });
        const tempSock = createServer((_req, res) => res.end('{}'));
        const tempSockPath = join(staleSockDir, 'bot-runtime', 'temp.sock');
        const staleHostSock = join(staleSockDir, 'bot-runtime', 'host.sock');
        await new Promise<void>((resolve) => tempSock.listen(tempSockPath, resolve));
        await link(tempSockPath, staleHostSock);
        await new Promise<void>((resolve) => tempSock.close(() => resolve()));
        const connRefusedRes = await callBot(staleSockDir, { action: 'discover' });
        assert.equal(connRefusedRes.status, 503);
        assert.equal(connRefusedRes.socketAbsent, false);
      } finally {
        await rm(shortRoot, { recursive: true, force: true });
      }
    } finally {
      await new Promise<void>((resolve) => symHost.close(() => resolve()));
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await hub.close();
    }
  },
);

test('personal-bot rejects unconsented OAuth tokens with insufficient_scope, allows re-consented same-client tokens and revokes cleanly', async () => {
  const hub = await createTestServer();
  const host = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    res.end(JSON.stringify({ id: 'bot-1', current: convId, binding: 'b-1', events: [], active: null }));
  });
  const convId = randomUUID();
  try {
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => host.listen(join(folder, 'host.sock'), resolve));

    const user = await hub.createUser('同意机器人成员');
    await setBotProfile(hub.records.vault, {
      name: '授权测试机器人',
      protocol: 'openai',
      endpoint: 'https://model.example.invalid/v1',
      model: 'demo',
      key: 'secret-demo-key',
    });

    const redirect = 'http://127.0.0.1:43123/callback';
    const reg = await fetch(hub.url + '/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Desktop Client', redirect_uris: [redirect], token_endpoint_auth_method: 'none' }),
    });
    assert.equal(reg.status, 201);
    const clientId = ((await reg.json()) as { client_id: string }).client_id;

    async function authorizeWithChoice(checkBot: boolean): Promise<string> {
      const verifier = randomUUID() + '-' + randomUUID();
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
      const authRes = await fetch(
        hub.url +
          `/oauth/authorize?${new URLSearchParams({
            response_type: 'code',
            client_id: clientId,
            redirect_uri: redirect,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            state: 'st',
            resource: hub.mcpUrl,
            scope: 'bot',
          })}`,
        { redirect: 'manual' },
      );
      assert.equal(authRes.status, 303);
      const authPath = authRes.headers.get('location')!;
      const bound = (authRes.headers.getSetCookie?.() ?? [authRes.headers.get('set-cookie') ?? '']).join('; ').split(';')[0];
      const inv = await hub.records.principals.invite(hub.admin.principal, user.user.id);
      const page1 = await fetch(hub.url + authPath, { headers: { cookie: bound } });
      const csrf1 = /name="csrf" value="([^"]+)"/.exec(await page1.text())![1];
      const ident = await fetch(hub.url + authPath, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bound, origin: hub.url },
        body: new URLSearchParams({ csrf: csrf1, step: 'identity', code: inv.code }),
      });
      assert.equal(ident.status, 303);
      const page2 = await fetch(hub.url + authPath, { headers: { cookie: bound } });
      const html2 = await page2.text();
      const csrf2 = /name="csrf" value="([^"]+)"/.exec(html2)![1];
      const account = /name="account" value="([^"]+)"/.exec(html2)![1];
      const decision = await fetch(hub.url + authPath, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: bound, origin: hub.url },
        body: new URLSearchParams({
          csrf: csrf2,
          step: 'decide',
          decision: 'approve',
          account,
          ...(checkBot ? { scope_bot: '1' } : {}),
        }),
      });
      assert.equal(decision.status, 303);
      const code = new URL(decision.headers.get('location')!).searchParams.get('code')!;
      const tokRes = await fetch(hub.url + '/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource: hub.mcpUrl,
        }),
      });
      assert.equal(tokRes.status, 200);
      const tokJson = (await tokRes.json()) as { access_token: string; scope?: string };
      assert.equal(tokJson.scope, checkBot ? 'bot' : '');
      return tokJson.access_token;
    }

    const callBotApi = (token: string, action = 'discover') =>
      fetch(hub.url + chatPath, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: JSON.stringify(
          action === 'send'
            ? { action: 'send', conversation: convId, request: randomUUID(), text: 'hello' }
            : { action: 'discover' },
        ),
      });
    const callMcp = (token: string) =>
      fetch(hub.mcpUrl, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'c', version: '1.0.0' } },
        }),
      });

    const unconsented = await authorizeWithChoice(false);
    const denied = await callBotApi(unconsented);
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get('www-authenticate'), 'Bearer error="insufficient_scope", scope="bot"');
    const deniedBody = (await denied.json()) as { code?: string; message?: string };
    assert.equal(deniedBody.code, 'BOT_CLIENT_FORBIDDEN');
    assert.match(deniedBody.message ?? '', /允许这个客户端使用我的机器人/);
    assert.equal((await callMcp(unconsented)).status, 200, '/mcp still works without bot consent');

    const consented = await authorizeWithChoice(true);
    const allowedDiscover = await callBotApi(consented, 'discover');
    assert.equal(allowedDiscover.status, 200);
    const allowedSend = await callBotApi(consented, 'send');
    assert.equal(allowedSend.status, 200);
    assert.equal((await callMcp(consented)).status, 200);

    assert.equal((await callBotApi(user.token, 'discover')).status, 200, 'direct member token remains allowed');
    const session = await hub.records.principals.openConsoleSession(user.user.id, (await hub.records.principals.passwordState(user.user.id)).revision);
    assert.ok(session);
    const consoleRes = await callBotApi(session.token, 'discover');
    assert.equal(consoleRes.status, 403);
    assert.equal(((await consoleRes.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

    const revoked = await fetch(hub.url + '/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: consented }),
    });
    assert.equal(revoked.status, 200);
    assert.equal((await callBotApi(consented, 'discover')).status, 401);
    assert.equal((await callMcp(consented)).status, 401);
  } finally {
    await new Promise<void>((resolve) => host.close(() => resolve()));
    await hub.close();
  }
});
