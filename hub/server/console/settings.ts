import {tooltip} from './presentation.ts';
import {dot} from './ui.ts';
import {stat,facts,technicalCode,technical} from './presentation.ts';
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
import { connectedClients, clientLabel } from './circles.ts';
import { CLIENT_COLUMNS, clientRow } from './connections.ts';
import { code, html, link, liveModule, page, pageLayout, pre, table, type Html } from './html.ts';
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
  return html`<details><summary>浏览器信任步骤（macOS / Linux / Windows）</summary>
<p>${tooltip('颁发机构证书','把 Hub 数据文件夹中的 tls/ca.crt 复制到本机，按系统导入，并在客户端的信任证书设置中填写路径。')}</p>
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
  const service = card({ title: '服务', lead: html`${dot('ok')}`, tail: chip('运行中', 'pass') }, kv([
    ['版本', facts?.release ? code(facts.release) : '未记录'],
    ['已运行', facts === undefined ? '—' : duration(now - facts.startedAt.getTime())],
    ['访问地址', code(originOf(ctx))],
  ]));
  const certificate = cert === null
    ? card({ title: '证书',hint:'启用内置 HTTPS 后显示证书指纹与有效期。', lead: html`${dot('idle')}`, tail: chip('未启用 HTTPS', 'unchecked') }, html`<p class="ch-meta">内置 HTTPS 未启用</p>`)
    : card({ title: '证书', lead: html`${dot(cert.daysLeft > 30 ? 'ok' : 'warn')}`, meta: `剩余 ${cert.daysLeft} 天` }, html`${kv([
        ['颁发机构指纹', authority === null ? '未读到颁发机构证书' : html`${technicalCode(authority)}`],
        ['服务器证书指纹', html`${technicalCode(cert.fingerprint)}`],
        ['有效期至', when(cert.validTo)],
      ])}${ctx.admin ? trustSteps() : ''}`);
  const storage = await storageFacts(ctx);
  const database = card({ title: '数据库', lead: html`${dot('ok')}`, meta: 'PostgreSQL' }, kv([
    ['大小', storage.database_bytes === null ? '暂不可读' : sizeText(storage.database_bytes)],
    ['连接', '仅本机连接，未开放网络端口'],
    ['记录', '仅追加，已写入的记录不可修改'],
  ]));
  const backups = storage.backups;
  const backupState = backups === null
    ? html`<p class="ch-meta">备份信息暂不可读。</p>`
    : backups.count === 0
      ? html`<p class="ch-meta">尚无备份。</p>`
      : kv([['最近备份', backups.latest_at === null ? '时间未读到' : when(backups.latest_at)], ['份数', `${backups.count} 份`]]);
  const backup = card({ title: '备份',hint:'备份在 Hub 所在的主机上执行。', lead: html`${dot(backups !== null && backups.count > 0 ? 'ok' : 'idle')}` }, html`${backupState}${ctx.admin ? html`<div class="ch-actions">${commandLink(commands.backup(), '备份命令')}</div>` : ''}`);
  return html`<section class="ch-section" data-columns="4">${service}${certificate}${backup}${database}</section>`;
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
  const dialogs: CommandDialog[] = [];
  const secrets = await secretsOf(ctx, run);
  const secretName=ctx.url.searchParams.get('secret'),selectedSecret=secrets.rows?.find(secret=>secret.name===secretName);
  if(secretName&&!selectedSecret)return neutralPage(ctx);
  let secretBody: Html;
  if (secrets.rows !== null) {
    const rows = secrets.rows.map((secret) => {
      const set = commands.secretSet(secret.name);
      const unset = commands.secretUnset(secret.name);
      if (!secret.withdrawn&&secret.name===secretName) dialogs.push(set, unset);
      return [
        link('/console/settings',secret.name,{secret:secret.name}),
        secret.consumers.length === 0 ? '—' : html`${secret.consumers.map((consumer) => html`<div>${consumer}</div>`)}`,
        secret.by, when(secret.at),
        secret.withdrawn ? chip('已吊销', 'unchecked') : html`<span class="ch-meta">•••••••• 已加密</span>`,

      ];
    });
    secretBody = table(['名称', '用于', '设置人', '更新时间', '内容'], rows, '尚无凭据：接入业务系统时设置',undefined,{selected:secrets.rows.findIndex(secret=>secret.name===secretName),hrefs:secrets.rows.map(secret=>'/console/settings?'+new URLSearchParams({secret:secret.name}))});
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
  const body = html`${sectionHead('凭据', undefined, undefined, 'secrets', '业务系统与运行环境的凭据加密保存；页面、记录与模型只可见名称。更新与吊销在 Hub 所在主机上执行')}
