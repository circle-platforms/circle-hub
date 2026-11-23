import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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
    await refreshHost(hub.deps.config.dataDir, hub.records.vault);
    const configureFrame = seen.at(-1) as { owner?: unknown; op?: { action?: string }; config?: typeof profile };
    assert.equal(configureFrame.owner, '_hub');
    assert.deepEqual(configureFrame.op, { action: 'configure' });
    assert.equal(configureFrame.config?.key, profile.key);

    const response = await send(member.token, op);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(profile.key));
    assert.equal((seen.at(-1)!.config as typeof profile).key, profile.key);
    assert.equal((seen.at(-1)!.owner), member.principal.id);

    await disableBot(hub.deps);
    const disableFrame = seen.at(-1) as { owner?: unknown; op?: { action?: string } };
    assert.equal(disableFrame.owner, '_hub');
    assert.deepEqual(disableFrame.op, { action: 'disable' });
    assert.equal((await send(member.token, { action: 'discover' })).status, 200);
    assert.equal(seen.at(-1)!.config, null);
    assert.equal((await send(member.token, op)).status, 503);
    // Offline refreshHost never throws when host.sock does not exist
    await refreshHost(join(hub.deps.config.dataDir, 'no-such-dir'), hub.records.vault);
    await hub.records.principals.setDisabled(hub.admin.principal, member.principal.id, true);
    assert.equal((await send(member.token, { action: 'discover' })).status, 401);
    assert.equal(seen.length, 5);
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
    assert.equal(mismatchRes.status, 409);
    const mismatchBody = (await mismatchRes.json()) as { code?: string; message?: string };
    assert.equal(mismatchBody.code, 'BOT_VERSION_MISMATCH');
    assert.ok(!JSON.stringify(mismatchBody).includes('raw upstream'));

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
          expectPattern: /^参数无效：.*机器人附件完整性校验未通过/,
        },
        {
          hostStatus: 422,
          hostBody: { code: 'invalid_request', message: 'bad attachment' },
          expectStatus: 422,
          expectCode: 'BOT_INVALID_REQUEST',
          expectPattern: /^参数无效：.*机器人附件完整性校验未通过/,
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
      assert.equal(symConnected, false, 'must NEVER connect through symlinked bot-runtime');
      assert.match(sockRes.adminDetail ?? '', /是符号链接/);

      // S10: inspectBotRuntimeDir & ensureBotRuntimeDir checks
      const missingDir = join(hub.deps.config.dataDir, 'missing-data');
      await mkdir(missingDir, { mode: 0o700 });
      assert.deepEqual(await inspectBotRuntimeDir(missingDir), {
        ok: false,
        path: join(missingDir, 'bot-runtime'),
        reason: '不存在',
      });
      await ensureBotRuntimeDir(missingDir);
      assert.deepEqual(await inspectBotRuntimeDir(missingDir), {
        ok: true,
        path: join(missingDir, 'bot-runtime'),
      });
      assert.equal(((await lstat(join(missingDir, 'bot-runtime'))).mode & 0o777), 0o700);

      const fileDataDir = join(hub.deps.config.dataDir, 'file-data');
      await mkdir(fileDataDir, { mode: 0o700 });
      await writeFile(join(fileDataDir, 'bot-runtime'), 'not-a-dir');
      assert.equal((await inspectBotRuntimeDir(fileDataDir)).ok, false);
      const fileInspect = await inspectBotRuntimeDir(fileDataDir);
      assert.equal(fileInspect.ok ? '' : fileInspect.reason, '不是普通目录');

      // ensureBotRuntimeDir never chmods a pre-existing wrong-mode directory
      const wrongModeDataDir = join(hub.deps.config.dataDir, 'wrong-mode-data');
      await mkdir(join(wrongModeDataDir, 'bot-runtime'), { recursive: true, mode: 0o755 });
      await chmod(join(wrongModeDataDir, 'bot-runtime'), 0o755);
      await ensureBotRuntimeDir(wrongModeDataDir);
      assert.equal(((await lstat(join(wrongModeDataDir, 'bot-runtime'))).mode & 0o777), 0o755);
    } finally {
      await new Promise<void>((resolve) => symHost.close(() => resolve()));
      await new Promise<void>((resolve) => host.close(() => resolve()));
      await hub.close();
    }
  },
);
