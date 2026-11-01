// The console's management (owner decision 75): administrators manage users and tokens, task packs, resources, secrets and
// knowledge sync from the browser. Every action is a form POST (this server's own origin, the session's CSRF token, an
// administrator's session) that runs the matching `circle-hub` commands through the command bridge, as the signed-in
// administrator: the same checks, records and messages as the command line, shown on the result page. The console's pages
// offer four of them (proposal decision 6 of 2026-10-31: adding a member, connecting a business system, publishing a task
// pack, importing knowledge); the first two are a sequence of commands that stops at the first one that does not finish. Values from a form
// become argv words only after the checks here (a positional never starts with `-`; flag values are passed as
// `--flag=value`), and a secret value goes to `secret set` through the bridge, never into argv. Knowledge sync can run for
// minutes, so it runs as a background job whose output the jobs page shows. Publishing a task pack takes two steps (item 5
// of the console interface doc, 2026-11-01): an uploaded zip is checked with `pack publish <dir> --stage --dry-run` and,
// when it passes, kept in the staging store (staging.ts) until its administrator publishes it with `pack publish <dir>
// --stage` or discards it. Backup, restore, deploy and rollback stop the server and stay on the command line.
//
// The first administrator is created at /console/setup with the one-time setup code (`circle-hub setup-code`) while no
// administrator exists; its token is shown once and opens a session.
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { ENVIRONMENT, PERMISSION_ROLE, isEnvironment, labelOf } from '../../../contracts/generated/vocabulary.ts';
import { initialPassword, validPassword } from '../../records/api.ts';
import type { Principal } from '../../records/api.ts';
import type { CommandBridge, CommandRun } from '../command-bridge.ts';
import { NEUTRAL, neutralPage } from './pages.ts';
import { stagedDigest, type PackStaging, type StagedPack } from './staging.ts';
import { checkSetupCode, removeSetupCode } from '../setup-code.ts';
import { code, html, link, liveModule, page, pre, section, table, type Html } from './html.ts';
import { circleEntry, originOf } from './settings.ts';
import { callout, card, chip, stepper, when } from './ui.ts';
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
export function word(form: Form, name: string, label: string): string {
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
export function pairs(form: Form, name: string, label: string): string[] {
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

export function credentialValues(form: Form): Record<string, string> {
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
      // An invitation code for the standard authorization, or a token for a client without it.
      const connect = form.get('connect') || 'invitation';
      if (connect !== 'invitation' && connect !== 'token') throw new FormError('连接方式不对');
      return [
        { argv: ['user', 'create', name, flag('role', role)] },
        connect === 'token' ? { argv: ['token', 'issue', name, flag('label', form.get('label') || 'Circle')] } : { argv: ['user', 'invite', name] },
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
  readonly #watchers: ((job: Job) => void)[] = [];
  constructor(now: () => Date = () => new Date(), keep = 50) {
    this.#now = now;
    this.#keep = keep;
  }

  /** Called when a job starts and when it ends (the live updates' import.progress). */
  watch(watcher: (job: Job) => void): void {
    this.#watchers.push(watcher);
  }

  start(title: string, argv: readonly string[], by: Principal, run: () => Promise<CommandRun>): Job {
    const job: Job = { id: randomBytes(6).toString('hex'), title, argv, by: by.name, started: this.#now().toISOString(), finished: null, result: null };
    this.#jobs.unshift(job);
    this.#jobs.splice(this.#keep);
    this.#tell(job);
    void run()
      .catch((error: unknown): CommandRun => ({ code: 1, stdout: [], stderr: [`执行出错：${error instanceof Error ? error.message : String(error)}`] }))
      .then((result) => {
        job.result = result;
        job.finished = this.#now().toISOString();
        this.#tell(job);
      });
    return job;
  }

  #tell(job: Job): void {
    for (const watcher of this.#watchers) {
      try {
        watcher(job);
      } catch {
        // A watcher's failure never changes the job.
      }
    }
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

const TOKEN_ONCE = '下面的令牌只显示这一次：现在复制，保存到只有使用者能读的地方。离开这页就再也看不到它。';
const INVITATION_ONCE = '下面的邀请码只显示这一次：现在复制并交给该成员。邀请码 24 小时内有效，仅可使用一次。';

/** The notice of a command whose output holds a value shown once: a token, or an invitation code. */
function onceNotice(argv: readonly string[]): string | null {
  if (argv[0] === 'token') return TOKEN_ONCE;
  return argv[0] === 'user' && argv[1] === 'invite' ? INVITATION_ONCE : null;
}

function runLines(run: CommandRun, notice: string | null): Html {
  return html`<p class="${run.code === 0 ? 'ok' : 'error'}">${run.code === 0 ? '已完成' : run.code === 2 ? '参数不正确，未执行' : '未完成'}（退出码 ${run.code}）</p>
${notice !== null && run.code === 0 ? html`<p class="notice">${notice}</p>` : ''}
${run.stdout.length > 0 ? pre(run.stdout.join('\n')) : ''}
${run.stderr.length > 0 ? html`<pre class="error">${run.stderr.join('\n')}</pre>` : ''}`;
}

/** The chrome of a management result: the place of the navigation the action belongs to. */
function actionChrome(ctx: PageContext, action: Action) {
  return ctx.chrome(action.title, { active: action.back.startsWith('/console/operations/member') ? 'team' : action.back.startsWith('/console/operations/knowledge') || action.back === KNOWLEDGE ? 'knowledge' : action.back.startsWith('/console/operations/pack') || action.back === PACKS ? 'packs' : action.back.startsWith('/console/operations/system') || action.back === RESOURCES ? 'connections' : 'settings', sub: '与命令行执行相同的命令，写入相同的记录' });
}

/** Each command of an action with its output; the commands after one that did not finish were not run. */
export function resultPage(ctx: PageContext, action: Action, runs: CommandRun | readonly { argv: readonly string[]; run: CommandRun }[], form?: Form): PageResult {
  const steps = 'code' in runs ? [{ argv: [] as readonly string[], run: runs }] : runs;
  const last = steps[steps.length - 1].run;
  const several = !('code' in runs);
  const body = steps.map((step, index) => several
    ? card({ title: `第 ${index + 1} 步`, meta: html`<code>${['circle-hub', ...step.argv].join(' ')}</code>` }, runLines(step.run, action.once === true ? onceNotice(step.argv) : null))
    : card(null, runLines(step.run, action.once === true ? TOKEN_ONCE : null)));
  const trust = ctx.secure ? html`，并把颁发机构证书加入 ${code('trust_cert_files')}` : '';
  const connected = html`<p class="sub">成员完成连接后，${link('/console/team', '团队')}的“已连接的 Circle”显示该 Circle 与最近使用时间。</p>`;
  const after = last.code !== 0 || action !== ACTIONS['member-add'] || form === undefined
    ? ''
    : form.get('connect') === 'token'
      ? card({ title: '写入成员的 Circle', meta: '访问令牌' }, html`<p class="sub">在该成员的 Circle 中用 ${code('/secrets CIRCLE_HUB_TOKEN')} 保存上面的令牌，再把以下配置写入 Circle 的 settings.json${trust}：</p><pre class="snippet">${circleEntry(originOf(ctx))}</pre>${connected}`)
      : card({ title: '成员的 Circle 如何连接', meta: 'MCP 标准授权' }, html`<p class="sub">把以下配置写入该成员 Circle 的 settings.json${trust}。Circle 首次连接时在浏览器中打开授权页，成员输入上面的邀请码并确认授权即完成连接。</p><pre class="snippet">${circleEntry(originOf(ctx), false)}</pre>${connected}`);
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
    : runLines(job.result, null);
  return {
    status: 200,
    body: page(chrome, html`${liveModule('job', ['import.progress'], card({ title: job.title, tail: jobState(job), meta: `发起人 ${job.by} · 开始于 ${when(job.started)}` }, html`<p>${code(job.argv.join(' '))}</p>${state}`), { job: job.id })}<p class="mt16">${link('/console/operations/knowledge', '返回')}</p>`),
  };
}

// ---------------------------------------------------------------- executing

export interface ManageDeps {
  bridge: CommandBridge | undefined;
  jobs: JobStore;
  /** Task packs that passed the check of 发布任务包 and wait for its 发布 step. */
  staging: PackStaging;
  log: (line: string) => void;
}

const BRIDGE_MISSING = '这个 Hub 进程没有接上命令执行，网页管理暂不可用；请在 Hub 所在主机的 Circle 中执行对应的命令';

/** A run's output with the private directories written as <目录>: no page shows where the server keeps an upload. */
function withoutPaths(run: CommandRun, ...paths: string[]): CommandRun {
  const hide = (line: string): string => paths.reduce((text, path) => text.split(path).join('<目录>'), line);
  return { ...run, stdout: run.stdout.map(hide), stderr: run.stderr.map(hide) };
}

// ---------------------------------------------------------------- 发布任务包: check, then publish

/** The steps of 发布任务包 that are not one plain command: check an upload, publish a stage, discard one. */
export const PACK_STEPS = ['pack-stage', 'pack-publish', 'pack-discard'] as const;
export type PackStep = (typeof PACK_STEPS)[number];
export const isPackStep = (name: string): name is PackStep => (PACK_STEPS as readonly string[]).includes(name);

/** Why a step ran no command: no command bridge (503), an upload the form refuses (400), a stage that is not there (404). */
export interface StepRefusal {
  status: 400 | 404 | 409 | 503;
  message: string;
}

export interface StageResult {
  /** The check's run (`pack publish <dir> --stage --dry-run`); null when it did not run. */
  run: CommandRun | null;
  /** The stage that waits for the 发布 step: only when the check passed and the content is not published yet. */
  stage: StagedPack | null;
  /** The check passed for content already published as that version: nothing to publish, nothing kept. */
  published: { pack: string; version: string } | null;
  refused: StepRefusal | null;
}

export interface PublishStageResult {
  /** The publication's run (`pack publish <dir> --stage`); null when it did not run. */
  run: CommandRun | null;
  stage: StagedPack | null;
  refused: StepRefusal | null;
}

/**
 * Checks an uploaded zip as the signed-in administrator (`token`): unpacked into a private temporary directory, checked
 * with the dry run of `pack publish --stage`, then kept in the staging store when it passed and is new, removed otherwise.
 */
export async function stagePack(ctx: PageContext, deps: ManageDeps, token: string, upload: Buffer | undefined): Promise<StageResult> {
  const none = { run: null, stage: null, published: null };
  if (deps.bridge === undefined) return { ...none, refused: { status: 503, message: BRIDGE_MISSING } };
  if (upload === undefined || upload.length === 0) return { ...none, refused: { status: 400, message: '请选择要上传的任务包 zip 文件' } };
  let unpacked: { root: string; dir: string };
  try {
    unpacked = await unpackZip(upload);
  } catch (error) {
    if (error instanceof UploadError) return { ...none, refused: { status: 400, message: error.message } };
    throw error;
  }
  let kept = false;
  try {
    const run = withoutPaths(await deps.bridge.run(['pack', 'publish', unpacked.dir, '--stage', '--dry-run'], { token }), unpacked.dir, unpacked.root);
    deps.log(`控制台管理操作 pack publish --dry-run（${ctx.principal.name}）：退出码 ${run.code}`);
    if (run.code !== 0) return { run, stage: null, published: null, refused: null };
    const read = await stagedDigest(unpacked.dir);
    const listed = read === null ? [] : await ctx.deps.packs.list(ctx.principal);
    if (read !== null && listed.some((pack) => pack.id === read.pack && pack.version === read.version && pack.digest === read.digest && !pack.withdrawn)) {
      return { run, stage: null, published: { pack: read.pack, version: read.version }, refused: null };
    }
    kept = true;
    return { run, stage: await deps.staging.add(ctx.principal.id, unpacked), published: null, refused: null };
  } finally {
    if (!kept) await rm(unpacked.root, { recursive: true, force: true });
  }
}

/**
 * Publishes a stage of the signed-in administrator with `pack publish <dir> --stage`, provided its pack.json still has the
 * digest that passed the check; the stage ends either way. Someone else's stage, an expired and an unknown one are absent.
 */
export async function publishStage(ctx: PageContext, deps: ManageDeps, token: string, id: string): Promise<PublishStageResult> {
  if (deps.bridge === undefined) return { run: null, stage: null, refused: { status: 503, message: BRIDGE_MISSING } };
  const taken = await deps.staging.take(id, ctx.principal.id);
  if (taken === null) return { run: null, stage: null, refused: { status: 404, message: NEUTRAL } };
  const { stage, dir } = taken;
  try {
    if ((await stagedDigest(dir))?.digest !== stage.digest) return { run: null, stage, refused: { status: 409, message: '暂存的任务包在校验后发生了变化，未发布；请重新上传并校验' } };
    const run = withoutPaths(await deps.bridge.run(['pack', 'publish', dir, '--stage'], { token }), dir);
    deps.log(`控制台管理操作 pack publish（${ctx.principal.name}）：退出码 ${run.code}`);
    return { run, stage, refused: null };
  } finally {
    await taken.done();
  }
}

/** Ends a stage of the signed-in administrator without publishing it; null when there is none by that id. */
export async function discardStage(ctx: PageContext, deps: ManageDeps, id: string): Promise<StagedPack | null> {
  const taken = await deps.staging.take(id, ctx.principal.id);
  if (taken === null) return null;
  await taken.done();
  return taken.stage;
}

const PACK_BACK = '/console/operations/pack';
const PUBLISH: Action = { title: '发布任务包', back: PACK_BACK, build: () => { throw new FormError('请上传任务包'); } };
const PACK_STEP_NAMES = ['上传', '发布校验', '发布', '完成'] as const;
const shortDigest = (digest: string): string => `${digest.slice(0, 12)}…`;

/** The 发布 and 放弃 forms of a stage, with the session's CSRF token. */
export function stageForms(stage: StagedPack, csrf: string): Html {
  const id = html`<input type="hidden" name="stage" value="${stage.id}">`;
  return html`<div class="row">${actionForm('pack-publish', csrf, id, '发布', { inline: true, primary: false })}${actionForm('pack-discard', csrf, id, '放弃', { inline: true })}</div>`;
}

function checkLines(run: CommandRun): Html {
  const state = run.code === 0 ? html`<p class="ok">发布校验已通过（退出码 0）</p>` : run.code === 2 ? html`<p class="error">参数不正确，未执行（退出码 2）</p>` : html`<p class="error">未通过发布校验（退出码 ${run.code}）</p>`;
  return html`${state}${run.stdout.length > 0 ? pre(run.stdout.join('\n')) : ''}${run.stderr.length > 0 ? html`<pre class="error">${run.stderr.join('\n')}</pre>` : ''}`;
}

function refusedPage(ctx: PageContext, refusal: StepRefusal): PageResult {
  // A stage that ended, expired or belongs to someone else: the console's neutral answer.
  if (refusal.status === 404) return neutralPage(ctx);
  return { status: refusal.status, body: page(actionChrome(ctx, PUBLISH), html`${card(null, html`<p class="error">${refusal.message}</p>`)}<p class="mt16">${link(PACK_BACK, '返回')}</p>`) };
}

/** The check's page: every result of the dry run, then the 发布 step when the pack was staged. */
export function stageResultPage(ctx: PageContext, result: StageResult): PageResult {
  if (result.refused !== null) return refusedPage(ctx, result.refused);
  const run = result.run!;
  const stage = result.stage;
  const next = stage !== null
    ? card({ title: '发布', tail: chip('等待发布中', 'judgment'), meta: `暂存至 ${when(new Date(stage.expires).toISOString())}` }, html`<p>任务包 ${code(`${stage.pack}@${stage.version}`)}（摘要 ${shortDigest(stage.digest)}）已暂存。发布执行 ${code('circle-hub pack publish <目录> --stage')}，写入发布记录；暂存 30 分钟内有效，过期后需重新上传。</p>${stageForms(stage, ctx.csrf ?? '')}`)
    : result.published !== null
      ? callout('info', html`相同内容已发布为 ${code(`${result.published.pack}@${result.published.version}`)}，无需再次发布；未暂存。`)
      : run.code === 0
        ? callout('warn', '发布校验已通过，但暂存未能保存；请重新上传。')
        : callout('warn', '未通过发布校验，未暂存；按上面每条问题的处理修改后重新上传。');
  const status = run.code === 0 ? 200 : run.code === 2 ? 400 : 409;
  return {
    status,
    body: page(actionChrome(ctx, PUBLISH), html`${stepper(PACK_STEP_NAMES, stage !== null ? 2 : 1)}<div class="stack">${card({ title: '发布校验', meta: code('circle-hub pack publish <目录> --stage --dry-run') }, checkLines(run))}${next}</div><p class="mt16">${link(PACK_BACK, '返回')}</p>`),
  };
}

/** The publication's page: the command's output, the steps complete when it published. */
export function publishResultPage(ctx: PageContext, result: PublishStageResult): PageResult {
  if (result.refused !== null) return refusedPage(ctx, result.refused);
  const run = result.run!;
  const status = run.code === 0 ? 200 : run.code === 2 ? 400 : 409;
  return {
    status,
    body: page(actionChrome(ctx, PUBLISH), html`${stepper(PACK_STEP_NAMES, run.code === 0 ? 4 : 2)}<div class="stack">${card({ title: '发布', meta: code('circle-hub pack publish <目录> --stage') }, runLines(run, null))}</div><p class="mt16">${run.code === 0 ? html`${link('/console/packs', '查看任务包')} · ` : ''}${link(PACK_BACK, '返回')}</p>`),
  };
}

/** One of the steps of 发布任务包, run and shown as a page. */
export async function runPackStep(ctx: PageContext, deps: ManageDeps, name: PackStep, form: Form, token: string, upload?: Buffer): Promise<PageResult> {
  if (name === 'pack-stage') return stageResultPage(ctx, await stagePack(ctx, deps, token, upload));
  if (name === 'pack-publish') return publishResultPage(ctx, await publishStage(ctx, deps, token, form.get('stage')));
  const discarded = await discardStage(ctx, deps, form.get('stage'));
  if (discarded === null) return refusedPage(ctx, { status: 404, message: NEUTRAL });
  return { status: 200, body: page(actionChrome(ctx, PUBLISH), html`${card(null, html`<p>已放弃暂存的任务包 ${code(`${discarded.pack}@${discarded.version}`)}，暂存内容已删除。</p>`)}<p class="mt16">${link(PACK_BACK, '返回')}</p>`) };
}

/** Runs one action for `principal` (an administrator) with the session's token; the steps of 发布任务包 go to runPackStep. */
export async function runAction(ctx: PageContext, deps: ManageDeps, name: string, form: Form, token: string, upload?: Buffer): Promise<PageResult> {
  if (isPackStep(name)) return runPackStep(ctx, deps, name, form, token, upload);
  const action = ACTIONS[name];
  if (deps.bridge === undefined) return { status: 503, body: page(actionChrome(ctx, action), html`${card(null, html`<p class="error">${BRIDGE_MISSING}</p>`)}<p class="mt16">${link(action.back, '返回')}</p>`) };
  let built: Built[];
  try {
    const made = action.build(form);
    built = Array.isArray(made) ? made : [made];
  } catch (error) {
    if (error instanceof FormError) return formErrorPage(ctx, action, error.message);
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
  const runs: { argv: readonly string[]; run: CommandRun }[] = [];
  for (const step of built) {
    const result = await run(step);
    deps.log(`控制台管理操作 ${step.argv.slice(0, 2).join(' ')}（${ctx.principal.name}）：退出码 ${result.code}`);
    runs.push({ argv: step.argv, run: result });
    if (result.code !== 0) break;
  }
  return resultPage(ctx, action, built.length === 1 ? runs[0].run : runs, form);
}

// ---------------------------------------------------------------- setup

export type SetupOutcome =
  | { ok: true; token: string; name: string; password: string | null }
  | { ok: false; status: number; message: string };

/**
 * Creates the first administrator when the setup code matches and none exists; the code is removed once used. The token
 * the records issue is returned once, for the page and the session.
 */
export async function completeSetup(
  dataDir: string,
  principals: { list(): Promise<{ role: string }[]>; bootstrapAdmin(name: string, credential?: {password:string;mustChange:boolean}): Promise<{ user: { name: string }; token: { token: string } }> },
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
  const supplied=form.get('password');
  if (supplied && !validPassword(supplied)) return {ok:false,status:400,message:'口令须为 12 至 256 个字符，不含控制字符'};
  const password=supplied || initialPassword();
  let created;
  try {
    created = await principals.bootstrapAdmin(name,{password,mustChange:supplied === ''});
  } catch (error) {
    return { ok: false, status: 409, message: error instanceof Error ? error.message : String(error) };
  }
  await removeSetupCode(dataDir);
  return { ok: true, token: created.token.token, name: created.user.name, password: supplied ? null : password };
}

export function environmentOptions(selected = ''): Html {
  return html`${ENVIRONMENT.map((value) => html`<option value="${value}"${value === selected ? html` selected` : ''}>${labelOf('environment', value)}</option>`)}`;
}

export function roleOptions(): Html {
  return html`${PERMISSION_ROLE.map((value) => html`<option value="${value}">${labelOf('permission_role', value)}</option>`)}`;
}
