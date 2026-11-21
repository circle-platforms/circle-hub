// Reset is the only operation accepted by this worker; the parent CLI supplies its already-bound execution ports.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { CODE_ROOT, identityOf, settingsOf, type PlatformContext } from '../../platform/api.ts';
import { PlatformError } from '../../platform/api.ts';
import { withLock, writeFileAtomic } from '../../platform/api.ts';
import { renderPlist, serviceEnvironment } from '../../platform/api.ts';
import { toolEnvironment } from '../../platform/api.ts';
import { parseResetRequest, type ResetRequest, type ResetReport } from './types.ts';

export interface ResetWorkerStatus {
  operationId: string;
  acknowledged: boolean;
  running: boolean;
  completed: boolean;
  report?: ResetReport;
  error?: { reason: string; nextAction: string };
}
interface Envelope { operationId: string; authorizationContext: string; request: ResetRequest; ackDeadline: number }
interface PrivateStatus extends ResetWorkerStatus { workerPid?: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACK_WAIT_MS = 30_000;
const failed = { reason: '初始化操作未完成', nextAction: '检查私有备份与恢复状态后重试；不要删除归档' };
function paths(context: PlatformContext, id: string) {
  if (!UUID.test(id)) throw new PlatformError('初始化操作编号无效');
  const directory = join(context.layout.run, 'reset');
  return { directory, request: join(directory, `${id}.request.json`), status: join(directory, `${id}.status.json`), ack: join(directory, `${id}.ack`), claim: join(directory, `${id}.claim`) };
}
function auth(value: string): void {
  if (typeof value !== 'string' || !/^(?:admin|setup):[^\s\p{Cc}]{1,200}$/u.test(value)) throw new PlatformError('初始化授权上下文无效');
}
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new PlatformError('初始化状态目录不是私有目录');
}
async function privateText(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (info.mode & 0o077) !== 0) throw new PlatformError('初始化状态文件不是私有文件');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function envelope(context: PlatformContext, id: string, authorizationContext?: string): Promise<Envelope> {
  const value = JSON.parse(await privateText(paths(context, id).request)) as Envelope;
  if (value.operationId !== id || !Number.isFinite(value.ackDeadline)) throw new PlatformError('初始化请求无法核对');
  auth(value.authorizationContext);
  if (authorizationContext !== undefined && value.authorizationContext !== authorizationContext) throw new PlatformError('对象不存在或无权读取');
  return { ...value, request: parseResetRequest(value.request) };
}
async function status(context: PlatformContext, id: string): Promise<PrivateStatus> {
  const value = JSON.parse(await privateText(paths(context, id).status)) as PrivateStatus;
  if (value.operationId !== id || typeof value.completed !== 'boolean' || typeof value.running !== 'boolean' || typeof value.acknowledged !== 'boolean') throw new PlatformError('初始化状态无法核对');
  if (!value.completed) {
    let error: ResetWorkerStatus['error'];
    if (value.workerPid !== undefined) {
      if (!Number.isSafeInteger(value.workerPid) || value.workerPid < 1) throw new PlatformError('初始化进程编号无法核对');
      try { process.kill(value.workerPid, 0); }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === 'ESRCH') error = { reason: '初始化进程已停止，结果尚未确认', nextAction: '以新授权操作重试，由初始化入口先恢复未完成的操作；不要删除归档' };
        else if (code !== 'EPERM') throw cause;
      }
    } else if (!value.running && context.now().getTime() >= (await envelope(context, id)).ackDeadline) {
      error = { reason: '初始化工作进程未确认启动，未执行初始化', nextAction: '以新授权操作重新预览并确认初始化' };
    }
    if (error) {
      const stopped: PrivateStatus = { operationId: id, acknowledged: value.acknowledged, running: false, completed: true, error };
      await save(context, stopped);
      return stopped;
    }
  }
  return value;
}
async function save(context: PlatformContext, value: PrivateStatus): Promise<void> {
  await writeFileAtomic(paths(context, value.operationId).status, JSON.stringify(value), 0o600);
}
async function acknowledged(context: PlatformContext, id: string): Promise<boolean> {
  try { return await privateText(paths(context, id).ack) === id; }
  catch (error) { if (missing(error)) return false; throw error; }
}
async function launch(context: PlatformContext, id: string): Promise<void> {
  const settings = await settingsOf(context);
  const environment = serviceEnvironment(context.layout, settings, identityOf(context));
  const args = [process.execPath, join(CODE_ROOT, 'bin', 'circle-hub'), 'reset', '--worker', id];
  const label = `io.github.circle-platforms.circle-hub.reset.${id}`;
  if (context.platform === 'linux') {
    const result = await context.runner('/usr/bin/systemd-run', ['--user', '--quiet', '--collect', `--unit=${label}`,
      '--property=Type=exec', '--property=UMask=0077', '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null',
      '--property=LimitCORE=0', '--property=CoredumpFilter=0',
      ...Object.entries(environment).map(([key, value]) => `--setenv=${key}=${value}`), '--', ...args],
    { env: toolEnvironment({ HOME: context.home, USER: context.user, XDG_RUNTIME_DIR: `/run/user/${context.uid}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${context.uid}/bus` }), timeoutMs: 15_000 });
    if (result.code !== 0) throw new PlatformError('无法启动独立初始化进程', '确认用户服务管理器可用');
  } else if (context.platform === 'darwin') {
    const plist = join(paths(context, id).directory, `${id}.plist`);
    const text = renderPlist({ label, programArguments: args, workingDirectory: CODE_ROOT, environment, standardOutPath: '/dev/null', standardErrorPath: '/dev/null' })
      .replace('<key>KeepAlive</key>\n\t<true/>', '<key>KeepAlive</key>\n\t<false/>');
    await writeFile(plist, text, { flag: 'wx', mode: 0o600 });
    const result = await context.runner('/bin/launchctl', ['bootstrap', `gui/${context.uid}`, plist], { env: toolEnvironment({ HOME: context.home, USER: context.user }), timeoutMs: 15_000 });
    if (result.code !== 0) throw new PlatformError('无法启动独立初始化进程', '确认当前账户的登录会话可用');
  } else throw new PlatformError('当前系统不支持初始化工作进程');
}

