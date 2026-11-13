import { isAdmin } from '../records/api.ts';
import { ADMIN_COMMANDS } from './command-registry.ts';
// The administrator commands the assembly registers with the server CLI: pack, resource, secret, knowledge, init-admin and
// operator-token. Every command that changes state acts as the admin of the operator token: CIRCLE_HUB_TOKEN, or when it is
// not set the private key file of the deployment (account operator-token beside the vault master key, hub/platform
// fileKeyStore, on every platform since decision 137); anything else is refused. The server CLI's built-in state-changing commands use the same rule
// (operatorAdmin, operatorAct). Read-only commands, the server CLI's included (operatorViewer), act as the token's account
// when there is a token (`--as` must then name that account), else as the acting admin (`--as`, or the only enabled one); a
// token file that cannot be read only costs a notice. Reads are not an access boundary: without any token they act as
// the only admin. A lost or dead token file is replaced without a token by `operator-token reissue`: a new token of an
// enabled admin goes straight into the file and is never shown. Output is Chinese, made safe for a terminal, and never shows a token
// or a secret value: tokens come from stdin, credentials from stdin or explicitly named environment-file keys, never as argv values.
import { RECORD_KINDS, type RecordKind } from '../../contracts/generated/protocol.ts';
import { variableCommand, namedSecretCommand, VAR_USAGE, NAMED_SECRET_USAGE } from './variables.ts';
import { maskCommand, MASK_USAGE } from './cli-mask.ts';
import { executorCommand, jobCommand, EXECUTOR_USAGE, JOB_USAGE, bedCommand, BED_USAGE, readUploadedCommandBytes } from './cli-job.ts';
import { traceCommand, TRACE_USAGE } from './cli-trace.ts';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isLeaseOp, labelOf } from '../../contracts/generated/vocabulary.ts';
import { HubConfigError, HubEnvironmentError } from '../config/index.ts';
import { productionShareKey, isSha256, type IssuedToken, type Page, type Principal, type RecordsKit, type SourceArtifactBody, type StoredRecord, type User } from '../records/api.ts';
import { parsePackRef } from '../runs/api.ts';
import type { CliCommand, CliContext } from './api.ts';
import { hintOf, messageOf } from './assemble/errors.ts';
import { tokenBytes, type OperatorTokenStore } from './assemble/operator-token.ts';
import { DEFAULT_ADMIN_NAME, initialPassword, validPassword } from '../records/api.ts';
import { readSecret as readSecretFromStdin } from './assemble/secret-input.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { CliError, UsageError } from './errors.ts';
import { parse, decided } from './cli-arguments.ts';
import { Session, REISSUE_LABEL, REISSUE, REMOVE_ITEM, type AdminCommandOptions, type OperatorAct } from './cli-session.ts';
import { packCommand, packIdOf, PACK_USAGE } from './cli-pack.ts';
import { resourceCommand, RESOURCE_USAGE } from './cli-resource.ts';
import { knowledgeCommand, KNOWLEDGE_USAGE } from './cli-knowledge.ts';
export type { AdminCommandOptions, OperatorAct } from './cli-session.ts';
export { PACK_USAGE } from './cli-pack.ts';
export { RESOURCE_USAGE } from './cli-resource.ts';
export { KNOWLEDGE_USAGE, writeKnowledgeViewFile, runContributionEntries } from './cli-knowledge.ts';

export { SECRET_USAGE, ORIGINAL_USAGE, LEASE_USAGE, SHARE_USAGE, UNSHARE_USAGE, DOC_USAGE, INIT_ADMIN_USAGE, OPERATOR_TOKEN_USAGE } from './cli-command-usage.ts';
import { ORIGINAL_USAGE, LEASE_USAGE, SHARE_USAGE, UNSHARE_USAGE, DOC_USAGE, INIT_ADMIN_USAGE, OPERATOR_TOKEN_USAGE } from './cli-command-usage.ts';

