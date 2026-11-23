import { evidence, tooltip, field, facts, technicalCode, technical } from './presentation.ts';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BOT_MODEL_PROTOCOL, BOT_SECRET_SLOT, labelOf, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { BotSecretChangeAudit } from '../../../contracts/src/resources.ts';
import { MANIFEST_FILE, layoutAt, listBackups } from '../../platform/api.ts';
import { maskPlaceholder } from '../../records/api.ts';
import type { CommandRun } from '../command-bridge.ts';
import { inspectBotRuntimeDir, probeBotSocket, readBotProfile, readChannel, readIdentity, type BotProfile } from '../personal-bot.ts';
import { commands } from './commands.ts';
import { connectedClients, clientLabel } from './circles.ts';
import { CLIENT_COLUMNS, clientRow } from './connections.ts';
import { code, href, html, link, liveModule, page, pageLayout, pre, table, type Html } from './html.ts';
import { circleEntry, originOf, neutralPage, type PageContext, type PageResult } from './context.ts';
import { registeredActionForm } from './command-form.ts';
import { actionForm } from './manage.ts';
import { errorLine, segments } from './components.ts';
import { resetRebuildSection } from './reset.ts';
import { box, card, chip, commandLink, commandModal, duration, kv, sectionHead, when, type CommandDialog } from './ui.ts';

export type { HubFacts } from './context.ts';
export { circleEntry, originOf } from './context.ts';

export function certificateFacts(pem: string | null, now: number): { fingerprint: string; daysLeft: number; validTo: string } | null {
  if (pem === null) return null;
  try {
    const cert = new X509Certificate(pem);
    const end = Date.parse(cert.validTo);
    return { fingerprint: cert.fingerprint256, daysLeft: Math.floor((end - now) / 86_400_000), validTo: new Date(end).toISOString() };
  } catch {
    return null;
  }
}

export async function authorityFingerprint(dataDir: string): Promise<string | null> {
  try {
    return new X509Certificate(await readFile(join(dataDir, 'tls', 'ca.crt'))).fingerprint256;
  } catch {
    return null;
  }
}

/** Steps to trust this Hub's certificate authority in a browser, per operating system of the reader's computer. */
export function trustSteps(): Html {
  return html`<details><summary>浏览器信任步骤（macOS / Linux / Windows）</summary>
<p>${tooltip('颁发机构证书','把 Hub 数据文件夹中的 tls/ca.crt 复制到装有客户端的电脑，按系统导入，并在客户端的信任证书设置中填写路径。')}</p>
<ol class="ch-meta">
<li><b>macOS</b>：双击证书加入“钥匙串访问”的“系统”钥匙串，打开证书，在“信任”中将“使用此证书时”设为“始终信任”。</li>
<li><b>Linux</b>：复制到 ${code('/usr/local/share/ca-certificates/circle-hub.crt')}，执行 ${code('sudo update-ca-certificates')}；Firefox 在“设置 → 隐私与安全 → 证书”中导入。</li>
<li><b>Windows</b>：双击证书，选择“安装证书”，存储位置选“本地计算机”，放入“受信任的根证书颁发机构”。</li>
</ol>
</details>`;
}

/**
 * The Hub's storage as it can be read now: the complete backups under the data root (`circle-hub backup` writes them;
 * the newest by its manifest's created_at) and the database's size. Each is null when it cannot be read: unknown, not none.
 */
export async function storageFacts(ctx: PageContext): Promise<{ backups: { count: number; latest_at: string | null } | null; database_bytes: number | null }> {
  let backups: { count: number; latest_at: string | null } | null = null;
  try {
    const dirs = await listBackups(layoutAt(ctx.deps.config.dataDir));
    const newest = dirs.at(-1);
    let latest: string | null = null;
    if (newest !== undefined) {
      const created = (JSON.parse(await readFile(join(newest, MANIFEST_FILE), 'utf8')) as { created_at?: unknown } | null)?.created_at;
      latest = typeof created === 'string' && !Number.isNaN(Date.parse(created)) ? created : null;
    }
    backups = { count: dirs.length, latest_at: latest };
  } catch {
    backups = null;
  }
  let bytes: number | null = null;
  try {
    const size = await ctx.deps.records.store.databaseSize?.();
    bytes = typeof size === 'number' && Number.isFinite(size) ? size : null;
  } catch {
    bytes = null;
  }
  return { backups, database_bytes: bytes };
}

