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
    assert.equal(tooLarge.json.code, 'BOT_INVALID_REQUEST');

    // H10b: body > declared content-length -> 413 BOT_INVALID_REQUEST; short body < declared -> 422 BOT_INVALID_REQUEST
    const makeStreamReq = (declared: number, bodyBytes: Buffer) => {
      const req = Object.assign(new EventEmitter(), {
        method: 'PUT',
        headers: { 'content-length': String(declared) },
        async *[Symbol.asyncIterator]() {
          yield bodyBytes;
        },
        resume() {},
      }) as unknown as IncomingMessage;
      let status = 0;
      let sent = false;
      let ended = false;
      let body = '';
      const res = {
        get headersSent() {
          return sent;
        },
        get writableEnded() {
          return ended;
        },
        destroyed: false,
        setHeader() {},
        writeHead(code: number) {
          status = code;
          sent = true;
        },
        end(chunk?: string | Buffer) {
          body = chunk ? String(chunk) : '';
          ended = true;
        },
      } as unknown as ServerResponse;
      return { req, res, result: () => ({ status, json: body ? JSON.parse(body) : null }) };
    };

    const overDeclared = makeStreamReq(4, Buffer.from('0123456789'));
    await botFiles.transferBotFile(
      overDeclared.req,
      overDeclared.res,
      hub.deps.config.dataDir,
      user.principal.id,
      '3'.repeat(64),
      async () => true,
    );
    assert.equal(overDeclared.result().status, 413);
    assert.equal(overDeclared.result().json.code, 'BOT_INVALID_REQUEST');

    const shortPayload = Buffer.from('short');
    const shortSha = createHash('sha256').update(shortPayload).digest('hex');
    const shortPut = makeStreamReq(20, shortPayload);
    await botFiles.transferBotFile(
      shortPut.req,
      shortPut.res,
      hub.deps.config.dataDir,
      user.principal.id,
      shortSha,
      async () => true,
    );
    assert.equal(shortPut.result().status, 422);
    assert.equal(shortPut.result().json.code, 'BOT_INVALID_REQUEST');

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
    assert.equal(((await tamperedGet.json()) as { code?: string }).code, 'BOT_NOT_FOUND');
  } finally {
    await hub.close();
  }
});

