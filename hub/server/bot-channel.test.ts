import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { botFilesPath } from './bot-files.ts';
import {
  channelProfileName,
  disableBot,
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
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

test('bot channel enforces guards, handles inbound/next/receipt records and files, and syncs adapter', async () => {
  const hub = await createTestServer();
  const folder = join(hub.deps.config.dataDir, 'bot-runtime');
  await mkdir(folder, { recursive: true, mode: 0o700 });
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
    const missingAuth = await postChannel('missing', { action: 'next' });
    assert.equal(missingAuth.status, 401);
    assert.equal(((await missingAuth.json()) as { code?: string }).code, 'BOT_UNAUTHENTICATED');

    const stored = newChannel({ bot: 'bot-1', secret: 'chan-secret', hub: hub.url + '/' });
    await hub.records.vault.put(channelProfileName, JSON.stringify(stored));
    const disabledChanAuth = await postChannel(stored.token, { action: 'next' });
    assert.equal(disabledChanAuth.status, 401);
    assert.equal(((await disabledChanAuth.json()) as { code?: string }).code, 'BOT_UNAUTHENTICATED');

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

    // H3 staging check: inbound referencing an unstaged sha fails with 400 BOT_INVALID_REQUEST and writes no record
    const unstagedSha = createHash('sha256').update('never-staged').digest('hex');
    const unstagedInbound = await postChannel(stored.token, {
      action: 'inbound',
      subject: 'ext-user-1',
      platformId: 'msg-unstaged',
      text: 'missing file',
      files: [{ sha256: unstagedSha, size: 12, name: 'missing.txt' }],
    });
    assert.equal(unstagedInbound.status, 400);
    assert.equal(((await unstagedInbound.json()) as { code?: string }).code, 'BOT_INVALID_REQUEST');

    const fileBytes = Buffer.from('channel-attachment');
    const fileSha = createHash('sha256').update(fileBytes).digest('hex');
    const channelFileUrl = hub.url + '/api/bot-channel/v1/files/' + fileSha;
    assert.equal((await fetch(channelFileUrl, { method: 'GET', headers: { authorization: 'Bearer ' + stored.token } })).status, 403);
    const subjectHeader = Buffer.from('ext-user-1', 'utf8').toString('base64url');
    assert.equal(
      (
        await fetch(channelFileUrl, {
          method: 'PUT',
          headers: {
            authorization: 'Bearer ' + stored.token,
            'circle-member-subject': subjectHeader,
            'content-length': String(fileBytes.length),
          },
          body: fileBytes,
        })
      ).status,
      403,
    );
    const putFile = await fetch(channelFileUrl, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
        'content-length': String(fileBytes.length),
      },
      body: fileBytes,
    });
    assert.equal(putFile.status, 200);
    assert.deepEqual(await putFile.json(), { sha256: fileSha, size: fileBytes.length });

    // H3: PUT went to channel-staging only, NOT into member files dir yet
    const memberHash = createHash('sha256').update(member.principal.id).digest('hex');
    const stagedPath = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', memberHash, fileSha);
    assert.equal((await stat(stagedPath)).isFile(), true);
    const getBeforeInbound = await fetch(hub.url + botFilesPath + fileSha, {
      headers: { authorization: 'Bearer ' + member.token },
    });
    assert.equal(getBeforeInbound.status, 404);

    // H3: Channel GET without Bot-Delivery-Receipt is forbidden
    const getNoReceipt = await fetch(channelFileUrl, {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
      },
    });
    assert.equal(getNoReceipt.status, 403);
    assert.equal(((await getNoReceipt.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

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

    // H3: Inbound verified & promoted staged file into member files and appended member-bot-inbound@1 declared record
    await assert.rejects(stat(stagedPath));
    const getByMember = await fetch(hub.url + botFilesPath + fileSha, {
      headers: { authorization: 'Bearer ' + member.token },
    });
    assert.equal(getByMember.status, 200);
    assert.equal(await getByMember.text(), 'channel-attachment');
    const inboundRecord = await hub.records.store.getByKey('action', 'chat-inbound:' + op1.request);
    assert.equal(inboundRecord?.schema, 'member-bot-inbound@1');
    assert.equal(inboundRecord?.provenance, 'declared');
    assert.ok(!JSON.stringify(inboundRecord?.body).includes('note.txt'));
    assert.ok(!JSON.stringify(inboundRecord?.body).includes('你好'));

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
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'not_dispatched');

    // H3: Channel GET before intent exists for receiptGood is refused
    const getUnintended = await fetch(channelFileUrl, {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
        'bot-delivery-receipt': receiptGood,
      },
    });
    assert.equal(getUnintended.status, 403);

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
    const nextJson = (await nextRes.json()) as {
      delivery: {
        text: string;
        receipt: string;
        role: string;
        sha256: string;
        size: number;
        intent: {
          sha256: string;
          size: number;
          text_sha256: string | null;
          text_size: number;
          file_sha256: string | null;
          file_size: number | null;
          name_sha256: string | null;
        };
      };
    };
    assert.equal(nextJson.delivery.text, '已同步结果');
    assert.equal(nextJson.delivery.role, 'user');
    assert.equal(nextJson.delivery.receipt, receiptGood);
    assert.equal(nextJson.delivery.intent.text_sha256, createHash('sha256').update('已同步结果').digest('hex'));
    assert.equal(nextJson.delivery.intent.text_size, Buffer.byteLength('已同步结果'));
    assert.equal(nextJson.delivery.intent.file_sha256, fileSha);
    assert.equal(nextJson.delivery.intent.file_size, fileBytes.length);
    assert.equal(nextJson.delivery.sha256, nextJson.delivery.intent.sha256);
    assert.equal(nextJson.delivery.size, nextJson.delivery.intent.text_size + fileBytes.length);

    const intentRecord = await hub.records.store.getByKey('action', 'chat-intent:' + receiptGood);
    assert.equal(intentRecord?.schema, 'member-notification-intent@1');

    // H3: Now channel GET with matching intent, member, and receipt succeeds; wrong sha or wrong member fails
    const getByChannel = await fetch(channelFileUrl, {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
        'bot-delivery-receipt': receiptGood,
      },
    });
    assert.equal(getByChannel.status, 200);
    assert.equal(await getByChannel.text(), 'channel-attachment');

    const getWrongSha = await fetch(hub.url + '/api/bot-channel/v1/files/' + '9'.repeat(64), {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
        'bot-delivery-receipt': receiptGood,
      },
    });
    assert.equal(getWrongSha.status, 403);
    const getWrongShaJson = await getWrongSha.json();
    const getMissingIntentFile = await fetch(channelFileUrl, {
      headers: {
        authorization: 'Bearer ' + stored.token,
        'bot-member-subject': subjectHeader,
        'bot-delivery-receipt': '00000000-0000-4000-8000-000000000000',
      },
    });
    assert.equal(getMissingIntentFile.status, 403);
    assert.deepEqual(await getMissingIntentFile.json(), getWrongShaJson);

    const replayNext = await postChannel(stored.token, { action: 'next' });
    assert.deepEqual(await replayNext.json(), { delivery: null });

    // H12: Existing vs nonexistent receipt cross-member/channel error responses are indistinguishable
    const otherReceipt = '44444444-4444-4444-8444-444444444444';
    const missingReceiptRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: otherReceipt,
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(missingReceiptRes.status, 404);
    const missingReceiptJson = (await missingReceiptRes.json()) as { code?: string; message?: string };
    assert.equal(missingReceiptJson.code, 'BOT_NOT_FOUND');

    // Insert intent belonging to a different channel and check indistinguishable 404 payload
    await hub.records.store.put({
      kind: 'action',
      schema: 'member-notification-intent@1',
      provenance: 'declared',
      unique_key: 'chat-intent:99999999-9999-4999-8999-999999999999',
      body: {
        ...(intentRecord!.body as Record<string, unknown>),
        receipt: '99999999-9999-4999-8999-999999999999',
        channel: 'f'.repeat(64),
      },
    });
    const crossChannelReceiptRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: '99999999-9999-4999-8999-999999999999',
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(crossChannelReceiptRes.status, 404);
    assert.deepEqual(await crossChannelReceiptRes.json(), missingReceiptJson);

    // H4: Aggregate delivery intent digest covers text as well as attachment
    const altTextReceipt = '12121212-1212-4121-8121-121212121212';
    nextDelivery = {
      id: '34343434-3434-4343-8343-343434343434',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: altTextReceipt,
      role: 'assistant',
      text: '另一段文本',
      file: { sha256: fileSha, size: fileBytes.length, name: 'note.txt' },
    };
    const altNext = await postChannel(stored.token, { action: 'next' });
    assert.equal(altNext.status, 200);
    const altJson = (await altNext.json()) as { delivery: { sha256: string; intent: { text_sha256: string } } };
    assert.notEqual(altJson.delivery.sha256, nextJson.delivery.sha256);
    assert.notEqual(altJson.delivery.intent.text_sha256, nextJson.delivery.intent.text_sha256);

    // H4: Legacy state strings rejected cleanly
    const legacyStateRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'sent',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(legacyStateRes.status, 400);
    assert.equal(((await legacyStateRes.json()) as { code?: string }).code, 'BOT_INVALID_REQUEST');

    // H4: Degraded unknown receipt uses provenance declared + non-empty missing[] & next, then can be confirmed with supersedes
    const badAckRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'issued',
      acknowledgment: { request: fileSha, code: 42 },
      reached_target: false,
    });
    assert.equal(badAckRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'unknown');
    const receiptDegraded = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptGood);
    assert.equal(receiptDegraded?.provenance, 'declared');
    const degradedBody = receiptDegraded?.body as { outcome?: string; missing?: string[]; next?: string };
    assert.equal(degradedBody.outcome, 'unknown');
    assert.ok(Array.isArray(degradedBody.missing) && degradedBody.missing.length > 0);
    assert.ok(typeof degradedBody.next === 'string' && degradedBody.next.length > 0);

    const confirmedRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(confirmedRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'issued');
    const receiptConfirmed = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptGood + ':confirmed');
    assert.equal(receiptConfirmed?.provenance, 'declared');
    assert.equal((receiptConfirmed?.body as { outcome?: string; supersedes?: string }).outcome, 'issued');
    assert.equal((receiptConfirmed?.body as { supersedes?: string }).supersedes, receiptDegraded?.digest);

    // Idempotent retry on terminal receipt -> 200; conflicting update -> 409 BOT_CONFLICT
    const idempotentRetry = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(idempotentRetry.status, 200);
    const conflictRetry = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptGood,
      state: 'target_rejected',
      acknowledgment: { request: fileSha, code: 99 },
      reached_target: true,
    });
    assert.equal(conflictRetry.status, 409);
    assert.equal(((await conflictRetry.json()) as { code?: string }).code, 'BOT_CONFLICT');

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
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(issuedRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'issued');
    const receiptIssued = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptIssuedId);
    assert.equal((receiptIssued?.body as { outcome?: string }).outcome, 'issued');
    assert.equal(receiptIssued?.provenance, 'declared');

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
      state: 'target_rejected',
      reached_target: false,
    });
    assert.equal(refusedNoAckRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'unknown');
    const receiptRefusedNoAck = await hub.records.store.getByKey('effect', 'chat-receipt:' + receiptRefusedNoAckId);
    assert.equal((receiptRefusedNoAck?.body as { outcome?: string }).outcome, 'unknown');

    // H4: Valid target_rejected supersedes prior unknown, and valid not_dispatched records properly
    const rejectedConfirm = await postChannel(stored.token, {
      action: 'receipt',
      receipt: receiptRefusedNoAckId,
      state: 'target_rejected',
      acknowledgment: { request: fileSha, code: 4001 },
      reached_target: true,
    });
    assert.equal(rejectedConfirm.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'target_rejected');
    const confirmedRejected = await hub.records.store.getByKey(
      'effect',
      'chat-receipt:' + receiptRefusedNoAckId + ':confirmed',
    );
    assert.equal((confirmedRejected?.body as { outcome?: string }).outcome, 'target_rejected');
    assert.equal((confirmedRejected?.body as { supersedes?: string }).supersedes, receiptRefusedNoAck?.digest);

    const notDispatchedReceiptId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    nextDelivery = {
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: notDispatchedReceiptId,
      role: 'assistant',
      text: '未发送',
    };
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 200);
    const notDispatchedRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: notDispatchedReceiptId,
      state: 'not_dispatched',
      reached_target: false,
    });
    assert.equal(notDispatchedRes.status, 200);
    assert.equal((hostCalls.at(-1)!.op as { state?: string }).state, 'not_dispatched');
    const notDispatchedRec = await hub.records.store.getByKey('effect', 'chat-receipt:' + notDispatchedReceiptId);
    assert.equal(notDispatchedRec?.provenance, 'declared');
    assert.equal((notDispatchedRec?.body as { outcome?: string; reached_target?: boolean }).outcome, 'not_dispatched');
    assert.equal((notDispatchedRec?.body as { reached_target?: boolean }).reached_target, false);

    // H4: Missing item.file on disk notifies host state='not_dispatched' BEFORE returning 409 BOT_CONFLICT
    const missingFileReceipt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    nextDelivery = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: missingFileReceipt,
      role: 'assistant',
      text: '附件遗失',
      file: { sha256: 'e'.repeat(64), size: 42, name: 'missing.bin' },
    };
    const missingFileNext = await postChannel(stored.token, { action: 'next' });
    assert.equal(missingFileNext.status, 409);
    assert.equal(((await missingFileNext.json()) as { code?: string }).code, 'BOT_CONFLICT');
    assert.deepEqual(hostCalls.at(-1)!.op, { action: 'receipt', receipt: missingFileReceipt, state: 'not_dispatched' });

    // H13: Malformed delivery from host logs no raw text/file name
    const secretPayloadText = 'CONFIDENTIAL_RAW_DELIVERY_TEXT_123';
    const secretFileName = 'CONFIDENTIAL_FILE_NAME_456.txt';
    nextDelivery = {
      id: 'not-a-uuid',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      role: 'assistant',
      text: secretPayloadText,
      file: { sha256: fileSha, size: fileBytes.length, name: secretFileName },
    };
    const malformedNext = await postChannel(stored.token, { action: 'next' });
    assert.equal(malformedNext.status, 502);
    assert.ok(!hub.logs.join('\n').includes(secretPayloadText));
    assert.ok(!hub.logs.join('\n').includes(secretFileName));

    // R10 + R11: notice delivery role + optional code forwarding without altering computeIntentPayload, and config sync on claim/receipt
    const noticeReceipt = '13131313-1313-4131-8131-131313131313';
    nextDelivery = {
      id: '24242424-2424-4242-8242-242424242424',
      owner: member.principal.id,
      subject: 'ext-user-1',
      receipt: noticeReceipt,
      role: 'notice',
      code: 'new_conversation',
      text: '内部提示文本',
    };
    const noticeNext = await postChannel(stored.token, { action: 'next' });
    assert.equal(noticeNext.status, 200);
    const noticeBody = (await noticeNext.json()) as {
      delivery?: {
        role?: string;
        code?: string;
        text?: string;
        sha256?: string;
        intent?: { sha256?: string; text_sha256?: string; file_sha256?: string | null };
      };
    };
    assert.equal(noticeBody.delivery?.role, 'notice');
    assert.equal(noticeBody.delivery?.code, 'new_conversation');
    assert.equal(noticeBody.delivery?.text, '内部提示文本');
    const noticeTextSha = createHash('sha256').update(Buffer.from('内部提示文本', 'utf8')).digest('hex');
    const expectedNoticeDigest = createHash('sha256')
      .update(
        JSON.stringify({
          file_sha256: null,
          file_size: null,
          name_sha256: null,
          text_sha256: noticeTextSha,
          text_size: Buffer.byteLength('内部提示文本', 'utf8'),
        }),
      )
      .digest('hex');
    assert.equal(noticeBody.delivery?.sha256, expectedNoticeDigest);
    assert.equal(noticeBody.delivery?.intent?.sha256, expectedNoticeDigest);
    assert.equal((hostCalls.at(-1)?.config as { key?: string } | undefined)?.key, 'synthetic-key');

    await disableBot(hub.records.vault);
    nextDelivery = null;
    assert.equal((await postChannel(stored.token, { action: 'next' })).status, 200);
    assert.equal(hostCalls.at(-1)?.config, null);
    const noticeReceiptRes = await postChannel(stored.token, {
      action: 'receipt',
      receipt: noticeReceipt,
      state: 'issued',
      acknowledgment: { request: fileSha, code: 0 },
      reached_target: true,
    });
    assert.equal(noticeReceiptRes.status, 200);
    assert.equal(hostCalls.at(-1)?.config, null);

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

