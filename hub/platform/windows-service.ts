// Windows service with the same lifecycle contract as the macOS LaunchAgent and the Linux systemd unit (`LaunchAgent` in
// launchd.ts): install, uninstall, start, stop and status, plus the host that runs `circle-hub serve` under the Service
// Control Manager. Everything native goes through the injectable `Scm` and `ServiceDispatcher` (windows-scm.ts implements
// them with koffi over advapi32); this module loads no addon, so its logic is tested on any host with fakes.
//
// Shape, as launchd and systemd have it: the service definition (`plist` in the contract) is a JSON file of the same
// ServiceDefinition, and the SCM's command line is fixed: `"<node>" "<release>\hub\platform\windows-service-host.ts"
// "<definition>"`. The host connects to the SCM, starts `programArguments` as a child with exactly the definition's
// working directory and environment (plus the Windows system locations), its output appended to the two log files, and
// the child in a Job object that kills it when the host ends. Stop: the host asks the child to stop as SIGTERM would (an
// IPC message: Windows has no SIGTERM), waits 30 s (ExitTimeOut 30, TimeoutStopSec=30), then ends the Job. A child that
// exits by itself is a failure (ERROR_SERVICE_SPECIFIC_ERROR with its exit code), so the SCM's failure actions restart the
// service after 10 s, as KeepAlive and Restart=always do. Start type automatic: it starts at boot, before any login.
//
// Identity: never LocalSystem. The default is the service's virtual account `NT SERVICE\<label>`, which needs no
// password; a managed service account (`DOMAIN\name$`) or `NT AUTHORITY\LocalService` may be named. No password is ever
// accepted or stored. The owner accepted the synthetic Windows probe's loosenings for the probe only: production use of
// this account needs its own verification on a non-administrator account (decision of 2026-10-30).
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, win32 } from 'node:path';
import { PlatformError } from './errors.ts';
import { exists, writeFileAtomic } from './files.ts';
import type { LaunchAgent, ServiceDefinition, ServiceStatus } from './launchd.ts';

// winsvc.h and winerror.h values used here.
export const SERVICE_STOPPED = 1;
export const SERVICE_START_PENDING = 2;
export const SERVICE_STOP_PENDING = 3;
export const SERVICE_RUNNING = 4;
export const SERVICE_CONTROL_STOP = 1;
export const SERVICE_CONTROL_INTERROGATE = 4;
export const SERVICE_CONTROL_SHUTDOWN = 5;
export const SERVICE_CONTROL_PRESHUTDOWN = 0x0f;
export const SERVICE_ACCEPT_STOP = 0x1;
export const SERVICE_ACCEPT_PRESHUTDOWN = 0x100;
export const NO_ERROR = 0;
export const ERROR_CALL_NOT_IMPLEMENTED = 120;
export const ERROR_SERVICE_SPECIFIC_ERROR = 1066;

/** Restart delay after a failure (ThrottleInterval 10, RestartSec=10). */
export const RESTART_DELAY_MS = 10_000;
/** How long a stop waits for the server before the Job ends it (ExitTimeOut 30, TimeoutStopSec=30). */
export const STOP_GRACE_MS = 30_000;
/** The message that asks a server child to stop, as SIGTERM does elsewhere (bin/circle-hub, acceptServiceStop). */
export const STOP_MESSAGE = 'circle-hub:service-stop';
/** Format of the service definition file. */
export const DEFINITION_FORMAT = 'circle-hub-service@1';

const LABEL = /^[A-Za-z0-9._-]{1,128}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What the SCM holds for a service, as `Scm.create` and `Scm.update` write it. */
export interface ScmServiceConfig {
  name: string;
  displayName: string;
  description: string;
  /** lpBinaryPathName: the complete, quoted command line (serviceCommandLine). */
  commandLine: string;
  /** lpServiceStartName; never LocalSystem, never with a password (serviceAccount). */
  account: string;
  /** SC_ACTION_RESTART delay of the failure actions, which also apply to a non-crash failure. */
  restartDelayMs: number;
  /** SERVICE_CONFIG_PRESHUTDOWN_INFO: how long the SCM waits for the service at system shutdown. */
  preshutdownTimeoutMs: number;
}

