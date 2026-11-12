// The write interfaces of /console/api (decision 125; the "管理操作接口" of the interface doc): the console's management
// operations as JSON, for an administrator's session, with the session's CSRF token in X-CSRF-Token and this console's
// Origin (checked by console/index.ts). Each runs the very `circle-hub` commands of the HTML forms, built by the same
// builders of manage.ts and run through the command bridge as the signed-in administrator, so the checks, records and
// messages are those of the command line; publishing a task pack is its two steps, a check of the uploaded zip that keeps a
// stage (POST /packs/stage) and the publication of that stage (POST /packs/stage/<id>/publish, or /discard), by the
// administrator who staged it. Every other operation is only described: POST /commands answers the command for
// the administrator's Circle to run on the Hub's host, and runs nothing. Answers follow the doc: 200 (202 for a knowledge
// import, which runs in the background) when every command finished; 400 for a parameter the builders refuse or a usage
// error (exit code 2); 409 when a command did not finish (exit code 1), with what it said; 503 when this process has no
// command bridge. An error is {code, message, fix}; none of these situations has a registered code, so code is null.
import type { CommandBridge } from '../command-bridge.ts';
import { commands } from './commands.ts';
import { ACTIONS, FormError, discardStage, publishStage, stagePack, type Built, type Form, type JobStore, type StepRefusal } from './manage.ts';
import { PACK_ID, byId } from './packs.ts';
import type { PageContext } from './pages.ts';
import { circleEntry, originOf } from './settings.ts';
import type { PackStaging } from './staging.ts';
import { runForgetTrial, runTrial, trialJson } from './trial.ts';
import type { CommandDialog } from './ui.ts';
import { neutral, type ApiResult } from './api.ts';

export interface WriteOptions {
  bridge: CommandBridge | undefined;
  jobs: JobStore;
  log: (line: string) => void;
  staging: PackStaging;
  /** The session's token: the commands act as its administrator. */
  token: string;
  /** The zip of POST /packs/stage. */
  upload?: Buffer;
}

type Fields = Readonly<Record<string, unknown>>;

const bad = (message: string, fix = '按说明改正参数后重试'): ApiResult => ({ status: 400, body: { code: null, message, fix } });
const INVITATION = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A JSON object as the builders' form: strings (trimmed, except secret values), true as '1', false as ''. */
function formOf(fields: Fields): Form {
  return {
    get: (name) => {
      const value = Object.hasOwn(fields, name) ? fields[name] : undefined;
      if (typeof value === 'boolean') return value ? '1' : '';
      if (typeof value !== 'string') return '';
      return name === 'value' || /^value_[0-9]$/.test(name) ? value : value.trim();
    },
  };
}

/** The operations that run, by their path under /console/api. */
const RUNNING: Readonly<Record<string, string>> = { members: 'member-add', systems: 'system-add', 'knowledge/imports': 'knowledge-sync' };

async function execute(ctx: PageContext, options: WriteOptions, name: string, fields: Fields): Promise<ApiResult> {
  const action = ACTIONS[name];
  if (options.bridge === undefined) return { status: 503, body: { code: null, message: '操作暂不可用：这个 Hub 进程没有接上命令执行', fix: '在运行 Hub 的服务器上执行同一命令' } };
  let built: Built[];
  try {
    const made = action.build(formOf(fields));
    built = Array.isArray(made) ? made : [made];
  } catch (error) {
    if (error instanceof FormError) return bad(error.message);
    throw error;
  }
  const bridge = options.bridge;
  const run = (step: Built) => bridge.run(step.argv, { token: options.token, ...(step.secrets ? { secrets: step.secrets } : {}) });
  if (action.background) {
    const [step] = built;
    const what = step.argv.slice(0, 2).join(' ');
    const job = options.jobs.start(action.title, step.argv, ctx.principal, async () => {
      const result = await run(step);
      options.log(`控制台后台任务 ${what}（${ctx.principal.name}）结束：退出码 ${result.code}`);
      return result;
    });
    options.log(`控制台后台任务 ${what} 由 ${ctx.principal.name} 经接口发起`);
    return { status: 202, body: { job: job.id, command: ['circle-hub', ...step.argv].join(' '), status_url: `/console/api/knowledge/imports/${job.id}` } };
  }
  const steps: { command: string; code: number; stdout: string[]; stderr: string[] }[] = [];
  for (const step of built) {
    const result = await run(step);
    options.log(`控制台管理操作 ${step.argv.slice(0, 2).join(' ')}（${ctx.principal.name}，经接口）：退出码 ${result.code}`);
    steps.push({ command: ['circle-hub', ...step.argv].join(' '), code: result.code, stdout: result.stdout, stderr: result.stderr });
    if (result.code !== 0) break;
  }
  const last = steps[steps.length - 1];
  if (last.code !== 0) {
    return { status: last.code === 2 ? 400 : 409, body: { code: null, message: last.code === 2 ? '参数不正确，未执行' : '操作未完成', fix: last.stderr[last.stderr.length - 1] ?? '按命令的输来源理后重试', steps } };
  }
  if (name !== 'member-add') return { status: 200, body: { steps } };
  // The value shown once: the invitation code (or the token), and the Circle entry that goes with it.
  const output = steps[1].stdout;
  const withToken = steps[1].command.startsWith('circle-hub token ');
  return {
    status: 200,
    body: {
      steps,
      username: String(fields.name ?? ''),
      initial_password: steps[0].stdout.find(line => /^[A-Za-z0-9_-]{24}$/.test(line)) ?? null,
      must_change_password: true,
      ...(withToken ? { token: output.find((line) => TOKEN.test(line)) ?? null } : { invitation: output.find((line) => INVITATION.test(line)) ?? null }),
      circle_entry: JSON.parse(circleEntry(originOf(ctx), withToken)) as unknown,
    },
  };
}

