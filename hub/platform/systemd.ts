// Linux user service with the same lifecycle contract as the macOS LaunchAgent. The account's user manager must persist
// across logouts (an administrator enables lingering); the Hub and PostgreSQL remain owned by that same account.
import { rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PlatformError } from './errors.ts';
import { exists, writeFileAtomic } from './files.ts';
import type { LaunchAgent, ServiceDefinition, ServiceStatus } from './launchd.ts';
import { runCommand, tailLines, toolEnvironment, type CommandRunner } from './process.ts';

const LABEL = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function defaultSystemdDirectory(home: string = userInfo().homedir): string {
  return join(home, '.config', 'systemd', 'user');
}

// systemd expands percent specifiers in unit settings and dollar variables in ExecStart. Escaping both prevents a path
// or a token from changing meaning; controls are refused rather than interpreted as extra unit directives.
function value(text: string, expandDollar = false): string {
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PlatformError('服务定义含控制字符');
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
  return `"${expandDollar ? escaped.replaceAll('$', () => '$$') : escaped}"`;
}

// Path-valued systemd properties are parsed as a complete literal value, not as a shell or ExecStart word.
// Quoting them would make the leading quote part of the path and systemd would reject it as non-absolute.
function pathValue(text: string): string {
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new PlatformError('服务路径含控制字符');
  return text.replaceAll('%', '%%');
}

