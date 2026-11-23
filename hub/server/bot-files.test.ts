import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import * as botFiles from './bot-files.ts';
import { setBotProfile } from './personal-bot.ts';
import { createTestServer } from './testing.ts';

const { botFilesPath, fileLimit } = botFiles;
const sampleProfile = {
  name: '测试机器人',
  protocol: 'openai',
  endpoint: 'http://127.0.0.1:1234',
  model: 'demo',
  key: 'fixture-bot-secret',
};
const ownerFolder = (dataDir: string, ownerId: string) =>
  join(dataDir, 'bot-runtime', 'files', createHash('sha256').update(ownerId).digest('hex'));

test(
  'a 17 MiB attachment is streamed, rehashed, and readable only by its active owner',
  { timeout: 30000 },
  async () => {
    const hub = await createTestServer();
    try {
      await setBotProfile(hub.records.vault, sampleProfile);
      const a = await hub.createUser('附件甲');
      const b = await hub.createUser('附件乙');
      const size = 17 * 1024 * 1024;
      const chunk = Buffer.alloc(1024 * 1024, 65);
      const digest = createHash('sha256');
      for (let n = 0; n < 17; n++) digest.update(chunk);
      const sha = digest.digest('hex');
      const target = hub.url + botFilesPath + sha;
      const body = async function* () {
        for (let n = 0; n < 17; n++) yield chunk;
      };
      const opts = {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + a.token, 'content-length': String(size) },
        body: body(),
        duplex: 'half',
      } as unknown as RequestInit;
      const saved = await fetch(target, opts);
      assert.equal(saved.status, 200);
      assert.deepEqual(await saved.json(), { sha256: sha, size });
      assert.equal((await fetch(target, { headers: { authorization: 'Bearer ' + b.token } })).status, 404);
      const response = await fetch(target, { headers: { authorization: 'Bearer ' + a.token } });
      assert.equal(response.status, 200);
      const read = createHash('sha256');
      for await (const block of response.body!) read.update(block);
      assert.equal(read.digest('hex'), sha);
      assert.equal(
        (
          await fetch(hub.url + botFilesPath + '0'.repeat(64), {
            ...opts,
            body: Buffer.from('bad'),
            headers: { authorization: 'Bearer ' + a.token, 'content-length': '3' },
          })
        ).status,
        422,
      );
      await hub.records.principals.setDisabled(hub.admin.principal, a.principal.id, true);
      assert.equal((await fetch(target, { headers: { authorization: 'Bearer ' + a.token } })).status, 401);
    } finally {
      await hub.close();
    }
  },
);

test('bot-files returns 503 BOT_DISABLED when bot profile is absent or disabled, and rejects OAuth tokens with 403 BOT_CLIENT_FORBIDDEN while /mcp allows them', async () => {
  const hub = await createTestServer();
  try {
    const user = await hub.createUser('权限成员');
    const data = Buffer.from('hello');
    const sha = createHash('sha256').update(data).digest('hex');

    const getDisabled = await fetch(hub.url + botFilesPath + sha, {
      headers: { authorization: 'Bearer ' + user.token },
    });
    assert.equal(getDisabled.status, 503);
    assert.equal(((await getDisabled.json()) as { code?: string }).code, 'BOT_DISABLED');

    const putDisabled = await fetch(hub.url + botFilesPath + sha, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + user.token, 'content-length': String(data.length) },
      body: data,
    });
    assert.equal(putDisabled.status, 503);
    assert.equal(((await putDisabled.json()) as { code?: string }).code, 'BOT_DISABLED');

    await setBotProfile(hub.records.vault, sampleProfile);
    const client = await hub.records.principals.registerClient('mcp-oauth-client', ['http://127.0.0.1:43123/cb']);
    const oauthToken = (
      await hub.records.principals.issueToken(user.principal, user.principal.id, client.name, client.id)
    ).token;

    const putOAuth = await fetch(hub.url + botFilesPath + sha, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + oauthToken, 'content-length': String(data.length) },
      body: data,
    });
    assert.equal(putOAuth.status, 403);
    assert.equal(((await putOAuth.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

    const getOAuth = await fetch(hub.url + botFilesPath + sha, {
      headers: { authorization: 'Bearer ' + oauthToken },
    });
    assert.equal(getOAuth.status, 403);
    assert.equal(((await getOAuth.json()) as { code?: string }).code, 'BOT_CLIENT_FORBIDDEN');

    const mcpRes = await fetch(hub.mcpUrl, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + oauthToken,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    });
    assert.equal(mcpRes.status, 200);

    const localToolsRes = await fetch(hub.url + '/local-tools/nonexistent-pack@1.0.0/file.ts', {
      headers: { authorization: 'Bearer ' + oauthToken },
    });
    assert.equal(localToolsRes.status, 404);
  } finally {
    await hub.close();
  }
});

