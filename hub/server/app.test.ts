import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubConfig } from '../config/index.ts';
import { openTestRecords } from '../testing/records.ts';
import type { AppOptions } from './api.ts';
import {
  createApp,
  DEFAULT_BOT_FILE_UPLOAD_RECEIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_RECEIVE_TIMEOUT_MS,
} from './app.ts';
import { BOT_FILE_RETENTION_MS, botFilesPath } from './bot-files.ts';
import { channelProfileName, newChannel, setBotProfile } from './personal-bot.ts';
import { fakeDeps } from './testing.ts';

test(
  'app startup creates 0700 bot-runtime, cleans stale temp/expired files while preserving fresh ones, deduplicates and masks syncChannel failures, and enforces receive-only timeouts',
  { timeout: 30_000 },
  async () => {
    assert.equal(DEFAULT_REQUEST_RECEIVE_TIMEOUT_MS, 120_000);
    assert.equal(DEFAULT_BOT_FILE_UPLOAD_RECEIVE_TIMEOUT_MS, 15 * 60 * 1000);

    const records = await openTestRecords();
    const logs: string[] = [];
    const config: HubConfig = {
      dataDir: records.dataDir,
      logDir: join(records.dataDir, 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: records.database,
      limits: { ...records.config.limits },
    };
    const { deps } = fakeDeps(config, records);

    const memberHash = createHash('sha256').update('usr_test').digest('hex');
    const filesDir = join(records.dataDir, 'bot-runtime', 'files', memberHash);
    const stagingDir = join(records.dataDir, 'bot-runtime', 'channel-staging', memberHash);
    await mkdir(filesDir, { mode: 0o700, recursive: true });
    await mkdir(stagingDir, { mode: 0o700, recursive: true });
    const now = Date.now();
    const staleDate = new Date(now - 16 * 60 * 1000);
    const expiredDate = new Date(now - BOT_FILE_RETENTION_MS - 60_000);

    const validSha = createHash('sha256').update('valid-file').digest('hex');
    const validPath = join(filesDir, validSha);
    const expiredSha = createHash('sha256').update('expired-file').digest('hex');
    const expiredPath = join(filesDir, expiredSha);
    const stalePartPath = join(filesDir, 'orphan.part');
    const freshPartPath = join(filesDir, 'active.part');
    const staleStagedPath = join(stagingDir, 'a'.repeat(64));
    const freshStagedPath = join(stagingDir, 'b'.repeat(64));

    await writeFile(validPath, 'valid-file');
    await writeFile(expiredPath, 'expired-file');
    await utimes(expiredPath, expiredDate, expiredDate);
    await writeFile(stalePartPath, 'partial');
    await utimes(stalePartPath, staleDate, staleDate);
    await writeFile(freshPartPath, 'fresh-partial');
    await writeFile(staleStagedPath, 'staged-leftover');
    await utimes(staleStagedPath, staleDate, staleDate);
    await writeFile(freshStagedPath, 'fresh-staged');

    // Trigger refreshChannel failure on startup (origin mismatch) so S2 deduplication is exercised
    const channelSecret = 'sync-channel-secret-999';
    const mismatchChan = newChannel({
      bot: 'bot-app',
      secret: channelSecret,
      hub: 'https://mismatch.example.invalid/',
    });
    await records.vault.put(channelProfileName, JSON.stringify({ ...mismatchChan, enabled: true }));

    let channelSocketMode: '503' | '502' | '200' = '503';
    const channelSocketServer = createServer(async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      if (channelSocketMode === '503') {
        res.statusCode = 503;
        res.end(JSON.stringify({ message: `channel down secret=${channelSecret}` }));
        return;
      }
      if (channelSocketMode === '502') {
        res.statusCode = 502;
        res.end(JSON.stringify({ message: 'adapter gateway timeout' }));
        return;
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true }));
    });

    const app = createApp(deps, {
      codeRoot: records.dataDir,
      log: (line) => logs.push(line),
      closeTimeoutMs: 5000,
      requestTimeoutMs: 60,
      botFileUploadTimeoutMs: 60_000,
      channelSyncIntervalMs: 25,
      botRetentionSweepIntervalMs: 40,
    } as AppOptions);

    try {
      // Remove bot-runtime mode check scenario on startup: verify valid dir keeps 0700
      const info = await app.listen();
      assert.equal(((await lstat(join(records.dataDir, 'bot-runtime'))).mode & 0o777), 0o700);
      await assert.rejects(stat(stalePartPath));
      await assert.rejects(stat(staleStagedPath));
      await assert.rejects(stat(expiredPath));
      assert.equal((await readFile(freshPartPath)).toString(), 'fresh-partial');
      assert.equal((await readFile(freshStagedPath)).toString(), 'fresh-staged');
      assert.equal((await readFile(validPath)).toString(), 'valid-file');

      // S4 periodic retention sweep: backdate validPath > 30d and verify periodic sweep prunes it
      await utimes(validPath, expiredDate, expiredDate);
      for (let i = 0; i < 50; i++) {
        const exists = await stat(validPath).then(() => true, () => false);
        if (!exists) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await assert.rejects(stat(validPath));

      // S2: Wait several intervals with same thrown mismatch failure -> logged ONLY ONCE
      await new Promise((r) => setTimeout(r, 120));
      const mismatchLogs = logs.filter((line) => line.includes('refreshChannel'));
      assert.equal(mismatchLogs.length, 1, `expected deduplicated mismatch log, got: ${mismatchLogs.join('\n')}`);
      assert.ok(!mismatchLogs[0]!.includes('个人助手'));

      // Start channel.sock and point hub to info.url; resolved 503 with secret must log once & mask secret
      await new Promise<void>((resolve) =>
        channelSocketServer.listen(join(records.dataDir, 'bot-runtime', 'channel.sock'), resolve),
      );
      const alignedChan = newChannel({ bot: 'bot-app', secret: channelSecret, hub: info.url + '/' });
      await records.vault.put(channelProfileName, JSON.stringify({ ...alignedChan, enabled: true }));
      for (let i = 0; i < 60 && !logs.some((line) => line.includes('状态 503')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 90));
      const logs503 = logs.filter((line) => line.includes('状态 503'));
      assert.equal(logs503.length, 1, 'identical 503 failure must log once');
      assert.ok(!logs503[0]!.includes(channelSecret), 'channel secret must be masked from sync logs');
      assert.ok(logs503[0]!.includes('[REDACTED]'));

      // Change failure to 502 -> logs once for changed status/message
      channelSocketMode = '502';
      for (let i = 0; i < 60 && !logs.some((line) => line.includes('状态 502')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(logs.filter((line) => line.includes('状态 502')).length, 1);

      // Recover to 200 -> logs recovery once and stays quiet afterward
      channelSocketMode = '200';
      for (let i = 0; i < 60 && !logs.some((line) => line.includes('已恢复')); i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 90));
      assert.equal(logs.filter((line) => line.includes('已恢复')).length, 1);

      await setBotProfile(records.vault, {
        name: '超时测试',
        protocol: 'openai',
        endpoint: 'https://model.example.invalid/v1',
        model: 'demo',
        key: 'timeout-key',
      });
      const boot = await records.principals.bootstrapAdmin('管理员', {
        password: 'Synthetic!Password1',
        mustChange: false,
      });
      const member = await records.principals.createUser(boot.user, '超时成员', 'user', {
        password: 'Synthetic!Password1',
        mustChange: false,
      });
      const token = (await records.principals.issueToken(boot.user, member.id, 'test')).token;

      // R1: Slow chunked bot file upload uses botFileUploadTimeoutMs while non-upload stalled body hits 408 BOT_REQUEST_TIMEOUT
      let releaseUploadChunk2!: () => void;
      const uploadChunk2Gate = new Promise<void>((resolve) => {
        releaseUploadChunk2 = resolve;
      });
      const payload = Buffer.from('slow-bot-upload-ok');
      const sha = createHash('sha256').update(payload).digest('hex');
      const slowUploadPromise = fetch(info.url + botFilesPath + sha, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + token, 'content-length': String(payload.length) },
        body: (async function* () {
          yield payload.subarray(0, 5);
          await uploadChunk2Gate;
          yield payload.subarray(5);
        })(),
        duplex: 'half',
      } as unknown as RequestInit);

      try {
        const stalledReply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          let settled = false;
          const req = httpRequest(
            info.url + '/api/bot/v1',
            {
              method: 'POST',
              headers: {
                authorization: 'Bearer ' + token,
                'content-type': 'application/json',
                'bot-client-version': '1.18.1',
                'content-length': '64',
              },
            },
            (res) => {
              let body = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                body += chunk;
              });
              res.on('end', () => {
                if (!settled) {
                  settled = true;
                  clearTimeout(guard);
                  req.destroy();
                  resolve({ status: res.statusCode ?? 0, body });
                }
              });
              res.on('error', () => {
                if (!settled) {
                  settled = true;
                  clearTimeout(guard);
                  req.destroy();
                  resolve({ status: res.statusCode ?? 0, body });
                }
              });
            },
          );
          const guard = setTimeout(() => {
            if (!settled) {
              settled = true;
              req.destroy();
              resolve({ status: 0, body: '' });
            }
          }, 2_000);
          guard.unref();
          req.on('error', (err) => {
            if (settled || req.destroyed) return;
            settled = true;
            clearTimeout(guard);
            reject(err);
          });
          req.write('{');
        });
        assert.equal(stalledReply.status, 408);
        assert.equal((JSON.parse(stalledReply.body) as { code?: string }).code, 'BOT_REQUEST_TIMEOUT');

        releaseUploadChunk2();
        const slowUpload = await slowUploadPromise;
        assert.equal(slowUpload.status, 200);
      } finally {
        releaseUploadChunk2();
        await slowUploadPromise.catch(() => undefined);
      }

      // T4: /console/api/stream SSE stays open past requestTimeoutMs (60ms) without hitting 408
      const loginPage = await fetch(info.url + '/console/login');
      const loginHtml = await loginPage.text();
      const loginCsrf = /name="csrf" value="([^"]+)"/.exec(loginHtml)![1];
      const loginCookie = loginPage.headers.getSetCookie()[0].split(';')[0];
      const signedIn = await fetch(info.url + '/console/login', {
        method: 'POST',
        redirect: 'manual',
        headers: { origin: info.url, cookie: loginCookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: '超时成员', password: 'Synthetic!Password1', csrf: loginCsrf }).toString(),
      });
      assert.equal(signedIn.status, 303);
      const sessionCookie = signedIn.headers.getSetCookie().find((c) => c.startsWith('circle_hub_session='))!.split(';')[0];
      const sseStream = await new Promise<{ status: number; contentType: string; chunk: string; close: () => void; closedEarly: () => boolean }>((resolve, reject) => {
        let earlyClose = false;
        const sseReq = httpRequest(
          info.url + '/console/api/stream',
          { method: 'GET', headers: { cookie: sessionCookie, accept: 'text/event-stream' } },
          (res) => {
            let chunk = '';
            res.setEncoding('utf8');
            res.on('data', (d) => {
              chunk += d;
            });
            res.on('end', () => {
              earlyClose = true;
            });
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
              chunk,
              close: () => sseReq.destroy(),
              closedEarly: () => earlyClose,
            });
          },
        );
        sseReq.on('error', (err) => {
          if (!sseReq.destroyed) reject(err);
        });
        sseReq.end();
      });
      try {
        assert.equal(sseStream.status, 200);
        assert.match(sseStream.contentType, /^text\/event-stream/);
        await new Promise((r) => setTimeout(r, 120));
        assert.equal(sseStream.closedEarly(), false, 'SSE stream must stay open past requestTimeoutMs (60ms)');
      } finally {
        sseStream.close();
      }
    } finally {
      await app.close();
      channelSocketServer.closeAllConnections?.();
      await new Promise<void>((resolve) => channelSocketServer.close(() => resolve()));
      await records.close();
    }
  },
);