test(
  'bot-files exports quota/retention constants, prunes/rejects expired files, refreshes mtime on re-upload, and cleans only stale temp files',
  { timeout: 30_000 },
  async () => {
    const exported = botFiles as unknown as {
      MAX_MEMBER_BOT_BYTES?: number;
      MAX_MEMBER_BOT_FILES?: number;
      BOT_FILE_RETENTION_MS?: number;
      cleanupBotRuntimeTempFiles?: (dataDir: string, options?: { maxAgeMs?: number; now?: number }) => Promise<void>;
      pruneExpiredBotFiles?: (dataDir: string, options?: { now?: number; retentionMs?: number }) => Promise<void>;
      handleBotFile: (req: IncomingMessage, res: ServerResponse, deps: unknown, sha: string) => Promise<void>;
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
    assert.equal(typeof exported.pruneExpiredBotFiles, 'function');

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
      let firstSha = '';
      for (let i = 0; i < 256; i += batchSize) {
        await Promise.all(
          Array.from({ length: batchSize }, (_, j) => putAt(Buffer.from(`f-${i + j}`))).map(async (p, idx) => {
            const { res, sha } = await p;
            assert.equal(res.status, 200);
            if (i === 0 && idx === 0) firstSha = sha;
          }),
        );
      }

      const overflowCount = await putAt(Buffer.from('file-257'));
      assert.equal(overflowCount.res.status, 413);
      assert.equal(((await overflowCount.res.json()) as { code?: string }).code, 'BOT_QUOTA_EXCEEDED');

      // S4: Re-uploading an existing file while at 256/256 quota refreshes its mtime instead of overflowing quota
      clock += Math.floor(exported.BOT_FILE_RETENTION_MS! / 2);
      const refreshExisting = await putAt(Buffer.from('f-0'));
      assert.equal(refreshExisting.res.status, 200);

      // Advance past original expiry of f-1..f-255, while refreshed f-0 is still unexpired!
      clock += Math.floor(exported.BOT_FILE_RETENTION_MS! / 2) + 1000;
      const expiredGet = await fetch(hub.url + botFilesPath + createHash('sha256').update('f-1').digest('hex'), {
        headers: { authorization: 'Bearer ' + user.token },
      });
      assert.equal(expiredGet.status, 404);
      assert.equal(((await expiredGet.json()) as { code?: string }).code, 'BOT_NOT_FOUND');

      const refreshedGet = await fetch(hub.url + botFilesPath + firstSha, {
        headers: { authorization: 'Bearer ' + user.token },
      });
      assert.equal(refreshedGet.status, 200);
      assert.equal(await refreshedGet.text(), 'f-0');

      const afterExpiry = await putAt(Buffer.from('after-retention-prune'));
      assert.equal(afterExpiry.res.status, 200);
      const remainingFiles = await readdir(ownerFolder(hub.deps.config.dataDir, user.principal.id));
      assert.deepEqual(remainingFiles.sort(), [firstSha, afterExpiry.sha].sort());

      // S4: pruneExpiredBotFiles removes expired files directly
      const ownerDir = ownerFolder(hub.deps.config.dataDir, user.principal.id);
      const oldDate = new Date(clock - exported.BOT_FILE_RETENTION_MS! - 1000);
      await utimes(join(ownerDir, firstSha), oldDate, oldDate);
      await exported.pruneExpiredBotFiles!(hub.deps.config.dataDir, { now: clock });
      assert.deepEqual(await readdir(ownerDir), [afterExpiry.sha]);

      const byteReq = (payload: Buffer) => {
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
      const c1 = byteReq(bigBytePayload);
      await exported.transferBotFile(c1.req, c1.res, hub.deps.config.dataDir, user.principal.id, bigSha, async () => true, {
        now: () => clock,
        maxMemberBytes: 1024,
      });
      assert.equal(c1.result().status, 200);

      const secondBig = Buffer.alloc(500, 66);
      const secondSha = createHash('sha256').update(secondBig).digest('hex');
      const c2 = byteReq(secondBig);
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

      // S3: cleanupBotRuntimeTempFiles defaults to 15m age for both .part and channel-staging/*
      const stalePart = join(ownerDir, 'stale.part');
      const freshPart = join(ownerDir, 'fresh.part');
      await writeFile(stalePart, Buffer.from('leftover-part'));
      await writeFile(freshPart, Buffer.from('active-part'));
      await utimes(stalePart, new Date(clock - 16 * 60 * 1000), new Date(clock - 16 * 60 * 1000));
      await utimes(freshPart, new Date(clock - 60 * 1000), new Date(clock - 60 * 1000));

      const stagingDir = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', 'deadbeef');
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      const stagedLeftover = join(stagingDir, 'a'.repeat(64));
      const stagedFresh = join(stagingDir, 'b'.repeat(64));
      await writeFile(stagedLeftover, Buffer.from('leftover-staged'));
      await writeFile(stagedFresh, Buffer.from('fresh-staged'));
      await utimes(stagedLeftover, new Date(clock - 16 * 60 * 1000), new Date(clock - 16 * 60 * 1000));
      await utimes(stagedFresh, new Date(clock - 60 * 1000), new Date(clock - 60 * 1000));

      await exported.cleanupBotRuntimeTempFiles!(hub.deps.config.dataDir, { now: clock });
      await assert.rejects(stat(stalePart));
      await assert.rejects(stat(stagedLeftover));
      assert.equal((await readFile(freshPart)).toString(), 'active-part');
      assert.equal((await readFile(stagedFresh)).toString(), 'fresh-staged');
      assert.equal((await readFile(join(ownerDir, afterExpiry.sha))).toString(), 'after-retention-prune');

      // S11: handleBotFile checks vault.has('personal-bot.model') without calling vault.get(...)
      let hasCalls = 0;
      let getCalls = 0;
      const spyDeps = {
        ...hub.deps,
        records: {
          ...hub.deps.records,
          vault: {
            ...hub.deps.records.vault,
            has: async (key: string) => {
              if (key === 'personal-bot.model') hasCalls += 1;
              return false;
            },
            get: async (key: string) => {
              if (key === 'personal-bot.model') getCalls += 1;
              return null;
            },
          },
        },
      };
      const spyReq = Object.assign(new EventEmitter(), {
        method: 'GET',
        headers: { authorization: 'Bearer ' + user.token },
        resume() {},
      }) as unknown as IncomingMessage;
      let spyStatus = 0;
      let spyBody = '';
      let spySent = false;
      let spyEnded = false;
      const spyRes = {
        get headersSent() {
          return spySent;
        },
        get writableEnded() {
          return spyEnded;
        },
        destroyed: false,
        setHeader() {},
        writeHead(code: number) {
          spyStatus = code;
          spySent = true;
        },
        end(chunk?: string | Buffer) {
          spyBody = chunk ? String(chunk) : '';
          spyEnded = true;
        },
      } as unknown as ServerResponse;
      await exported.handleBotFile(spyReq, spyRes, spyDeps, afterExpiry.sha);
      assert.equal(spyStatus, 503);
      assert.equal((JSON.parse(spyBody) as { code?: string }).code, 'BOT_DISABLED');
      assert.equal(hasCalls, 1);
      assert.equal(getCalls, 0);
    } finally {
      await hub.close();
    }
  },
);

test(
  'R5: barrier-gated concurrent PUT uploads and channel-staging promotions enforce quotas without over-committing or leaking inFlight reservations',
  { timeout: 30_000 },
  async (t) => {
    const hub = await createTestServer();
    try {
      await setBotProfile(hub.records.vault, sampleProfile);
      const user = await hub.createUser('并发配额成员');
      const nowMs = Date.UTC(2026, 10, 5, 0, 0, 0);

      const makeGatedReq = (payload: Buffer, options: { abortSecond?: boolean } = {}) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        t.after(() => release.resolve());
        const req = Object.assign(new EventEmitter(), {
          method: 'PUT',
          headers: { 'content-length': String(payload.length) },
          async *[Symbol.asyncIterator]() {
            yield payload.subarray(0, 10);
            entered.resolve();
            await release.promise;
            if (options.abortSecond) throw new Error('simulated client abort');
            yield payload.subarray(10);
          },
          resume() {},
        }) as unknown as IncomingMessage;
        let status = 0;
        let body = '';
        let sent = false;
        let ended = false;
        const res = {
          get headersSent() {
            return sent;
          },
          get writableEnded() {
            return ended;
          },
          destroyed: false,
          setHeader() {},
          writeHead(code: number) {
            status = code;
            sent = true;
          },
          end(chunk?: string | Buffer) {
            body = chunk ? String(chunk) : '';
            ended = true;
          },
        } as unknown as ServerResponse;
        return {
          req,
          res,
          entered: entered.promise,
          release: release.resolve,
          result: () => ({ status, json: body ? JSON.parse(body) : null }),
        };
      };

      const p1 = Buffer.alloc(600, 1);
      const sha1 = createHash('sha256').update(p1).digest('hex');
      const p2 = Buffer.alloc(600, 2);
      const sha2 = createHash('sha256').update(p2).digest('hex');

      // 1. Concurrent PUTs gated at barrier: first reserves 600/1024; second must immediately reject 413 BOT_QUOTA_EXCEEDED
      const firstAbort = makeGatedReq(p1, { abortSecond: true });
      const firstPromise = botFiles.transferBotFile(
        firstAbort.req,
        firstAbort.res,
        hub.deps.config.dataDir,
        user.principal.id,
        sha1,
        async () => true,
        { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
      );
      await firstAbort.entered;

      const secondWhileActive = makeGatedReq(p2);
      const secondUploadPromise = botFiles.transferBotFile(
        secondWhileActive.req,
        secondWhileActive.res,
        hub.deps.config.dataDir,
        user.principal.id,
        sha2,
        async () => true,
        { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
      );
      await Promise.race([secondUploadPromise, secondWhileActive.entered]);
      secondWhileActive.release();
      await secondUploadPromise;
      assert.equal(secondWhileActive.result().status, 413);
      assert.equal(secondWhileActive.result().json.code, 'BOT_QUOTA_EXCEEDED');

      // 2. Abort first upload -> inFlight reservation released -> retry upload of sha2 succeeds
      firstAbort.release();
      await assert.rejects(firstPromise);

      const thirdGated = makeGatedReq(p1);
      const thirdPromise = botFiles.transferBotFile(
        thirdGated.req,
        thirdGated.res,
        hub.deps.config.dataDir,
        user.principal.id,
        sha1,
        async () => true,
        { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
      );
      await thirdGated.entered;

      // 3. Barrier-gated file + staging concurrent quotas: stage p2 and verifyChannelStagedFiles must see inFlight from thirdPromise -> 413
      const ownerDirHash = createHash('sha256').update(user.principal.id).digest('hex');
      const stagingDir = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', ownerDirHash);
      await mkdir(stagingDir, { recursive: true, mode: 0o700 });
      await writeFile(join(stagingDir, sha2), p2);
      const stagedWhilePutActive = await botFiles.verifyChannelStagedFiles(
        hub.deps.config.dataDir,
        user.principal.id,
        [{ sha256: sha2, size: p2.length, name: 'staged.bin' }],
        { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
      );
      assert.equal(stagedWhilePutActive.ok, false);
      if (!stagedWhilePutActive.ok) {
        assert.equal(stagedWhilePutActive.status, 413);
        assert.equal(stagedWhilePutActive.code, 'BOT_QUOTA_EXCEEDED');
      }

      // Finish thirdPromise (600 bytes on disk, limit 1024), or test staging reservation blocking PUT
      thirdGated.release();
      await thirdPromise;
      assert.equal(thirdGated.result().status, 200);

      // Reverse direction: staging reserves 600 bytes for another member -> concurrent PUT 500 bytes hits 413 until staging releases
      const userB = await hub.createUser('并发暂存成员');
      const userBHash = createHash('sha256').update(userB.principal.id).digest('hex');
      const userBStaging = join(hub.deps.config.dataDir, 'bot-runtime', 'channel-staging', userBHash);
      await mkdir(userBStaging, { recursive: true, mode: 0o700 });
      await writeFile(join(userBStaging, sha2), p2);
      const stagedReserve = await botFiles.verifyChannelStagedFiles(
        hub.deps.config.dataDir,
        userB.principal.id,
        [{ sha256: sha2, size: p2.length, name: 'staged.bin' }],
        { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
      );
      assert.equal(stagedReserve.ok, true);
      if (stagedReserve.ok) {
        try {
          const putBlockedByStaging = makeGatedReq(Buffer.alloc(500, 3));
          const blockedSha = createHash('sha256').update(Buffer.alloc(500, 3)).digest('hex');
          const blockedPromise = botFiles.transferBotFile(
            putBlockedByStaging.req,
            putBlockedByStaging.res,
            hub.deps.config.dataDir,
            userB.principal.id,
            blockedSha,
            async () => true,
            { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
          );
          await Promise.race([blockedPromise, putBlockedByStaging.entered]);
          putBlockedByStaging.release();
          await blockedPromise;
          assert.equal(putBlockedByStaging.result().status, 413);
          assert.equal(putBlockedByStaging.result().json.code, 'BOT_QUOTA_EXCEEDED');

          await stagedReserve.release();
          const putAfterRelease = makeGatedReq(Buffer.alloc(500, 3));
          putAfterRelease.release();
          await botFiles.transferBotFile(
            putAfterRelease.req,
            putAfterRelease.res,
            hub.deps.config.dataDir,
            userB.principal.id,
            blockedSha,
            async () => true,
            { now: () => nowMs, maxMemberBytes: 1024, maxMemberFiles: 10 },
          );
          assert.equal(putAfterRelease.result().status, 200);
        } finally {
          await stagedReserve.release();
        }
      }
    } finally {
      await hub.close();
    }
  },
);