test('bot-files rejects oversized >100 MiB, mismatched digest with no .part left, tampered GET, and supports slow multi-chunk + concurrent identical uploads', async () => {
  const hub = await createTestServer();
  try {
    await setBotProfile(hub.records.vault, sampleProfile);
    const user = await hub.createUser('边界成员');

    const tooLarge = await new Promise<{ status: number; json: { code?: string } }>((resolve, reject) => {
      const req = httpRequest(
        hub.url + botFilesPath + '1'.repeat(64),
        {
          method: 'PUT',
          headers: { authorization: 'Bearer ' + user.token, 'content-length': String(fileLimit + 1) },
        },
        async (res) => {
          const buf: Buffer[] = [];
          for await (const c of res) buf.push(c);
          resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(buf).toString('utf8')) });
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.json.code, 'BOT_QUOTA_EXCEEDED');

    const wrongBody = Buffer.from('not-matching-digest');
    const wrongPut = await fetch(hub.url + botFilesPath + '2'.repeat(64), {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + user.token, 'content-length': String(wrongBody.length) },
      body: wrongBody,
    });
    assert.equal(wrongPut.status, 422);
    assert.equal(((await wrongPut.json()) as { code?: string }).code, 'BOT_INVALID_REQUEST');
    const entriesAfterBad = await readdir(ownerFolder(hub.deps.config.dataDir, user.principal.id));
    assert.deepEqual(entriesAfterBad, []);

    const chunks = [Buffer.from('chunk-one-'), Buffer.from('chunk-two-'), Buffer.from('chunk-three')];
    const combined = Buffer.concat(chunks);
    const sha = createHash('sha256').update(combined).digest('hex');
    let releaseSecondChunk!: () => void;
    const secondChunkGate = new Promise<void>((resolve) => {
      releaseSecondChunk = resolve;
    });
    const slowBody = async function* () {
      yield chunks[0];
      await secondChunkGate;
      yield chunks[1];
      yield chunks[2];
    };
    const uploadPromise = fetch(hub.url + botFilesPath + sha, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + user.token, 'content-length': String(combined.length) },
      body: slowBody(),
      duplex: 'half',
    } as unknown as RequestInit);
    setTimeout(() => releaseSecondChunk(), 15);
    const slowRes = await uploadPromise;
    assert.equal(slowRes.status, 200);

    const concurrentPayload = Buffer.from('concurrent-identical-content');
    const concurrentSha = createHash('sha256').update(concurrentPayload).digest('hex');
    const [r1, r2] = await Promise.all([
      fetch(hub.url + botFilesPath + concurrentSha, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + user.token, 'content-length': String(concurrentPayload.length) },
        body: concurrentPayload,
      }),
      fetch(hub.url + botFilesPath + concurrentSha, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + user.token, 'content-length': String(concurrentPayload.length) },
        body: concurrentPayload,
      }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const storedEntries = await readdir(ownerFolder(hub.deps.config.dataDir, user.principal.id));
    assert.equal(storedEntries.some((name) => name.endsWith('.part')), false);

    const storedPath = join(ownerFolder(hub.deps.config.dataDir, user.principal.id), sha);
    await writeFile(storedPath, Buffer.from('tampered-bytes-' + 'x'.repeat(combined.length)));
    const tamperedGet = await fetch(hub.url + botFilesPath + sha, {
      headers: { authorization: 'Bearer ' + user.token },
    });
    assert.equal(tamperedGet.status, 404);
    assert.equal(((await tamperedGet.json()) as { code?: string }).code, 'BOT_CONFLICT');
  } finally {
    await hub.close();
  }
});