async function secretCommand(session: Session, args: readonly string[]): Promise<number> { return namedSecretCommand(session, args); }

// ---------------------------------------------------------------- knowledge

// ---------------------------------------------------------------- init-admin

/**
 * Stores a token nobody has seen in the operator token file. When the write fails the token is revoked, so that no token
 * exists that nobody can account for; the message says what happened (`done` first) and the hint how to go on. Neither
 * names a command that needs the token that could not be stored.
 */
const principalOf = (user: Pick<User, 'id' | 'name' | 'role'>): Principal => ({ id: user.id, name: user.name, role: user.role });

async function storeUnseen(kit: RecordsKit, store: OperatorTokenStore, admin: Pick<User, 'id' | 'name' | 'role'>, token: IssuedToken, done: string, replace = false): Promise<void> {
  try {
    await store.write(token.token, { replace });
  } catch (error) {
    let revoked: boolean;
    let why = '';
    try {
      revoked = await kit.principals.revokeToken(principalOf(admin), token.id);
    } catch (failure) {
      revoked = false;
      why = `（${messageOf(failure)}）`;
    }
    // A write whose read-back failed may still have left the file behind.
    const left = await store.present().catch(() => false);
    const stored = `${done}，但令牌没能存进${store.where}：${messageOf(error)}`;
    const remove = left ? `${REMOVE_ITEM}；` : '';
    const again = `${remove}确认私有密钥目录可用后，用 ${REISSUE} --as ${admin.name} 签发新令牌存进${store.where}（不显示）`;
    if (revoked) throw new CliError(`${stored}。这个令牌已撤销，没有显示`, again);
    throw new CliError(`${stored}。这个没有显示过的令牌 ${token.id} 没能确认已经撤销${why}`, `${again}；再用 circle-hub token revoke ${token.id} 撤销这个没有显示过的令牌`);
  }
}

export async function initAdminCommand(session: Session, args: readonly string[]): Promise<number> {
  const { positionals, values } = parse(args, { 'password-stdin': { type: 'boolean' } }, 0, 1);
  const name = positionals[0] ?? DEFAULT_ADMIN_NAME;
  const supplied = values['password-stdin'] === true ? await (session.options.readSecret ?? readSecretFromStdin)('管理员密码') : '';
  if (values['password-stdin'] === true && supplied === '') throw new UsageError('未收到管理员密码；未创建账号或操作令牌');
  if (supplied !== '' && !validPassword(supplied)) throw new UsageError('密码须为 12 至 256 个字符，不含控制字符');
  const password = supplied || initialPassword();
  const kit = await session.records();
  if ((await kit.principals.list()).some((user) => isAdmin(user))) {
    throw new CliError(
      '已经有管理员；init-admin 只建第一位管理员',
      `给用户签发令牌用 circle-hub token issue <用户>（以私有密钥文件里的操作令牌执行）；操作令牌丢了（令牌文件丢失，或它的令牌已撤销）就用 ${REISSUE}`,
    );
  }
  const store = await session.tokens();
  const replacing = await store.present();
  const { user, token } = await decided(() => kit.principals.bootstrapAdmin(name, {password,mustChange:supplied === ''}));
  await storeUnseen(kit, store, user, token, `已建立第一位管理员 ${user.name}（${user.id}）`, true);
  if (replacing) session.out('已原子替换上一个库留下的操作令牌文件');
  session.out(`已建立第一位管理员 ${user.name}（${user.id}）；它的令牌 ${token.id} 已存进${store.where}，没有显示`);
  if (supplied === '') { session.out('初始密码（仅显示一次，首次登录必须修改）：'); session.out(password); }
  session.out('之后改变状态的命令（user、token 和 pack、resource、secret、knowledge 里的这类命令）都从这个操作令牌文件读管理员令牌，不用另外给出令牌');
  return 0;
}

// ---------------------------------------------------------------- operator-token

