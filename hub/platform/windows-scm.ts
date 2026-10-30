// The native side of windows-service.ts: the Service Control Manager through koffi 3.3.3 (the version the Circle client pins,
// the one dependency exception the owner granted, loaded only here and only on Windows) over advapi32 and kernel32, from
// the protected system directory. No other DLL, no PowerShell, no sc.exe, no shell.
//
// Functions (advapi32 unless noted):
//   management  OpenSCManagerW, OpenServiceW, CreateServiceW, ChangeServiceConfigW, ChangeServiceConfig2W (levels 1
//               description, 2 failure actions, 4 failure-actions flag, 5 service SID type, 7 preshutdown timeout),
//               StartServiceW, ControlService, QueryServiceStatusEx (SC_STATUS_PROCESS_INFO), QueryServiceConfigW,
//               DeleteService, CloseServiceHandle
//   service     StartServiceCtrlDispatcherW (called through koffi's async member: it blocks a koffi worker thread for the
//               service's life, so the JS event loop keeps running), RegisterServiceCtrlHandlerExW, SetServiceStatus
//   kernel32    GetSystemDirectoryW, GetLastError, GetProcessHeap, HeapAlloc, HeapFree, RtlMoveMemory, CreateJobObjectW,
//               SetInformationJobObject, OpenProcess, AssignProcessToJobObject, TerminateJobObject, CloseHandle
// Callbacks are koffi registered callbacks: ServiceMain runs on a thread the SCM creates and HandlerEx on the dispatcher's
// (koffi worker) thread. koffi queues both to the JS main thread and blocks the calling thread until JS returns (koffi
// documentation, "Asynchronous callbacks"), so the main thread must never block while the service runs. That behaviour
// was observed with koffi 3.3.3 on macOS ARM64 only (a pthread calling a registered callback while an async call waited);
// on Windows it is a runner check, not a claim.
//
// Layouts, identical on Windows x64 and ARM64 (LLP64: DWORD 4 bytes, pointers 8):
//   SERVICE_STATUS 28: Type 0, CurrentState 4, ControlsAccepted 8, Win32ExitCode 12, ServiceSpecificExitCode 16,
//                      CheckPoint 20, WaitHint 24
//   SERVICE_STATUS_PROCESS 36: SERVICE_STATUS, then ProcessId 28, ServiceFlags 32
//   SERVICE_TABLE_ENTRYW 16: ServiceName 0, ServiceProc 8; the table ends with an all-zero entry
//   QUERY_SERVICE_CONFIGW 64: ServiceType 0, StartType 4, ErrorControl 8, BinaryPathName 16, LoadOrderGroup 24, TagId 32,
//                      Dependencies 40, ServiceStartName 48, DisplayName 56; the strings follow in the same block
//   SERVICE_DESCRIPTIONW 8: Description 0
//   SERVICE_FAILURE_ACTIONSW 40: ResetPeriod 0, RebootMsg 8, Command 16, Actions count 24, Actions 32
//   SC_ACTION 8: Type 0, Delay 4
//   SERVICE_FAILURE_ACTIONS_FLAG, SERVICE_SID_INFO, SERVICE_PRESHUTDOWN_INFO 4: one DWORD
//   JOBOBJECT_EXTENDED_LIMIT_INFORMATION 144: LimitFlags 16 (as hub/rules/sandbox/windows.ts writes it)
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { createRequire } from 'node:module';
import { PlatformError } from './errors.ts';
import type { ServiceDefinition } from './launchd.ts';
import {
  ERROR_CALL_NOT_IMPLEMENTED, STOP_MESSAGE, windowsServiceEnvironment,
  type Scm, type ScmServiceConfig, type ScmServiceState, type ServerProcess, type ServiceDispatcher, type ServiceStatusReport,
} from './windows-service.ts';