// ---------------------------------------------------------------- commands for the administrator's Circle

const USER_ID = /^usr_[0-9a-z]{26}$/;
const TOKEN_ID = /^tok_[0-9a-z]{26}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/** The command dialog of one operation on one object, after checking that the object exists for this administrator. */
async function described(ctx: PageContext, operation: string, object: string): Promise<CommandDialog | null> {
  const principals = ctx.deps.records.principals;
  const user = async () => (USER_ID.test(object) ? principals.get(object) : null);
  switch (operation) {
    case 'user-disable':
    case 'user-enable':
    case 'user-invite':
    case 'token-issue': {
      const found = await user();
      if (found === null||found.deleted_at) return null;
      if (operation === 'user-invite') return found.disabled ? null : commands.userInvite(found);
      if (operation === 'token-issue') return commands.tokenIssue(found);
      return operation === 'user-disable' ? commands.userDisable(found) : commands.userEnable(found);
    }
    case 'token-revoke': {
      if (!TOKEN_ID.test(object)) return null;
      for (const owner of await principals.list()) {
        const token = (await principals.tokens(owner.id)).find((t) => t.id === object && t.revoked_at === null);
        if (token !== undefined) return commands.tokenRevoke(token, owner.name);
      }
      return null;
    }
    case 'secret-set':
    case 'secret-unset':
      return SECRET_NAME.test(object) ? (operation === 'secret-set' ? commands.secretSet(object) : commands.secretUnset(object)) : null;
    case 'resource-toggle':
    case 'resource-reset-login': {
      const resource = (await ctx.deps.resources.list(ctx.principal)).find((r) => r.id === object);
      if (resource === undefined) return null;
      return operation === 'resource-toggle' ? commands.resourceToggle(resource) : commands.resourceResetLogin(resource);
    }
    case 'executor-disable': {
      const executor = ctx.deps.dispatch === undefined ? undefined : (await ctx.deps.dispatch.executors(ctx.principal)).find((e) => e.id === object && e.enabled);
      return executor === undefined ? null : commands.executorDisable(executor);
    }
    case 'pack-assign':
    case 'pack-maintainer':
    case 'pack-activate':
    case 'pack-retire': {
      const [id, version] = operation === 'pack-retire' ? object.split('@') : [object, undefined];
      const versions = PACK_ID.test(id) ? byId(await ctx.deps.packs.list(ctx.principal)).get(id) : undefined;
      if (versions === undefined) return null;
      if (operation === 'pack-retire') {
        const listed = versions.find((v) => v.version === version && !v.withdrawn);
        return listed === undefined ? null : commands.packRetire(`${listed.id}@${listed.version}`);
      }
      const live = versions.find((v) => !v.withdrawn);
      if (live === undefined) return null;
      if (operation === 'pack-assign') return live.kind === 'workflow' ? commands.packAssign(id) : null;
      if (operation === 'pack-activate') return live.kind === 'product' ? commands.packActivate(id, live.active === true) : null;
      return commands.packMaintainer(id);
    }
    case 'tls-issue':
      return object === '' ? commands.tlsIssue() : null;
    case 'backup':
      return object === '' ? commands.backup() : null;
    case 'restore':
      return object === '' ? commands.restore() : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------- publishing a task pack

const refusal = (refused: StepRefusal): ApiResult => (refused.status === 404
  ? neutral()
  : { status: refused.status, body: { code: null, message: refused.message, fix: refused.status === 503 ? '在运行 Hub 的服务器上执行同一命令' : '按说明处理后重新上传' } });

async function stage(ctx: PageContext, options: WriteOptions): Promise<ApiResult> {
  const result = await stagePack(ctx, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log }, options.token, options.upload);
  if (result.refused !== null) return refusal(result.refused);
  const run = result.run!;
  const check = { command: 'circle-hub pack publish <文件夹> --stage --dry-run', code: run.code, stdout: run.stdout, stderr: run.stderr };
  if (run.code !== 0) return { status: run.code === 2 ? 400 : 409, body: { code: null, message: '未通过发布校验', fix: '按校验结果中每条问题的处理修改后重新上传', check } };
  if (result.published !== null) return { status: 200, body: { check, stage: null, published: result.published } };
  if (result.stage === null) return { status: 409, body: { code: null, message: '发布校验已通过，但暂存未能保存', fix: '重新上传', check } };
  const staged = result.stage;
  return {
    status: 200,
    body: { check, stage: { id: staged.id, pack: staged.pack, version: staged.version, digest: staged.digest, expires_at: new Date(staged.expires).toISOString() }, publish_url: `/console/api/packs/stage/${staged.id}/publish` },
  };
}

async function publish(ctx: PageContext, options: WriteOptions, id: string): Promise<ApiResult> {
  const result = await publishStage(ctx, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log }, options.token, id);
  if (result.refused !== null) return refusal(result.refused);
  const run = result.run!;
  const steps = [{ command: 'circle-hub pack publish <文件夹> --stage', code: run.code, stdout: run.stdout, stderr: run.stderr }];
  if (run.code !== 0) return { status: run.code === 2 ? 400 : 409, body: { code: null, message: '操作未完成', fix: run.stderr[run.stderr.length - 1] ?? '按命令的输来源理后重新上传', steps } };
  return { status: 200, body: { steps, pack: result.stage!.pack, version: result.stage!.version } };
}