/** The shared binary size formatter, retained under the settings helper name. */
export {size as sizeText} from './format.ts';
import {size as sizeText} from './format.ts';

async function hubState(ctx: PageContext): Promise<Html> {
  const facts = ctx.hub;
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const cert = certificateFacts(facts?.certificate ?? null, now);
  const authority = cert === null ? null : await authorityFingerprint(ctx.deps.config.dataDir);
  const service = box({ title: '服务', tail: chip('运行中', 'pass') }, kv([
    ['Hub 版本', facts?.release ? code(facts.release) : '未记录'],
    ['已运行', facts === undefined ? '未记录' : duration(now - facts.startedAt.getTime())],
    ['访问地址', code(originOf(ctx))],
  ]));
  const certificate = cert === null
    ? box({ title: '证书',hint:'启用内置 HTTPS 后显示证书指纹与有效期。', tail: chip('未启用 HTTPS', 'unchecked') }, html`<p class="ch-meta">内置 HTTPS 未启用</p>`)
    : box({ title: '证书', tail: chip(`剩余 ${cert.daysLeft} 天`, cert.daysLeft > 30 ? 'pass' : 'incomplete') }, html`${kv([
        ['颁发机构指纹', authority === null ? '未读到颁发机构证书' : html`${technicalCode(authority)}`],
        ['服务器证书指纹', html`${technicalCode(cert.fingerprint)}`],
        ['有效期至', when(cert.validTo)],
      ])}${ctx.admin ? trustSteps() : ''}`);
  const storage = await storageFacts(ctx);
  const database = box({ title: '数据库', meta: 'PostgreSQL' }, kv([
    ['大小', storage.database_bytes === null ? '暂不可读' : sizeText(storage.database_bytes)],
    ['连接', '仅服务器本地连接，未开放网络端口'],
    ['记录', '仅追加，已写入的记录不可修改'],
  ]));
  const backups = storage.backups;
  const backupState = backups === null
    ? html`<p class="ch-meta">备份信息暂不可读。</p>`
    : backups.count === 0
      ? html`<p class="ch-meta">尚无备份。</p>`
      : kv([['最近备份', backups.latest_at === null ? '时间未读到' : when(backups.latest_at)], ['份数', `${backups.count} 份`]]);
  const backup = box({ title: '备份',hint:'备份在运行 Hub 的服务器上执行。', ...(ctx.admin ? { tail: commandLink(commands.backup(), '备份命令…', 'ch-btn ch-btn--ghost') } : {}) }, backupState);
  // Decision 151, step 8: four cards, two a row, each with its state at the head. They were four bare columns.
  return html`<section class="ch-section" data-columns="2" data-hub-state>${service}${certificate}${backup}${database}</section>`;
}

export interface SecretRow {
  name: string;
  by: string;
  at: string;
  withdrawn: boolean;
  version: number | null;
  digestRule: string | null;
  length: number | null;
  entry: string | null;
}

export interface Secrets {
  rows: SecretRow[] | null;
  /** The text of `secret list` when the records have no variables port (or it failed). */
  text: CommandRun | null;
}

type VaultSecretMeta = {
  name: string;
  entry: string;
  version: number;
  digest_rule: string;
  length: number;
  set_by: string | null;
  set_at: string | null;
  revoked: boolean;
};

const UNKNOWN = '未知';

async function whoSet(ctx: PageContext, id: string | null | undefined): Promise<string> {
  if (id === null || id === undefined || id === '') return UNKNOWN;
  return ctx.userName(id);
}

function whenOrUnknown(at: string | null | undefined): string {
  return at === null || at === undefined || at === '' ? UNKNOWN : at;
}