test(
  'R1 + R9 + S10: ensureBotRuntimeDir leaves wrong-mode dirs intact, receive timer skips response streams and destroys trickling early-401 sockets, and /api/bot* returns structured JSON errors',
  { timeout: 30_000 },
  async () => {
    const records = await openTestRecords();
    const botDir = join(records.dataDir, 'bot-runtime');
    await mkdir(botDir, { mode: 0o755, recursive: true });
    await chmod(botDir, 0o755);

    const config: HubConfig = {
      dataDir: records.dataDir,
      logDir: join(records.dataDir, 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: records.database,
      limits: { ...records.config.limits },
    };
    const { deps } = fakeDeps(config, records);

    const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    let forceAuthThrow = false;
    let holdMcpEntered!: () => void;
    const mcpEntered = new Promise<void>((resolve) => {
      holdMcpEntered = resolve;
    });
    let releaseMcp!: () => void;
    const mcpGate = new Promise<void>((resolve) => {
      releaseMcp = resolve;
    });

    const originalAuth = deps.records.principals.authenticateAccessToken!.bind(deps.records.principals);
    deps.records.principals.authenticateAccessToken = async (auth) => {
      if (forceAuthThrow) throw new Error('simulated auth failure');
      return originalAuth(auth);
    };
    const originalSummaries = deps.workflows.summaries.bind(deps.workflows);
    deps.workflows.summaries = async (by) => {
      holdMcpEntered();
      await mcpGate;
      return originalSummaries(by);
    };

    const app = createApp(deps, {
      codeRoot: records.dataDir,
      closeTimeoutMs: 5000,
      requestTimeoutMs: 50,
      scheduleReceiveTimeout: (fn, ms) => {
        const entry = { fn, ms, cleared: false };
        scheduled.push(entry);
        return {
          unref() {},
          [Symbol.toPrimitive]() {
            return scheduled.indexOf(entry);
          },
          _entry: entry,
        } as unknown as ReturnType<typeof setTimeout>;
      },
    });
    const originalClearTimeout = globalThis.clearTimeout;
    globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout> | undefined) => {
      if (id && typeof id === 'object' && '_entry' in id) {
        (id as unknown as { _entry: { cleared: boolean } })._entry.cleared = true;
        return;
      }
      originalClearTimeout(id);
    }) as typeof clearTimeout;

    try {
      const info = await app.listen();
      // S10: pre-existing 0755 bot-runtime must NOT be chmodded to 0700 by startup
      assert.equal(((await lstat(botDir)).mode & 0o777), 0o755);

      // R9 + F2: wrong Host / Origin on /api/bot* -> 403 BOT_CLIENT_FORBIDDEN with situational nextAction
      const wrongOrigin = await fetch(info.url + '/api/bot/v1', {
        method: 'POST',
        headers: { origin: 'https://evil.example.invalid', 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(wrongOrigin.status, 403);
      const wrongOriginJson = (await wrongOrigin.json()) as { code?: string; message?: string };
      assert.equal(wrongOriginJson.code, 'BOT_CLIENT_FORBIDDEN');
      assert.match(wrongOriginJson.message ?? '', /请确认请求来源在允许名单内后重试/);

      const wrongHost = await new Promise<{ status: number; json: { code?: string; message?: string } }>((resolve, reject) => {
        const hostReq = httpRequest(
          info.url + '/api/bot/v1',
          {
            method: 'POST',
            headers: { host: 'evil.example.invalid:9999', 'content-type': 'application/json', 'content-length': '2' },
          },
          async (res) => {
            const chunks: Buffer[] = [];
            for await (const c of res) chunks.push(c);
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          },
        );
        hostReq.on('error', reject);
        hostReq.end('{}');
      });
      assert.equal(wrongHost.status, 403);
      assert.equal(wrongHost.json.code, 'BOT_CLIENT_FORBIDDEN');
      assert.match(wrongHost.json.message ?? '', /请使用本部署允许的访问地址与端口后重试/);

      // R9: unknown subpath under /api/bot* -> 404 BOT_NOT_FOUND
      const unknownSubpath = await fetch(info.url + '/api/bot/v1/unknown-subpath');
      assert.equal(unknownSubpath.status, 404);
      assert.equal(((await unknownSubpath.json()) as { code?: string }).code, 'BOT_NOT_FOUND');

      // R9: unexpected throw -> fail() -> 500 BOT_UPSTREAM_UNAVAILABLE
      forceAuthThrow = true;
      const internalErr = await fetch(info.url + '/api/bot/v1', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'bot-client-version': '1.0.0' },
        body: '{}',
      });
      assert.equal(internalErr.status, 500);
      assert.equal(((await internalErr.json()) as { code?: string }).code, 'BOT_UPSTREAM_UNAVAILABLE');
      forceAuthThrow = false;

      // R1: Early 401 with trickling request body keeps receive timer armed after response finishes, and firing destroys socket
      let reqDestroyed = false;
      let sockDestroyed = false;
      let finishCount = 0;
      const reqSocket = Object.assign(new EventEmitter(), {
        remoteAddress: '127.0.0.1',
        destroy() {
          sockDestroyed = true;
        },
      });
      const reqObj = Object.assign(new EventEmitter(), {
        url: '/api/bot/v1',
        method: 'POST',
        headers: { host: new URL(info.url).host, 'content-type': 'application/json', 'content-length': '100' },
        complete: false,
        aborted: false,
        destroyed: false,
        socket: reqSocket,
        resume() {},
        destroy() {
          reqDestroyed = true;
          reqObj.destroyed = true;
        },
      });
      const req = reqObj as unknown as IncomingMessage;
      const resObj = Object.assign(new EventEmitter(), {
        statusCode: 0,
        headersSent: false,
        writableEnded: false,
        writableFinished: false,
        destroyed: false,
        setHeader() {},
        writeHead(status: number) {
          resObj.statusCode = status;
          resObj.headersSent = true;
        },
        end() {
          resObj.writableEnded = true;
          resObj.writableFinished = true;
          finishCount += 1;
          resObj.emit('finish');
        },
        destroy() {
          resObj.destroyed = true;
        },
      });
      const res = resObj as unknown as ServerResponse;

      scheduled.length = 0;
      app.handler(req, res);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(finishCount, 1);
      assert.equal((res as unknown as { statusCode: number }).statusCode, 401);
      assert.equal(scheduled.length, 1);
      assert.equal(scheduled[0]!.cleared, false, 'receive timer must NOT clear on response finish while body still trickles');

      // Firing receive timer after headersSent destroys request + socket immediately
      scheduled[0]!.fn();
      assert.equal(reqDestroyed, true);
      assert.equal(sockDestroyed, true);

      // R1: Once request body finishes ('end'), receive timer IS cleared so long-running response has no timeout
      const boot = await records.principals.bootstrapAdmin('长请求管理员', {
        password: 'Synthetic!Password1',
        mustChange: false,
      });
      const initRes = await fetch(info.url + '/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + boot.token.token,
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
            clientInfo: { name: 'app-test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(initRes.status, 200);
      const mcpSessionId = initRes.headers.get('mcp-session-id')!;
      assert.ok(mcpSessionId);

      const mcpReqPromise = fetch(info.url + '/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + boot.token.token,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-03-26',
          'mcp-session-id': mcpSessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'list_task_packs', arguments: {} },
        }),
      });
      await mcpEntered;
      // The /mcp request body ended -> its receive timer was cleared! Even invoking any scheduled callback is a no-op.
      assert.ok(scheduled.at(-1)!.cleared, 'receive timer must clear as soon as request body emits end');
      scheduled.at(-1)!.fn();

      // R9 + F2: While mcpReqPromise holds close() in stopping state, /api/bot/v1 returns 503 BOT_UPSTREAM_UNAVAILABLE JSON with situational nextAction
      const closingPromise = app.close();
      const stoppingRes = await fetch(info.url + '/api/bot/v1', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + boot.token.token, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'discover' }),
      });
      assert.equal(stoppingRes.status, 503);
      const stoppingJson = (await stoppingRes.json()) as { code?: string; message?: string };
      assert.equal(stoppingJson.code, 'BOT_UPSTREAM_UNAVAILABLE');
      assert.match(stoppingJson.message ?? '', /请等待 Hub 重启完成后原样重试/);

      releaseMcp();
      const mcpRes = await mcpReqPromise;
      assert.equal(mcpRes.status, 200);
      await closingPromise;
    } finally {
      releaseMcp();
      globalThis.clearTimeout = originalClearTimeout;
      await app.close();
      await records.close();
    }
  },
);