/** A service as the SCM reports it (QueryServiceStatusEx and QueryServiceConfigW). */
export interface ScmServiceState {
  state: number;
  pid?: number;
  win32ExitCode: number;
  serviceExitCode: number;
  commandLine: string;
  account: string;
}

/** Service management through the SCM. Each call opens and closes its own handles. */
export interface Scm {
  /** undefined when there is no such service (ERROR_SERVICE_DOES_NOT_EXIST). */
  query(name: string): Promise<ScmServiceState | undefined>;
  create(config: ScmServiceConfig): Promise<void>;
  update(config: ScmServiceConfig): Promise<void>;
  start(name: string): Promise<void>;
  /** Sends SERVICE_CONTROL_STOP; a service that is no longer active counts as done. The caller waits through query. */
  stop(name: string): Promise<void>;
  /** DeleteService: the SCM removes the service once it has stopped and every handle is closed. */
  remove(name: string): Promise<void>;
}

/** One SetServiceStatus report. */
export interface ServiceStatusReport {
  state: number;
  controlsAccepted: number;
  win32ExitCode: number;
  serviceExitCode: number;
  checkPoint: number;
  waitHintMs: number;
}

/** The service side of the SCM: StartServiceCtrlDispatcherW, RegisterServiceCtrlHandlerExW and SetServiceStatus. */
export interface ServiceDispatcher {
  /**
   * Connects this process to the SCM and resolves once the dispatcher returns (the service reported SERVICE_STOPPED).
   * `main` runs when the SCM calls ServiceMain, after the control handler is registered; `control` receives each control
   * code and returns its Win32 result at once (the SCM waits for it).
   */
  run(name: string, handlers: { main(report: (status: ServiceStatusReport) => void): void; control(code: number): number }): Promise<void>;
}

/** The server child of a host. */
export interface ServerProcess {
  readonly pid: number;
  /** Resolves with the exit code, or null when the process ended without one. */
  readonly exited: Promise<number | null>;
  /** Asks the server to stop as SIGTERM would (STOP_MESSAGE on its IPC channel). */
  requestStop(): void;
  /** Ends the server at once through its Job object. */
  kill(): void;
}

/** Windows argv quoting for CreateProcess (no shell involved); the rule of hub/rules/sandbox/windows.ts, kept per package. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new PlatformError('Windows 参数含空字符');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

/** Splits a command line the way the C runtime does for the quoted form serviceCommandLine writes. */
export function splitWindowsCommandLine(line: string): string[] {
  const args: string[] = [];
  let index = 0;
  while (index < line.length) {
    while (line[index] === ' ' || line[index] === '\t') index++;
    if (index >= line.length) break;
    let arg = '';
    let quoted = false;
    for (; index < line.length; index++) {
      const char = line[index]!;
      if (char === '\\') {
        let slashes = 0;
        while (line[index] === '\\') { slashes++; index++; }
        if (line[index] === '"') {
          arg += '\\'.repeat(Math.floor(slashes / 2));
          if (slashes % 2 === 1) { arg += '"'; continue; }
          index--;
          continue;
        }
        arg += '\\'.repeat(slashes);
        index--;
        continue;
      }
      if (char === '"') { quoted = !quoted; continue; }
      if (!quoted && (char === ' ' || char === '\t')) break;
      arg += char;
    }
    args.push(arg);
  }
  return args;
}

/** The SCM command line: this Node, the release's host script and the definition file, each quoted. */
export function serviceCommandLine(node: string, hostScript: string, definitionPath: string): string {
  for (const path of [node, hostScript, definitionPath]) {
    if (!win32.isAbsolute(path) || CONTROL.test(path) || path.startsWith('\\\\')) throw new PlatformError('服务命令行的路径必须是本机绝对路径，且不含控制字符');
  }
  return [node, hostScript, definitionPath].map(quoteWindowsArgument).join(' ');
}

