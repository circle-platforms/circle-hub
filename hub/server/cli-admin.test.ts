import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BotSecretChangeAudit, MemberExternalIdentityAudit } from '../../contracts/src/resources.ts';
import { sha256Hex } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { createCommandBridge } from './command-bridge.ts';
import { createTestServer, testConsoleCredentials } from './testing.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
});
after(async () => {
  await postgres?.stop();
});

test('D1 + H1 CLI & Console: bot-secret-change@1 audits, reviewer removal, and admin bot identity-unbind flow', async (t) => {
  const bridgeEnv = (records: { dataDir: string; database: { host: string; port: number; database: string; user: string } }) => ({
    CIRCLE_HUB_DATA_DIR: records.dataDir,
    CIRCLE_HUB_LOG_DIR: join(records.dataDir, 'logs'),
    CIRCLE_HUB_HOST: '127.0.0.1',
    CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: postgres.socketDir,
    CIRCLE_HUB_DATABASE_PORT: String(records.database.port),
    CIRCLE_HUB_DATABASE_NAME: records.database.database,
    CIRCLE_HUB_DATABASE_USER: records.database.user,
  });

  const hub = await createTestServer({
    postgres,
    bridge: (records) =>
      createCommandBridge({
        cwd: records.dataDir,
        env: bridgeEnv(records),
        overrides: {
          keyProvider: () => records.keyProvider,
          operatorTokens: () => memoryOperatorTokens(null, '测试空令牌存储'),
        },
      }),
  });
  t.after(() => hub.close());

  const bridge = createCommandBridge({
    cwd: hub.deps.config.dataDir,
    env: bridgeEnv({ dataDir: hub.deps.config.dataDir, database: hub.records.database }),
    overrides: {
      keyProvider: () => hub.records.keyProvider,
      operatorTokens: () => memoryOperatorTokens(null, '测试空令牌存储'),
    },
  });

  // 1. D1: reviewer CLI subcommands are refused cleanly.
  for (const oldCmd of ['review-set', 'review-test', 'review-disable']) {
    const res = await bridge.run(['bot', oldCmd], { token: hub.admin.token });
    assert.equal(res.code, 2, `legacy ${oldCmd} must be rejected`);
  }

  // 2. D1: bot set / identity-set / channel-set / disable / identity-remove / channel-remove record bot-secret-change@1 without secret values.
  const modelKey = 'synthetic-secret-model-key-123';
  const appSecret = 'synthetic-secret-identity-456';
  const chanSecret = 'synthetic-secret-channel-789';

  assert.equal(
    (
      await bridge.run(['bot', 'set'], {
        token: hub.admin.token,
        secrets: {
          'bot-model': JSON.stringify({
            name: '合成助手',
            protocol: 'openai',
            model: 'demo-model',
            endpoint: 'https://model.example.invalid/v1',
            key: modelKey,
          }),
        },
      })
    ).code,
    0,
  );
  assert.equal(
    (
      await bridge.run(['bot', 'identity-set'], {
        token: hub.admin.token,
        secrets: {
          'personal-bot.identity': JSON.stringify({
            tenant: 'demo-tenant',
            application: 'demo-app',
            secret: appSecret,
          }),
        },
      })
    ).code,
    0,
  );
  assert.equal(
    (
      await bridge.run(['bot', 'channel-set'], {
        token: hub.admin.token,
        secrets: {
          'personal-bot.channel': JSON.stringify({
            bot: 'demo-bot',
            hub: 'https://hub.example.invalid/',
            secret: chanSecret,
          }),
        },
      })
    ).code,
    0,
  );
  assert.equal((await bridge.run(['bot', 'disable'], { token: hub.admin.token })).code, 0);
  assert.equal((await bridge.run(['bot', 'identity-remove'], { token: hub.admin.token })).code, 0);
  assert.equal((await bridge.run(['bot', 'channel-remove'], { token: hub.admin.token })).code, 0);

  const actions = (await hub.records.store.list({ kind: 'action', limit: 100 })).items;
  const secretChanges = actions
    .filter((item) => item.schema === 'bot-secret-change@1')
    .map((item) => BotSecretChangeAudit.parse(item.body));
  assert.deepEqual(
    secretChanges.map((entry) => [entry.slot, entry.action, entry.by]),
    [
      ['personal-bot.model', 'set', hub.admin.principal.id],
      ['personal-bot.identity', 'set', hub.admin.principal.id],
      ['personal-bot.channel', 'set', hub.admin.principal.id],
      ['personal-bot.model', 'remove', hub.admin.principal.id],
      ['personal-bot.identity', 'remove', hub.admin.principal.id],
      ['personal-bot.channel', 'remove', hub.admin.principal.id],
    ],
  );
  const rawAuditJson = JSON.stringify(secretChanges);
  assert.ok(!rawAuditJson.includes(modelKey));
  assert.ok(!rawAuditJson.includes(appSecret));
  assert.ok(!rawAuditJson.includes(chanSecret));

  // 3. Console login + verify /console/settings?tab=bot has no reviewer card/actions.
  const send = (path: string, init: RequestInit = {}) => fetch(hub.url + path, { redirect: 'manual', ...init });
  const firstCookie = (r: Response) => r.headers.getSetCookie()[0].split(';')[0];
  const csrf = (body: string) => /name="csrf" value="([^"]+)"/.exec(body)![1];

  const loginPage = await send('/console/login');
  const loginRes = await send('/console/login', {
    method: 'POST',
    headers: { origin: hub.url, cookie: firstCookie(loginPage) },
    body: new URLSearchParams({ ...testConsoleCredentials(hub.admin.token), csrf: csrf(await loginPage.text()) }),
  });
  assert.equal(loginRes.status, 303);
  const adminCookie = loginRes.headers.getSetCookie().find((c) => c.startsWith('circle_hub_session='))!.split(';')[0];

  const botTab = await send('/console/settings?tab=bot', { headers: { cookie: adminCookie } });
  assert.equal(botTab.status, 200);
  const botHtml = await botTab.text();
  assert.ok(!botHtml.includes('独立复核模型'));
  assert.ok(!botHtml.includes('bot-review-'));

  const reviewPost = await send('/console/admin/do/bot-review-set', {
    method: 'POST',
    headers: { origin: hub.url, cookie: adminCookie },
    body: new URLSearchParams({ csrf: csrf(botHtml) }),
  });
  assert.equal(reviewPost.status, 404);

  // 4. H1: Admin unbind via console team page + CLI bot identity-unbind.
  const alice = await hub.createUser('命令行解绑甲');
  const bob = await hub.createUser('命令行解绑乙');
  const issuerA = 'https://work.example.invalid/tenant-cli-a';
  const issuerB = 'https://work.example.invalid/tenant-cli-b';
  const subA = 'cli-sub-alpha';
  const subB = 'cli-sub-bravo';

  await hub.records.principals.bindExternalIdentity(alice.principal, issuerA, subA);
  await hub.records.principals.bindExternalIdentity(alice.principal, issuerB, subB);

  // CLI unbind targeting a single issuer keeps the other issuer.
  const singleUnbind = await bridge.run(['bot', 'identity-unbind', alice.principal.id, '--issuer', issuerA], {
    token: hub.admin.token,
  });
  assert.equal(singleUnbind.code, 0, singleUnbind.stderr.join('\n'));
  assert.equal(await hub.records.principals.externalMember(issuerA, subA), null);
  assert.equal((await hub.records.principals.externalMember(issuerB, subB))?.id, alice.principal.id);

  // Console team member inspector shows unbind form for remaining binding, and executing unbinds it.
  const teamMemberBefore = await send(`/console/team/${alice.principal.id}`, { headers: { cookie: adminCookie } });
  const teamHtmlBefore = await teamMemberBefore.text();
  assert.match(teamHtmlBefore, /bot-identity-unbind/);
  assert.match(teamHtmlBefore, /解除外部身份绑定/);

  const unbindPost = await send('/console/admin/do/bot-identity-unbind', {
    method: 'POST',
    headers: { origin: hub.url, cookie: adminCookie },
    body: new URLSearchParams({ csrf: csrf(teamHtmlBefore), user: alice.principal.id }),
  });
  assert.equal(unbindPost.status, 200);
  assert.equal(await hub.records.principals.externalMember(issuerB, subB), null);

  // Another member can immediately bind the freed external identity.
  await hub.records.principals.bindExternalIdentity(bob.principal, issuerB, subB);
  assert.equal((await hub.records.principals.externalMember(issuerB, subB))?.id, bob.principal.id);

  const teamMemberAfter = await send(`/console/team/${alice.principal.id}`, { headers: { cookie: adminCookie } });
  assert.doesNotMatch(await teamMemberAfter.text(), /bot-identity-unbind/);

  const identityAudits = (await hub.records.store.find({ kind: 'action', key: 'member.external_identity.member', value: alice.principal.id, limit: 20 })).items
    .filter((item) => item.schema === 'member-external-identity@1')
    .map((item) => MemberExternalIdentityAudit.parse(item.body));
  const unbinds = identityAudits.filter((a) => a.action === 'unbind');
  assert.equal(unbinds.length, 2);
  assert.ok(unbinds.every((u) => u.reason === 'manual' && u.by === hub.admin.principal.id));
  assert.deepEqual(
    unbinds.map((u) => u.issuer).sort(),
    [sha256Hex(issuerA), sha256Hex(issuerB)].sort(),
  );
});
