import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { UserId } from '../../contracts/src/common.ts';
import type { HubConfig } from '../config/index.ts';
import { Database, createPool, openRecords, isAdmin, sha256Hex, parseStrictJson, type RecordsKit } from '../records/api.ts';
import { type SyncReport } from '../knowledge/api.ts';
import { CODE_ROOT, createContext, identityOf, settingsOf, serviceEnvironment, toolEnvironment, renderPlist, withLock, writeFileAtomic, hubKeyProvider, platformLockPath } from '../platform/api.ts';
import { assembleHub } from './assemble/hub.ts';
import type { Session } from './cli-session.ts';
import { loadServerConfig } from './main.ts';
import { CliError } from './errors.ts';

export interface DeploymentSyncTarget { product: string; line: string | null }
interface DeploymentSyncIntentValue { schema: 'deployment-sync-intent@1'; targets: DeploymentSyncTarget[] }
async function parseIntent(input: unknown): Promise<DeploymentSyncIntentValue> {
  return (await import('../../contracts/src/deployment.ts')).DeploymentSyncIntent.parse(input);
}
export interface DeploymentSyncTask extends DeploymentSyncTarget { id: string; progressCommand: string }
export interface DeploymentSyncStatus extends DeploymentSyncTarget {
  id: string; running: boolean; completed: boolean; probing: boolean; synchronized: boolean; current: boolean;
  error?: { reason: string; nextAction: string };
}
interface Request extends DeploymentSyncTarget { id: string; actor: string; databaseOid: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const intentKey = 'deployment-sync';
const problem = () => new CliError('后台知识同步未完成', '使用 knowledge sync-status 查询任务；修复来源、权限或初始化状态后重新提交');
const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
function paths(config: HubConfig, id: string) {
  if (!UUID.test(id)) throw new CliError('知识同步任务编号无效');
  const directory = join(config.dataDir, 'run', 'deployment-sync');
  return { directory, request: join(directory, id + '.request.json'), status: join(directory, id + '.status.json'), claim: join(directory, id + '.claim') };
}
async function privateDirectory(directory: string, create = false) {
  if (create) await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw problem();
}
async function directory(config: HubConfig) {
  await privateDirectory(config.dataDir);
  await privateDirectory(join(config.dataDir, 'run'), true);
  const result = join(config.dataDir, 'run', 'deployment-sync');
  await privateDirectory(result, true);
  return result;
}
async function readPrivate(path: string): Promise<unknown> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 1024 * 1024) throw problem();
    return parseStrictJson(await file.readFile('utf8'));
  } finally { await file.close(); }
}
function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw problem();
  return input as Record<string, unknown>;
}
async function requestOf(config: HubConfig, id: string): Promise<Request> {
  const value = object(await readPrivate(paths(config, id).request));
  if (value.id !== id || typeof value.databaseOid !== 'string' || !/^[1-9][0-9]*$/.test(value.databaseOid)) throw problem();
  const actor = UserId.parse(value.actor);
  const [target] = (await parseIntent({ schema: 'deployment-sync-intent@1', targets: [{ product: value.product, line: value.line }] })).targets;
  if (!target) throw problem();
  return { id, actor, databaseOid: value.databaseOid, ...target };
}
async function statusOf(config: HubConfig, id: string): Promise<DeploymentSyncStatus> {
  const request = await requestOf(config, id), value = object(await readPrivate(paths(config, id).status));
  if (value.id !== id || value.product !== request.product || value.line !== request.line) throw problem();
  for (const key of ['running', 'completed', 'probing', 'synchronized', 'current']) if (typeof value[key] !== 'boolean') throw problem();
  return { id, product: request.product, line: request.line, running: value.running as boolean, completed: value.completed as boolean,
    probing: value.probing as boolean, synchronized: value.synchronized as boolean, current: value.current as boolean,
    ...(value.error === undefined ? {} : { error: { reason: '同步尚未证实完成', nextAction: '核对来源、管理员权限及数据库身份后重新提交' } }) };
}
async function save(config: HubConfig, status: DeploymentSyncStatus) {
  await writeFileAtomic(paths(config, status.id).status, JSON.stringify(status), 0o600);
}
async function databaseOid(config: HubConfig): Promise<string> {
  const db = new Database(createPool(config.database, 1));
  try {
    const row = (await db.query('SELECT oid::text AS oid FROM pg_database WHERE datname=current_database()')).rows[0];
    if (!row || typeof row.oid !== 'string') throw problem();
    return row.oid;
  } finally { await db.end(); }
}
async function resetting(config: HubConfig): Promise<boolean> {
  try { await lstat(join(config.dataDir, 'run', 'reset-operation.json')); return true; }
  catch (error) { if (absent(error)) return false; throw error; }
}