export const SERVICE_WIN32_OWN_PROCESS = 0x10;
export const SERVICE_AUTO_START = 2;
export const SERVICE_ERROR_NORMAL = 1;
export const SC_ACTION_RESTART = 1;
export const SERVICE_SID_TYPE_UNRESTRICTED = 1;
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** PostgreSQL that the server starts through pg_ctl must outlive server restarts, as it does in its own session elsewhere. */
export const JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
const SC_MANAGER_CONNECT = 0x0001;
const SC_MANAGER_CREATE_SERVICE = 0x0002;
const SERVICE_QUERY_CONFIG = 0x0001;
const SERVICE_CHANGE_CONFIG = 0x0002;
const SERVICE_QUERY_STATUS = 0x0004;
const SERVICE_START = 0x0010;
const SERVICE_STOP = 0x0020;
const DELETE = 0x10000;
const SERVICE_NO_CHANGE = 0xffffffff;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_SERVICE_ALREADY_RUNNING = 1056;
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
const ERROR_SERVICE_NOT_ACTIVE = 1062;
const ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063;
const ERROR_SERVICE_MARKED_FOR_DELETE = 1072;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

/** SERVICE_STATUS for SetServiceStatus. */
export function encodeServiceStatus(status: ServiceStatusReport): Buffer {
  const data = Buffer.alloc(28);
  const fields = [SERVICE_WIN32_OWN_PROCESS, status.state, status.controlsAccepted, status.win32ExitCode, status.serviceExitCode, status.checkPoint, status.waitHintMs];
  fields.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('SERVICE_STATUS 字段无效');
    data.writeUInt32LE(value, index * 4);
  });
  return data;
}

/** SERVICE_STATUS_PROCESS from QueryServiceStatusEx. */
export function decodeServiceStatusProcess(data: Buffer): { state: number; win32ExitCode: number; serviceExitCode: number; pid: number } {
  if (data.length < 36) throw new RangeError('SERVICE_STATUS_PROCESS 太短');
  return { state: data.readUInt32LE(4), win32ExitCode: data.readUInt32LE(12), serviceExitCode: data.readUInt32LE(16), pid: data.readUInt32LE(28) };
}

/** A NUL-terminated UTF-16 string at an absolute address inside a copied native block; refused outside the block. */
export function stringAt(block: Buffer, base: bigint, pointer: bigint): string | undefined {
  if (pointer === 0n) return undefined;
  const offset = pointer - base;
  if (offset < 0n || offset >= BigInt(block.length) || offset % 2n !== 0n) throw new RangeError('服务配置字符串越界');
  const start = Number(offset);
  for (let end = start; end + 1 < block.length; end += 2) {
    if (block.readUInt16LE(end) === 0) return block.toString('utf16le', start, end);
  }
  throw new RangeError('服务配置字符串没有结尾');
}

/** The command line and account from a QUERY_SERVICE_CONFIGW block copied from native memory at `base`. */
export function decodeServiceConfig(block: Buffer, base: bigint): { commandLine: string; account: string } {
  if (block.length < 64) throw new RangeError('QUERY_SERVICE_CONFIGW 太短');
  return {
    commandLine: stringAt(block, base, block.readBigUInt64LE(16)) ?? '',
    account: stringAt(block, base, block.readBigUInt64LE(48)) ?? '',
  };
}

/** SERVICE_FAILURE_ACTIONSW pointing at `actions` (three SC_ACTION_RESTART entries, see failureActionArray). */
export function encodeFailureActions(actions: bigint, count: number, resetSeconds: number): Buffer {
  const data = Buffer.alloc(40);
  data.writeUInt32LE(resetSeconds, 0);
  data.writeUInt32LE(count, 24);
  data.writeBigUInt64LE(actions, 32);
  return data;
}

/** SC_ACTION[3]: restart after the delay for the first, second and every later failure. */
export function failureActionArray(delayMs: number): Buffer {
  if (!Number.isInteger(delayMs) || delayMs < 1000 || delayMs > 3_600_000) throw new RangeError('重启延迟无效');
  const data = Buffer.alloc(24);
  for (let index = 0; index < 3; index++) {
    data.writeInt32LE(SC_ACTION_RESTART, index * 8);
    data.writeUInt32LE(delayMs, index * 8 + 4);
  }
  return data;
}