/** The account the service runs as: its virtual account by default; never LocalSystem; never one that needs a password. */
export function serviceAccount(label: string, account: string = `NT SERVICE\\${label}`): string {
  const virtual = account === `NT SERVICE\\${label}`;
  const localService = /^NT AUTHORITY\\LocalService$/i.test(account);
  // A (group) managed service account, DOMAIN\name$: the domain manages its password, the Hub never sees one.
  const managed = /^[A-Za-z0-9._-]{1,64}\\[A-Za-z0-9._-]{1,60}\$$/.test(account);
  if (virtual || localService || managed) return account;
  throw new PlatformError(`服务账户 ${account} 不受支持：只用服务自己的虚拟账户、托管服务账户（以 $ 结尾）或 NT AUTHORITY\\LocalService，不用 LocalSystem，也不保存任何口令`);
}

/**
 * The service SID of a service name, which is also its virtual account's SID: S-1-5-80 followed by the SHA-1 of the
 * upper-case UTF-16 name as five little-endian sub-authorities (what `sc showsid` prints). Access to the data root and the
 * release is granted to this SID; it exists before the service does, so grants can precede the first start.
 */
export function serviceSid(name: string): string {
  if (!LABEL.test(name)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  const digest = createHash('sha1').update(Buffer.from(name.toUpperCase(), 'utf16le')).digest();
  return `S-1-5-80-${[0, 4, 8, 12, 16].map((offset) => digest.readUInt32LE(offset)).join('-')}`;
}

function assertDefinition(definition: ServiceDefinition): void {
  if (!LABEL.test(definition.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  if (definition.programArguments.length < 1 || !definition.programArguments.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) throw new PlatformError('服务没有要运行的程序');
  for (const path of [definition.programArguments[0]!, definition.workingDirectory, definition.standardOutPath, definition.standardErrorPath]) {
    if (!win32.isAbsolute(path) || CONTROL.test(path)) throw new PlatformError('服务程序、目录和日志必须是绝对路径且不含控制字符');
  }
  for (const [key, value] of Object.entries(definition.environment)) {
    if (!ENV_NAME.test(key) || typeof value !== 'string' || value.includes('\0')) throw new PlatformError('服务环境变量无效');
  }
}

/** The definition file the host reads: the ServiceDefinition itself, under DEFINITION_FORMAT. */
export function renderServiceDefinition(definition: ServiceDefinition): string {
  assertDefinition(definition);
  const environment = Object.fromEntries(Object.entries(definition.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify({ format: DEFINITION_FORMAT, ...definition, environment }, null, 2)}\n`;
}

export function parseServiceDefinition(text: string): ServiceDefinition {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PlatformError('服务定义文件不是有效的 JSON');
  }
  if (value === null || typeof value !== 'object' || value.format !== DEFINITION_FORMAT) throw new PlatformError(`服务定义文件不是 ${DEFINITION_FORMAT}`);
  const environment = value.environment;
  if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) throw new PlatformError('服务环境变量无效');
  const definition: ServiceDefinition = {
    label: String(value.label),
    programArguments: Array.isArray(value.programArguments) ? value.programArguments.map(String) : [],
    workingDirectory: String(value.workingDirectory),
    environment: environment as Record<string, string>,
    standardOutPath: String(value.standardOutPath),
    standardErrorPath: String(value.standardErrorPath),
  };
  assertDefinition(definition);
  return definition;
}

/**
 * The child's environment: exactly the definition's names, with PATH replaced by the Windows system directories, plus the
 * system and profile locations a Windows program needs to start, taken from the host's own (the SCM's) environment.
 */
export function windowsServiceEnvironment(definition: Record<string, string>, host: NodeJS.ProcessEnv): Record<string, string> {
  const pick = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(host)) if (key.toUpperCase() === name && value) return value;
    return undefined;
  };
  const systemRoot = pick('SYSTEMROOT');
  if (systemRoot === undefined || !/^[A-Za-z]:\\[^;\u0000-\u001f]*$/.test(systemRoot)) throw new PlatformError('服务环境缺少有效的 SystemRoot');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(definition)) if (key.toUpperCase() !== 'PATH') env[key] = value;
  env.SystemRoot = systemRoot;
  env.windir = systemRoot;
  env.PATH = `${systemRoot}\\System32;${systemRoot};${systemRoot}\\System32\\Wbem`;
  for (const [name, key] of [['SYSTEMDRIVE', 'SystemDrive'], ['COMSPEC', 'ComSpec'], ['TEMP', 'TEMP'], ['TMP', 'TMP'], ['USERPROFILE', 'USERPROFILE'], ['APPDATA', 'APPDATA'], ['LOCALAPPDATA', 'LOCALAPPDATA'], ['PROGRAMDATA', 'ProgramData']] as const) {
    const value = pick(name);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export interface WindowsServiceAgentOptions {
  label: string;
  /** Directory of the definition file. */
  directory: string;
  /** windows-service-host.ts of the release the service runs. */
  hostScript: string;
  /** Default `NT SERVICE\<label>` (serviceAccount). */
  account?: string;
  scm: Scm;
  /** How long stop and uninstall wait for SERVICE_STOPPED; default 60 s (the 30 s grace plus the Job's end). */
  stopTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The SCM service of a deployment, as a `LaunchAgent`: `plist` is the definition file, `service` the SCM name. */
export function windowsServiceAgent(options: WindowsServiceAgentOptions): LaunchAgent {
  if (!LABEL.test(options.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  if (!isAbsolute(options.directory) || CONTROL.test(options.directory)) throw new PlatformError('服务定义目录必须是绝对路径且不含控制字符');
  const account = serviceAccount(options.label, options.account);
  const scm = options.scm;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  const service = options.label;
  const plist = join(options.directory, `${options.label}.json`);
  const stopTimeout = options.stopTimeoutMs ?? 60_000;

  /** A service of this name is ours only when its command line names this definition file. */
  const ensureOwned = (current: ScmServiceState | undefined): void => {
    if (current === undefined) return;
    const args = splitWindowsCommandLine(current.commandLine);
    if (args.at(-1)?.toLowerCase() !== plist.toLowerCase()) {
      throw new PlatformError('服务控制管理器里的同名服务不属于这个部署（命令行没有指向这个服务定义），不停止、不删除也不覆盖', '管理员核对这个服务的来源后再处理');
    }
  };
  const waitStopped = async (): Promise<void> => {
    const deadline = now() + stopTimeout;
    for (;;) {
      const current = await scm.query(service);
      if (current === undefined || current.state === SERVICE_STOPPED) return;
      if (now() >= deadline) throw new PlatformError(`Windows 服务 ${service} 没有在 ${Math.round(stopTimeout / 1000)} 秒内停下`, '用 sc.exe queryex 查看它的进程，确认后再重试');
      await sleep(250);
    }
  };
  const status = async (): Promise<ServiceStatus> => {
    const installed = await exists(plist);
    const current = await scm.query(service);
    if (current === undefined) return { plist, installed, loaded: false, running: false };
    const stoppedWithError = current.state === SERVICE_STOPPED && current.win32ExitCode !== NO_ERROR;
    return {
      plist,
      installed,
      loaded: current.state !== SERVICE_STOPPED,
      running: current.state === SERVICE_RUNNING,
      // A stopped service has no process, whatever an earlier query said.
      ...(current.state !== SERVICE_STOPPED && current.pid !== undefined && current.pid > 0 ? { pid: current.pid } : {}),
      ...(stoppedWithError ? { lastExit: String(current.win32ExitCode === ERROR_SERVICE_SPECIFIC_ERROR ? current.serviceExitCode : current.win32ExitCode) } : {}),
    };
  };

  return {
    plist,
    service,
    status,

    async install(definition) {
      if (definition.label !== options.label) throw new PlatformError('服务标签不一致');
      const text = renderServiceDefinition(definition);
      const config: ScmServiceConfig = {
        name: service,
        displayName: 'Circle Hub',
        description: 'Circle Hub（circle-hub serve），只监听本机',
        commandLine: serviceCommandLine(definition.programArguments[0]!, options.hostScript, plist),
        account,
        restartDelayMs: 10_000,
        preshutdownTimeoutMs: 60_000,
      };
      const current = await scm.query(service);
      ensureOwned(current);
      if (current !== undefined && current.state !== SERVICE_STOPPED) {
        await scm.stop(service);
        await waitStopped();
      }
      await writeFileAtomic(plist, text, 0o644);
      if (current === undefined) await scm.create(config);
      else await scm.update(config);
      await scm.start(service);
    },

    async uninstall() {
      const installed = await exists(plist);
      const current = await scm.query(service);
      ensureOwned(current);
      if (current === undefined && !installed) return false;
      if (current !== undefined && current.state !== SERVICE_STOPPED) {
        await scm.stop(service);
        await waitStopped();
      }
      if (current !== undefined) await scm.remove(service);
      await rm(plist, { force: true });
      return true;
    },

    async start() {
      if (!(await exists(plist))) throw new PlatformError('服务还没安装', '先运行 circle-hub service install');
      const current = await scm.query(service);
      if (current === undefined) throw new PlatformError('服务定义在，但服务控制管理器里没有这个服务', '运行 circle-hub service install');
      ensureOwned(current);
      if (current.state !== SERVICE_STOPPED) return false;
      await scm.start(service);
      return true;
    },

    async stop() {
      const current = await scm.query(service);
      ensureOwned(current);
      if (current === undefined || current.state === SERVICE_STOPPED) return false;
      await scm.stop(service);
      await waitStopped();
      return true;
    },
  };
}

export interface ServiceHostOptions {
  definition: ServiceDefinition;
  /** Starts the server child; a throw is reported as a failed start. */
  spawn(definition: ServiceDefinition): ServerProcess;
  stopGraceMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** The host's own diagnostics (the error log); operation names and exit codes only. */
  log?: (line: string) => void;
}

/**
 * The service main loop. ServiceMain reports START_PENDING, starts the server and reports RUNNING (accepting STOP and
 * PRESHUTDOWN). STOP or PRESHUTDOWN: STOP_PENDING, the server is asked to stop, and its Job ends it after the grace time.
 * The server's exit ends the service: NO_ERROR when it was asked to stop, otherwise ERROR_SERVICE_SPECIFIC_ERROR with its
 * exit code, which the SCM's failure actions answer with a restart. Resolves with the code the host process exits with.
 */
export async function runServiceHost(dispatcher: ServiceDispatcher, options: ServiceHostOptions): Promise<number> {
  const grace = options.stopGraceMs ?? STOP_GRACE_MS;
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const log = options.log ?? (() => {});
  let report: ((status: ServiceStatusReport) => void) | undefined;
  let child: ServerProcess | undefined;
  let stopping = false;
  let stopped = false;
  let killTimer: unknown;
  let hostCode = 0;
  const status = (state: number, fields: Partial<ServiceStatusReport> = {}): void => {
    if (stopped) return;
    if (state === SERVICE_STOPPED) stopped = true;
    report?.({ state, controlsAccepted: 0, win32ExitCode: NO_ERROR, serviceExitCode: 0, checkPoint: 0, waitHintMs: 0, ...fields });
  };
  const beginStop = (): void => {
    if (stopping) return;
    stopping = true;
    if (child === undefined) {
      // Before ServiceMain started the server (or after it failed to): there is nothing to wait for.
      if (report !== undefined) status(SERVICE_STOPPED);
      return;
    }
    status(SERVICE_STOP_PENDING, { checkPoint: 1, waitHintMs: grace + 5_000 });
    try {
      child.requestStop();
    } catch {
      log('windows-service: stop-request-failed');
    }
    const running = child;
    killTimer = setTimer(() => {
      log('windows-service: stop-grace-elapsed');
      running.kill();
    }, grace);
  };
  await dispatcher.run(options.definition.label, {
    main(reporter) {
      report = reporter;
      if (stopping) {
        status(SERVICE_STOPPED);
        return;
      }
      status(SERVICE_START_PENDING, { checkPoint: 1, waitHintMs: 30_000 });
      try {
        child = options.spawn(options.definition);
      } catch {
        log('windows-service: server-start-failed');
        hostCode = 1;
        status(SERVICE_STOPPED, { win32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR, serviceExitCode: 1 });
        return;
      }
      const running = child;
      status(SERVICE_RUNNING, { controlsAccepted: SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_PRESHUTDOWN });
      void running.exited.then((code) => {
        if (killTimer !== undefined) clearTimer(killTimer);
        log(`windows-service: server-exited ${code ?? 'none'}`);
        if (stopping) {
          status(SERVICE_STOPPED);
        } else {
          hostCode = 1;
          // Windows exit codes are DWORDs (a crash is 0xC0000005 and up): report them unsigned.
          status(SERVICE_STOPPED, { win32ExitCode: ERROR_SERVICE_SPECIFIC_ERROR, serviceExitCode: code === null || code === 0 ? 1 : code >>> 0 });
        }
      });
    },
    control(code) {
      if (code === SERVICE_CONTROL_INTERROGATE) return NO_ERROR;
      if (code === SERVICE_CONTROL_STOP || code === SERVICE_CONTROL_PRESHUTDOWN || code === SERVICE_CONTROL_SHUTDOWN) {
        // The SCM waits for this handler: only start the stop here; the server's exit reports SERVICE_STOPPED.
        beginStop();
        return NO_ERROR;
      }
      return ERROR_CALL_NOT_IMPLEMENTED;
    },
  });
  return hostCode;
}

/**
 * The Task Scheduler fallback's loop (windows-task.ts): no SCM, so the host supervises the server itself and starts it again
 * RESTART_DELAY_MS after any exit, until the task ends the host (and with it the Job that holds the server).
 */
export async function runTaskHost(options: { definition: ServiceDefinition; spawn(definition: ServiceDefinition): ServerProcess; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void; rounds?: number }): Promise<void> {
  const sleep = options.sleep ?? pause;
  const log = options.log ?? (() => {});
  for (let round = 0; options.rounds === undefined || round < options.rounds; round++) {
    let code: number | null = null;
    try {
      code = await options.spawn(options.definition).exited;
    } catch {
      log('windows-task: server-start-failed');
    }
    log(`windows-task: server-exited ${code ?? 'none'}`);
    await sleep(RESTART_DELAY_MS);
  }
}

/**
 * Child side of STOP_MESSAGE, for bin/circle-hub on Windows when a host started it with an IPC channel: the message reaches
 * the same SIGTERM listeners `serve` waits on. The channel does not keep the server alive, and a host that disappears
 * (its channel closes) counts as a stop, since the Job ends the server with it anyway.
 */
export function acceptServiceStop(target: Pick<NodeJS.Process, 'on' | 'emit' | 'channel'>): void {
  target.channel?.unref();
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    (target.emit as (event: string) => boolean).call(target, 'SIGTERM');
  };
  target.on('message', (message: unknown) => {
    if (message === STOP_MESSAGE) stop();
  });
  target.on('disconnect', stop);
}

/** Reads and checks a definition file for the host. */
export async function readServiceDefinition(path: string): Promise<ServiceDefinition> {
  return parseServiceDefinition(await readFile(path, 'utf8'));
}
