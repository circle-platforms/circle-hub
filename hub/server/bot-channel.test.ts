import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { botFilesPath } from './bot-files.ts';
import {
  channelProfileName,
  identityIssuer,
  identityProfileName,
  newChannel,
  readChannel,
  refreshChannel,
  setBotProfile,
} from './personal-bot.ts';
import { createTestServer } from './testing.ts';

async function listenUnixSocket(
  socketPath: string,
  handler: (body: Record<string, unknown>) => { status?: number; body: unknown },
): Promise<{ close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(chunk);
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
    const reply = handler(parsed);
    res.statusCode = reply.status ?? 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('bot channel enforces guards, handles inbound/next/receipt records and files, and syncs adapter', async () => {
  const hub = await createTestServer();
  const folder = join(hub.deps.config.dataDir, 'bot-runtime');
  await mkdir(folder, { mode: 0o700 });
  const hostCalls: Record<string, unknown>[] = [];
  const channelCalls: Record<string, unknown>[] = [];
  let nextDelivery: unknown = null;
  const host = await listenUnixSocket(join(folder, 'host.sock'), (body) => {
    hostCalls.push(body);
    const op = body.op as { action?: string } | undefined;
    if (op?.action === 'claim') return { body: { delivery: nextDelivery } };
    if (op?.action === 'receipt') return { body: { ok: true } };
    return { body: { accepted: true } };
  });
  const channelSock = await listenUnixSocket(join(folder, 'channel.sock'), (body) => {
    channelCalls.push(body);
    return { body: { ok: true } };
  });

  try {
    const channelPath = '/api/bot-channel/v1';
    const member = await hub.createUser('通道成员');
    const postChannel = (token: string | null, body: unknown, headers: Record<string, string> = {}) =>
      fetch(hub.url + channelPath, {
        method: 'POST',
        headers: {
          ...(token ? { authorization: 'Bearer ' + token } : {}),
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    assert.equal((await fetch(hub.url + channelPath, { method: 'GET' })).status, 403);
    assert.equal((await postChannel(null, { action: 'next' }, { origin: hub.url })).status, 403);
    assert.equal((await postChannel(null, 'x', { 'content-type': 'text/plain' })).status, 403);
    assert.equal((await postChannel('missing', { action: 'next' })).status, 401);

    const stored = newChannel({ bot: 'bot-1', secret: 'chan-secret', hub: hub.url + '/' });
    await hub.records.vault.put(channelProfileName, JSON.stringify(stored));
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 401);

    await hub.records.vault.put(channelProfileName, JSON.stringify({ ...stored, enabled: true }));
    assert.equal((await postChannel('wrong-token', { action: 'next' })).status, 401);
    assert.equal((await postChannel(stored.token, { action: 'invalid' })).status, 400);
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 503);

    const identity = { tenant: 'tenant-1', application: 'app-1', secret: 'app-secret' };
    await hub.records.vault.put(identityProfileName, JSON.stringify(identity));
    const issuer = identityIssuer(identity.tenant);
    await hub.records.principals.bindExternalIdentity(member.principal, issuer, 'ext-user-1');

    assert.equal((await postChannel(stored.token, { action: 'authorize', subject: 'unbound' })).status, 403);
    const authRes = await postChannel(stored.token, { action: 'authorize', subject: 'ext-user-1' });
    assert.equal(authRes.status, 200);
    assert.deepEqual(await authRes.json(), { bound: true });

    await setBotProfile(hub.records.vault, {
      name: '合成机器人',
      protocol: 'openai',
      endpoint: 'https://model.example.invalid/v1',
      model: 'demo',
      key: 'synthetic-key',
    });

    const emptyInbound = await postChannel(stored.token, {
      action: 'inbound',
      subject: 'ext-user-1',
      platformId: 'msg-empty',
      text: '   ',
    });
    assert.equal(emptyInbound.status, 400);

    const fileBytes = Buffer.from('channel-attachment');
    const fileSha = createHash('sha256').update(fileBytes).digest('hex');
    const channelFileUrl = hub.url + '/api/bot-channel/v1/files/' + fileSha;
    assert.equal((await fetch(channelFileUrl, { method: 'GET', headers: { authorization: 'Bearer ' + stored.token } })).status, 403);
    const subjectHeader = Buffer.from('ext-user-1', 'utf8').toString('base64url');
    const putFile = await fetch(channelFileUrl, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer ' + stored.token,
        'circle-member-subject': subjectHeader,
        'content-length': String(fileBytes.length),
      },
      body: fileBytes,
    });
    assert.equal(putFile.status, 200);
    assert.deepEqual(await putFile.json(), { sha256: fileSha, size: fileBytes.length });
    const getByMember = await fetch(hub.url + botFilesPath + fileSha, {
      headers: { authorization: 'Bearer ' + member.token },
    });
    assert.equal(getByMember.status, 200);
    assert.equal(await getByMember.text(), 'channel-attachment');
    const getByChannel = await fetch(channelFileUrl, {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'circle-member-subject': subjectHeader,
      },
    });
    assert.equal(getByChannel.status, 200);
    assert.equal(await getByChannel.text(), 'channel-attachment');

    const inboundPayload = {
      action: 'inbound',
      subject: 'ext-user-1',
      platformId: 'msg-1',
      text: '你好',
      files: [{ sha256: fileSha, size: fileBytes.length, name: 'note.txt' }],
    };
    const in1 = await postChannel(stored.token, inboundPayload);
    const in2 = await postChannel(stored.token, inboundPayload);
    assert.equal(in1.status, 200);
    assert.equal(in2.status, 200);
    assert.deepEqual(await in1.json(), { accepted: true });
    const op1 = hostCalls[0].op as { action: string; request: string; text: string };
    const op2 = hostCalls[1].op as { action: string; request: string; text: string };
    assert.equal(op1.action, 'inbound');
    assert.match(op1.request, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(op1.request, op2.request);
    assert.equal(hostCalls[0].owner, member.principal.id);

    assert.deepEqual(await (await postChannel(stored.token, { action: 'next' })).json(), { delivery: null });

    const receiptGood = '11111111-1111-4111-8111-111111111111';
    nextDelivery = {
      id: '22222222-2222-4222-8222-222222222222',
      owner: 'usr_00000000000000000000000001',
      subject: 'ext-user-1',
      receipt: receiptGood,
      role: 'user',
      text: 'ignored',
    };
    const mismatchRes = await postChannel(stored.token, { action: 'next' });
    assert.deepEqual(await mismatchRes.json(), { delivery: null });
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'refused');

    nextDelivery = {
      id: '33333333-3333-4333-8333-333333333333',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: receiptGood,
      role: 'user',
      text: '已同步结果',
      file: { sha256: fileSha, size: fileBytes.length, name: 'note.txt' },
    };
    const nextRes = await postChannel(stored.token, { action: 'next' });
    assert.equal(nextRes.status, 200);
    const nextJson = (await nextRes.json()) as { delivery: { text: string; receipt: string; sha256: string } };
    assert.equal(nextJson.delivery.text, '来自 Mac：\n已同步结果');
    assert.equal(nextJson.delivery.receipt, receiptGood);
    assert.equal(nextJson.delivery.sha256, fileSha);

    const intentRecord = await hub.records.store.getByKey('action', 'chat-intent:' + receiptGood);
    assert.equal(intentRecord?.schema, 'member-notification-intent@1');

    const replayNext = await postChannel(stored.token, { action: 'next' });
    assert.deepEqual(await replayNext.json(), { delivery: null });

    assert.equal(
      (
        await postChannel(stored.token, {
          action: 'receipt',
          receipt: '44444444-4444-4444-8444-444444444444',
          state: 'sent',
          acknowledgment: { request: fileSha, code: 0 },
          reached_target: true,
        })
      ).status,
      404,
    );

    const badAckRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'sent',
      acknowledgment: { request: fileSha, code: 42 },
      reached_target: false,
    });
    assert.equal(badAckRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'unknown');
    const receiptDegraded = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptGood);
    assert.equal((receiptDegraded?.body as { outcome?: string }).outcome, 'unknown');

    const receiptIssuedId = '55555555-5555-4555-8555-555555555555';
    nextDelivery = {
      id: '66666666-6666-4666-8666-666666666666',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: receiptIssuedId,
      role: 'assistant',
      text: '完成',
    };
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 200);
    const issuedRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptIssuedId,
      state: 'sent',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(issuedRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'sent');
    const receiptIssued = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptIssuedId);
    assert.equal((receiptIssued?.body as { outcome?: string }).outcome, 'issued');

    const receiptRefusedNoAckId = '77777777-7777-4777-8777-777777777777';
    nextDelivery = {
      id: '88888888-8888-4888-8888-888888888888',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: receiptRefusedNoAckId,
      role: 'assistant',
      text: '被拒',
    };
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 200);
    const refusedNoAckRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptRefusedNoAckId,
      state: 'refused',
      reached_target: false,
    });
    assert.equal(refusedNoAckRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'unknown');
    const receiptRefusedNoAck = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptRefusedNoAckId);
    assert.equal((receiptRefusedNoAck?.body as { outcome?: string }).outcome, 'unknown');

    await assert.rejects(
      refreshChannel(hub.deps.config.dataDir, hub.records.vault, new Set(['https://other.example.invalid'])),
      /适配器须访问本部署声明的 Hub 地址/,
    );
    await refreshChannel(hub.deps.config.dataDir, hub.records.vault, new Set([hub.url]));
    assert.equal(channelCalls.at(-1)!.action, 'configure');
    const disabled = { ...(await readChannel(hub.records.vault))!, enabled: false };
    await hub.records.vault.put(channelProfileName, JSON.stringify(disabled));
    await refreshChannel(hub.deps.config.dataDir, hub.records.vault, new Set([hub.url]));
    assert.equal(channelCalls.at(-1)!.action, 'disconnect');

    await hub.records.principals.setDisabled(hub.admin.principal, member.principal.id, true);
    await hub.records.vault.put(channelProfileName, JSON.stringify({ ...disabled, enabled: true }));
    assert.equal((await postChannel(stored.token, { action: 'authorize', subject: 'ext-user-1' })).status, 403);
  } finally {
    await host.close();
    await channelSock.close();
    await hub.close();
  }
});