${card(null, secretBody)}
${sectionHead('Hub 状态', undefined, undefined, 'hub', '服务、证书、备份与数据库')}
${await hubState(ctx)}
${sectionHead('需停机或在主机上执行的操作', undefined, undefined, undefined, '控制台不执行这些操作；在 Hub 所在主机上执行')}
${card({title:'主机操作',hint:'部署与回滚在 Hub 主机上通过 circle-hub deploy 和 circle-hub rollback 执行。'}, html`<div class="ch-actions">${stopping.map((dialog) => commandLink(dialog, dialog.title))}</div>`)}
${liveModule('dialogs', ['member.connected'], dialogs.filter(dialog=>!selectedSecret||!dialog.id.startsWith('cmd-secret')).map(commandModal))}`;
  return {
    status: 200,
    body: page(ctx.chrome('设置', {
      active: 'settings',
      hint: '凭据与 Hub 状态；需人工处理的事项在 Hub 所在主机上完成',

    }),pageLayout(html`${seg([['secrets','凭据'],['hub','Hub 状态']],'设置分区')}${body}`,{detail:!!selectedSecret,back:link('/console/settings','返回设置'),inspector:selectedSecret?html`<div data-inspector-content><span class="ch-tag">凭据</span><h2 class="ch-panel-title">${selectedSecret.name}</h2>${facts([['内容',selectedSecret.withdrawn?'已吊销':'已加密'],['用于',selectedSecret.consumers.join('、')||'—'],['设置人',selectedSecret.by],['更新时间',when(selectedSecret.at)]])}<footer class="ch-inspector-actions">${selectedSecret.withdrawn?'':html`${commandLink(commands.secretUnset(selectedSecret.name),'吊销…','ch-btn ch-btn--danger')}${commandLink(commands.secretSet(selectedSecret.name),'更新…','ch-btn ch-btn--primary')}`}</footer>${dialogs.filter(dialog=>dialog.id.startsWith('cmd-secret')).map(commandModal)}</div>`:html`<h2 class="ch-panel-title">设置</h2>${stat('凭据项',secrets.rows?.length??'—')}${facts([['服务','运行中'],['内置 HTTPS',ctx.hub?.certificate?'已启用':'未启用'],['已运行',ctx.hub?duration(Date.now()-ctx.hub.startedAt.getTime()):'—']])}`})),
  };
}

async function memberSettings(ctx: PageContext): Promise<PageResult> {
  const tokens = await ctx.deps.records.principals.tokens(ctx.principal.id);
  const clients = await connectedClients(ctx.deps.records, tokens.filter(token => token.revoked_at === null).map(token => ({ token, owner: ctx.principal.name })));
  const rows = clients.map(client => [...clientRow(client, clientLabel(client)), '由管理员断开']);
  const body = html`<section class="ch-section" data-columns="2" id="mine">
${liveModule('my-circles', ['member.connected'], card({ title: ctx.principal.name, lead: html`<span class="ch-avatar" aria-hidden="true">${[...ctx.principal.name][0] ?? ''}</span>`, tail: chip(uiLabelOf('permission_role', ctx.principal.role), 'plain') }, html`${sectionHead('我的客户端', undefined, undefined, undefined, '每台设备上的客户端独立连接；名称和版本照客户端报的写；断开由管理员执行')}${table([...CLIENT_COLUMNS,'操作'], rows, { title: '尚无已连接的客户端', text: '按“连接新的客户端”的配置连接后，客户端列在这里。' })}`))}
${card({ title: '连接新的客户端', meta: 'MCP 标准连接确认',hint:'下面是 mcp_servers 格式的条目；其他客户端按各自的格式填写同一 MCP 地址。浏览器确认身份后允许连接；其他设备可使用管理员签发的邀请码。' }, html`<pre class="ch-quote">${circleEntry(originOf(ctx), false)}</pre>`)}
</section>
${sectionHead('Hub 状态', undefined, undefined, 'hub', '服务、证书、备份与数据库')}
${await hubState(ctx)}`;
  return { status: 200, body: page(ctx.chrome('设置', { active: 'settings', hint: '我的客户端与 Hub 状态',  }),pageLayout(html`${seg([['mine','我的客户端'],['hub','Hub 状态']],'设置分区')}${body}`,{inspector:html`<h2 class="ch-panel-title">我的客户端</h2>${stat('已连接',rows.length)}${card({title:'最近使用'},html`<p>${when(lastUse(active(tokens)))}</p>`)}${facts([['服务','运行中'],['内置 HTTPS',ctx.hub?.certificate?'已启用':'未启用']])}`})) };
}

/** The old management pages of decision 122 land here; a member gets the neutral page as before. */
export function adminOnly(ctx: PageContext, render: () => Promise<PageResult>): Promise<PageResult> {
  return ctx.admin ? render() : Promise.resolve(neutralPage(ctx));
}

