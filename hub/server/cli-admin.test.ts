import assert from 'node:assert/strict';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { BotSecretChangeAudit, MemberExternalIdentityAudit } from '../../contracts/src/resources.ts';
import { labelOf } from '../../contracts/generated/vocabulary.ts';
import { sha256Hex } from '../records/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { memoryOperatorTokens } from './assemble/operator-token.ts';
import { createCommandBridge } from './command-bridge.ts';
import { wordingProblems } from './console/testing-wording.ts';
import { CSS } from './console/style.ts';
import { createTestServer, testConsoleCredentials } from './testing.ts';

let postgres: TemporaryPostgres;
before(async () => {
  postgres = await startPostgres({ socket: true, passwordless: true });
});
after(async () => {
  await postgres?.stop();
});

test('D1 + H1 + S8 + S12 CLI & Console: bot-secret-change@1 audits, reviewer removal, admin bot identity-unbind, and bot settings page', { timeout: 60_000 }, async (t) => {
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
    env: { ...bridgeEnv({ dataDir: hub.deps.config.dataDir, database: hub.records.database }), CIRCLE_HUB_PORT: String(hub.port) },
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

  const offlineSet = await bridge.run(['bot', 'set'], {
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
  });
  assert.equal(offlineSet.code, 0);
  assert.ok(offlineSet.stdout.join('\n').includes('机器人模型配置已保存（宿主当前未连接，将在下次调用时同步）'));
  assert.match(offlineSet.stderr.join('\n'), /^通知机器人宿主配置变更失败（版本 1）：/);
  assert.ok(!offlineSet.stderr.join('\n').includes(modelKey));
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
  const offlineDisable = await bridge.run(['bot', 'disable'], { token: hub.admin.token });
  assert.equal(offlineDisable.code, 0);
  assert.ok(offlineDisable.stdout.join('\n').includes('机器人模型已停用（宿主当前未连接，将在下次调用时同步）'));
  assert.match(offlineDisable.stderr.join('\n'), /^通知机器人宿主配置变更失败（版本 2）：/);
  assert.equal((await bridge.run(['bot', 'identity-remove'], { token: hub.admin.token })).code, 0);
  assert.equal((await bridge.run(['bot', 'channel-remove'], { token: hub.admin.token })).code, 0);

  // S8: channel-start & channel-stop record start_channel / stop_channel when adapter confirms
  await bridge.run(['bot', 'identity-set'], {
    token: hub.admin.token,
    secrets: {
      'personal-bot.identity': JSON.stringify({ tenant: 'demo-tenant', application: 'demo-app', secret: appSecret }),
    },
  });
  await bridge.run(['bot', 'channel-set'], {
    token: hub.admin.token,
    secrets: {
      'personal-bot.channel': JSON.stringify({ bot: 'demo-bot', hub: hub.url + '/', secret: chanSecret }),
    },
  });
  const botRuntimeDir = join(hub.deps.config.dataDir, 'bot-runtime');
  await mkdir(botRuntimeDir, { recursive: true, mode: 0o700 });
  const channelSockServer = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => channelSockServer.listen(join(botRuntimeDir, 'channel.sock'), resolve));
  let hostMode: 'secret_error' | 'ok' = 'secret_error';
  const hostRequests: Array<{ owner?: unknown; op?: { action?: string }; config?: { key?: string } | null; configVersion?: number }> = [];
  const hostSockServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      owner?: unknown;
      op?: { action?: string };
      config?: { key?: string } | null;
      configVersion?: number;
    };
    hostRequests.push(parsed);
    if (parsed.op?.action === 'test' && hostMode === 'secret_error') {
      res.statusCode = 502;
      res.end(JSON.stringify({ message: `host exploded with ${modelKey}` }));
      return;
    }
    res.end(JSON.stringify(parsed.op?.action === 'test' ? { tested: true } : { ok: true }));
  });
  await new Promise<void>((resolve) => hostSockServer.listen(join(botRuntimeDir, 'host.sock'), resolve));

  try {
    const startRes = await bridge.run(['bot', 'channel-start'], { token: hub.admin.token });
    assert.equal(startRes.code, 0, startRes.stderr.join('\n'));
    const stopRes = await bridge.run(['bot', 'channel-stop'], { token: hub.admin.token });
    assert.equal(stopRes.code, 0, stopRes.stderr.join('\n'));

    // S5 + S10 + R11 + F5/F14: bot set notifies host.sock with configure frame & monotonic configVersion and truthful stdout; bot test masks vault secrets and surfaces bot-runtime mode error
    const connectedSet = await bridge.run(['bot', 'set'], {
      token: hub.admin.token,
      secrets: {
        'bot-model': JSON.stringify({
          name: '测试机器人',
          protocol: 'openai',
          model: 'demo-model',
          endpoint: 'https://model.example.invalid/v1',
          key: modelKey,
        }),
      },
    });
    assert.equal(connectedSet.code, 0);
    assert.ok(connectedSet.stdout.join('\n').includes('机器人模型配置已保存，已通知宿主'));
    assert.equal(connectedSet.stderr.length, 0);
    assert.equal(hostRequests.at(-1)?.owner, '_hub');
    assert.deepEqual(hostRequests.at(-1)?.op, { action: 'configure' });
    assert.equal(hostRequests.at(-1)?.config?.key, modelKey);
    assert.equal(hostRequests.at(-1)?.configVersion, 3);
    const testMaskedFail = await bridge.run(['bot', 'test'], { token: hub.admin.token });
    assert.notEqual(testMaskedFail.code, 0);
    assert.equal(hostRequests.at(-1)?.op?.action, 'test');
    assert.equal(hostRequests.at(-1)?.configVersion, 3);
    assert.ok(!testMaskedFail.stderr.join('\n').includes(modelKey));
    assert.ok(testMaskedFail.stderr.join('\n').includes('[REDACTED]'));

    hostMode = 'ok';
    const testOk = await bridge.run(['bot', 'test'], { token: hub.admin.token });
    assert.equal(testOk.code, 0, testOk.stderr.join('\n'));
    assert.equal(hostRequests.at(-1)?.op?.action, 'test');
    assert.equal(hostRequests.at(-1)?.configVersion, 3);

    await chmod(botRuntimeDir, 0o755);
    const testDirFail = await bridge.run(['bot', 'test'], { token: hub.admin.token });
    assert.notEqual(testDirFail.code, 0);
    assert.ok(testDirFail.stderr.join('\n').includes('权限为 0755（须为 0700）'));
    await chmod(botRuntimeDir, 0o700);
  } finally {
    await new Promise<void>((resolve) => channelSockServer.close(() => resolve()));
    await new Promise<void>((resolve) => hostSockServer.close(() => resolve()));
  }

  const actions = (await hub.records.store.list({ kind: 'action', limit: 100 })).items;
  const secretChanges = actions
    .filter((item) => item.schema === 'bot-secret-change@1')
    .map((item) => BotSecretChangeAudit.parse(item.body));
  assert.deepEqual(
    secretChanges.map((entry) => [entry.slot, entry.action, entry.by]),
    [
      ['model', 'set', hub.admin.principal.id],
      ['identity', 'set', hub.admin.principal.id],
      ['channel', 'set', hub.admin.principal.id],
      ['model', 'remove', hub.admin.principal.id],
      ['identity', 'remove', hub.admin.principal.id],
      ['channel', 'remove', hub.admin.principal.id],
      ['identity', 'set', hub.admin.principal.id],
      ['channel', 'set', hub.admin.principal.id],
      ['channel', 'start_channel', hub.admin.principal.id],
      ['channel', 'stop_channel', hub.admin.principal.id],
      ['model', 'set', hub.admin.principal.id],
    ],
  );
  const rawAuditJson = JSON.stringify(secretChanges);
  assert.ok(!rawAuditJson.includes(modelKey));
  assert.ok(!rawAuditJson.includes(appSecret));
  assert.ok(!rawAuditJson.includes(chanSecret));

  // S8 + F5: If audit append fails after vault write, refreshHost MUST STILL run BEFORE throwing audit failure!
  const { botCommand } = await import('./cli-admin.ts');
  const { Session } = await import('./cli-session.ts');
  const failingAuditHostFrames: Array<{ owner?: unknown; op?: { action?: string }; configVersion?: number }> = [];
  const failingAuditHost = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    failingAuditHostFrames.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => failingAuditHost.listen(join(botRuntimeDir, 'host.sock'), resolve));
  const failingStore = new Proxy(hub.records.store, {
    get(target, prop) {
      if (prop === 'put') {
        return async () => {
          throw new Error('simulated audit write failure');
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const failingSession = new Session(
    {
      io: { stdout() {}, stderr() {}, env: { CIRCLE_HUB_TOKEN: hub.admin.token }, cwd: hub.deps.config.dataDir },
      config: () => hub.deps.config,
      records: async () => ({ ...hub.records, store: failingStore }),
      deps: async () => hub.deps,
      actingAdmin: async () => hub.admin.principal,
    },
    {
      tokens: () => memoryOperatorTokens(hub.admin.token, '测试令牌'),
      readSecret: async () =>
        JSON.stringify({
          name: '审计失败测试',
          protocol: 'openai',
          model: 'demo-model',
          endpoint: 'https://model.example.invalid/v1',
          key: modelKey,
        }),
    },
  );
  try {
    await assert.rejects(
      () => botCommand(failingSession, ['set']),
      (err: unknown) => err instanceof Error && /审计记录写入失败/.test(err.message) && /机器人模型/.test(err.message),
    );
    assert.deepEqual(failingAuditHostFrames.at(-1)?.op, { action: 'configure' });
    assert.equal(failingAuditHostFrames.at(-1)?.configVersion, 4);

    await assert.rejects(
      () => botCommand(failingSession, ['disable']),
      (err: unknown) => err instanceof Error && /审计记录写入失败/.test(err.message) && /机器人模型/.test(err.message),
    );
    assert.deepEqual(failingAuditHostFrames.at(-1)?.op, { action: 'disable' });
    assert.equal(failingAuditHostFrames.at(-1)?.configVersion, 5);
  } finally {
    await new Promise<void>((resolve) => failingAuditHost.close(() => resolve()));
  }

  // 3. Console login + S12 verify /console/settings?tab=bot has pure Chinese labels, status box, recent audit box, callback URL, and passes wordingProblems
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
  assert.deepEqual(wordingProblems(botHtml), [], 'bot settings page must pass wordingProblems when healthy');
  assert.ok(!botHtml.includes('独立复核模型'));
  assert.ok(!botHtml.includes('bot-review-'));
  assert.ok(!botHtml.includes('个人助手'));
  assert.ok(botHtml.includes('OpenAI 对话补全协议') && botHtml.includes('Anthropic 消息协议') && botHtml.includes('OpenAI Responses 协议'));
  for (const label of [
    '机器人名称',
    '接口协议',
    '模型服务地址',
    '模型标识',
    '模型系列标识（选填）',
    '模型密钥',
    '租户标识',
    '登录应用标识',
    '登录应用密钥',
    '机器人标识',
    '适配器访问 Hub 的地址',
    '通道机器人密钥',
    '运行状态',
    '最近配置变更',
    labelOf('bot_secret_slot', 'model'),
    labelOf('bot_secret_action', 'start_channel'),
    labelOf('bot_secret_action', 'stop_channel'),
    hub.url + '/console/identity/callback',
    '未连接',
    '配置机器人模型、扫码登录应用、私聊通道与运行状态',
    'ch-kv--wide',
    '填写模型服务的 HTTPS 接口地址；仅本机调试时可使用回环 HTTP 地址。',
    '仅当需要按模型系列标识区分能力策略时填写，留空则按默认模型处理。',
    '从模型服务商控制台获取；保存时加密写入密钥库，页面不回显旧密钥。',
    '填写外部身份平台中的组织或企业租户标识。',
    '填写外部扫码登录应用的应用标识。',
    '从外部应用管理后台获取密钥；保存时加密写入密钥库，不回显旧密钥。',
    '允许管理员账号用扫码登录控制台',
    '默认不允许：管理员账号用账号和密码登录，绑定的外部身份只用于私聊通道。勾选并保存后，绑定了外部身份的管理员也可以用扫码登录。',
    '填写外部消息平台中创建的机器人标识。',
    '填写通道适配器在本地或内网访问当前 Hub 的根地址，须为 HTTPS 或回环 HTTP 地址。',
    '从外部消息平台机器人详情页获取通道密钥；保存时加密写入密钥库，不回显旧密钥。',
  ]) {
    assert.ok(botHtml.includes(label), `expected ${label} on /console/settings?tab=bot`);
  }
  assert.match(botHtml, /凭据 <span class="ch-count">\d+<\/span>/);
  assert.match(botHtml, /<input type="checkbox" name="adminLogin" value="1"> 允许管理员账号用扫码登录控制台/);
  assert.ok(CSS.includes('.ch-kv--wide { grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--space-4); }'));
  assert.equal((botHtml.match(/ch-btn--primary/g) ?? []).length, 3, 'all 3 forms must use primary submit buttons');

  const identitySecrets = (extra: Record<string, unknown>) => ({
    'personal-bot.identity': JSON.stringify({ tenant: 'demo-tenant', application: 'demo-app', secret: appSecret, ...extra }),
  });
  assert.equal((await bridge.run(['bot', 'identity-set'], { token: hub.admin.token, secrets: identitySecrets({ adminLogin: true }) })).code, 0);
  const switchedOnHtml = await (await send('/console/settings?tab=bot', { headers: { cookie: adminCookie } })).text();
  assert.match(switchedOnHtml, /<input type="checkbox" name="adminLogin" value="1" checked> 允许管理员账号用扫码登录控制台/);
  assert.notEqual((await bridge.run(['bot', 'identity-set'], { token: hub.admin.token, secrets: identitySecrets({ adminLogin: 'yes' }) })).code, 0);
  assert.equal((await bridge.run(['bot', 'identity-set'], { token: hub.admin.token, secrets: identitySecrets({}) })).code, 0);

  // T5(b): Verify "运行中" status chips appear when host.sock and channel.sock ARE listening
  const liveHostSock = createServer((_req, res) => res.end('{}'));
  const liveChanSock = createServer((_req, res) => res.end('{}'));
  await new Promise<void>((resolve) => liveHostSock.listen(join(botRuntimeDir, 'host.sock'), resolve));
  await new Promise<void>((resolve) => liveChanSock.listen(join(botRuntimeDir, 'channel.sock'), resolve));
  try {
    const liveBotHtml = await (await send('/console/settings?tab=bot', { headers: { cookie: adminCookie } })).text();
    assert.equal(
      (liveBotHtml.match(/<span class="ch-badge ch-badge--pass"><span class="ch-dot ch-dot--pass" aria-hidden="true"><\/span>运行中<\/span>/g) ?? []).length,
      3,
      'status box, host.sock, and channel.sock must all show 运行中 when listening',
    );
  } finally {
    await new Promise<void>((resolve) => liveHostSock.close(() => resolve()));
    await new Promise<void>((resolve) => liveChanSock.close(() => resolve()));
  }

  // Verify wordingProblems also passes when bot-runtime has wrong mode (0o755) or is a regular file
  await chmod(botRuntimeDir, 0o755);
  const badModeHtml = await (await send('/console/settings?tab=bot', { headers: { cookie: adminCookie } })).text();
  assert.ok(badModeHtml.includes('权限为 0755（须为 0700）'));
  assert.deepEqual(wordingProblems(badModeHtml), [], 'bot settings page must pass wordingProblems on 0755');
  await rm(botRuntimeDir, { recursive: true, force: true });
  await writeFile(botRuntimeDir, 'not-a-dir');
  const badTypeHtml = await (await send('/console/settings?tab=bot', { headers: { cookie: adminCookie } })).text();
  assert.ok(badTypeHtml.includes('不是普通目录'));
  assert.deepEqual(wordingProblems(badTypeHtml), [], 'bot settings page must pass wordingProblems on non-dir');
  await rm(botRuntimeDir, { force: true });

  // S12: channel-hub default value uses originOf(ctx) for HTTPS/loopback and falls back to http://127.0.0.1:<port> for non-loopback HTTP
  const { settingsPage } = await import('./console/settings.ts');
  const { pageContext } = await import('./console/console-http.ts');
  const { SessionStore } = await import('./console/session.ts');
  const { JobStore } = await import('./console/manage.ts');
  const { PackStaging } = await import('./console/staging.ts');
  const makeChannelDefaultTest = async (origin: string, secure: boolean) => {
    await hub.records.vault.remove('personal-bot.channel');
    const urlObj = new URL(origin + '/console/settings?tab=bot');
    const ctx = pageContext(
      {
        deps: { ...hub.deps, config: { ...hub.deps.config, port: 4321 } },
        sessions: new SessionStore(),
        ownOrigins: () => new Set([origin]),
        log() {},
        jobs: new JobStore(),
        staging: new PackStaging(),
        secureRequest: () => secure,
      },
      { headers: { host: urlObj.host } } as never,
      urlObj,
      hub.admin.principal,
      { id: 's1', token: hub.admin.token, csrf: 'c1', expires: Date.now() + 60_000, created: Date.now() } as never,
      secure,
    );
    const rendered = await settingsPage({ ...ctx, origin, secure }, null);
    return /id="channel-hub"[^>]*value="([^"]*)"/.exec(rendered.body.text)?.[1];
  };
  assert.equal(await makeChannelDefaultTest('http://localhost:4321', false), 'http://localhost:4321');
  assert.equal(await makeChannelDefaultTest('https://hub.example.invalid', true), 'https://hub.example.invalid');
  assert.equal(await makeChannelDefaultTest('http://hub.example.invalid:4321', false), 'http://127.0.0.1:4321');

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
  const binds = identityAudits.filter((a) => a.action === 'bind');
  const unbinds = identityAudits.filter((a) => a.action === 'unbind');
  assert.equal(binds.length, 2);
  assert.equal(unbinds.length, 2);
  assert.ok(unbinds.every((u) => u.reason === 'manual' && u.by === hub.admin.principal.id));
  assert.ok(unbinds.every((u) => /^[0-9a-f]{64}$/.test(u.issuer) && u.issuer !== sha256Hex(issuerA) && u.issuer !== sha256Hex(issuerB)));
  assert.deepEqual(
    unbinds.map((u) => u.issuer).sort(),
    binds.map((b) => b.issuer).sort(),
  );

  // R11 + F5/F14: bot disable sends { owner: '_hub', op: { action: 'disable' }, configVersion } when host.sock is present and prints notified stdout
  await mkdir(botRuntimeDir, { recursive: true, mode: 0o700 });
  const disableRequests: Array<{ owner?: unknown; op?: { action?: string }; configVersion?: number }> = [];
  const disableHostServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    disableRequests.push(
      JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        owner?: unknown;
        op?: { action?: string };
        configVersion?: number;
      },
    );
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => disableHostServer.listen(join(botRuntimeDir, 'host.sock'), resolve));
  try {
    const disableRes = await bridge.run(['bot', 'disable'], { token: hub.admin.token });
    assert.equal(disableRes.code, 0, disableRes.stderr.join('\n'));
    assert.ok(disableRes.stdout.join('\n').includes('机器人模型已停用，已通知宿主'));
    assert.equal(disableRes.stderr.length, 0);
    assert.equal(disableRequests.length, 1);
    assert.deepEqual(disableRequests[0], { owner: '_hub', op: { action: 'disable' }, configVersion: 6 });
  } finally {
    await new Promise<void>((resolve) => disableHostServer.close(() => resolve()));
  }

  // M2: bot set & bot disable report 通知宿主失败：<原因> (masked) when host returns 500 or bot-runtime is 0755, and 宿主当前未连接 ONLY when socket is absent
  const err500Host = createServer(async (req, res) => {
    for await (const _ of req) {
      // drain
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ message: `host 500 with ${modelKey}` }));
  });
  await new Promise<void>((resolve) => err500Host.listen(join(botRuntimeDir, 'host.sock'), resolve));
  try {
    const set500 = await bridge.run(['bot', 'set'], {
      token: hub.admin.token,
      secrets: {
        'bot-model': JSON.stringify({
          name: '报错测试',
          protocol: 'openai',
          model: 'demo-model',
          endpoint: 'https://model.example.invalid/v1',
          key: modelKey,
        }),
      },
    });
    assert.equal(set500.code, 0);
    assert.match(set500.stdout.join('\n'), /机器人模型配置已保存（通知宿主失败：.*\[REDACTED\].*）/);
    assert.ok(!set500.stdout.join('\n').includes(modelKey));
    assert.ok(!set500.stdout.join('\n').includes('宿主当前未连接'));
    assert.match(set500.stderr.join('\n'), /^通知机器人宿主配置变更失败（版本 7）：/);
    assert.ok(!set500.stderr.join('\n').includes(modelKey));

    const disable500 = await bridge.run(['bot', 'disable'], { token: hub.admin.token });
    assert.equal(disable500.code, 0);
    assert.match(disable500.stdout.join('\n'), /机器人模型已停用（通知宿主失败：.*\[REDACTED\].*）/);
    assert.ok(!disable500.stdout.join('\n').includes(modelKey));
    assert.ok(!disable500.stdout.join('\n').includes('宿主当前未连接'));

    await chmod(botRuntimeDir, 0o755);
    const setBadDir = await bridge.run(['bot', 'set'], {
      token: hub.admin.token,
      secrets: {
        'bot-model': JSON.stringify({
          name: '目录错误测试',
          protocol: 'openai',
          model: 'demo-model',
          endpoint: 'https://model.example.invalid/v1',
          key: modelKey,
        }),
      },
    });
    assert.equal(setBadDir.code, 0);
    assert.match(setBadDir.stdout.join('\n'), /机器人模型配置已保存（通知宿主失败：bot-runtime 异常：权限为 0755（须为 0700））/);
    assert.ok(!setBadDir.stdout.join('\n').includes('宿主当前未连接'));

    const disableBadDir = await bridge.run(['bot', 'disable'], { token: hub.admin.token });
    assert.equal(disableBadDir.code, 0);
    assert.match(disableBadDir.stdout.join('\n'), /机器人模型已停用（通知宿主失败：bot-runtime 异常：权限为 0755（须为 0700））/);
    assert.ok(!disableBadDir.stdout.join('\n').includes('宿主当前未连接'));
    await chmod(botRuntimeDir, 0o700);
  } finally {
    await new Promise<void>((resolve) => err500Host.close(() => resolve()));
  }

  // With 0700 bot-runtime and ENOENT host.sock, bot set & bot disable report 宿主当前未连接
  await rm(join(botRuntimeDir, 'host.sock'), { force: true });
  const setMissingSock = await bridge.run(['bot', 'set'], {
    token: hub.admin.token,
    secrets: {
      'bot-model': JSON.stringify({
        name: '缺失套接字测试',
        protocol: 'openai',
        model: 'demo-model',
        endpoint: 'https://model.example.invalid/v1',
        key: modelKey,
      }),
    },
  });
  assert.equal(setMissingSock.code, 0);
  assert.ok(setMissingSock.stdout.join('\n').includes('机器人模型配置已保存（宿主当前未连接，将在下次调用时同步）'));
  const disableMissingSock = await bridge.run(['bot', 'disable'], { token: hub.admin.token });
  assert.equal(disableMissingSock.code, 0);
  assert.ok(disableMissingSock.stdout.join('\n').includes('机器人模型已停用（宿主当前未连接，将在下次调用时同步）'));
});