/** Exact current authorization binding only. No scan of history and no inference from previous successful jobs. */
export async function readDeploymentSyncIntent(session: Session): Promise<DeploymentSyncIntentValue | null> {
  await session.admin();
  return readIntent(await session.records());
}
async function readIntent(records: RecordsKit): Promise<DeploymentSyncIntentValue | null> {
  const authorization = await records.authorizations.resourceConfig(intentKey);
  if (!authorization?.body.bound) return null;
  const bytes = await records.objects.get(authorization.body.bound);
  if (!bytes || sha256Hex(bytes) !== authorization.body.bound) throw new CliError('部署同步声明原件缺失或摘要不一致');
  return parseIntent(parseStrictJson(Buffer.from(bytes).toString('utf8')));
}

async function launch(config: HubConfig, id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const context = createContext(env), settings = await settingsOf(context);
  const environment = serviceEnvironment(context.layout, settings, identityOf(context));
  const child = loadServerConfig(environment);
  if (child.dataDir !== config.dataDir || child.database.host !== config.database.host || child.database.port !== config.database.port || child.database.database !== config.database.database || child.database.user !== config.database.user) throw new CliError('后台同步目标与当前服务数据库不一致，未启动任务');
  const args = [process.execPath, join(CODE_ROOT, 'bin', 'circle-hub'), 'knowledge', 'sync-worker', id];
  const label = 'io.github.circle-platforms.circle-hub.deployment-sync.' + id;
  if (context.platform === 'linux') {
    const result = await context.runner('/usr/bin/systemd-run', ['--user', '--quiet', '--collect', '--unit=' + label,
      '--property=Type=exec', '--property=UMask=0077', '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null',
      '--property=LimitCORE=0', '--property=CoredumpFilter=0', ...Object.entries(environment).map(([k,v]) => `--setenv=${k}=${v}`), '--', ...args],
    { env: toolEnvironment({ HOME: context.home, USER: context.user, XDG_RUNTIME_DIR: `/run/user/${context.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${context.uid}/bus` }), timeoutMs: 15_000 });
    if (result.code !== 0) throw problem();
  } else if (context.platform === 'darwin') {
    const plist = join(paths(config,id).directory, id + '.plist');
    const text = renderPlist({ label, programArguments: args, workingDirectory: CODE_ROOT, environment, standardOutPath: '/dev/null', standardErrorPath: '/dev/null' }).replace('<key>KeepAlive</key>\n\t<true/>', '<key>KeepAlive</key>\n\t<false/>');
    await writeFile(plist, text, { flag: 'wx', mode: 0o600 });
    const result = await context.runner('/bin/launchctl', ['bootstrap', `gui/${context.uid}`, plist], { env: toolEnvironment({ HOME: context.home, USER: context.user }), timeoutMs: 15_000 });
    if (result.code !== 0) throw problem();
  } else throw new CliError('当前系统不支持后台知识同步');
}

/** Returns only after durable requests and supervisor launches. Never probes or synchronizes in the submitting process. */
export async function queueDeploymentSync(session: Session, input: readonly DeploymentSyncTarget[]): Promise<{ tasks: DeploymentSyncTask[]; current: DeploymentSyncTarget[] }> {
  const actor = await session.admin(), config = session.config();
  const targets = (await parseIntent({ schema: 'deployment-sync-intent@1', targets: input })).targets;
  const intent = await readIntent(await session.records());
  if (targets.some(target => !intent?.targets.some(declared => declared.product === target.product && declared.line === target.line)))
    throw new CliError('同步目标尚未列入当前已授权部署声明，未提交任务');
  const root = await directory(config);
  return withLock(join(root, 'queue.lock'), async () => {
    if (await resetting(config)) throw new CliError('初始化进行中，未提交后台同步任务');
    const oid = await databaseOid(config), tasks: DeploymentSyncTask[] = [];
    const unique = new Map(targets.map(target => [JSON.stringify([target.product,target.line]), target]));
    for (const target of unique.values()) {
      let id: string | undefined;
      for (const file of await readdir(root)) {
        if (!file.endsWith('.request.json')) continue;
        const candidate = file.slice(0, -'.request.json'.length);
        const request = await requestOf(config, candidate);
        if (request.databaseOid === oid && request.product === target.product && request.line === target.line && !(await statusOf(config,candidate)).completed) { id = candidate; break; }
      }
      if (!id) {
        id = randomUUID();
        const request: Request = { id, actor: actor.id, databaseOid: oid, ...target };
        await writeFile(paths(config,id).request, JSON.stringify(request), { flag: 'wx', mode: 0o600 });
        const status: DeploymentSyncStatus = { id, ...target, running: false, completed: false, probing: false, synchronized: false, current: false };
        await save(config,status);
        try { await launch(config,id,session.ctx.io.env); }
        catch { await save(config,{...status,completed:true,error:{reason:'独立同步进程未能启动',nextAction:'修复用户服务管理器后重新提交'}}); throw problem(); }
      }
      tasks.push({ id, ...target, progressCommand: 'circle-hub knowledge sync-status ' + id });
    }
    return { tasks, current: [] };
  });
}