/**
 * `operator-token set`: a lost token file (another machine, a reset data root) is replaced by a token of an enabled admin read
 * from standard input (never argv or the environment), checked against the records before it is stored, never shown.
 * `operator-token reissue [--as <admin>]`: the same without any token in hand (the break-glass path): a new token of an
 * enabled admin (`--as`, or the only one) is issued and goes straight into the item, never shown; when it cannot be stored
 * it is revoked. Neither ever overwrites a token file: one that no longer works is removed first (`operator-token remove`). The reissue
 * needs no token because the CLI is no access boundary against whoever can run it against the database (that account can
 * change the database directly); what it gives exists only in the deployment's token file.
 */
export async function operatorTokenCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'reissue') return reissueCommand(session, rest);
  if (sub === 'remove') {
    const {values} = parse(rest, {'confirm-only-operator-token':{type:'boolean'}}, 0);
    const store = await session.tokens();
    if (values['confirm-only-operator-token'] !== true) throw new UsageError('仅删除本地操作令牌文件须加 --confirm-only-operator-token；不会撤销数据库令牌或改动密钥库主密钥');
    session.out('先停止 Hub 服务并核对旧令牌；删除本地文件不会阻止运行中读取者或撤销旧令牌，恢复后用 token list 和 token revoke 核对并撤销旧令牌');
    session.out(await store.remove() ? '已删除本地操作令牌文件；密钥库主密钥未改动，数据库令牌未撤销' : '本地操作令牌文件本来就不存在；密钥库主密钥未改动');
    session.out(`下一步：${REISSUE}（有几位管理员时加 --as <管理员>），再核对并撤销旧令牌`);
    return 0;
  }
  if (sub !== 'set') throw new UsageError(`operator-token 的子命令：${OPERATOR_TOKEN_USAGE}`);
  parse(rest, {}, 0);
  const kit = await session.records();
  const store = await session.tokens();
  if (await store.present()) {
    throw new CliError(`${store.where}里已经有操作令牌，不覆盖`, `它不能用了就先${REMOVE_ITEM}，再运行 circle-hub operator-token set`);
  }
  const read = session.options.readSecret ?? ((label: string) => readSecretFromStdin(label));
  // A Hub token has no white space; a pasted line may.
  const token = (await decided(() => read('管理员令牌'))).trim();
  const principal = tokenBytes(token) === null ? null : await kit.principals.authenticate(`Bearer ${token}`);
  if (principal === null || !isAdmin(principal)) {
    throw new CliError(
      '这个令牌无效，或者不属于启用中的管理员，没有存进操作令牌文件',
      `给一个启用中的管理员的有效令牌；手里没有的话，用 ${REISSUE} 给一位启用中的管理员签发新令牌，直接存进操作令牌文件（不显示）`,
    );
  }
  await store.write(token);
  session.out(`已把管理员 ${principal.name}（${principal.id}）的操作令牌存进${store.where}，没有显示；之后改变状态的命令从这里读它`);
  return 0;
}

async function reissueCommand(session: Session, args: readonly string[]): Promise<number> {
  const { values } = parse(args, { as: { type: 'string' } }, 0);
  const kit = await session.records();
  const store = await session.tokens();
  if (await store.present()) {
    throw new CliError(`${store.where}里已经有操作令牌，不覆盖`, `它还能用就不用重新签发；不能用了（令牌已撤销、账号已停用）就先${REMOVE_ITEM}，再运行 ${REISSUE}`);
  }
  // Who: `--as`, or the only enabled admin (records keeps at least one enabled admin).
  const admin = await session.ctx.actingAdmin(values.as);
  const token = await decided(() => kit.principals.issueToken(admin, admin.id, REISSUE_LABEL));
  const done = `已为管理员 ${admin.name}（${admin.id}）签发新的操作令牌 ${token.id}`;
  await storeUnseen(kit, store, admin, token, done);
  session.out(`${done}，存进了${store.where}，没有显示；之后改变状态的命令从这里读它`);
  session.out(`原来的操作令牌如果还有效（例如还留在另一台机器的令牌文件里），用 circle-hub token list ${admin.name} 查看，用 circle-hub token revoke <令牌编号> 撤销`);
  return 0;
}

