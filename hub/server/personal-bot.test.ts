import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { chatPath, disableBot, readBotProfile, setBotProfile } from './personal-bot.ts';
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
    const send = (token: string, op: unknown) =>
      fetch(hub.url + chatPath, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'circle-version': '1.18.1' },
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
    assert.equal(seen[1].owner, member.principal.id);
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