/** A fresh, complete report may establish unchanged roots. No timestamps or human reason strings are evidence. */
export function unchangedDeploymentProbe(report: SyncReport): boolean {
  if (!report.dry_run || report.error !== null || !report.plan.done || report.plan.failed_reads.length || report.plan.limits.rounds || report.plan.limits.reads || report.counts.failed) return false;
  const roots = [...report.builds, ...(report.scope ? [report.scope] : [])];
  return roots.length > 0 && roots.every(root => root.outcome === 'skipped' && root.root !== null && root.composition !== null && root.would_produce !== true);
}

export async function deploymentSyncStatus(session: Session, id: string): Promise<DeploymentSyncStatus> {
  await session.admin();
  await directory(session.config());
  return statusOf(session.config(),id);
}

/** Fixed internal CLI branch. Uses neither the submitting Session nor any of its pools or token material. */
async function executeDeploymentSyncWorker(config: HubConfig, id: string, env: NodeJS.ProcessEnv): Promise<number> {
  await directory(config);
  const request = await requestOf(config,id), file = paths(config,id);
  if ((await statusOf(config,id)).completed) return 1;
  try { await writeFile(file.claim,id,{flag:'wx',mode:0o600}); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 1; throw error; }
  const state: DeploymentSyncStatus = { id, product: request.product, line: request.line, running:true,completed:false,probing:false,synchronized:false,current:false };
  const controller = new AbortController(), finished = new AbortController();
  let records: Awaited<ReturnType<typeof openRecords>> | undefined;
  let hub: Awaited<ReturnType<typeof assembleHub>> | undefined;
  let changed = false;
  const monitor = async () => {
    try {
      while (!finished.signal.aborted) {
        if (await resetting(config) || await databaseOid(config) !== request.databaseOid) { changed=true;controller.abort();return; }
        await delay(250,undefined,{signal:finished.signal});
      }
    } catch { if (!finished.signal.aborted) { changed=true;controller.abort(); } }
  };
  let observing: Promise<void> | undefined;
  try {
    await save(config,state);
    if (await resetting(config)) throw problem();
    if (await databaseOid(config) !== request.databaseOid) throw problem();
    records = await openRecords(config,{migrate:false,keyProvider:hubKeyProvider(env)});
    const actor = await records.principals.get(request.actor);
    if (!actor || actor.disabled || actor.deleted_at || !isAdmin(actor)) throw new CliError('提交同步的管理员已失效，未执行同步');
    const intent = await readIntent(records);
    if (!intent?.targets.some(target => target.product === request.product && target.line === request.line)) throw new CliError('当前部署声明不再包含该同步目标');
    observing = monitor();
    hub = await assembleHub(config,records,{command:true,leases:null});
    if (changed) throw problem();
    await save(config,{...state,probing:true});
    const product = (await hub.packs.productByName(request.product)) ?? (await hub.packs.productById(request.product));
    if (!product) throw problem();
    const synchronize = (by: typeof actor, dryRun: boolean) => hub!.knowledge.syncProduct(product, {
      by, ...(request.line === null ? {} : { lines: [request.line] }), dryRun, recheck:true, includeUnreleased:false,maxAgeSeconds:0,signal:controller.signal,
    });
    const probe = await synchronize(actor,true);
    if (changed || probe.error !== null || !probe.plan.done || probe.plan.failed_reads.length || probe.counts.failed) throw problem();
    if (unchangedDeploymentProbe(probe)) { await save(config,{...state,running:false,completed:true,current:true}); return 0; }
    const freshActor = await records.principals.get(request.actor);
    if (!freshActor || freshActor.disabled || freshActor.deleted_at || !isAdmin(freshActor) || changed) throw problem();
    await save(config,{...state,probing:false});
    const result = await synchronize(freshActor,false);
    if (changed || result.error !== null || !result.plan.done || result.plan.failed_reads.length || result.counts.failed) throw problem();
    await save(config,{...state,running:false,completed:true,synchronized:true});
    return 0;
  } catch {
    await save(config,{...state,running:false,completed:true,error:{reason:'同步未完成或数据库身份已改变',nextAction:'初始化结束后核对数据库、管理员和来源，再重新提交'}});
    return 1;
  } finally {
    finished.abort(); await observing;
    await hub?.dispatch?.close();
    await records?.close();
  }
}

/** Share reset's existing exclusion boundary so it cannot replace a database between our OID check and a write. */
export async function runDeploymentSyncWorker(config: HubConfig, id: string, env: NodeJS.ProcessEnv): Promise<number> {
  await directory(config);
  const request = await requestOf(config,id);
  const lock = platformLockPath(createContext(env));
  const occupied = async () => {
    try { await lstat(lock); return true; }
    catch (error) { if (absent(error)) return false; throw error; }
  };
  for (;;) {
    while (await resetting(config)) await delay(250);
    let entered = false;
    try {
      return await withLock(lock, () => { entered=true; return executeDeploymentSyncWorker(config,id,env); });
    } catch {
      if (!entered && await occupied()) { await delay(250); continue; }
      await save(config,{id,product:request.product,line:request.line,running:false,completed:true,probing:false,synchronized:false,current:false,
        error:{reason:'同步执行条件或初始化互斥未能核对',nextAction:'初始化结束后重新提交同步'}});
      return 1;
    }
  }
}