test(
  'R3 + S6: inbound staging promotion survives transient store.put failure and heals partial commits; concurrent { unknown, issued } receipts serialize cleanly',
  { timeout: 30_000 },
  async (t) => {
    const hub = await createTestServer();
    const folder = join(hub.deps.config.dataDir, 'bot-runtime');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const hostReceiptStates: string[] = [];
    const host = await listenUnixSocket(join(folder, 'host.sock'), (body) => {
      const op = body.op as { action?: string; state?: string } | undefined;
      if (op?.action === 'receipt') {
        hostReceiptStates.push(String(op.state ?? ''));
        return { body: { ok: true } };
      }
      return { body: { accepted: true } };
    });

    try {
      const member = await hub.createUser('事务重试成员');
      const stored = newChannel({ bot: 'bot-r3-s6', secret: 'chan-sec-r3', hub: hub.url + '/' });
      await hub.records.vault.put(channelProfileName, JSON.stringify({ ...stored, enabled: true }));
      const identity = { tenant: 'tenant-r3', application: 'app-r3', secret: 'app-sec-r3' };
      await hub.records.vault.put(identityProfileName, JSON.stringify(identity));
      await setBotProfile(hub.records.vault, {
        name: '重试机器人',
        protocol: 'openai',
        endpoint: 'https://model.example.invalid/v1',
        model: 'demo',
        key: 'retry-key',
      });
      const issuer = identityIssuer(identity.tenant);
      await hub.records.principals.bindExternalIdentity(member.principal, issuer, 'ext-r3');

      const postChannel = (body: unknown) =>
        fetch(hub.url + '/api/bot-channel/v1', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + stored.token, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

      const stagedBytes = Buffer.from('staged-attachment-for-r3');
      const stagedSha = createHash('sha256').update(stagedBytes).digest('hex');
      const subjectHeader = Buffer.from('ext-r3', 'utf8').toString('base64url');
      const putRes = await fetch(hub.url + '/api/bot-channel/v1/files/' + stagedSha, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + stored.token,
          'bot-member-subject': subjectHeader,
          'content-length': String(stagedBytes.length),
        },
        body: stagedBytes,
      });
      assert.equal(putRes.status, 200);

      const memberHash = createHash('sha256').update(member.principal.id).digest('hex');
      const stagedPath = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', memberHash, stagedSha);
      const filesPath = join(hub.deps.config.dataDir, 'bot-runtime', 'files', memberHash, stagedSha);

      // R3 part 1: transient store.put failure leaves staged file intact and writes 0 records; retry succeeds cleanly with 1 record
      const originalPut = hub.deps.records.store.put.bind(hub.deps.records.store);
      let failInboundPut = true;
      hub.deps.records.store.put = (async (input, tx) => {
        if (failInboundPut && input.schema === 'member-bot-inbound@1') {
          failInboundPut = false;
          throw new Error('transient store.put failure');
        }
        return originalPut(input, tx);
      }) as typeof hub.deps.records.store.put;

      const r3Payload = {
        action: 'inbound',
        subject: 'ext-r3',
        platformId: 'msg-r3-1',
        text: '测试入站恢复',
        files: [{ sha256: stagedSha, size: stagedBytes.length, name: 'r3.txt' }],
      };
      const failedAttempt = await postChannel(r3Payload);
      assert.equal(failedAttempt.status, 500);
      assert.equal(((await failedAttempt.json()) as { code?: string }).code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.equal((await stat(stagedPath)).isFile(), true, 'staged copy must NOT be deleted when store.put fails');
      await assert.rejects(stat(filesPath));

      const retryAttempt = await postChannel(r3Payload);
      assert.equal(retryAttempt.status, 200);
      assert.deepEqual(await retryAttempt.json(), { accepted: true });
      await assert.rejects(stat(stagedPath));
      assert.equal((await stat(filesPath)).isFile(), true);

      // R3 part 2: simulate existingInbound already persisted while staged file was NOT yet moved out of channel-staging
      const stagedBytes2 = Buffer.from('staged-attachment-for-r3-heal');
      const stagedSha2 = createHash('sha256').update(stagedBytes2).digest('hex');
      const putRes2 = await fetch(hub.url + '/api/bot-channel/v1/files/' + stagedSha2, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + stored.token,
          'bot-member-subject': subjectHeader,
          'content-length': String(stagedBytes2.length),
        },
        body: stagedBytes2,
      });
      assert.equal(putRes2.status, 200);

      // Compute same deterministic request key for msg-r3-heal and pre-insert record without moving staged file
      const reqHash = createHash('sha256').update(JSON.stringify([issuer, stored.bot, 'ext-r3', 'msg-r3-heal'])).digest();
      reqHash[6] = (reqHash[6] & 15) | 0x80;
      reqHash[8] = (reqHash[8] & 63) | 0x80;
      const hex = reqHash.subarray(0, 16).toString('hex');
      const healReqId = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
      const healChannelId = createHash('sha256').update(JSON.stringify([issuer, stored.bot])).digest('hex');
      await originalPut({
        kind: 'action',
        schema: 'member-bot-inbound@1',
        provenance: 'declared',
        unique_key: 'chat-inbound:' + healReqId,
        index: [{ key: 'chat.inbound.owner', value: member.principal.id }],
        body: {
          schema: 'member-bot-inbound@1',
          kind: 'dispatch',
          request: healReqId,
          member: member.principal.id,
          issuer,
          subject: createHash('sha256').update(JSON.stringify([issuer, 'ext-r3'])).digest('hex'),
          channel: healChannelId,
          platform_id_sha256: createHash('sha256').update(JSON.stringify([issuer, 'msg-r3-heal'])).digest('hex'),
          text_sha256: createHash('sha256').update(Buffer.from('heal text', 'utf8')).digest('hex'),
          text_size: Buffer.byteLength('heal text', 'utf8'),
          files: [{ sha256: stagedSha2, size: stagedBytes2.length, name_sha256: createHash('sha256').update('heal.txt').digest('hex') }],
          at: new Date().toISOString(),
        },
      });
      const stagedPath2 = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', memberHash, stagedSha2);
      const filesPath2 = join(hub.deps.config.dataDir, 'bot-runtime', 'files', memberHash, stagedSha2);
      assert.equal((await stat(stagedPath2)).isFile(), true);
      const healRetry = await postChannel({
        action: 'inbound',
        subject: 'ext-r3',
        platformId: 'msg-r3-heal',
        text: 'heal text',
        files: [{ sha256: stagedSha2, size: stagedBytes2.length, name: 'heal.txt' }],
      });
      assert.equal(healRetry.status, 200);
      await assert.rejects(stat(stagedPath2));
      assert.equal((await stat(filesPath2)).isFile(), true);

      // S6: concurrent { unknown, issued } receipt pair serializes deterministically inside withTransaction + store.lock without spurious 409s
      const s6Receipt = 'eeeeeeee-1111-4111-8111-111111111111';
      await originalPut({
        kind: 'action',
        schema: 'member-notification-intent@1',
        provenance: 'declared',
        unique_key: 'chat-intent:' + s6Receipt,
        index: [{ key: 'chat.notification.owner', value: member.principal.id }],
        body: {
          schema: 'member-notification-intent@1',
          kind: 'dispatch',
          event: 'ffffffff-1111-4111-8111-111111111111',
          receipt: s6Receipt,
          member: member.principal.id,
          issuer,
          channel: healChannelId,
          subject: createHash('sha256').update(JSON.stringify([issuer, 'ext-r3'])).digest('hex'),
          sha256: stagedSha,
          size: 4,
          text_sha256: createHash('sha256').update('ping').digest('hex'),
          text_size: 4,
          file_sha256: null,
          file_size: null,
          name_sha256: null,
          write: {
            interaction: 'submit_then_read',
            effect_class: 'notification',
            retry_safety: 'unsafe',
            signing: 'service_on_behalf',
            reversible: false,
            target_key: createHash('sha256').update(JSON.stringify([issuer, 'ext-r3'])).digest('hex'),
            audience: member.principal.id,
            evidence: { call: 'receipt', pointer: '/acknowledgment/code' },
            refusal: { stage: '/state', reached_device: '/reached_target' },
            writes_hub_records: true,
          },
        },
      });

      const originalLock = hub.deps.records.store.lock.bind(hub.deps.records.store);
      let firstLocked = false;
      let receiptLocked = false;
      const firstEntered = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      t.after(() => releaseFirst.resolve());
      hub.deps.records.store.lock = (async (key, tx) => {
        await originalLock(key, tx);
        if (key === 'chat-receipt:' + s6Receipt && !firstLocked) {
          firstLocked = true;
          receiptLocked = true;
          firstEntered.resolve();
          await releaseFirst.promise;
        }
      }) as typeof hub.deps.records.store.lock;

      try {
        const unknownPromise = postChannel({
          action: 'receipt',
          receipt: s6Receipt,
          state: 'unknown',
          reached_target: null,
        });
        await Promise.race([unknownPromise, firstEntered.promise]);
        assert.equal(receiptLocked, true, 'handleChannelReceipt must acquire transaction advisory lock for receipt key');
        const issuedPromise = postChannel({
          action: 'receipt',
          receipt: s6Receipt,
          state: 'issued',
          acknowledgment: { request: stagedSha, code: 0 },
          reached_target: true,
        });
        // Give issued request time to reach and block on pg advisory lock while unknown holds tx
        await new Promise((r) => setTimeout(r, 30));
        releaseFirst.resolve();

        const [rUnknown, rIssued] = await Promise.all([unknownPromise, issuedPromise]);
        assert.equal(rUnknown.status, 200);
        assert.equal(rIssued.status, 200);
        const finalConfirmed = await hub.records.store.getByKey('effect', 'chat-receipt:' + s6Receipt + ':confirmed');
        assert.equal((finalConfirmed?.body as { outcome?: string }).outcome, 'issued');

        const lateUnknown = await postChannel({
          action: 'receipt',
          receipt: s6Receipt,
          state: 'unknown',
          reached_target: null,
        });
        assert.equal(lateUnknown.status, 200);
        assert.equal(hostReceiptStates.at(-1), 'issued');
      } finally {
        releaseFirst.resolve();
      }
    } finally {
      await host.close();
      await hub.close();
    }
  },
);
