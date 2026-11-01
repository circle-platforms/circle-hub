// 设置 (the design canvas's Admin board): members and the Circles connected with their tokens, credentials and the Hub's
// state for administrators; a member sees their own Circles and the Hub's state. The console runs only adding a member
// (proposal decision 6 of 2026-10-31); disabling, disconnecting, issuing a spare login token and changing a credential are
// commands for the administrator's Circle. Token values and credential contents are never shown.
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { MANIFEST_FILE, layoutAt, listBackups } from '../../platform/api.ts';
import type { TokenInfo, User } from '../../records/api.ts';
import type { CommandRun } from '../command-bridge.ts';
import { commands } from './commands.ts';
import { code, html, link, liveModule, page, pre, table, type Html } from './html.ts';
import { neutralPage, type PageContext, type PageResult } from './pages.ts';
import { button, card, chip, commandLink, commandModal, duration, kv, sectionHead, seg, when, type CommandDialog } from './ui.ts';

/** What the console knows about the process serving it, for the Hub's state. */
export interface HubFacts {
  /** The release this process serves (release.json), null without one. */
  release: string | null;
  startedAt: Date;
  /** PEM of the built-in HTTPS server certificate, null when HTTPS is off. */
  certificate: string | null;
}

/** The Circle entry of this Hub (the `mcp_servers` block of Circle's settings), with the token as a secret reference. */
/**
 * The Circle settings entry for this Hub: without headers for the MCP standard authorization (the client opens the
 * authorization page in a browser), or with the token kept as a Circle secret for a client without it.
 */
export function circleEntry(origin: string, token = true): string {
  const entry = { name: 'circle-hub', url: `${origin}/mcp`, transport: 'streamable_http' };
  return JSON.stringify({ mcp_servers: [token ? { ...entry, headers: { Authorization: 'Bearer ${secret:CIRCLE_HUB_TOKEN}' } } : entry] }, null, 2);
}

/** The origin a browser reached this console on: the scheme of the channel and the Host it sent. */
export function originOf(ctx: PageContext): string {
  return ctx.origin ?? `${ctx.secure ? 'https' : 'http'}://${ctx.url.host}`;
}

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

/** A fingerprint shortened as the design shows it: the first three and the last two bytes. */
const shortPrint = (fingerprint: string): string => {
  const bytes = fingerprint.split(':');
  return bytes.length <= 6 ? fingerprint : `${bytes.slice(0, 3).join(':')}:…:${bytes.slice(-2).join(':')}`;
};