/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION of the server's Job: killed with the host; what it starts is not in the Job. */
export function serverJobLimits(): Buffer {
  const data = Buffer.alloc(144);
  data.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, 16);
  return data;
}

/** The koffi surface used here, injectable for tests (as hub/rules/sandbox/windows.ts does). */
export interface KoffiLike {
  version: string;
  load(name: string): { func(declaration: string): KoffiFunction };
  proto(declaration: string): unknown;
  pointer(type: unknown): unknown;
  register(callback: (...args: never[]) => unknown, type: unknown): bigint;
  unregister(callback: bigint): void;
}
export type KoffiFunction = ((...args: unknown[]) => unknown) & { async?: (...args: unknown[]) => void };

const w = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le');
const valid = (handle: unknown): handle is bigint => typeof handle === 'bigint' && handle !== 0n && BigInt.asIntN(64, handle) !== -1n;

interface Native {
  koffi: KoffiLike;
  kernel: { func(declaration: string): KoffiFunction };
  advapi: { func(declaration: string): KoffiFunction };
  lastError: () => number;
  /** Copies bytes into a native heap block the caller frees with `release`. */
  allocate(bytes: Buffer): bigint;
  release(pointer: bigint): void;
  copyOut(pointer: bigint, length: number): Buffer;
}

function loadNative(koffi: KoffiLike): Native {
  if (koffi.version !== '3.3.3') throw new PlatformError('Windows 服务适配需要 koffi 3.3.3');
  // kernel32 is a KnownDLL; advapi32 comes from the kernel-reported system directory, never a search path.
  const kernel = koffi.load('kernel32.dll');
  const systemDirectory = kernel.func('uint32_t __stdcall GetSystemDirectoryW(_Out_ void *buffer, uint32_t size)');
  const directory = Buffer.alloc(65536);
  const length = Number(systemDirectory(directory, directory.length / 2));
  if (!length || length >= directory.length / 2) throw new PlatformError('无法确定 Windows 系统目录');
  const advapi = koffi.load(`${directory.toString('utf16le', 0, length * 2)}\\advapi32.dll`);
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const heap = kernel.func('void * __stdcall GetProcessHeap()')();
  const heapAlloc = kernel.func('void * __stdcall HeapAlloc(void *heap, uint32_t flags, uintptr_t size)');
  const heapFree = kernel.func('int __stdcall HeapFree(void *heap, uint32_t flags, void *memory)');
  const move = kernel.func('void __stdcall RtlMoveMemory(void *target, void *source, uintptr_t size)');
  return {
    koffi, kernel, advapi,
    lastError: () => Number(lastError()),
    allocate(bytes) {
      const pointer: unknown = heapAlloc(heap, 8, bytes.length);
      if (!valid(pointer)) throw new PlatformError('Windows 内存分配失败');
      move(pointer, bytes, bytes.length);
      return pointer;
    },
    release(pointer) { heapFree(heap, 0, pointer); },
    copyOut(pointer, size) {
      const data = Buffer.alloc(size);
      move(data, pointer, size);
      return data;
    },
  };
}

function scmFailure(step: string, code: number): PlatformError {
  return new PlatformError(`Windows 服务控制失败：${step}（错误 ${code}）`, code === ERROR_ACCESS_DENIED ? '以管理员身份运行 circle-hub service 命令' : undefined);
}