export async function secretsOf(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<Secrets> {
  const variables = ctx.deps.records.variables as {
    listSecrets?: (by: typeof ctx.principal) => Promise<VaultSecretMeta[]>;
  } | undefined;
  if (variables?.listSecrets !== undefined) {
    try {
      const rows: SecretRow[] = [];
      for (const meta of await variables.listSecrets(ctx.principal)) {
        rows.push({
          name: meta.name,
          by: await whoSet(ctx, meta.set_by),
          at: whenOrUnknown(meta.set_at),
          withdrawn: meta.revoked,
          version: meta.version,
          digestRule: meta.digest_rule,
          length: meta.length,
          entry: meta.entry,
        });
      }
      return { rows, text: null };
    } catch {
    }
  }
  return { rows: null, text: run === null ? null : await run(['secret', 'list']) };
}

/**
 * The masking dictionary, for an administrator (B02 R[11], decision 159): the rules in force, what each puts in place of a
 * match, and the commands that change them. A pattern is not a secret and is shown; nothing a rule matched is kept anywhere.
 */
async function maskingCard(ctx: PageContext, dialogs: CommandDialog[]): Promise<Html | null> {
  const store = ctx.deps.records.masking;
  if (store === undefined) return null;
  const set = commands.maskSet();
  dialogs.push(set);
  const hint = '读业务系统的文本内容时，命中规则的片段先换成方括号里的文字再保存；包函数、模型和页面看到的都是替换后的内容，被替换的值 Hub 不保存。只处理文本，表格、压缩包等文件原样保存。成员上传和写入的内容不替换。';
  let body: Html;
  try {
    const state = await store.list(ctx.principal);
    const removals = state.rules.map((rule) => commands.maskRemove(rule.name));
    dialogs.push(...removals);
    body = table(['规则', '替换成', '模式', '操作'], state.rules.map((rule, index) => [rule.name, maskPlaceholder(rule.label), html`${code(rule.pattern)}${rule.ignore_case ? html` <span class="ch-meta">不区分大小写</span>` : ''}`, commandLink(removals[index], '删除…', 'ch-btn ch-btn--sm ch-btn--ghost')]), { title: '还没有遮盖规则', text: '业务系统的内容原样保存。添加规则后，命中的密码、密钥等片段在保存前被替换。' });
  } catch {
    body = errorLine('遮盖字典暂不可用');
  }
  return html`<section id="masking">${box({ title: '遮盖字典', hint, tail: commandLink(set, '添加规则…', 'ch-btn ch-btn--sm ch-btn--secondary') }, body, { flush: true })}</section>`;
}

export async function settingsPage(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<PageResult> {
  return ctx.admin ? adminSettings(ctx, run) : memberSettings(ctx);
}

/** The two tabs of the settings page (decision 151, step 8): the first is the reader's own list, the second the Hub's state. */
function settingsTabs(first: string, hub: boolean, total?: number, bot = false): Html {
  return segments('设置内容', [
    { href: '/console/settings', label: first, count: total, current: !hub && !bot },
    { href: href('/console/settings', { tab: 'hub' }), label: 'Hub 状态', current: hub },
    ...(first === '凭据' ? [{ href: href('/console/settings', { tab: 'bot' }), label: '机器人', current: bot }] : []),
  ], 'data-settings-tabs');
}

function botModelForm(profile: BotProfile | null, csrf: string): Html {
  const id = 'bot';
  const fields = html`<div data-fields>
    ${field('机器人名称', html`<input id="${id}-name" name="name" required maxlength="256" value="${profile?.name ?? ''}">`)}
    ${field('接口协议', html`<select id="${id}-protocol" name="protocol">${BOT_MODEL_PROTOCOL.map((p) => html`<option value="${p}"${profile?.protocol === p ? html` selected` : ''}>${uiLabelOf('bot_model_protocol', p)}</option>`)}</select>`)}
    ${field('模型服务地址', html`<input id="${id}-endpoint" name="endpoint" type="url" required spellcheck="false" value="${profile?.endpoint ?? ''}">`, '填写模型服务的 HTTPS 接口地址；仅本机调试时可使用回环 HTTP 地址。')}
    ${field('模型标识', html`<input id="${id}-model" name="model" required spellcheck="false" value="${profile?.model ?? ''}">`)}
    ${field('模型系列标识（选填）', html`<input id="${id}-family" name="family" maxlength="256" spellcheck="false" value="${profile?.family ?? ''}">`, '仅当需要按模型系列标识区分能力策略时填写，留空则按默认模型处理。')}
    ${field('模型密钥', html`<input id="${id}-key" name="value" type="password" autocomplete="new-password" required>`, '从模型服务商控制台获取；保存时加密写入密钥库，页面不回显旧密钥。')}
  </div>`;
  return actionForm('bot-set', csrf, fields, profile ? '保存并轮换密钥' : '保存配置', { primary: true });
}

function defaultChannelHubUrl(ctx: PageContext): string {
  const origin = originOf(ctx);
  try {
    const parsed = new URL(origin);
    if (
      parsed.protocol === 'https:' ||
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
    ) {
      return origin;
    }
  } catch {
    // Fall back to loopback HTTP URL when origin is unavailable or non-loopback HTTP.
  }
  return `http://127.0.0.1:${ctx.deps.config.port}`;
}

async function recentBotSecretChanges(ctx: PageContext): Promise<Array<{ slot: typeof BOT_SECRET_SLOT[number]; action: Parameters<typeof labelOf<'bot_secret_action'>>[1]; by: string; at: string }>> {
  const store = ctx.deps.records.store;
  if (!store) return [];
  try {
    const rawItems =
      typeof store.findMany === 'function'
        ? await store.findMany({ kind: 'action', key: 'bot.secret.slot', values: [...BOT_SECRET_SLOT] })
        : (await store.list({ kind: 'action', newestFirst: true, limit: 100 })).items;
    const rows: Array<{ slot: typeof BOT_SECRET_SLOT[number]; action: Parameters<typeof labelOf<'bot_secret_action'>>[1]; by: string; at: string }> = [];
    for (const item of rawItems) {
      if (item.schema !== 'bot-secret-change@1') continue;
      const parsed = BotSecretChangeAudit.safeParse(item.body);
      if (parsed.success) {
        rows.push({
          slot: parsed.data.slot,
          action: parsed.data.action,
          by: parsed.data.by,
          at: parsed.data.at,
        });
      }
    }
    rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    return rows.slice(0, 20);
  } catch {
    return [];
  }
}

async function adminBotSettings(
  ctx: PageContext,
  run: ((argv: string[]) => Promise<CommandRun>) | null,
): Promise<PageResult> {
  const secrets = await secretsOf(ctx, run);
  const vault = typeof ctx.deps.records.vault?.get === 'function' ? ctx.deps.records.vault : null;
  const csrf = ctx.csrf ?? '';
  const profile = vault ? await readBotProfile(vault).catch(() => null) : null;
  const identity = vault ? await readIdentity(vault).catch(() => null) : null;
  const channel = vault ? await readChannel(vault).catch(() => null) : null;

  const runtimeDir = await inspectBotRuntimeDir(ctx.deps.config.dataDir);
  const [hostConnected, channelConnected] = runtimeDir.ok
    ? await Promise.all([
        probeBotSocket(ctx.deps.config.dataDir, 'host'),
        probeBotSocket(ctx.deps.config.dataDir, 'channel'),
      ])
    : [false, false];

  const statusBox = box(
    {
      title: '运行状态',
      hint: '显示机器人运行文件夹权限与宿主进程、通道适配器的本地连接状态。',
      tail: chip(
        runtimeDir.ok && hostConnected ? '运行中' : runtimeDir.ok ? '未连接' : '异常',
        runtimeDir.ok && hostConnected ? 'pass' : runtimeDir.ok ? 'incomplete' : 'fail',
      ),
    },
    kv([
      [
        html`运行文件夹 ${code('bot-runtime')}`,
        runtimeDir.ok
          ? html`${chip('正常', 'pass')} ${code('0700')}`
          : html`${chip('异常', 'fail')} ${evidence(runtimeDir.reason)}`,
      ],
      [html`宿主连接 ${code('host.sock')}`, hostConnected ? chip('运行中', 'pass') : chip('未连接', 'unchecked')],
      [html`通道连接 ${code('channel.sock')}`, channelConnected ? chip('运行中', 'pass') : chip('未连接', 'unchecked')],
    ], { wide: true }),
  );

  const modelCard = box(
    {
      title: '机器人模型',
      hint: '配置对话接口地址、协议与密钥，供客户端发起对话与上传附件；密钥只写不回显。',
      tail: chip(profile ? '已配置' : '未配置', profile ? 'pass' : 'unchecked'),
    },
    html`<p class="ch-meta">请从模型服务提供方获取接口协议、服务地址、模型标识和访问密钥。</p>${botModelForm(profile, csrf)}${profile ? html`<div class="ch-actions">${actionForm('bot-test', csrf, '', '测试连接', { primary: false })}${actionForm('bot-disable', csrf, '', '停用', { primary: false })}</div>` : ''}`,
  );

  const applicationForm = actionForm(
    'bot-identity',
    csrf,
    html`<div data-fields>
      ${field('租户标识', html`<input name="tenant" id="bot-tenant" required value="${identity?.tenant ?? ''}">`, '填写外部身份平台中的组织或企业租户标识。')}
      ${field('登录应用标识', html`<input name="application" id="bot-app" required value="${identity?.application ?? ''}">`, '填写外部扫码登录应用的应用标识。')}
      ${field('登录应用密钥', html`<input name="value" id="bot-app-secret" type="password" autocomplete="new-password" required>`, '从外部应用管理后台获取密钥；保存时加密写入密钥库，不回显旧密钥。')}
    </div>`,
    '保存登录应用',
    { primary: true },
  );
  const identityCard = box(
    {
      title: '扫码登录应用',
      hint: '配置外部扫码登录应用参数与回调地址；成员绑定后可用于控制台扫码登录与私聊通道身份对应。',
      tail: chip(identity ? '已配置' : '未配置', identity ? 'pass' : 'unchecked'),
    },
    html`<p class="ch-meta">请在外部应用管理后台将回调地址设为 ${code(originOf(ctx) + '/console/identity/callback')}，再填入租户标识、登录应用标识与密钥。</p>${applicationForm}${identity ? html`<div class="ch-actions"><form method="post" action="/console/identity/bind"><input type="hidden" name="csrf" value="${csrf}"><button class="ch-btn ch-btn--secondary" type="submit">扫码绑定本人身份</button></form></div>` : ''}`,
  );

  const channelForm = actionForm(
    'bot-channel',
    csrf,
    html`<div data-fields>
      ${field('机器人标识', html`<input name="bot" id="channel-id" required value="${channel?.bot ?? ''}">`, '填写外部消息平台中创建的机器人标识。')}
      ${field('适配器访问 Hub 的地址', html`<input name="hub" id="channel-hub" type="url" value="${channel?.hub ?? defaultChannelHubUrl(ctx)}" required>`, '填写通道适配器在本地或内网访问当前 Hub 的根地址，须为 HTTPS 或回环 HTTP 地址。')}
      ${field('通道机器人密钥', html`<input name="value" id="channel-secret" type="password" autocomplete="new-password" required>`, '从外部消息平台机器人详情页获取通道密钥；保存时加密写入密钥库，不回显旧密钥。')}
    </div>`,
    '保存私聊通道',
    { primary: true },
  );
  const channelCard = box(
    {
      title: '私聊机器人通道',
      hint: '配置外部消息适配器接入 Hub 所需的机器人标识、访问地址与密钥，并控制通道启停。',
      tail: chip(
        channel ? (channel.enabled ? '已请求启用' : '已配置，已停用') : '未配置',
        channel ? (channel.enabled ? 'pass' : 'incomplete') : 'unchecked',
      ),
    },
    html`<p class="ch-meta">请从外部消息平台获取机器人标识与密钥；保存通道与扫码登录应用后，可在此请求启用或停止私聊通道。</p>${channelForm}${channel && identity ? html`<div class="ch-actions">${actionForm(channel.enabled ? 'bot-channel-stop' : 'bot-channel-start', csrf, '', channel.enabled ? '停止私聊通道' : '启动私聊通道', { primary: false })}</div>` : ''}`,
  );

  const changes = await recentBotSecretChanges(ctx);
  const changeRows: unknown[][] = [];
  for (const row of changes) {
    const actorName = await ctx.userName(row.by);
    changeRows.push([
      labelOf('bot_secret_slot', row.slot),
      labelOf('bot_secret_action', row.action),
      actorName,
      when(row.at),
    ]);
  }
  const auditBox = box(
    {
      title: '最近配置变更',
      hint: '记录每次机器人模型、扫码登录应用与私聊通道的配置更改，不含密钥原文。',
    },
    table(
      ['配置项', '操作', '操作人', '时间'],
      changeRows,
      { title: '尚无配置变更记录', text: '保存、停用或启停机器人配置后，变更记录列在这里。' },
    ),
    { flush: changeRows.length > 0 },
  );

  const body = html`<div class="ch-stack" data-settings>${settingsTabs('凭据', false, secrets.rows?.length, true)}<div class="ch-stack" data-settings-tab="bot">${statusBox}${modelCard}${identityCard}${channelCard}${auditBox}</div></div>`;
  return {
    status: 200,
    body: page(
      ctx.chrome('设置', {
        active: 'settings',
        hint: '配置机器人模型、扫码登录应用、私聊通道与运行状态',
      }),
      pageLayout(body, { inspector: null }),
    ),
  };
}

async function adminSettings(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<PageResult> {
  if (ctx.url.searchParams.get('tab') === 'bot') return adminBotSettings(ctx, run);
  const dialogs: CommandDialog[] = [];
  const secrets = await secretsOf(ctx, run);
  const secretName=ctx.url.searchParams.get('secret'),selectedSecret=secrets.rows?.find(secret=>secret.name===secretName);
  if(secretName&&!selectedSecret)return neutralPage(ctx);
  const hub = !selectedSecret && ctx.url.searchParams.get('tab') === 'hub';
  let secretBody: Html;
  if (secrets.rows !== null) {
    const rows = secrets.rows.map((secret) => {
      const set = commands.secretSet(secret.name);
      const unset = commands.secretUnset(secret.name);
      if (!secret.withdrawn&&secret.name===secretName) dialogs.push(set, unset);
      return [
        link('/console/settings',secret.name,{secret:secret.name}),
        secret.by,
        secret.at === UNKNOWN ? UNKNOWN : when(secret.at),
        secret.withdrawn ? chip('已吊销', 'unchecked') : html`<span class="ch-meta">•••••••• 已加密</span>`,
      ];
    });
    secretBody = table([tooltip('名称', '业务系统与运行环境的凭据加密保存；页面、记录与模型只可见名称。更新与吊销在运行 Hub 的服务器上执行'), '设置人', '更新时间', '内容'], rows, { title: '尚无凭据', text: '接入业务系统时设置。' },undefined,{selected:secrets.rows.findIndex(secret=>secret.name===secretName),hrefs:secrets.rows.map(secret=>'/console/settings?'+new URLSearchParams({secret:secret.name}))});
  } else if (secrets.text === null) {
    secretBody = errorLine('凭据列表暂不可用');
  } else if (secrets.text.code === 0) {
    secretBody = secrets.text.stdout.length > 0 ? pre(secrets.text.stdout.join('\n')) : html`<p class="empty">尚无凭据：接入业务系统时设置</p>`;
  } else {
    secretBody = html`<pre class="error"><code>${[...secrets.text.stdout, ...secrets.text.stderr].join('\n')}</code></pre>`;
  }
  // The masking dictionary stands under the credentials (B02 R[11]): what the Hub replaces in a business system's answer.
  const masking = hub ? null : await maskingCard(ctx, dialogs);
  // The host operations and their dialogs are the Hub tab's; the credential tab carries no dialog nothing on it opens.
  const stopping = [commands.backup(), commands.restore(), commands.tlsIssue()];
  if (hub) dialogs.push(...stopping);
  const setSecret = hub || selectedSecret ? '' : card(
    { title: '设置凭据', hint: '不必先有资源或执行器引用这个名字；内容只进密钥库，不进命令参数和页面。' },
    registeredActionForm('secret-set', ctx.csrf ?? '', '设置', { primary: true }),
  );
  const content = hub
    ? html`${await hubState(ctx)}
${box({title:'服务器上的操作',hint:'控制台不执行这些操作；在运行 Hub 的服务器上执行。部署与回滚在运行 Hub 的服务器上通过 circle-hub deploy 和 circle-hub rollback 执行。'}, html`<div class="ch-actions">${stopping.map((dialog) => commandLink(dialog, dialog.title))}</div>`)}
${resetRebuildSection(ctx)}`
    : html`<section id="secrets">${box(null, secretBody, { flush: secrets.rows !== null })}</section>${setSecret}${masking ?? ''}`;
  const body = html`<div class="ch-stack" data-settings>${settingsTabs('凭据', hub, secrets.rows?.length)}<div class="ch-stack" data-settings-tab="${hub ? 'hub' : 'secrets'}">${content}</div>
${liveModule('dialogs', ['member.connected'], dialogs.filter(dialog=>!selectedSecret||!dialog.id.startsWith('cmd-secret')).map(commandModal))}</div>`;
  const inspectorFacts: Array<readonly [string, string | Html]> = selectedSecret ? [
    ['内容', selectedSecret.withdrawn ? '已吊销' : '已加密'],
    ['设置人', selectedSecret.by],
    ['更新时间', selectedSecret.at === UNKNOWN ? UNKNOWN : when(selectedSecret.at)],
    ...(selectedSecret.version === null ? [] : [['版本', String(selectedSecret.version)] as const]),
    ...(selectedSecret.digestRule === null ? [] : [['摘要规则', selectedSecret.digestRule] as const]),
    ...(selectedSecret.length === null ? [] : [['长度', String(selectedSecret.length)] as const]),
  ] : [];
  return {
    status: 200,
    body: page(ctx.chrome('设置', {
      active: 'settings',
      hint: '凭据与 Hub 状态；需人工处理的事项在运行 Hub 的服务器上完成',

    }),pageLayout(body,{detail:!!selectedSecret,back:link('/console/settings','返回设置'),inspector:selectedSecret?html`<div data-inspector-content><span class="ch-tag">凭据</span><h2 class="ch-panel-title">${selectedSecret.name}</h2>${facts(inspectorFacts)}${selectedSecret.entry?technical(html`<div>${code(selectedSecret.entry)}</div>`):''}<footer class="ch-inspector-actions">${selectedSecret.withdrawn?'':html`${commandLink(commands.secretUnset(selectedSecret.name),'吊销…','ch-btn ch-btn--danger')}${commandLink(commands.secretSet(selectedSecret.name),'更新…','ch-btn ch-btn--primary')}`}</footer>${dialogs.filter(dialog=>dialog.id.startsWith('cmd-secret')).map(commandModal)}</div>`:null})),
  };
}

async function memberSettings(ctx: PageContext): Promise<PageResult> {
  const binding = await ctx.deps.records.vault?.has?.('personal-bot.identity')?.catch(() => false)
    ? html`<form method="post" action="/console/identity/bind"><input type="hidden" name="csrf" value="${ctx.csrf ?? ''}"><button class="ch-btn" type="submit">扫码绑定本人身份</button></form>`
    : '';
  const hub = ctx.url.searchParams.get('tab') === 'hub';
  const tokens = await ctx.deps.records.principals.tokens(ctx.principal.id);
  const clients = hub ? [] : await connectedClients(ctx.deps.records, tokens.filter(token => token.revoked_at === null).map(token => ({ token, owner: ctx.principal.name })));
  const rows = clients.map(client => [...clientRow(client, clientLabel(client)), '由管理员断开']);
  const content = hub ? await hubState(ctx) : html`<section class="ch-section" data-columns="2" id="mine">
${liveModule('my-circles', ['member.connected'], card({ title: ctx.principal.name, lead: html`<span class="ch-avatar" aria-hidden="true">${[...ctx.principal.name][0] ?? ''}</span>`, tail: chip(uiLabelOf('permission_role', ctx.principal.role), 'plain') }, html`${sectionHead('我的客户端', undefined, undefined, undefined, '每台设备上的客户端独立连接；名称和版本照客户端报的写；断开由管理员执行')}${table([...CLIENT_COLUMNS,'操作'], rows, { title: '尚无已连接的客户端', text: '按“连接新的客户端”的配置连接后，客户端列在这里。' })}`))}
${card({ title: '连接新的客户端', meta: 'MCP 标准连接确认',hint:'下面是 mcpServers 格式的条目；其他客户端按各自的格式填写同一 MCP 地址。浏览器确认身份后允许连接；其他设备可使用管理员签发的邀请码。' }, html`<pre class="ch-quote"><code>${circleEntry(originOf(ctx), false)}</code></pre>`)}
</section>`;
  const body = html`<div class="ch-stack" data-settings>${settingsTabs('我的客户端', hub, tokens.filter(token => token.revoked_at === null).length)}<div class="ch-stack" data-settings-tab="${hub ? 'hub' : 'mine'}">${binding}${content}</div></div>`;
  return { status: 200, body: page(ctx.chrome('设置', { active: 'settings', hint: '我的客户端与 Hub 状态',  }),pageLayout(body,{inspector:null})) };
}

/** The old management pages of decision 122 land here; a member gets the neutral page as before. */
export function adminOnly(ctx: PageContext, render: () => Promise<PageResult>): Promise<PageResult> {
  return ctx.admin ? render() : Promise.resolve(neutralPage(ctx));
}

