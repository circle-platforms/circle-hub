// The console's management (owner decision 75): administrators manage users and tokens, task packs, resources, secrets and
// knowledge sync from the browser. Every action is a form POST (this server's own origin, the session's CSRF token, an
// administrator's session) that runs the matching `circle-hub` commands through the command bridge, as the signed-in
// administrator: the same checks, records and messages as the command line, shown on the result page. The console's pages
// offer four of them (proposal decision 6 of 2026-10-31: adding a member, connecting a business system, publishing a task
// pack, importing knowledge); the first two are a sequence of commands that stops at the first one that does not finish. Values from a form
// become argv words only after the checks here (a positional never starts with `-`; flag values are passed as
// `--flag=value`), and a secret value goes to `secret set` through the bridge, never into argv. Knowledge sync can run for
// minutes, so it runs as a background job whose output the jobs page shows. Backup, restore, deploy and rollback stop the
// server and stay on the command line.
//
// The first administrator is created at /console/setup with the one-time setup code (`circle-hub setup-code`) while no
// administrator exists; its token is shown once and opens a session.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { ENVIRONMENT, PERMISSION_ROLE, isEnvironment, labelOf } from '../../../contracts/generated/vocabulary.ts';
import type { Principal } from '../../records/api.ts';
import type { CommandBridge, CommandRun } from '../command-bridge.ts';
import { checkSetupCode, removeSetupCode } from '../setup-code.ts';
import { code, html, link, page, pre, section, table, type Html } from './html.ts';
import { circleEntry, originOf } from './settings.ts';
import { card, chip, when } from './ui.ts';
import type { PageContext, PageResult } from './pages.ts';
import { UploadError, unpackZip } from './upload.ts';

/** A form's fields, trimmed; absent fields are the empty string. */
export type Form = { get(name: string): string };

export interface Built {
  argv: string[];
  secrets?: Record<string, string>;
}

export class FormError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormError';
  }
}

/** A positional argument from a form: present, one line, and never something the parser would read as a flag. */
function word(form: Form, name: string, label: string): string {
  const value = form.get(name);
  if (value === '') throw new FormError(`请填写${label}`);
  if (value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value) || value.length > 512) throw new FormError(`${label}的写法不对`);
  return value;
}

/** `--flag=value`: the value may start with `-`, it is never read as another flag. */
function flag(name: string, value: string): string {
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) throw new FormError(`--${name} 的内容不能有控制字符`);
  return `--${name}=${value}`;
}

/** Non-empty lines of a textarea, each `left=right` (role=url, key=value, item=secret name). */
function pairs(form: Form, name: string, label: string): string[] {
  const lines = form.get(name).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) if (line.indexOf('=') <= 0) throw new FormError(`${label}每行写成 名字=值：${line.slice(0, 80)}`);
  return lines;
}

export interface Action {
  title: string;
  /** Where the result page links back to. */
  back: string;
  /** One command, or several run in order; a command that does not finish (exit code other than 0) stops the rest. */
  build(form: Form): Built | Built[];
  /** Runs as a background job (knowledge sync). */
  background?: boolean;
  /** The result's standard output holds a value shown only once (an issued token). */
  once?: boolean;
}

const USERS = '/console/admin';
const OPERATIONS = '/console/operations';

/** Up to three credentials of a business system, each a name and its content (the content is taken as typed). */
const SECRET_SLOTS = [1, 2, 3] as const;

function credentialValues(form: Form): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of SECRET_SLOTS) {
    const name = form.get(`secret_name_${slot}`);
    const value = form.get(`value_${slot}`);
    if (name === '' && value === '') continue;
    if (name === '' || value === '') throw new FormError('凭据的名称与内容都要填写');
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) throw new FormError(`凭据名称 ${name.slice(0, 64)} 只能用大写字母、数字和下划线，并以字母开头`);
    if (Object.hasOwn(out, name)) throw new FormError(`凭据 ${name} 填了两次`);
    out[name] = value;
  }
  return out;
}
const PACKS = '/console/admin/packs';
const RESOURCES = '/console/admin/resources';
const SECRETS = '/console/admin/secrets';
const KNOWLEDGE = '/console/admin/knowledge';