/** The SCM management calls of `Scm`. */
export function createWindowsScm(koffi: KoffiLike): Scm {
  const native = loadNative(koffi);
  const fn = (declaration: string) => native.advapi.func(declaration);
  const openManager = fn('void * __stdcall OpenSCManagerW(void *machine, void *database, uint32_t access)');
  const openService = fn('void * __stdcall OpenServiceW(void *manager, void *name, uint32_t access)');
  const createService = fn('void * __stdcall CreateServiceW(void *manager, void *name, void *display, uint32_t access, uint32_t type, uint32_t start, uint32_t error, void *binary, void *group, void *tag, void *dependencies, void *account, void *password)');
  const changeConfig = fn('int __stdcall ChangeServiceConfigW(void *service, uint32_t type, uint32_t start, uint32_t error, void *binary, void *group, void *tag, void *dependencies, void *account, void *password, void *display)');
  const changeConfig2 = fn('int __stdcall ChangeServiceConfig2W(void *service, uint32_t level, void *info)');
  const startService = fn('int __stdcall StartServiceW(void *service, uint32_t count, void *args)');
  const controlService = fn('int __stdcall ControlService(void *service, uint32_t control, _Out_ void *status)');
  const queryStatus = fn('int __stdcall QueryServiceStatusEx(void *service, int level, _Out_ void *buffer, uint32_t size, _Out_ void *needed)');
  const queryConfig = fn('int __stdcall QueryServiceConfigW(void *service, void *buffer, uint32_t size, _Out_ void *needed)');
  const deleteService = fn('int __stdcall DeleteService(void *service)');
  const closeHandle = fn('int __stdcall CloseServiceHandle(void *handle)');

  const withManager = <T>(access: number, operation: (manager: bigint) => T): T => {
    const manager: unknown = openManager(null, null, access);
    if (!valid(manager)) throw scmFailure('OpenSCManagerW', native.lastError());
    try { return operation(manager); } finally { closeHandle(manager); }
  };
  const withService = <T>(name: string, access: number, operation: (service: bigint) => T): T | undefined =>
    withManager(SC_MANAGER_CONNECT, (manager) => {
      const service: unknown = openService(manager, w(name), access);
      if (!valid(service)) {
        const code = native.lastError();
        if (code === ERROR_SERVICE_DOES_NOT_EXIST) return undefined;
        throw scmFailure('OpenServiceW', code);
      }
      try { return operation(service); } finally { closeHandle(service); }
    });
  const required = <T>(name: string, result: T | undefined): T => {
    if (result === undefined) throw new PlatformError(`服务控制管理器里没有服务 ${name}`, '先运行 circle-hub service install');
    return result;
  };
  // Virtual and managed service accounts take no password (NULL); LocalService takes an empty one.
  const password = (account: string) => (/^NT AUTHORITY\\LocalService$/i.test(account) ? w('') : null);
  const configure = (service: bigint, config: ScmServiceConfig): void => {
    const owned: bigint[] = [];
    const keep = (bytes: Buffer) => { const pointer = native.allocate(bytes); owned.push(pointer); return pointer; };
    try {
      const pointerInfo = (pointer: bigint) => { const data = Buffer.alloc(8); data.writeBigUInt64LE(pointer); return data; };
      const dword = (value: number) => { const data = Buffer.alloc(4); data.writeUInt32LE(value); return data; };
      const levels: [number, string, Buffer][] = [
        [1, 'SERVICE_CONFIG_DESCRIPTION', pointerInfo(keep(w(config.description)))],
        [2, 'SERVICE_CONFIG_FAILURE_ACTIONS', encodeFailureActions(keep(failureActionArray(config.restartDelayMs)), 3, 86_400)],
        [4, 'SERVICE_CONFIG_FAILURE_ACTIONS_FLAG', dword(1)],
        [5, 'SERVICE_CONFIG_SERVICE_SID_INFO', dword(SERVICE_SID_TYPE_UNRESTRICTED)],
        [7, 'SERVICE_CONFIG_PRESHUTDOWN_INFO', dword(config.preshutdownTimeoutMs)],
      ];
      for (const [level, step, info] of levels) if (!changeConfig2(service, level, info)) throw scmFailure(`ChangeServiceConfig2W ${step}`, native.lastError());
    } finally {
      for (const pointer of owned) native.release(pointer);
    }
  };

  return {
    async query(name) {
      return withService(name, SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG, (service): ScmServiceState => {
        const status = Buffer.alloc(36);
        const needed = Buffer.alloc(4);
        if (!queryStatus(service, 0, status, status.length, needed)) throw scmFailure('QueryServiceStatusEx', native.lastError());
        let size = 8192;
        for (;;) {
          const block = native.allocate(Buffer.alloc(size));
          try {
            if (queryConfig(service, block, size, needed)) {
              const decoded = decodeServiceConfig(native.copyOut(block, size), block);
              const { state, win32ExitCode, serviceExitCode, pid } = decodeServiceStatusProcess(status);
              return { state, win32ExitCode, serviceExitCode, ...(pid > 0 ? { pid } : {}), ...decoded };
            }
            const code = native.lastError();
            const wanted = needed.readUInt32LE();
            if (code !== ERROR_INSUFFICIENT_BUFFER || wanted <= size || wanted > 65536) throw scmFailure('QueryServiceConfigW', code);
            size = wanted;
          } finally {
            native.release(block);
          }
        }
      });
    },
    async create(config) {
      withManager(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE, (manager) => {
        const service: unknown = createService(manager, w(config.name), w(config.displayName), SERVICE_CHANGE_CONFIG | SERVICE_START | SERVICE_QUERY_STATUS,
          SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, w(config.commandLine), null, null, null, w(config.account), password(config.account));
        if (!valid(service)) throw scmFailure('CreateServiceW', native.lastError());
        try { configure(service, config); } finally { closeHandle(service); }
      });
    },
    async update(config) {
      required(config.name, withService(config.name, SERVICE_CHANGE_CONFIG | SERVICE_START, (service) => {
        if (!changeConfig(service, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START, SERVICE_ERROR_NORMAL, w(config.commandLine), null, null, null, w(config.account), password(config.account), w(config.displayName))) {
          throw scmFailure('ChangeServiceConfigW', native.lastError());
        }
        configure(service, config);
        return true;
      }));
    },
    async start(name) {
      required(name, withService(name, SERVICE_START, (service) => {
        if (!startService(service, 0, null)) {
          const code = native.lastError();
          if (code !== ERROR_SERVICE_ALREADY_RUNNING) throw scmFailure('StartServiceW', code);
        }
        return true;
      }));
    },
    async stop(name) {
      withService(name, SERVICE_STOP, (service) => {
        if (!controlService(service, 1, Buffer.alloc(28))) {
          const code = native.lastError();
          if (code !== ERROR_SERVICE_NOT_ACTIVE) throw scmFailure('ControlService STOP', code);
        }
      });
    },
    async remove(name) {
      withService(name, DELETE, (service) => {
        if (!deleteService(service)) {
          const code = native.lastError();
          if (code !== ERROR_SERVICE_MARKED_FOR_DELETE) throw scmFailure('DeleteService', code);
        }
      });
    },
  };
}