/** Steps to trust this Hub's certificate authority in a browser, per operating system of the reader's computer. */
export function trustSteps(): Html {
  return html`<details class="mt12"><summary>浏览器信任步骤（macOS / Linux / Windows）</summary>
<p class="sub mt8">颁发机构证书位于 Hub 数据目录的 ${code('tls/ca.crt')}，复制到访问控制台的电脑后：</p>
<ol class="small">
<li><b>macOS</b>：双击证书加入“钥匙串访问”的“系统”钥匙串，打开证书，在“信任”中将“使用此证书时”设为“始终信任”。</li>
<li><b>Linux</b>：复制到 ${code('/usr/local/share/ca-certificates/circle-hub.crt')}，执行 ${code('sudo update-ca-certificates')}；Firefox 在“设置 → 隐私与安全 → 证书”中导入。</li>
<li><b>Windows</b>：双击证书，选择“安装证书”，存储位置选“本地计算机”，放入“受信任的根证书颁发机构”。</li>
</ol>
<p class="sub">Circle 在设置的 ${code('trust_cert_files')} 中写入证书路径后即信任本 Hub。</p></details>`;
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

/** Bytes as the page shows them: MB with one decimal from 1 MB on. */
export function sizeText(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function hubState(ctx: PageContext): Promise<Html> {
  const facts = ctx.hub;
  const now = (ctx.deps.now?.() ?? new Date()).getTime();
  const cert = certificateFacts(facts?.certificate ?? null, now);
  const authority = cert === null ? null : await authorityFingerprint(ctx.deps.config.dataDir);
  const service = card({ title: '服务', lead: html`<span class="dot ok live" aria-hidden="true"></span>`, tail: chip('运行中', 'pass') }, kv([
    ['版本', facts?.release ? code(facts.release) : '未记录'],
    ['已运行', facts === undefined ? '—' : duration(now - facts.startedAt.getTime())],
    ['访问地址', code(originOf(ctx))],
  ]));
  const certificate = cert === null
    ? card({ title: '证书', lead: html`<span class="dot idle" aria-hidden="true"></span>`, tail: chip('未启用 HTTPS', 'unchecked') }, html`<p class="sub">Hub 未启用内置 HTTPS；启用后在此显示证书指纹与有效期。</p>`)
    : card({ title: '证书', lead: html`<span class="dot ${cert.daysLeft > 30 ? 'ok' : 'warn'}" aria-hidden="true"></span>`, meta: `剩余 ${cert.daysLeft} 天` }, html`${kv([
        ['颁发机构指纹', authority === null ? '未读到颁发机构证书' : html`<code title="${authority}">${shortPrint(authority)}</code>`],
        ['服务器证书指纹', html`<code title="${cert.fingerprint}">${shortPrint(cert.fingerprint)}</code>`],
        ['有效期至', when(cert.validTo)],
      ])}${ctx.admin ? trustSteps() : ''}`);
  const storage = await storageFacts(ctx);
  const database = card({ title: '数据库', lead: html`<span class="dot ok" aria-hidden="true"></span>`, meta: 'PostgreSQL' }, kv([
    ['大小', storage.database_bytes === null ? '暂不可读' : sizeText(storage.database_bytes)],
    ['连接', '仅本机连接，未开放网络端口'],
    ['记录', '仅追加，已写入的记录不可修改'],
  ]));
  const backups = storage.backups;
  const backupState = backups === null
    ? html`<p class="sub">备份信息暂不可读。</p>`
    : backups.count === 0
      ? html`<p class="sub">尚无备份。</p>`
      : kv([['最近备份', backups.latest_at === null ? '时间未读到' : when(backups.latest_at)], ['份数', `${backups.count} 份`]]);
  const backup = card({ title: '备份', lead: html`<span class="dot ${backups !== null && backups.count > 0 ? 'ok' : 'idle'}" aria-hidden="true"></span>` }, html`${backupState}<p class="sub">备份在 Hub 所在的主机上执行。</p>${ctx.admin ? html`<div class="card-f">${commandLink(commands.backup(), '备份命令')}</div>` : ''}`);
  return html`<section class="grid g4">${service}${certificate}${backup}${database}</section>`;
}

/** Active tokens of a user: each one is a Circle (or a spare console login) that can connect. */
const active = (tokens: readonly TokenInfo[]): TokenInfo[] => tokens.filter((token) => token.revoked_at === null);

function lastUse(tokens: readonly TokenInfo[]): string | null {
  const times = tokens.map((token) => token.last_used_at).filter((at): at is string => at !== null).sort();
  return times.at(-1) ?? null;
}

export interface Secrets {
  rows: { name: string; consumers: string[]; by: string; at: string; withdrawn: boolean }[] | null;
  /** The text of `secret list` when the records have no variables port (or it failed). */
  text: CommandRun | null;
}

export async function secretsOf(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<Secrets> {
  const variables = ctx.deps.records.variables as { list?: (by: typeof ctx.principal) => Promise<import('../../records/api.ts').NamedVersion[]> } | undefined;
  if (variables?.list !== undefined) {
    try {
      const rows = [];
      for (const named of await variables.list(ctx.principal)) {
        if (named.kind !== 'secret') continue;
        const definition = named.definition as { consumers?: { definition: string; item: string }[] } | null;
        rows.push({
          name: named.name,
          consumers: (definition?.consumers ?? []).map((consumer) => `${consumer.definition} · ${consumer.item}`),
          by: await ctx.userName(named.decision.body.decided_by),
          at: named.decision.body.decided_at,
          withdrawn: named.decision.body.revoked,
        });
      }
      return { rows, text: null };
    } catch {
      // Fall back to the command's own listing below.
    }
  }
  return { rows: null, text: run === null ? null : await run(['secret', 'list']) };
}

export async function settingsPage(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<PageResult> {
  return ctx.admin ? adminSettings(ctx, run) : memberSettings(ctx);
}

async function adminSettings(ctx: PageContext, run: ((argv: string[]) => Promise<CommandRun>) | null): Promise<PageResult> {
  const { principals } = ctx.deps.records;
  const users: User[] = await principals.list();
  const dialogs: CommandDialog[] = [];
  const memberRows = [];
  const tokenRows = [];
  for (const user of users) {
    const tokens = await principals.tokens(user.id);
    const live = active(tokens);
    const toggle = user.disabled ? commands.userEnable(user) : commands.userDisable(user);
    const spare = commands.tokenIssue(user);
    const invite = commands.userInvite(user);
    dialogs.push(toggle, spare, ...(user.disabled ? [] : [invite]));
    memberRows.push([
      html`<span class="namecell"><span class="avatar" aria-hidden="true">${[...user.name][0] ?? ''}</span><span><b>${user.name}</b><span class="digest">${user.id}</span></span></span>`,
      chip(uiLabelOf('permission_role', user.role), user.role === 'admin' ? 'judgment' : 'plain'),
      `${live.length} 个`,
      when(lastUse(tokens)),
      user.disabled ? chip('已停用', 'unchecked') : chip('使用中', 'pass'),
      html`${commandLink(toggle, user.disabled ? '启用' : '停用')}${user.disabled ? '' : html` ${commandLink(invite, '签发邀请码')}`} ${commandLink(spare, '签发备用登录令牌')}`,
    ]);
    for (const token of tokens) {
      const revoke = commands.tokenRevoke(token, user.name);
      if (token.revoked_at === null) dialogs.push(revoke);
      tokenRows.push([
        code(token.id), user.name, token.label || '—', token.client === null ? '访问令牌' : '标准授权', when(token.created_at), when(token.last_used_at),
        token.revoked_at === null ? chip('已连接', 'pass') : chip(`已断开 ${when(token.revoked_at)}`, 'unchecked'),
        token.revoked_at === null ? commandLink(revoke, '断开') : '',
      ]);
    }
  }
  const secrets = await secretsOf(ctx, run);
  let secretBody: Html;
  if (secrets.rows !== null) {
    const rows = secrets.rows.map((secret) => {
      const set = commands.secretSet(secret.name);
      const unset = commands.secretUnset(secret.name);
      if (!secret.withdrawn) dialogs.push(set, unset);
      return [
        html`<b>${secret.name}</b>`,
        secret.consumers.length === 0 ? '—' : html`${secret.consumers.map((consumer) => html`<div>${consumer}</div>`)}`,
        secret.by, when(secret.at),
        secret.withdrawn ? chip('已吊销', 'unchecked') : html`<span class="sub">•••••••• 已加密</span>`,
        secret.withdrawn ? '' : html`${commandLink(set, '更新')} ${commandLink(unset, '吊销')}`,
      ];
    });
    secretBody = table(['名称', '用于', '设置人', '更新时间', '内容', '操作'], rows, '尚无凭据：接入业务系统时设置');
  } else if (secrets.text === null) {
    secretBody = html`<p class="error">凭据列表暂不可用</p>`;
  } else if (secrets.text.code === 0) {
    secretBody = secrets.text.stdout.length > 0 ? pre(secrets.text.stdout.join('\n')) : html`<p class="empty">尚无凭据：接入业务系统时设置</p>`;
  } else {
    secretBody = html`<pre class="error">${[...secrets.text.stdout, ...secrets.text.stderr].join('\n')}</pre>`;
  }
  const origin = originOf(ctx);
  const stopping = [commands.backup(), commands.restore(), commands.tlsIssue()];
  dialogs.push(...stopping);
  const body = html`<section class="section" id="people">${liveModule('members', ['member.connected'], card({ title: '成员', meta: `${users.length} 人` }, table(['姓名', '角色', '已连接的 Circle', '最近活动', '状态', '操作'], memberRows, '尚无成员')))}</section>
<div class="mt16">${liveModule('member-circles', ['member.connected'], card({ title: '已连接的 Circle', meta: '每个 Circle 一个令牌，可单独断开；不显示令牌内容' }, table(['令牌', '成员', '标签', '连接方式', '签发时间', '最近使用', '状态', '操作'], tokenRows, '尚无已连接的 Circle')))}</div>
<p class="note">停用、启用、断开、签发邀请码与签发备用登录令牌生成命令，在管理员的 Circle 中执行；管理员的 Circle 不可用时，在 Hub 所在的主机上执行同一命令。</p>
<section class="grid g2 section">
${card({ title: '连接新的 Circle', meta: 'MCP 标准授权' }, html`<p class="sub">把以下配置写入 Circle 的 settings.json${ctx.secure ? html`，并把颁发机构证书加入 ${code('trust_cert_files')}` : ''}。Circle 首次连接时在浏览器中打开授权页：浏览器已登录控制台时确认授权即可；否则输入${link('/console/operations/member', '添加成员')}时签发的邀请码。</p><pre class="snippet">${circleEntry(origin, false)}</pre>`)}
${card({ title: '以访问令牌连接', meta: '客户端不支持 MCP 标准授权时' }, html`<p class="sub">在 Circle 中用 ${code('/secrets CIRCLE_HUB_TOKEN')} 保存成员的令牌，再把以下配置写入 Circle 的 settings.json。令牌在添加成员时选择访问令牌签发，或签发备用登录令牌，仅显示一次。</p><pre class="snippet">${circleEntry(origin)}</pre>`)}
</section>
${sectionHead('凭据', '业务系统与运行环境的凭据加密保存；页面、记录与模型只可见名称。更新与吊销在 Circle 中执行', undefined, 'secrets')}
${card(null, secretBody)}
${sectionHead('Hub 状态', '服务、证书、备份与数据库', undefined, 'hub')}
${await hubState(ctx)}
${sectionHead('需停机或在主机上执行的操作', '控制台不执行这些操作；在 Hub 所在主机上的管理员 Circle 中执行')}
${card(null, html`<div class="row">${stopping.map((dialog) => commandLink(dialog, dialog.title))}</div><p class="sub mt12">部署与回滚见 ${code('circle-hub deploy')} 与 ${code('circle-hub rollback')}。</p>`)}
${liveModule('dialogs', ['member.connected'], dialogs.map(commandModal))}`;
  return {
    status: 200,
    body: page(ctx.chrome('设置', {
      active: 'settings',
      sub: '按成员、凭据与 Hub 状态组织；需人工处理的事项在对应的 Circle 中完成。',
      actions: html`${seg([['people', '成员'], ['secrets', '凭据'], ['hub', 'Hub 状态']], '设置分区')}${button('/console/operations/member', '添加成员', { primary: true, icon: 'plus' })}`,
    }), body),
  };
}

async function memberSettings(ctx: PageContext): Promise<PageResult> {
  const tokens = await ctx.deps.records.principals.tokens(ctx.principal.id);
  const rows = tokens.map((token) => [code(token.id), token.label || '—', token.client === null ? '访问令牌' : '标准授权', when(token.created_at), when(token.last_used_at), token.revoked_at === null ? chip('已连接', 'pass') : chip(`已断开 ${when(token.revoked_at)}`, 'unchecked')]);
  const body = html`<section class="grid g-2-1 section" id="mine">
${liveModule('my-circles', ['member.connected'], card({ title: ctx.principal.name, lead: html`<span class="avatar" aria-hidden="true">${[...ctx.principal.name][0] ?? ''}</span>`, tail: chip(uiLabelOf('permission_role', ctx.principal.role), 'plain') }, html`${sectionHead('我的 Circle', '每台设备上的 Circle 独立连接；不显示令牌内容')}${table(['令牌', '标签', '连接方式', '签发时间', '最近使用', '状态'], rows, '尚无已连接的 Circle')}<p class="sub mt12">断开连接由管理员在 Circle 中执行。</p>`))}
${card({ title: '连接新的 Circle', meta: 'MCP 标准授权' }, html`<p class="sub">把以下配置写入新设备上 Circle 的 settings.json。Circle 打开授权页后，在已登录控制台的浏览器中确认以本账号授权；在其他设备上，输入管理员签发的邀请码。</p><pre class="snippet">${circleEntry(originOf(ctx), false)}</pre>`)}
</section>
${sectionHead('Hub 状态', '服务、证书、备份与数据库', undefined, 'hub')}
${await hubState(ctx)}`;
  return { status: 200, body: page(ctx.chrome('设置', { active: 'settings', sub: '我的 Circle 与 Hub 状态。', actions: seg([['mine', '我的 Circle'], ['hub', 'Hub 状态']], '设置分区') }), body) };
}

/** The old management pages of decision 75 land here; a member gets the neutral page as before. */
export function adminOnly(ctx: PageContext, render: () => Promise<PageResult>): Promise<PageResult> {
  return ctx.admin ? render() : Promise.resolve(neutralPage(ctx));
}