export const ACTIONS: Readonly<Record<string, Action>> = {
  'user-create': {
    title: '新建用户',
    back: USERS,
    build: (form) => {
      const role = form.get('role') || 'user';
      if (!(PERMISSION_ROLE as readonly string[]).includes(role)) throw new FormError('角色不对');
      return { argv: ['user', 'create', word(form, 'name', '用户名'), flag('role', role)] };
    },
  },
  'user-disable': { title: '停用用户', back: USERS, build: (form) => ({ argv: ['user', 'disable', word(form, 'user', '用户')] }) },
  'user-enable': { title: '恢复用户', back: USERS, build: (form) => ({ argv: ['user', 'enable', word(form, 'user', '用户')] }) },
  'token-issue': {
    title: '签发令牌',
    back: USERS,
    once: true,
    build: (form) => ({ argv: ['token', 'issue', word(form, 'user', '用户'), ...(form.get('label') ? [flag('label', form.get('label'))] : [])] }),
  },
  'token-revoke': { title: '撤销令牌', back: USERS, build: (form) => ({ argv: ['token', 'revoke', word(form, 'token', '令牌编号')] }) },
  'pack-grant': { title: '授予发布权', back: PACKS, build: (form) => ({ argv: ['pack', 'grant-publish', word(form, 'user', '用户')] }) },
  'pack-revoke': { title: '撤销发布权', back: PACKS, build: (form) => ({ argv: ['pack', 'revoke-publish', word(form, 'user', '用户')] }) },
  'pack-assign': { title: '分配任务包', back: PACKS, build: (form) => ({ argv: ['pack', 'assign', word(form, 'user', '用户'), word(form, 'pack', '任务包')] }) },
  'pack-unassign': { title: '取消分配', back: PACKS, build: (form) => ({ argv: ['pack', 'unassign', word(form, 'user', '用户'), word(form, 'pack', '任务包')] }) },
  'pack-retire': { title: '下架任务包版本', back: PACKS, build: (form) => ({ argv: ['pack', 'retire', word(form, 'ref', '包号@版本')] }) },
  'pack-activate': { title: '启用产品包', back: PACKS, build: (form) => ({ argv: ['pack', 'activate', word(form, 'pack', '产品包')] }) },
  'pack-deactivate': { title: '停用产品包', back: PACKS, build: (form) => ({ argv: ['pack', 'deactivate', word(form, 'pack', '产品包')] }) },
  'resource-add': {
    title: '添加资源',
    back: RESOURCES,
    build: (form) => {
      const environment = form.get('environment');
      if (!isEnvironment(environment)) throw new FormError('请选择环境');
      const origins = pairs(form, 'origins', '地址');
      if (origins.length === 0) throw new FormError('至少写一行 角色=地址');
      const plaintext = form.get('plaintext').split(/[,，\s]+/).filter(Boolean);
      return {
        argv: [
          'resource', 'add', word(form, 'system_pack', '系统包'),
          flag('name', word(form, 'name', '资源名')),
          flag('environment', environment),
          ...origins.map((line) => flag('origin', line)),
          ...plaintext.map((role) => flag('allow-plaintext', role)),
          ...pairs(form, 'settings', '设置').map((line) => flag('setting', line)),
          ...pairs(form, 'credentials', '凭据').map((line) => flag('credential', line)),
        ],
      };
    },
  },
  'resource-disable': { title: '停用资源', back: RESOURCES, build: (form) => ({ argv: ['resource', 'disable', word(form, 'resource', '资源')] }) },
  'resource-enable': { title: '启用资源', back: RESOURCES, build: (form) => ({ argv: ['resource', 'enable', word(form, 'resource', '资源')] }) },
  'resource-reset-login': { title: '重置登录状态', back: RESOURCES, build: (form) => ({ argv: ['resource', 'reset-login', word(form, 'resource', '资源')] }) },
  'secret-set': {
    title: '设置密钥',
    back: SECRETS,
    build: (form) => {
      const name = word(form, 'name', '密钥名');
      const value = form.get('value');
      if (value === '') throw new FormError('请填写密钥的值');
      return { argv: ['secret', 'set', flag('name', name), flag('reason', word(form, 'reason', '理由'))], secrets: { [name]: value } };
    },
  },
  'secret-unset': {
    title: '撤回密钥',
    back: SECRETS,
    build: (form) => ({ argv: ['secret', 'unset', flag('name', word(form, 'name', '密钥名')), flag('reason', word(form, 'reason', '理由'))] }),
  },
  'member-add': {
    title: '添加成员',
    back: `${OPERATIONS}/member`,
    once: true,
    build: (form) => {
      const role = form.get('role') || 'user';
      if (!(PERMISSION_ROLE as readonly string[]).includes(role)) throw new FormError('角色不对');
      const name = word(form, 'name', '姓名');
      return [
        { argv: ['user', 'create', name, flag('role', role)] },
        { argv: ['token', 'issue', name, flag('label', form.get('label') || 'Circle')] },
      ];
    },
  },
  'system-add': {
    title: '接入业务系统',
    back: `${OPERATIONS}/system`,
    build: (form) => {
      // The resource first: `secret set` names the definitions that reference a credential, so they must exist.
      const add = ACTIONS['resource-add'].build(form) as Built;
      const secrets = credentialValues(form);
      const names = Object.keys(secrets);
      if (names.length === 0) return [add];
      return [add, { argv: ['secret', 'set', ...names.map((name) => flag('name', name)), flag('reason', `接入业务系统 ${form.get('name')}`)], secrets }];
    },
  },
  'knowledge-sync': {
    title: '知识同步',
    back: KNOWLEDGE,
    background: true,
    build: (form) => ({
      argv: [
        'knowledge', 'sync', flag('product', word(form, 'product', '产品')),
        ...(form.get('line') ? [flag('line', word(form, 'line', '版本线'))] : []),
        ...(form.get('dry_run') ? ['--dry-run'] : []),
      ],
    }),
  },
};