test(
  'T4 + T5(a): default createApp creates 0700 bot-runtime on listen() and keeps default 120s/900s receive timeouts',
  { timeout: 15_000 },
  async () => {
    const records = await openTestRecords();
    const config: HubConfig = {
      dataDir: records.dataDir,
      logDir: join(records.dataDir, 'logs'),
      host: '127.0.0.1',
      port: 0,
      database: records.database,
      limits: { ...records.config.limits },
    };
    const { deps } = fakeDeps(config, records);
    const app = createApp(deps, { codeRoot: records.dataDir, closeTimeoutMs: 5000 });
    const hostServer = createServer(async (req, res) => {
      for await (const _ of req) {
        // drain
      }
      res.end(JSON.stringify({ id: 'ok' }));
    });
    try {
      // T5(a): bot-runtime does NOT exist before listen(); listen() creates it with mode 0700
      const runtimeDir = join(records.dataDir, 'bot-runtime');
      await assert.rejects(lstat(runtimeDir));
      const info = await app.listen();
      assert.equal(((await lstat(runtimeDir)).mode & 0o777), 0o700);
      await new Promise<void>((resolve) => hostServer.listen(join(runtimeDir, 'host.sock'), resolve));

      await setBotProfile(records.vault, {
        name: '默认超时测试',
        protocol: 'openai',
        endpoint: 'https://model.example.invalid/v1',
        model: 'demo',
        key: 'default-timeout-key',
      });
      const boot = await records.principals.bootstrapAdmin('默认超时管理员', {
        password: 'Synthetic!Password1',
        mustChange: false,
      });
      const member = await records.principals.createUser(boot.user, '默认超时成员', 'user', {
        password: 'Synthetic!Password1',
        mustChange: false,
      });
      const token = (await records.principals.issueToken(boot.user, member.id, 'test')).token;

      // T4: Default requestTimeoutMs (120_000) allows a slow body > 1050ms without 408
      const bodyStr = JSON.stringify({ action: 'discover' });
      const slowBodyRes = await fetch(info.url + '/api/bot/v1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
          'content-length': String(Buffer.byteLength(bodyStr)),
        },
        body: (async function* () {
          yield Buffer.from(bodyStr.slice(0, 5));
          await new Promise((r) => setTimeout(r, 1100));
          yield Buffer.from(bodyStr.slice(5));
        })(),
        duplex: 'half',
      } as unknown as RequestInit);
      assert.equal(slowBodyRes.status, 200);

      // T4: Default botFileUploadTimeoutMs (900_000) allows an upload > 10ms without 408
      const filePayload = Buffer.from('default-upload-timeout-ok');
      const fileSha = createHash('sha256').update(filePayload).digest('hex');
      const slowFileRes = await fetch(info.url + botFilesPath + fileSha, {
        method: 'PUT',
        headers: {
          authorization: 'Bearer ' + token,
          'content-length': String(filePayload.length),
        },
        body: (async function* () {
          yield filePayload.subarray(0, 5);
          await new Promise((r) => setTimeout(r, 25));
          yield filePayload.subarray(5);
        })(),
        duplex: 'half',
      } as unknown as RequestInit);
      assert.equal(slowFileRes.status, 200);
      assert.ok(randomUUID());
    } finally {
      await new Promise<void>((resolve) => hostServer.close(() => resolve()));
      await app.close();
      await records.close();
    }
  },
);