const STAGE_STEP = /^packs\/stage\/([A-Za-z0-9_-]{1,64})\/(publish|discard)$/;

/** Handles a POST under /console/api for an administrator; `fields` is the parsed JSON object of the body. */
export async function handleApiWrite(ctx: PageContext, rest: readonly string[], fields: Fields, options: WriteOptions): Promise<ApiResult> {
  if (!ctx.admin) return neutral();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') return bad(`字段 ${name.slice(0, 40)} 只能是字符串或真假值`);
  }
  const path = rest.join('/');
  if (Object.hasOwn(RUNNING, path)) {
    // The knowledge import runs the sync itself; a dry run is the import's preview (dry_run true).
    return execute(ctx, options, RUNNING[path], fields);
  }
  if (path === 'packs/stage') return stage(ctx, options);
  if (path === 'systems/test/forget') {
    const outcome = await runForgetTrial(ctx, formOf(fields));
    if ('forgotten' in outcome) return { status: 200, body: outcome.forgotten };
    return outcome.status === 404 ? neutral() : { status: outcome.status, body: { code: null, message: outcome.message, fix: '确认账户状态并重新填写同一组凭据后再清除' } };
  }
  // The read-only trial: fields of POST /systems, outcomes recorded without the configuration, no command run.
  if (path === 'systems/test') {
    const outcome = await runTrial(ctx, formOf(fields));
    if ('report' in outcome) return { status: 200, body: { report: trialJson(outcome.report) } };
    return outcome.status === 404 ? neutral() : { status: outcome.status, body: { code: null, message: outcome.message, fix: outcome.status === 503 ? '重启 Hub 后重试' : '按说明改正访问地址、凭据或业务系统接入后重试' } };
  }
  const step = STAGE_STEP.exec(path);
  if (step !== null && step[2] === 'publish') return publish(ctx, options, step[1]);
  if (step !== null) {
    const discarded = await discardStage(ctx, { bridge: options.bridge, jobs: options.jobs, staging: options.staging, log: options.log }, step[1]);
    return discarded === null ? neutral() : { status: 200, body: { discarded: { id: discarded.id, pack: discarded.pack, version: discarded.version } } };
  }
  if (path === 'commands') {
    const operation = typeof fields.operation === 'string' ? fields.operation : '';
    const object = typeof fields.object === 'string' ? fields.object : '';
    const dialog = await described(ctx, operation, object);
    if (dialog === null) return neutral();
    return { status: 200, body: { operation, object, title: dialog.title, text: dialog.text, command: dialog.command, executed: false } };
  }
  return neutral();
}