// ---------------------------------------------------------------- jobs

export interface Job {
  id: string;
  title: string;
  argv: readonly string[];
  by: string;
  started: string;
  finished: string | null;
  result: CommandRun | null;
}

/** Background runs of this process, newest first; at most `keep`. They end with the process, the records they wrote stay. */
export class JobStore {
  readonly #jobs: Job[] = [];
  readonly #keep: number;
  readonly #now: () => Date;
  constructor(now: () => Date = () => new Date(), keep = 50) {
    this.#now = now;
    this.#keep = keep;
  }

  start(title: string, argv: readonly string[], by: Principal, run: () => Promise<CommandRun>): Job {
    const job: Job = { id: randomBytes(6).toString('hex'), title, argv, by: by.name, started: this.#now().toISOString(), finished: null, result: null };
    this.#jobs.unshift(job);
    this.#jobs.splice(this.#keep);
    void run()
      .catch((error: unknown): CommandRun => ({ code: 1, stdout: [], stderr: [`执行出错：${error instanceof Error ? error.message : String(error)}`] }))
      .then((result) => {
        job.result = result;
        job.finished = this.#now().toISOString();
      });
    return job;
  }

  list(): readonly Job[] {
    return this.#jobs;
  }

  get(id: string): Job | undefined {
    return this.#jobs.find((job) => job.id === id);
  }
}

// ---------------------------------------------------------------- rendering

/** A POST form to an action of this console, with the session's CSRF token. */
export function actionForm(name: string, csrf: string, fields: Html | string, submit: string, options: { multipart?: boolean; inline?: boolean; primary?: boolean } = {}): Html {
  const button = options.primary ? html`<div class="form-f"><button type="submit" class="primary">${submit}</button></div>` : html`<button type="submit">${submit}</button>`;
  return html`<form method="post" action="/console/admin/do/${name}"${options.multipart ? html` enctype="multipart/form-data"` : ''}${options.inline ? html` class="inline"` : ''}><input type="hidden" name="csrf" value="${csrf}">${fields}${button}</form>`;
}

function runLines(run: CommandRun, once: boolean): Html {
  return html`<p class="${run.code === 0 ? 'ok' : 'error'}">${run.code === 0 ? '已完成' : run.code === 2 ? '参数不正确，未执行' : '未完成'}（退出码 ${run.code}）</p>
${once && run.code === 0 ? html`<p class="notice">下面的令牌只显示这一次：现在复制，保存到只有使用者能读的地方。离开这页就再也看不到它。</p>` : ''}
${run.stdout.length > 0 ? pre(run.stdout.join('\n')) : ''}
${run.stderr.length > 0 ? html`<pre class="error">${run.stderr.join('\n')}</pre>` : ''}`;
}

/** The chrome of a management result: the place of the navigation the action belongs to. */
function actionChrome(ctx: PageContext, action: Action) {
  return ctx.chrome(action.title, { active: action.back.startsWith('/console/operations/knowledge') || action.back === KNOWLEDGE ? 'knowledge' : action.back.startsWith('/console/operations/pack') || action.back === PACKS ? 'packs' : action.back.startsWith('/console/operations/system') || action.back === RESOURCES ? 'connections' : 'settings', sub: '与命令行执行相同的命令，写入相同的记录' });
}

/** Each command of an action with its output; the commands after one that did not finish were not run. */
export function resultPage(ctx: PageContext, action: Action, runs: CommandRun | readonly { argv: readonly string[]; run: CommandRun }[], form?: Form): PageResult {
  const steps = 'code' in runs ? [{ argv: [] as readonly string[], run: runs }] : runs;
  const last = steps[steps.length - 1].run;
  const several = !('code' in runs);
  const body = steps.map((step, index) => several
    ? card({ title: `第 ${index + 1} 步`, meta: html`<code>${['circle-hub', ...step.argv].join(' ')}</code>` }, runLines(step.run, action.once === true && step.argv[0] === 'token'))
    : card(null, runLines(step.run, action.once === true)));
  const after = last.code === 0 && action === ACTIONS['member-add'] && form !== undefined
    ? card({ title: '写入成员的 Circle', meta: '标准授权上线前使用' }, html`<p class="sub">在该成员的 Circle 中用 ${code('/secrets CIRCLE_HUB_TOKEN')} 保存上面的令牌，再把以下配置写入 Circle 的 settings.json${ctx.secure ? html`，并把颁发机构证书加入 ${code('trust_cert_files')}` : ''}：</p><pre class="snippet">${circleEntry(originOf(ctx))}</pre><p class="sub">连接完成后，${link('/console/settings', '设置')}的“已连接的 Circle”显示该令牌的最近使用时间。</p>`)
    : '';
  return {
    status: last.code === 0 ? 200 : last.code === 2 ? 400 : 409,
    body: page(actionChrome(ctx, action), html`<div class="stack">${body}${after}</div><p class="mt16">${link(action.back, '返回')}</p>`),
  };
}

export function formErrorPage(ctx: PageContext, action: Action, message: string): PageResult {
  return { status: 400, body: page(actionChrome(ctx, action), html`${card(null, html`<p class="error">${message}</p>`)}<p class="mt16">${link(action.back, '返回')}</p>`) };
}

const jobState = (job: Job): Html => job.result === null ? chip('进行中', 'judgment') : job.result.code === 0 ? chip('已完成', 'pass') : chip(`未完成，退出码 ${job.result.code}`, 'fail');

export function jobsSection(jobs: readonly Job[]): Html {
  return section('后台任务', table(['开始', '任务', '发起人', '状态'], jobs.map((job) => [
    when(job.started),
    link(`/console/admin/jobs/${job.id}`, `${job.title}：${job.argv.slice(2).join(' ')}`),
    job.by,
    html`${jobState(job)}${job.finished === null ? '' : html` <span class="sub">${when(job.finished)}</span>`}`,
  ]), '尚无后台任务'));
}

export function jobPage(ctx: PageContext, job: Job | undefined): PageResult {
  const chrome = ctx.chrome('后台任务', { active: 'knowledge', sub: html`${link('/console/operations/knowledge', '导入知识')} · 后台任务` });
  if (job === undefined) return { status: 404, body: page(chrome, html`${card(null, html`<p>没有这个任务（服务重启后，之前的任务不再列出；它们写下的记录照常保留）</p>`)}<p class="mt16">${link('/console/operations/knowledge', '返回')}</p>`) };
  const state = job.result === null
    ? html`<p class="notice">进行中，刷新本页查看进展</p>`
    : runLines(job.result, false);
  return {
    status: 200,
    body: page(chrome, html`${card({ title: job.title, tail: jobState(job), meta: `发起人 ${job.by} · 开始于 ${when(job.started)}` }, html`<p>${code(job.argv.join(' '))}</p>${state}`)}<p class="mt16">${link('/console/operations/knowledge', '返回')}</p>`),
  };
}

// ---------------------------------------------------------------- executing

export interface ManageDeps {
  bridge: CommandBridge | undefined;
  jobs: JobStore;
  log: (line: string) => void;
}

/**
 * Runs one action for `principal` (an administrator) with the session's token. A pack upload arrives as a zip archive:
 * it is unpacked into a private temporary directory and published with `--stage`, then the directory is removed.
 */
export async function runAction(ctx: PageContext, deps: ManageDeps, name: string, form: Form, token: string, upload?: Buffer): Promise<PageResult> {
  const action = name === 'pack-publish' ? PUBLISH : ACTIONS[name];
  if (deps.bridge === undefined) return { status: 503, body: page(actionChrome(ctx, action), html`${card(null, html`<p class="error">这个 Hub 进程没有接上命令执行，网页管理暂不可用；请在 Hub 所在主机的 Circle 中执行对应的命令</p>`)}<p class="mt16">${link(action.back, '返回')}</p>`) };
  let built: Built[];
  let unpacked: { root: string; dir: string } | null = null;
  try {
    if (name === 'pack-publish') {
      if (upload === undefined || upload.length === 0) throw new FormError('请选择要上传的任务包 zip 文件');
      unpacked = await unpackZip(upload);
      built = [{ argv: ['pack', 'publish', unpacked.dir, '--stage'] }];
    } else {
      const made = action.build(form);
      built = Array.isArray(made) ? made : [made];
    }
  } catch (error) {
    if (unpacked !== null) await rm(unpacked.root, { recursive: true, force: true });
    if (error instanceof FormError || error instanceof UploadError) return formErrorPage(ctx, action, error.message);
    throw error;
  }
  const bridge = deps.bridge;
  const run = (step: Built) => bridge.run(step.argv, { token, ...(step.secrets ? { secrets: step.secrets } : {}) });
  if (action.background) {
    const [step] = built;
    const what = step.argv.slice(0, 2).join(' ');
    const job = deps.jobs.start(action.title, step.argv, ctx.principal, async () => {
      const result = await run(step);
      deps.log(`控制台后台任务 ${what}（${ctx.principal.name}）结束：退出码 ${result.code}`);
      return result;
    });
    deps.log(`控制台后台任务 ${what} 由 ${ctx.principal.name} 发起`);
    return { status: 202, body: page(actionChrome(ctx, action), html`${card(null, html`<p>已在后台开始，${link(`/console/admin/jobs/${job.id}`, '查看进展')}。Hub 重启时，进行中的任务需重新发起，已写入的内容不受影响。</p>`)}<p class="mt16">${link(action.back, '返回')}</p>`) };
  }
  try {
    const runs: { argv: readonly string[]; run: CommandRun }[] = [];
    for (const step of built) {
      const result = await run(step);
      deps.log(`控制台管理操作 ${step.argv.slice(0, 2).join(' ')}（${ctx.principal.name}）：退出码 ${result.code}`);
      // Only words a form gave are shown; a pack's private directory is not.
      runs.push({ argv: name === 'pack-publish' ? [] : step.argv, run: result });
      if (result.code !== 0) break;
    }
    return resultPage(ctx, action, built.length === 1 ? runs[0].run : runs, form);
  } finally {
    if (unpacked !== null) await rm(unpacked.root, { recursive: true, force: true });
  }
}

const PUBLISH: Action = { title: '发布任务包', back: PACKS, build: () => { throw new FormError('请上传任务包'); } };

// ---------------------------------------------------------------- setup

export type SetupOutcome =
  | { ok: true; token: string; name: string }
  | { ok: false; status: number; message: string };

/**
 * Creates the first administrator when the setup code matches and none exists; the code is removed once used. The token
 * the records issue is returned once, for the page and the session.
 */
export async function completeSetup(
  dataDir: string,
  principals: { list(): Promise<{ role: string }[]>; bootstrapAdmin(name: string): Promise<{ user: { name: string }; token: { token: string } }> },
  form: Form,
  now: Date = new Date(),
): Promise<SetupOutcome> {
  if ((await principals.list()).some((user) => user.role === 'admin')) return { ok: false, status: 409, message: '已经有管理员了：请用管理员的令牌登录' };
  const name = form.get('name');
  if (name === '' || name.startsWith('-') || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, status: 400, message: '请填写管理员姓名' };
  const check = await checkSetupCode(dataDir, form.get('code'), now);
  if (check === 'none') return { ok: false, status: 403, message: '没有有效的初始化码：在 Hub 所在的主机上执行 circle-hub setup-code 生成' };
  if (check === 'expired') return { ok: false, status: 403, message: '初始化码已过期：执行 circle-hub setup-code 重新生成' };
  if (check === 'wrong') return { ok: false, status: 403, message: '初始化码不正确' };
  let created;
  try {
    created = await principals.bootstrapAdmin(name);
  } catch (error) {
    return { ok: false, status: 409, message: error instanceof Error ? error.message : String(error) };
  }
  await removeSetupCode(dataDir);
  return { ok: true, token: created.token.token, name: created.user.name };
}

export function environmentOptions(selected = ''): Html {
  return html`${ENVIRONMENT.map((value) => html`<option value="${value}"${value === selected ? html` selected` : ''}>${labelOf('environment', value)}</option>`)}`;
}

export function roleOptions(): Html {
  return html`${PERMISSION_ROLE.map((value) => html`<option value="${value}">${labelOf('permission_role', value)}</option>`)}`;
}