test('bot-files exports quota/retention constants, prunes expired files before quota checks, and cleanupBotRuntimeTempFiles removes .part and stale staging files', async () => {
  const exported = botFiles as unknown as {
    MAX_MEMBER_BOT_BYTES?: number;
    MAX_MEMBER_BOT_FILES?: number;
    BOT_FILE_RETENTION_MS?: number;
    cleanupBotRuntimeTempFiles?: (dataDir: string) => Promise<void>;
    transferBotFile: (
      req: IncomingMessage,
      res: ServerResponse,
      root: string,
      owner: string,
      sha: string,
      stillActive: () => Promise<boolean>,
      options?: { now?: () => number; maxMemberBytes?: number; maxMemberFiles?: number },
    ) => Promise<void>;
  };
  assert.equal(exported.MAX_MEMBER_BOT_BYTES, 512 * 1024 * 1024);
  assert.equal(exported.MAX_MEMBER_BOT_FILES, 256);
  assert.equal(exported.BOT_FILE_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(typeof exported.cleanupBotRuntimeTempFiles, 'function');

  let clock = Date.UTC(2026, 10, 1, 0, 0, 0);
  const hub = await createTestServer({ now: () => new Date(clock) });
  try {
    await setBotProfile(hub.records.vault, sampleProfile);
    const user = await hub.createUser('配额成员');

    const putAt = async (payload: Buffer) => {
      const sha = createHash('sha256').update(payload).digest('hex');
      const res = await fetch(hub.url + botFilesPath + sha, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + user.token, 'content-length': String(payload.length) },
        body: new Uint8Array(payload),
      });
      return { res, sha };
    };

    const batchSize = 32;
    for (let i = 0; i < 256; i += batchSize) {
      await Promise.all(
        Array.from({ length: batchSize }, (_, j) => putAt(Buffer.from(`f-${i + j}`))).map(async (p) => {
          const { res } = await p;
          assert.equal(res.status, 200);
        }),
      );
    }

    const overflowCount = await putAt(Buffer.from('file-257'));
    assert.equal(overflowCount.res.status, 413);
    assert.equal(((await overflowCount.res.json()) as { code?: string }).code, 'BOT_QUOTA_EXCEEDED');

    clock += exported.BOT_FILE_RETENTION_MS! + 1000;
    const afterExpiry = await putAt(Buffer.from('after-retention-prune'));
    assert.equal(afterExpiry.res.status, 200);
    const remainingFiles = await readdir(ownerFolder(hub.deps.config.dataDir, user.principal.id));
    assert.deepEqual(remainingFiles, [afterExpiry.sha]);

    const byteReq = (payload: Buffer, sha: string) => {
      const req = Object.assign(new EventEmitter(), {
        method: 'PUT',
        headers: { 'content-length': String(payload.length) },
        async *[Symbol.asyncIterator]() {
          yield payload;
        },
        resume() {},
      }) as unknown as IncomingMessage;
      let status = 0;
      let sent = false;
      let body = '';
      const res = {
        get headersSent() {
          return sent;
        },
        setHeader() {},
        writeHead(code: number) {
          status = code;
          sent = true;
        },
        end(chunk?: string | Buffer) {
          body = chunk ? String(chunk) : '';
        },
      } as unknown as ServerResponse;
      return { req, res, result: () => ({ status, json: body ? JSON.parse(body) : null }) };
    };

    const bigBytePayload = Buffer.alloc(600, 65);
    const bigSha = createHash('sha256').update(bigBytePayload).digest('hex');
    const c1 = byteReq(bigBytePayload, bigSha);
    await exported.transferBotFile(c1.req, c1.res, hub.deps.config.dataDir, user.principal.id, bigSha, async () => true, {
      now: () => clock,
      maxMemberBytes: 1024,
    });
    assert.equal(c1.result().status, 200);

    const secondBig = Buffer.alloc(500, 66);
    const secondSha = createHash('sha256').update(secondBig).digest('hex');
    const c2 = byteReq(secondBig, secondSha);
    await exported.transferBotFile(
      c2.req,
      c2.res,
      hub.deps.config.dataDir,
      user.principal.id,
      secondSha,
      async () => true,
      { now: () => clock, maxMemberBytes: 1024 },
    );
    assert.equal(c2.result().status, 413);
    assert.equal(c2.result().json.code, 'BOT_QUOTA_EXCEEDED');

    const ownerDir = ownerFolder(hub.deps.config.dataDir, user.principal.id);
    const stalePart = join(ownerDir, 'stale.part');
    await writeFile(stalePart, Buffer.from('leftover-part'));
    const stagingDir = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', 'deadbeef');
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const stagedLeftover = join(stagingDir, 'a'.repeat(64));
    await writeFile(stagedLeftover, Buffer.from('leftover-staged'));
    await utimes(stagedLeftover, new Date(clock - 1000), new Date(clock - 1000));

    await exported.cleanupBotRuntimeTempFiles!(hub.deps.config.dataDir);
    await assert.rejects(stat(stalePart));
    await assert.rejects(stat(stagedLeftover));
    assert.equal((await readFile(join(ownerDir, afterExpiry.sha))).toString(), 'after-retention-prune');
  } finally {
    await hub.close();
  }
});