// ---------------------------------------------------------------- original: the stored originals, listed and exported

/**
 * The read originals a gold script needs as input: every stored `source_artifact` whose origin is a read, by external id.
 * Only the external id, the digest, the size and the read time reach the screen — never the content.
 */
export async function originalCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { external: { type: 'string' }, suffix: { type: 'string' }, limit: { type: 'string' }, as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (!isAdmin(viewer)) throw new CliError('只有管理员能列出原件');
    const limit = values.limit === undefined ? 100 : Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new UsageError('--limit 是 1 到 500 的整数');
    const kit = await session.records();
    const lines: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Page<StoredRecord<SourceArtifactBody>> = await kit.store.list<SourceArtifactBody>({ kind: 'source_artifact', newestFirst: true, limit: 200, ...(cursor === null ? {} : { cursor }) });
      for (const record of page.items) {
        const body = record.body;
        if (!('read' in body.origin)) continue;
        const object = body.origin.read.object;
        if (values.external !== undefined && !object.startsWith(values.external)) continue;
        if (values.suffix !== undefined && !object.endsWith(values.suffix)) continue;
        // One line per external id: the newest read of the same object decides the digest shown.
        if (seen.has(object)) continue;
        seen.add(object);
        lines.push([object, body.sha256, `${body.size} 字节`, body.captured_at].join('\t'));
        if (lines.length >= limit) break;
      }
      cursor = lines.length >= limit ? null : page.next;
    } while (cursor !== null);
    if (lines.length === 0) session.out(values.suffix !== undefined ? (values.external === undefined ? '没有符合指定后缀的原件' : '没有同时符合指定前缀和后缀的原件') : values.external === undefined ? '还没有读过的原件' : '没有外部标识以这个前缀开头的原件');
    for (const line of lines) session.out(line);
    return 0;
  }
  if (sub === 'export') {
    const { positionals, values } = parse(rest, { out: { type: 'string' } }, 1);
    if (values.out === undefined || values.out === '') throw new UsageError('要用 --out 给出写到哪个文件');
    const sha = positionals[0];
    if (!isSha256(sha)) throw new UsageError('sha256 要写成 64 位小写十六进制');
    const viewer = await session.viewer(undefined);
    if (!isAdmin(viewer)) {
      // A non-admin gets the same answer as for a nonexistent original: no existence signal.
      throw new CliError('Hub 没有保存这份原件');
    }
    const kit = await session.records();
    const bytes = await kit.artifacts.trustedBytes(sha);
    if (bytes === null) throw new CliError('Hub 没有保存这份原件');
    const target = resolve(values.out);
    const existing = await lstat(target).then(() => true, () => false);
    if (existing) throw new CliError(`文件已存在，不覆盖：${target}`, '换一个不存在的文件名');
    try {
      await writeFile(target, bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      const why = error !== null && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string' ? (error as { code: string }).code : error instanceof Error ? error.message : '写入失败';
      throw new CliError(`写不了这个文件：${target}`, `检查路径和权限（${why}）`);
    }
    session.out(`已导出 ${sha}：${bytes.length} 字节，权限 0600`);
    return 0;
  }
  throw new UsageError(`original 的子命令：${ORIGINAL_USAGE}`);
}

// ---------------------------------------------------------------- lease: the lease table, listed and force-released

/**
 * The administrator's lease commands: `lease list` shows the unexpired, unreleased rows (key, holder run, until) of a
 * prefix — never the fencing token or the lease id; `lease release` force-frees a key with a reason that lands in the
 * action record. Only administrators; a non-administrator gets the same answer as for a row that does not exist.
 */