export async function launchReset(context: PlatformContext, input: ResetRequest, authorizationContext: string): Promise<{ operationId: string }> {
  auth(authorizationContext);
  const request = parseResetRequest(input);
  const directory = join(context.layout.run, 'reset');
  await privateDirectory(directory);
  return withLock(join(directory, 'launch.lock'), async () => {
    const pending = join(directory, 'pending');
    let previous: string | undefined;
    try { previous = await privateText(pending); } catch (error) { if (!missing(error)) throw error; }
    if (previous !== undefined) {
      const existing = await envelope(context, previous);
      if (existing.authorizationContext === authorizationContext && JSON.stringify(existing.request) === JSON.stringify(request)) return { operationId: previous };
      if (!(await status(context, previous)).completed) throw new PlatformError('已有初始化操作等待确认或正在执行', '等待该操作结束');
    }
    const operationId = randomUUID();
    const file = paths(context, operationId);
    const value: Envelope = { operationId, authorizationContext, request, ackDeadline: context.now().getTime() + ACK_WAIT_MS };
    await writeFile(file.request, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    await save(context, { operationId, acknowledged: false, running: false, completed: false });
    await writeFileAtomic(pending, operationId, 0o600);
    try { await launch(context, operationId); }
    catch {
      await save(context, { operationId, acknowledged: false, running: false, completed: true, error: failed });
      throw new PlatformError('初始化工作进程未能启动', '检查本机服务管理器后重试');
    }
    return { operationId };
  });
}

export async function acknowledgeReset(context: PlatformContext, id: string, authorizationContext: string): Promise<void> {
  auth(authorizationContext);
  const value = await envelope(context, id, authorizationContext);
  if ((await status(context, id)).completed) return;
  if (context.now().getTime() >= value.ackDeadline) throw new PlatformError('初始化确认已过期', '重新预览并确认初始化');
  try { await writeFile(paths(context, id).ack, id, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
}

export async function readResetStatus(context: PlatformContext, id: string, authorizationContext: string): Promise<ResetWorkerStatus> {
  auth(authorizationContext);
  await envelope(context, id, authorizationContext);
  const { workerPid: _workerPid, ...value } = await status(context, id);
  return { ...value, acknowledged: value.acknowledged || await acknowledged(context, id) };
}

export async function runResetWorker(context: PlatformContext, id: string, execute: (request: ResetRequest) => Promise<ResetReport>): Promise<number> {
  const value = await envelope(context, id);
  if ((await status(context, id)).completed) return 1;
  try { await writeFile(paths(context, id).claim, id, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 1; throw error; }
  let ack = false;
  try {
    await save(context, { operationId: id, acknowledged: false, running: false, completed: false, workerPid: process.pid });
    while (!(ack = await acknowledged(context, id))) {
      if (context.now().getTime() >= value.ackDeadline) {
        await save(context, { operationId: id, acknowledged: false, running: false, completed: true, error: { reason: '未收到响应完成确认，未执行初始化', nextAction: '重新预览并确认初始化' } });
        return 1;
      }
      await delay(50);
    }
    await save(context, { operationId: id, acknowledged: true, running: true, completed: false, workerPid: process.pid });
    const report = await execute(value.request);
    await save(context, { operationId: id, acknowledged: true, running: false, completed: true, report });
    return 0;
  } catch {
    await save(context, { operationId: id, acknowledged: ack, running: false, completed: true, error: failed });
    return 1;
  }
}
