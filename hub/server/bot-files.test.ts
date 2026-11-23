import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { botFilesPath } from './bot-files.ts';
import { createTestServer } from './testing.ts';

test(
  'a 17 MiB attachment is streamed, rehashed, and readable only by its active owner',
  { timeout: 30000 },
  async () => {
    const hub = await createTestServer();
    try {
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