export async function leaseCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'list') {
    const { values } = parse(rest, { prefix: { type: 'string' }, as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (!isAdmin(viewer)) throw new CliError('只有管理员能列出租约');
    const leases = await session.leases();
    const view = await leases.view(values.prefix ?? '', true);
    const registrations=await leases.registrations(values.prefix??'');
    const names=await session.names();
    const name=(id:string|undefined)=>id===undefined?'—':(names.get(id)??id+'（用户资料缺失，请管理员恢复）');
    if (view.entries.length === 0 && registrations.length===0) session.out('没有未到期的租约');
    for(const row of view.entries){const owner=registrations.find(reg=>row.key.startsWith(reg.prefix));
      session.out([row.key,name(owner?.owner),name(row.user),row.run,row.since,row.until??'无到期时刻'].join('\t'));
    }
    for(const reg of registrations)if(!view.entries.some(row=>row.key.startsWith(reg.prefix)))session.out([reg.prefix,name(reg.owner),'空闲','—','—','—'].join('\t'));
    return 0;
  }
  if(isLeaseOp(sub)&&(sub==='register'||sub==='unregister')){
    const {positionals,values}=parse(rest,{owner:{type:'string'},reason:{type:'string'},as:{type:'string'}},1);
    const prefix=positionals[0]??'';
    if(!values.reason?.trim())throw new UsageError('登记或注销须写 --reason <理由>');
    if(sub==='register'&&!values.owner)throw new UsageError('登记须写 --owner <用户>');
    const viewer=await session.viewer(values.as);
    if(!isAdmin(viewer))throw new CliError('只有管理员能管理登记');
    const leases=await session.leases();
    if(sub==='unregister'){
      const outcome=await leases.unregister({prefix,by:viewer.id,admin:true,reason:values.reason});
      if(!outcome.ok)throw new CliError(outcome.message,'先强制释放，或等它释放；再核对登记');
    }else{
      const owner=await session.user(values.owner!);
      if(owner.disabled)throw new CliError('不能登记给已停用的用户','先核对用户状态');
      const hub=await session.hub();const prefixes:string[]=[];
      for(const pack of await hub.registry.listPacks())if(pack.kind==='workflow')for(const version of pack.versions){
        const loaded=await hub.workflows.byDigest(version.digest);if(loaded?.workflow.leases)prefixes.push(loaded.workflow.leases.prefix);
      }
      const declared=prefixes.filter(root=>prefix.startsWith(root)&&prefix!==root).sort((a,b)=>b.length-a.length)[0];
      if(!declared)throw new CliError('没有工作流声明这个租约前缀','先发布声明对应租约前缀的工作流，再登记其下的键前缀');
      const outcome=await leases.register({prefix,declaredPrefix:declared,owner:owner.id,by:viewer.id,admin:true,reason:values.reason});
      if(!outcome.ok)throw new CliError(outcome.message,'核对登记前缀，不要使已有登记互相包含');
    }
    session.out(sub==='register'?'已登记 '+prefix:'已注销 '+prefix);
    return 0;
  }
  if (sub === 'release') {
    const { positionals, values } = parse(rest, { reason: { type: 'string' }, as: { type: 'string' } }, 1);
    const key = positionals[0] ?? '';
    if (key === '' || !/^[a-z0-9][a-z0-9:._/-]{0,199}$/.test(key)) throw new UsageError('键的写法不对（小写字母、数字和 :._/-，最长 200）');
    if (values.reason === undefined || values.reason.trim() === '') throw new UsageError('强制释放要写 --reason <理由>（写进动作记录）');
    const viewer = await session.viewer(values.as);
    if (!isAdmin(viewer)) {
      // The same answer as for a row that does not exist: no existence signal for a non-administrator.
      throw new CliError('没有租约行');
    }
    const leases = await session.leases();
    const dispatch = (await session.hub()).dispatch;
    if (!dispatch) throw new CliError('缺少未终态作业事实', '请管理员配置只读作业端口后重试');
    const jobs = await dispatch.activeLeaseJobs([key]);
    if (jobs.length) throw new CliError(`作业 ${jobs.map(job=>job.job).join('、')} 还没有终态，本地释放停不了网关上的作业`, '等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
    const outcome = await leases.forceRelease({ keys: [key], by: viewer.id, reason: values.reason, guard:async()=>{
      const active=await dispatch.activeLeaseJobs([key]);
      if(active.length)throw new CliError('作业 '+active.map(job=>job.job).join('、')+' 还没有终态，本地释放停不了网关上的作业','等它结束，或者请管理员用 circle-hub job status 看、用 job dispose 处置');
    } });
    if (!outcome.ok) throw new CliError(outcome.code === 'LEASE_NO_ROW' ? '没有租约行' : `没有释放：${outcome.message}`, outcome.code === 'LEASE_NO_ROW' ? '键上没有未到期的租约' : '稍后再试');
    session.out(`已释放 ${key}（理由：${values.reason.trim()}）`);
    return 0;
  }
  throw new UsageError(`lease 的子命令：${LEASE_USAGE}`);
}

// ---------------------------------------------------------------- doc: named documents

/**
 * The `doc` command (C4, hub/server/docs.ts): an admin publishes a named document with `doc put` (the file through the
 * source pipeline, the pointer moved by compare-and-set); `doc list` and `doc show` print name, digest and size only.
 * Everyone who is not an admin gets the same answer as for a doc that does not exist.
 */
export async function docCommand(session: Session, args: readonly string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === 'put') {
    const { positionals, values } = parse(rest, { reference: { type: 'string' } }, 1, 2);
    const [name, file] = positionals;
    if (Number(file !== undefined) + Number(values.reference !== undefined) !== 1) throw new UsageError('定义文件和 --reference 必须且只能提供一种');
    // The neutral rule: a non-admin is told what they would hear for a doc that does not exist.
    const viewer = await session.viewer(undefined);
    if (!isAdmin(viewer)) throw new CliError(`没有叫 ${name.slice(0, 80)} 的命名文档`);
    const admin = await session.admin();
    const source = file === undefined ? undefined : isAbsolute(file) ? file : resolve(session.ctx.io.cwd, file);
    const bytes = values.reference !== undefined
      ? await readUploadedCommandBytes(await session.records(), admin, values.reference)
      : await readFile(source!).catch(() => null);
    if (bytes === null) throw new CliError(`读不出文件 ${file.slice(0, 120)}`, '给一个有读取权限的现有文件');
    const hub = await session.hub();
    const put = await decided(() => hub.docs.put(admin, name, new Uint8Array(bytes), source === undefined ? {} : { fileName: basename(source) }));
    session.out(put.created ? `已发布命名文档 ${put.name}（摘要 ${put.sha256}，${put.size} 字节）` : `命名文档 ${put.name} 已经是这份（摘要 ${put.sha256}，${put.size} 字节）`);
    return 0;
  }
  if (sub === 'list') {
    const { values } = parse(rest, { as: { type: 'string' } }, 0);
    const viewer = await session.viewer(values.as);
    if (!isAdmin(viewer)) {
      session.out('还没有命名文档');
      return 0;
    }
    const hub = await session.hub();
    const list = await hub.docs.list();
    if (list.length === 0) {
      session.out('还没有命名文档');
      return 0;
    }
    for (const info of list) session.out(`${info.name}\t${info.sha256}\t${info.size} 字节`);
    return 0;
  }
  if (sub === 'show') {
    const { values, positionals } = parse(rest, { as: { type: 'string' } }, 1);
    const viewer = await session.viewer(values.as);
    if (!isAdmin(viewer)) throw new CliError(`没有叫 ${positionals[0].slice(0, 80)} 的命名文档`);
    const hub = await session.hub();
    const info = await hub.docs.show(positionals[0]);
    if (info === null) throw new CliError(`没有叫 ${positionals[0].slice(0, 80)} 的命名文档`);
    session.out(`${info.name}\t${info.sha256}\t${info.size} 字节`);
    return 0;
  }
  throw new UsageError(`doc 的子命令：${DOC_USAGE}`);
}

export async function recordsCommand(session:Session,args:readonly string[]):Promise<number> {
  const [sub,...rest]=args;if(sub!=='verify')throw new UsageError('records verify [--kind <记录类型>] [--vault]');
  const {values}=parse(rest,{kind:{type:'string'},as:{type:'string'},vault:{type:'boolean'}},0);
  const viewer=await session.viewer(values.as);if(!isAdmin(viewer))throw new CliError('只有管理员能核对记录完整性');
  const kind=values.kind ?? 'action';if(!(RECORD_KINDS as readonly string[]).includes(kind))throw new UsageError('记录类型不在生成的协议词表里');
  const records=await session.records();let cursor:string|null=null,total=0,notes=0;
  do {
    const page:Page<StoredRecord>=await records.store.list({kind:kind as RecordKind,limit:500,...(cursor?{cursor}:{})});
    for(const record of page.items){total++;if(record.integrity_note){notes++;if(record.kind==='action')session.out(`记录 ${record.id}；摘要 ${record.digest}；${record.integrity_note}`);}}
    cursor=page.next;
  }while(cursor);
  session.out(`已核对记录 ${total}；正文不是规范写法、内容与摘要一致 ${notes}`);
  if(values.vault){
    if(!records.vault.verify){session.out('密钥库核验未知：当前密钥库不支持只读逐条核验；下一步：安装支持核验的版本并停写后重试');return 1;}
    let result;
    try { result=await records.vault.verify(); } catch {session.out('密钥库核验未知：读取或解密核验未完成；下一步：停写并检查密钥来源和密钥库完整性后重试');return 1;}
    session.out(`密钥库：已核验 ${result.checked} 条；异常 ${result.failed} 项`);
    if(result.unknown){session.out('密钥库核验未知：没有可核对的密文条目或缺少必要事实；下一步：确认迁移源含密文条目和正确主密钥，停写后重试');return 1;}
    if(result.failed){session.out('密钥库核验未通过；下一步：检查备份、密钥及密文条目，停写后重试');return 1;}
  }
  return 0;
}

// ---------------------------------------------------------------- sharing (B04, R02): a read capability only
export async function sharingCommand(session: Session, args: readonly string[], withdraw = false): Promise<number> {
  const admin = await session.admin();
  const kit = await session.records();
  const [sub, ...rest] = args;
  if (sub === 'list' && !withdraw) {
    const {values} = parse(rest,{object:{type:'string'}},0);
    const shares = await kit.authorizations.shares(admin,values.object);
    const names = await session.names();
    for (const share of shares) session.out([share.body.object,labelOf('share_audience',share.body.share_audience ?? 'user'),names.get(share.body.subject) ?? share.body.subject,share.body.note ?? ''].map(terminalSafe).join('\t'));
    if (!shares.length) session.out('没有有效分享');
    return 0;
  }
  if (sub !== 'run' && sub !== 'production') throw new UsageError(withdraw ? UNSHARE_USAGE : SHARE_USAGE);
  const {positionals,values} = parse(rest,{users:{type:'string'},user:{type:'string'},'pack-users':{type:'boolean'},reason:{type:'string'}},1);
  const hub = await session.hub();
  let object: string; let pack: string;
  if (sub === 'run') {
    const run = await hub.deps.runs.getRun(admin,positionals[0]);
    if (!run) throw new CliError('对你不可用');
    object = run.run.run; pack = parsePackRef(run.run.pack)!.id;
    if (withdraw) {
      if (Boolean(values.user) === Boolean(values['pack-users']) || values.users) throw new UsageError(UNSHARE_USAGE);
      const audience = values.user ? (await session.user(values.user)).id : {kind:'pack_users' as const,pack};
      await kit.authorizations.unshare(admin,object,audience,values.reason);
    } else {
      if (Boolean(values.users) === Boolean(values['pack-users']) || values.user) throw new UsageError(SHARE_USAGE);
      const audience = values.users ? await Promise.all(values.users.split(',').map(async name => (await session.user(name.trim())).id)) : {kind:'pack_users' as const,pack};
      await kit.authorizations.share(admin,object,audience,values.reason);
    }
  } else {
    if (values.users || values.user || values['pack-users']) throw new UsageError(withdraw ? UNSHARE_USAGE : SHARE_USAGE);
    pack = packIdOf(positionals[0],'分享');
    const published = await hub.registry.resolve(pack);
    if (!published || published.kind !== 'workflow') throw new CliError('对你不可用');
    object = productionShareKey(pack);
    const audience = {kind:'pack_users' as const,pack};
    if (withdraw) await kit.authorizations.unshare(admin,object,audience,values.reason);
    else await kit.authorizations.share(admin,object,audience,values.reason);
  }
  session.out(`${withdraw ? '已撤回分享' : '已分享（只读）'} ${object}`);
  return 0;
}

// ---------------------------------------------------------------- registration

/**
 * An error a command ends with, made safe for a terminal (a message or a hint may quote a pack, a resource or a remote
 * system). The configuration's own errors pass unchanged: the server CLI prints them as they are.
 */
function terminalSafeError(error: unknown): unknown {
  if (error instanceof HubEnvironmentError || error instanceof HubConfigError) return error;
  if (error instanceof UsageError) return new UsageError(terminalSafe(error.message));
  if (error instanceof CliError) return new CliError(terminalSafe(error.message), error.hint === null ? null : terminalSafe(error.hint));
  const hint = hintOf(error);
  return new CliError(terminalSafe(messageOf(error)), hint === null ? null : terminalSafe(hint));
}

/**
 * The enabled admin of the operator token (CIRCLE_HUB_TOKEN, else the token file), for any state-changing CLI command,
 * the server CLI's built-in ones included. It takes CIRCLE_HUB_TOKEN out of the environment object (no child process this
 * command starts gets it); before or after `ctx.config()`, which accepts the name for commands.
 */
export function operatorAdmin(ctx: CliContext, options: AdminCommandOptions = {}): Promise<Principal> {
  return new Session(ctx, options).admin();
}

export function operatorMember(ctx:CliContext,options:AdminCommandOptions={}):Promise<Principal>{return new Session(ctx,options).member();}

/** operatorAdmin for a command that may cut off its own token: afterwards it says whether the operator token still works. */
export function operatorAct(ctx: CliContext, options: AdminCommandOptions = {}): Promise<OperatorAct> {
  return new Session(ctx, options).act();
}

/**
 * Who a read-only CLI command reads as, the server CLI's built-in ones included: the account of the operator token when
 * there is one (`--as` must then name that account), else `--as` or the only enabled admin (Session.viewer).
 */
export function operatorViewer(ctx: CliContext, options: AdminCommandOptions = {}, as?: string): Promise<Principal> {
  return new Session(ctx, options).viewer(as);
}

/** The administrator commands, for the assembly's registerCommands (tests inject the token store, stdin and the assembly). */
export function adminCommands(options: AdminCommandOptions = {}): CliCommand[] {
  return ADMIN_COMMANDS.map(({ name, summary, handler }) => ({
    name,
    summary,
    run: async (args, ctx) => {
      const session = new Session(ctx, options);
      try {
        return await handler(session, args);
      } catch (error) {
        throw terminalSafeError(error);
      } finally {
        await session.close();
      }
    },
  }));
}
