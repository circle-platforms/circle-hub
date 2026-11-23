import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { HubConfig } from '../config/index.ts';
import { openTestRecords } from '../testing/records.ts';
import type { AppOptions } from './api.ts';
import { createApp } from './app.ts';
import { botFilesPath } from './bot-files.ts';
import { channelProfileName, newChannel, setBotProfile } from './personal-bot.ts';
import { fakeDeps } from './testing.ts';

test('app startup cleans bot-runtime .part and stale channel-staging files while preserving valid stored files, logs refreshChannel errors, and enforces per-route request timeouts', async () => {
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
  const validSha = createHash('sha256').update('valid-file').digest('hex');
  const validPath = join(filesDir, validSha);
  const partPath = join(filesDir, 'orphan.part');
  const stagedPath = join(stagingDir, 'a'.repeat(64));
  await writeFile(validPath, 'valid-file');
  await writeFile(partPath, 'partial');
  await writeFile(stagedPath, 'staged-leftover');

  // Trigger refreshChannel failure on startup (origin mismatch) so H14 logging is exercised
  const chan = newChannel({ bot: 'bot-app', secret: 'chan-sec', hub: 'https://mismatch.example.invalid/' });
  await records.vault.put(channelProfileName, JSON.stringify({ ...chan, enabled: true }));

  const app = createApp(deps, {
    codeRoot: records.dataDir,
    log: (line) => logs.push(line),
    closeTimeoutMs: 5000,
    requestTimeoutMs: 50,
    botFileUploadTimeoutMs: 60_000,
    channelSyncIntervalMs: 20,
  } as AppOptions);

  try {
    const info = await app.listen();
    await assert.rejects(stat(partPath));
    await assert.rejects(stat(stagedPath));
    assert.equal((await readFile(validPath)).toString(), 'valid-file');
    for (let i = 0; i < 100 && logs.filter((line) => line.includes('refreshChannel')).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(logs.filter((line) => line.includes('refreshChannel')).length >= 2);

    await setBotProfile(records.vault, {
      name: '超时测试',
      protocol: 'openai',
      endpoint: 'https://model.example.invalid/v1',
      model: 'demo',
      key: 'timeout-key',
    });
    const boot = await records.principals.bootstrapAdmin('管理员', { password: 'Synthetic!Password1', mustChange: false });
    const member = await records.principals.createUser(boot.user, '超时成员', 'user', {
      password: 'Synthetic!Password1',
      mustChange: false,
    });
    const token = (await records.principals.issueToken(boot.user, member.id, 'test')).token;

    // Start a slow chunked bot file upload and wait until the concurrent non-upload route hits its 50ms timeout BEFORE finishing chunk 2.
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

    let finishStalledBody!: () => void;
    const stalledGate = new Promise<void>((resolve) => {
      finishStalledBody = resolve;
    });
    let nonUploadFailed = false;
    try {
      const stalled = await fetch(info.url + '/api/bot/v1', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json',
          'bot-client-version': '1.18.1',
        },
        body: (async function* () {
          yield Buffer.from('{');
          await stalledGate;
        })(),
        duplex: 'half',
      } as unknown as RequestInit);
      if (stalled.status === 408 || stalled.status >= 500) nonUploadFailed = true;
    } catch {
      nonUploadFailed = true;
    } finally {
      finishStalledBody();
      releaseUploadChunk2();
    }
    assert.equal(nonUploadFailed, true);
    const slowUpload = await slowUploadPromise;
    assert.equal(slowUpload.status, 200);
  } finally {
    await app.close();
    await records.close();
  }
});