const callbackTypes = new WeakMap<object, { main: unknown; handler: unknown }>();

/** The service side: one SERVICE_WIN32_OWN_PROCESS service per host process. */
export function createWindowsDispatcher(koffi: KoffiLike): ServiceDispatcher {
  const native = loadNative(koffi);
  // koffi type names are process-global: declare the two callback types once per koffi instance.
  let types = callbackTypes.get(koffi);
  if (types === undefined) {
    types = {
      main: koffi.proto('void __stdcall CircleHubServiceMain(uint32_t argc, void *argv)'),
      handler: koffi.proto('uint32_t __stdcall CircleHubHandlerEx(uint32_t control, uint32_t eventType, void *eventData, void *context)'),
    };
    callbackTypes.set(koffi, types);
  }
  const { main: ServiceMain, handler: HandlerEx } = types;
  const startDispatcher = native.advapi.func('int __stdcall StartServiceCtrlDispatcherW(void *table)');
  const registerHandler = native.advapi.func('void * __stdcall RegisterServiceCtrlHandlerExW(void *name, void *handler, void *context)');
  const setStatus = native.advapi.func('int __stdcall SetServiceStatus(void *handle, void *status)');
  return {
    run(name, handlers) {
      return new Promise<void>((resolve, reject) => {
        if (typeof startDispatcher.async !== 'function') {
          reject(new PlatformError('koffi 没有提供异步调用，服务分派会阻塞 JS 主线程'));
          return;
        }
        const handler = koffi.register(((control: number) => {
          try { return handlers.control(control) >>> 0; } catch { return ERROR_CALL_NOT_IMPLEMENTED; }
        }) as never, koffi.pointer(HandlerEx));
        let serviceName: bigint | undefined;
        let table: bigint | undefined;
        let main: bigint | undefined;
        const cleanup = () => {
          if (main !== undefined) koffi.unregister(main);
          koffi.unregister(handler);
          if (table !== undefined) native.release(table);
          if (serviceName !== undefined) native.release(serviceName);
        };
        try {
          serviceName = native.allocate(w(name));
          main = koffi.register((() => {
            // Runs on the JS main thread while the SCM's ServiceMain thread waits; it returns as soon as the server started.
            const handle: unknown = registerHandler(serviceName, handler, null);
            if (!valid(handle)) return;
            handlers.main((status) => { setStatus(handle, encodeServiceStatus(status)); });
          }) as never, koffi.pointer(ServiceMain));
          const entries = Buffer.alloc(32);
          entries.writeBigUInt64LE(serviceName, 0);
          entries.writeBigUInt64LE(main, 8);
          table = native.allocate(entries);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        startDispatcher.async(table, (error: unknown, ok: unknown) => {
          const code = native.lastError();
          cleanup();
          if (error) reject(error);
          else if (!ok) reject(code === ERROR_FAILED_SERVICE_CONTROLLER_CONNECT
            ? new PlatformError('windows-service-host.ts 只能由服务控制管理器启动', '用 circle-hub service start 启动服务')
            : scmFailure('StartServiceCtrlDispatcherW', code));
          else resolve();
        });
      });
    },
  };
}

/** Starts `programArguments` as the host's server child, inside a Job that ends it when the host ends. */
export function createServerSpawner(koffi: KoffiLike, hostEnvironment: NodeJS.ProcessEnv = process.env): (definition: ServiceDefinition) => ServerProcess {
  const native = loadNative(koffi);
  const createJob = native.kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
  const setJob = native.kernel.func('int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t size)');
  const openProcess = native.kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const assign = native.kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
  const terminate = native.kernel.func('int __stdcall TerminateJobObject(void *job, uint32_t code)');
  const close = native.kernel.func('int __stdcall CloseHandle(void *handle)');
  const job: unknown = createJob(null, null);
  if (!valid(job)) throw new PlatformError(`Windows Job 创建失败（错误 ${native.lastError()}）`);
  const limits = serverJobLimits();
  if (!setJob(job, 9, limits, limits.length)) {
    const code = native.lastError();
    close(job);
    throw new PlatformError(`Windows Job 设置失败（错误 ${code}）`);
  }
  // The Job handle stays open for the host's life: closing it (the host ends) kills the server with KILL_ON_JOB_CLOSE.
  return (definition) => {
    const out = openSync(definition.standardOutPath, 'a');
    const err = openSync(definition.standardErrorPath, 'a');
    let child: ChildProcess;
    try {
      child = spawn(definition.programArguments[0]!, definition.programArguments.slice(1), {
        cwd: definition.workingDirectory,
        env: windowsServiceEnvironment(definition.environment, hostEnvironment),
        stdio: ['ignore', out, err, 'ipc'],
        windowsHide: true,
        shell: false,
      });
    } finally {
      closeSync(out);
      closeSync(err);
    }
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    const pid = child.pid;
    const handle: unknown = pid === undefined ? 0n : openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    const assigned = valid(handle) && Boolean(assign(job, handle));
    if (valid(handle)) close(handle);
    if (!assigned) {
      // Fail closed: a server outside the Job could outlive the host and hold the port across restarts.
      child.kill();
      throw new PlatformError('无法把 Hub 服务进程放进 Windows Job');
    }
    return {
      pid: pid!,
      exited,
      requestStop() { if (child.connected) child.send(STOP_MESSAGE); },
      kill() { terminate(job, 1); },
    };
  };
}

const require = createRequire(import.meta.url);

/** The koffi module, only on Windows x64 or ARM64 and only at the reviewed version. */
export function loadKoffi(): KoffiLike {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new PlatformError('Windows 服务适配只可在 Windows x64 或 ARM64 上使用');
  const koffi = require('koffi') as KoffiLike;
  if (koffi.version !== '3.3.3') throw new PlatformError('Windows 服务适配需要 koffi 3.3.3');
  return koffi;
}