export function renderSystemdUnit(definition: ServiceDefinition): string {
  if (!LABEL.test(definition.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  if (definition.programArguments.length === 0 || !isAbsolute(definition.programArguments[0]!)) throw new PlatformError('服务程序必须是绝对路径');
  if (![definition.workingDirectory, definition.standardOutPath, definition.standardErrorPath].every(isAbsolute)) throw new PlatformError('服务目录和日志必须是绝对路径');
  const environment = Object.entries(definition.environment).sort(([a], [b]) => a.localeCompare(b)).map(([key, text]) => {
    if (!ENV_NAME.test(key)) throw new PlatformError('服务环境变量名无效');
    return `Environment=${value(`${key}=${text}`)}`;
  });
  return [
    '[Unit]',
    'Description=Circle Hub',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${pathValue(definition.workingDirectory)}`,
    `ExecStart=${definition.programArguments.map(arg => value(arg, true)).join(' ')}`,
    ...environment,
    'Restart=always',
    'RestartSec=10',
    'TimeoutStopSec=30',
    'UMask=0077',
    `StandardOutput=append:${pathValue(definition.standardOutPath)}`,
    `StandardError=append:${pathValue(definition.standardErrorPath)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export interface SystemdAgentOptions {
  label: string;
  directory: string;
  uid: number;
  runner?: CommandRunner;
  systemctl?: string;
  /** Explicit synthetic effective account for a fake runner, never for the host systemctl. */
  identity?: { uid: number; username: string; homedir: string };
}

/** The `plist` name is kept as the common service-definition path in the existing platform lifecycle contract. */
export function systemdAgent(options: SystemdAgentOptions): LaunchAgent {
  if (!LABEL.test(options.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  if (!Number.isSafeInteger(options.uid) || options.uid < 0) throw new PlatformError('服务用户 UID 无效');
  if (!isAbsolute(options.directory) || /[\u0000-\u001f\u007f]/.test(options.directory)) throw new PlatformError('服务单元目录必须是绝对路径且不含控制字符');
  if (options.identity && (!options.runner || options.runner === runCommand)) throw new PlatformError('合成账户只能用于测试运行器');
  const identity = options.identity ?? userInfo();
  if (identity.uid !== options.uid) throw new PlatformError('服务用户 UID 与当前有效账户不一致，不操作 systemd', '以服务账户运行命令');
  if (!identity.username || !isAbsolute(identity.homedir) || /[\u0000-\u001f\u007f]/.test(identity.username + identity.homedir)) throw new PlatformError('当前服务账户的名称或主目录不合法');
  const runner = options.runner ?? runCommand;
  const command = options.systemctl ?? '/usr/bin/systemctl';
  const service = `${options.label}.service`;
  const plist = join(options.directory, service);
  const runtime = `/run/user/${options.uid}`;
  const env = toolEnvironment({ HOME: identity.homedir, USER: identity.username, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` });
  const invoke = (args: string[], timeoutMs = 120_000) => runner(command, ['--user', ...args], { env, timeoutMs });
  const run = async (args: string[], action: string) => {
    const result = await invoke(args);
    if (result.code !== 0) throw new PlatformError(`${action}失败（systemctl 退出码 ${result.code}）：${tailLines(result.stderr || result.stdout) || '没有输出'}`, '确认用户 systemd 和 D-Bus 已启动，且该用户已启用 linger');
  };
  const inspect = async (): Promise<{status:ServiceStatus;definitionLoaded:boolean;fragmentPath?:string}> => {
    const installed = await exists(plist);
    const result = await invoke(['show', service, '--property=LoadState,ActiveState,MainPID,ExecMainStatus,FragmentPath'], 30_000);
    const fields = new Map(result.stdout.split('\n').flatMap(line => {
      const i = line.indexOf('='); return i < 1 ? [] : [[line.slice(0, i), line.slice(i + 1)] as [string, string]];
    }));
    // A missing unit is an ordinary absent service; a dead user manager or unreadable status is unknown, not stopped.
    if (fields.get('LoadState') === 'not-found' && (!fields.has('ActiveState') || fields.get('ActiveState') === 'inactive') && (!fields.has('MainPID') || fields.get('MainPID') === '0')) return {status:{ plist, installed, loaded: false, running: false },definitionLoaded:false};
    if (result.code !== 0 || fields.get('LoadState') !== 'loaded') throw new PlatformError(`无法读取 systemd 服务状态：${tailLines(result.stderr || result.stdout) || '没有输出'}`, '确认用户 systemd 和 D-Bus 已启动，且该用户已启用 linger');
    const active = fields.get('ActiveState');
    if (!active || !['active', 'inactive', 'activating', 'deactivating', 'reloading', 'failed'].includes(active)) throw new PlatformError('systemd 没有返回可识别的服务状态');
    const pid = fields.get('MainPID');
    const lastExit = fields.get('ExecMainStatus');
    return {definitionLoaded:true,fragmentPath:fields.get('FragmentPath'),status:{
      plist, installed, loaded: active !== 'inactive', running: active === 'active',
      ...(pid && /^[1-9][0-9]*$/.test(pid) ? { pid: Number(pid) } : {}),
      ...(lastExit && /^[0-9]+$/.test(lastExit) ? { lastExit } : {}),
    }};
  };
  const status = async (): Promise<ServiceStatus> => (await inspect()).status;
  const ensureOwned = (current: ServiceStatus, definitionLoaded: boolean, fragmentPath?: string): void => {
    if (!current.installed && definitionLoaded) throw new PlatformError('systemd 已加载该名称，但预期服务文件不存在，不能确认它属于此部署，不停止或禁用', '管理员核对服务单元来源与部署后再处理');
    if (definitionLoaded && fragmentPath !== plist) throw new PlatformError('systemd 已加载的同名服务来源与预期文件不一致，不停止、禁用或覆盖', '管理员核对服务单元来源与部署后再处理');
  };
  return {
    plist, service, status,
    async install(definition) {
      if (definition.label !== options.label) throw new PlatformError('服务标签不一致');
      const text = renderSystemdUnit(definition);
      const {status:current,definitionLoaded,fragmentPath} = await inspect();
      ensureOwned(current,definitionLoaded,fragmentPath);
      if (current.loaded) await run(['stop', service], '停止旧服务');
      await writeFileAtomic(plist, text, 0o644);
      await run(['daemon-reload'], '刷新服务定义');
      await run(['enable', '--now', service], '启用并启动服务');
    },
    async uninstall() {
      const {status:current,definitionLoaded,fragmentPath} = await inspect();
      ensureOwned(current,definitionLoaded,fragmentPath);
      if (!current.installed && !current.loaded) return false;
      if (current.loaded) await run(['stop', service], '停止服务');
      if (current.installed) {
        await run(['disable', service], '禁用服务');
        await rm(plist, { force: true });
        await run(['daemon-reload'], '刷新服务定义');
      }
      return true;
    },
    async start() {
      const {status:current,definitionLoaded,fragmentPath} = await inspect();
      if (!current.installed) throw new PlatformError('服务还没安装', '先运行 circle-hub service install');
      ensureOwned(current,definitionLoaded,fragmentPath);
      if (current.running) return false;
      await run(['start', service], '启动服务');
      return true;
    },
    async stop() {
      const {status:current,definitionLoaded,fragmentPath} = await inspect();
      ensureOwned(current,definitionLoaded,fragmentPath);
      if (!current.loaded) return false;
      await run(['stop', service], '停止服务');
      return true;
    },
  };
}
