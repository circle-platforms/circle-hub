// Design adapted from Circle src/windows_stranded.ts at 25863be04d2b169b5d776d7ec21a76ccbd330738,
// Apache-2.0, Copyright (c) 2026 qingshanfeihu and the Circle contributors.
// See https://github.com/circle-platforms/circle. No archived module is imported.
// A Job contains descendants; it does not deny network access or filesystem writes.
import { setTimeout as delay } from 'node:timers/promises';

export interface WindowsJobLimits {
  /** Aggregate user-mode CPU seconds, not total kernel + user CPU time. */
  userCpuSeconds: number;
  /** Aggregate committed virtual memory, not RSS. */
  committedBytes: number;
}

/** Encode the supported x64/ARM64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION ABI. */
export function windowsJobLimits(limits?: WindowsJobLimits): Buffer {
  const data = Buffer.alloc(144);
  let flags = 0x2000; // KILL_ON_JOB_CLOSE, without either breakaway flag.
  if (limits !== undefined) {
    if (!Number.isSafeInteger(limits.userCpuSeconds) || limits.userCpuSeconds < 1 || limits.userCpuSeconds > 3600 ||
        !Number.isSafeInteger(limits.committedBytes) || limits.committedBytes < 1 || limits.committedBytes > Number.MAX_SAFE_INTEGER)
      throw new RangeError('Windows Job 资源上限无效');
    flags |= 0x4 | 0x200; // JOB_TIME and JOB_MEMORY.
    data.writeBigInt64LE(BigInt(limits.userCpuSeconds) * 10_000_000n, 8);
    data.writeBigUInt64LE(BigInt(limits.committedBytes), 120);
  }
  data.writeUInt32LE(flags, 16);
  return data;
}

export interface WindowsJobApi {
  create(limits?: WindowsJobLimits): bigint;
  assign(job: bigint, pid: number): boolean;
  active(job: bigint): number;
  terminate(job: bigint): void;
  close(job: bigint): void;
}

/** Owns a trusted, idle bootstrap only. Assignment after spawn cannot confine earlier descendants. */
export function attachWindowsJob(api: WindowsJobApi, pid: number, limits?: WindowsJobLimits): { stop(): Promise<void> } {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Windows 进程标识无效');
  const job = api.create(limits);
  try {
    if (!api.assign(job, pid)) throw new Error('Windows Job 分配失败');
  } catch (error) {
    api.close(job);
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    stop() {
      // Preserve the original cleanup promise, as Circle preserves its taskkill promise.
      stopping ??= (async () => {
        try {
          api.terminate(job);
          const deadline = Date.now() + 10_000;
          while (api.active(job) !== 0) {
            if (Date.now() >= deadline) throw new Error('Windows Job 进程仍未退出');
            await delay(10);
          }
        } finally { api.close(job); }
      })();
      return stopping;
    },
  };
}

let loading: Promise<WindowsJobApi> | undefined;
/** Only the Windows adapter loads koffi; importing this module elsewhere loads no addon. */
export function loadWindowsJobApi(): Promise<WindowsJobApi> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
    return Promise.reject(new Error('Windows Job 仅支持原生 x64 或 ARM64'));
  loading ??= loadNative().catch(error => { loading = undefined; throw error; });
  return loading;
}

async function loadNative(): Promise<WindowsJobApi> {
  const { default: koffi } = await import('koffi');
  return createWindowsJobApi(koffi);
}

/** Injectable native boundary for synthetic loader/version checks without loading an addon. */
export function createWindowsJobApi(koffi: {
  version: string;
  load(name: string): { func(declaration: string): (...args: unknown[]) => unknown };
}): WindowsJobApi {
  if (koffi.version !== '3.3.3') throw new Error('Windows Job 的 koffi 版本不匹配');
  // Windows resolves this KnownDLL; no caller-controlled environment path is consulted.
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
  const set = kernel.func('int __stdcall SetInformationJobObject(void *job, int kind, void *data, uint32_t size)');
  const open = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const assign = kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
  const query = kernel.func('int __stdcall QueryInformationJobObject(void *job, int kind, void *data, uint32_t size, void *returned)');
  const terminate = kernel.func('int __stdcall TerminateJobObject(void *job, uint32_t code)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const valid = (handle: unknown): handle is bigint => typeof handle === 'bigint' && handle !== 0n && BigInt.asIntN(64, handle) !== -1n;
  return {
    create(resourceLimits) {
      const limits = windowsJobLimits(resourceLimits);
      const job: unknown = create(null, null);
      if (!valid(job)) throw new Error('Windows Job 创建失败');
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on both supported 64-bit ABIs.
      // KILL_ON_JOB_CLOSE is cleanup only; it is not a security isolation policy.
      if (!set(job, 9, limits, limits.length)) {
        close(job);
        throw new Error('Windows Job 清理策略设置失败');
      }
      return job;
    },
    assign(job, pid) {
      const processHandle: unknown = open(0x100 | 0x1, 0, pid);
      if (!valid(processHandle)) return false;
      try { return Boolean(assign(job, processHandle)); }
      finally { close(processHandle); }
    },
    active(job) {
      const accounting = Buffer.alloc(48);
      if (!query(job, 1, accounting, accounting.length, null)) throw new Error('Windows Job 状态读取失败');
      return accounting.readUInt32LE(40);
    },
    terminate(job) { if (!terminate(job, 1)) throw new Error('Windows Job 终止失败'); },
    close(job) { if (!close(job)) throw new Error('Windows Job 句柄关闭失败'); },
  };
}

/** Circle's approval and Job design supplies no kernel network/write boundary for Hub. */
export function windowsIsolationFailure(): string {
  return 'windows_kernel_network_write_isolation_unimplemented';
}

export interface WindowsRestrictedToken {
  readonly handle: bigint;
  close(): void;
}

/** A write-restricted token primitive, not a complete network/exec isolation backend. */
export async function loadWindowsRestrictedToken(): Promise<WindowsRestrictedToken> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
    throw new Error('Windows 受限令牌仅支持原生 x64 或 ARM64');
  const { default: koffi } = await import('koffi');
  return createWindowsRestrictedToken(koffi);
}

/** No impersonation, privilege enabling, account login, or credential-store access. */
export function createWindowsRestrictedToken(koffi: {
  version: string;
  load(name: string): { func(declaration: string): (...args: unknown[]) => unknown };
}): WindowsRestrictedToken {
  if (koffi.version !== '3.3.3') throw new Error('Windows 令牌的 koffi 版本不匹配');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const current = kernel.func('void * __stdcall GetCurrentProcess()');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const free = kernel.func('void * __stdcall LocalFree(void *memory)');
  const open = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)');
  const sidFromString = security.func('int __stdcall ConvertStringSidToSidW(void *text, void *sid)');
  const restrict = security.func('int __stdcall CreateRestrictedToken(void *existing, uint32_t flags, uint32_t disabledCount, void *disabled, uint32_t deletedCount, void *deleted, uint32_t restrictedCount, void *restricted, void *token)');
  const query = security.func('int __stdcall GetTokenInformation(void *token, uint32_t kind, void *data, uint32_t size, void *needed)');
  const equal = security.func('int __stdcall EqualSid(void *first, void *second)');
  const isRestricted = security.func('int __stdcall IsTokenRestricted(void *token)');
  const valid = (handle: bigint): boolean => handle !== 0n && BigInt.asIntN(64, handle) !== -1n;
  let original: bigint | undefined;
  let sid: bigint | undefined;
  let token: bigint | undefined;
  try {
    const output = Buffer.alloc(8);
    // TOKEN_DUPLICATE | TOKEN_QUERY. Never request privilege adjustment rights.
    if (!open(current(), 0xa, output)) throw new Error('Windows 当前进程令牌读取失败');
    original = output.readBigUInt64LE();
    if (!valid(original)) throw new Error('Windows 当前进程令牌无效');
    output.fill(0);
    // NULL SID has no intended grants. It is a restricting SID, not an empty DACL.
    // Actual write denial still requires native behavioral validation of the derived token.
    if (!sidFromString(Buffer.from('S-1-0-0\0', 'utf16le'), output)) throw new Error('Windows 限制 SID 创建失败');
    sid = output.readBigUInt64LE();
    if (!valid(sid)) throw new Error('Windows 限制 SID 无效');
    const entry = Buffer.alloc(16); // SID_AND_ATTRIBUTES on both supported 64-bit ABIs.
    entry.writeBigUInt64LE(sid);
    output.fill(0);
    // DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED; no SANDBOX_INERT or LUA fallback.
    if (!restrict(original, 0x9, 0, null, 0, null, 1, entry, output)) throw new Error('Windows 受限令牌创建失败');
    token = output.readBigUInt64LE();
    if (!valid(token) || !isRestricted(token)) throw new Error('Windows 受限令牌核验失败');
    // Verify the exact derived restricting SID, not merely TokenHasRestrictions.
    const groups = Buffer.alloc(4096);
    const needed = Buffer.alloc(4);
    if (!query(token, 11, groups, groups.length, needed) || needed.readUInt32LE() < 24 ||
        needed.readUInt32LE() > groups.length || groups.readUInt32LE() !== 1 ||
        !equal(groups.readBigUInt64LE(8), sid)) throw new Error('Windows 受限 SID 核验失败');
    const owned = token;
    let closed = false;
    token = undefined;
    return {
      get handle() { if (closed) throw new Error('Windows 受限令牌已关闭'); return owned; },
      close() {
        if (closed) return;
        if (!close(owned)) throw new Error('Windows 受限令牌关闭失败');
        closed = true;
      },
    };
  } finally {
    if (token !== undefined && valid(token)) close(token);
    if (sid !== undefined && valid(sid)) free(sid);
    if (original !== undefined && valid(original)) close(original);
  }
}

/** Windows argv quoting; no command shell is involved. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0')) throw new TypeError('Windows 参数含空字符');
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

/**
 * Trusted synthetic probe launcher only: no pack integration or readiness claim.
 * A suspended LPAC is checked and assigned before any supplied JavaScript runs.
 */
export async function runWindowsIsolationProbe(source: string): Promise<number> {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Windows LPAC 平台不可用');
  if (source.length > 8192 || source.includes('\0')) throw new TypeError('Windows 探针代码无效');
  const { default: koffi } = await import('koffi');
  if (koffi.version !== '3.3.3') throw new Error('Windows LPAC 的 koffi 版本不匹配');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const systemDirectory = kernel.func('uint32_t __stdcall GetSystemDirectoryW(void *buffer, uint32_t size)');
  const system = Buffer.alloc(65536);
  const systemLength = Number(systemDirectory(system, system.length / 2));
  if (!systemLength || systemLength >= system.length / 2) throw new Error('Windows 系统目录读取失败');
  const directory = system.subarray(0, systemLength * 2).toString('utf16le');
  // userenv is not assumed to be a KnownDLL: use the kernel-reported protected directory.
  const userenv = koffi.load(directory + '\\userenv.dll');
  const derive = userenv.func('int32_t __stdcall DeriveAppContainerSidFromAppContainerName(void *name, void *sid)');
  const freeSid = security.func('void * __stdcall FreeSid(void *sid)');
  const initialize = kernel.func('int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, void *size)');
  const update = kernel.func('int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t kind, void *value, uintptr_t size, void *previous, void *returned)');
  const deleteAttributes = kernel.func('void __stdcall DeleteProcThreadAttributeList(void *list)');
  const heap = kernel.func('void * __stdcall GetProcessHeap()')();
  const allocate = kernel.func('void * __stdcall HeapAlloc(void *heap, uint32_t flags, uintptr_t size)');
  const release = kernel.func('int __stdcall HeapFree(void *heap, uint32_t flags, void *memory)');
  const copy = kernel.func('void __stdcall RtlMoveMemory(void *target, void *source, uintptr_t size)');
  const create = security.func('int __stdcall CreateProcessAsUserW(void *token, void *application, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, void *directory, void *startup, void *information)');
  const openToken = security.func('int __stdcall OpenProcessToken(void *process, uint32_t rights, void *token)');
  const query = security.func('int __stdcall GetTokenInformation(void *token, uint32_t kind, void *data, uint32_t size, void *needed)');
  const equal = security.func('int __stdcall EqualSid(void *left, void *right)');
  const resume = kernel.func('uint32_t __stdcall ResumeThread(void *thread)');
  const terminate = kernel.func('int __stdcall TerminateProcess(void *process, uint32_t code)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t timeout)');
  const exitCode = kernel.func('int __stdcall GetExitCodeProcess(void *process, void *code)');
  const close = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');
  const failed = (stage: string): never => { throw new Error(`Windows LPAC ${stage}失败 (${String(lastError())})`); };
  const valid = (value: unknown): value is bigint => typeof value === 'bigint' && value !== 0n && BigInt.asIntN(64, value) !== -1n;
  const w = (value: string): Buffer => Buffer.from(value + '\0', 'utf16le');
  const allocations: bigint[] = [];
  const native = (buffer: Buffer): bigint => {
    const pointer: unknown = allocate(heap, 8, buffer.length);
    if (!valid(pointer)) return failed('分配');
    allocations.push(pointer);
    copy(pointer, buffer, buffer.length);
    return pointer;
  };
  let sid: bigint | undefined;
  let attributes: bigint | undefined;
  let attributesInitialized = false;
  let processHandle: bigint | undefined;
  let thread: bigint | undefined;
  let childToken: bigint | undefined;
  let job: { stop(): Promise<void> } | undefined;
  const restricted = createWindowsRestrictedToken(koffi);
  try {
    const output = Buffer.alloc(8);
    if (derive(w('circle-hub.isolation-probe'), output) !== 0) failed('包 SID');
    sid = output.readBigUInt64LE();
    if (!valid(sid)) failed('包 SID');
    const size = Buffer.alloc(8);
    initialize(null, 4, 0, size);
    const bytes = Number(size.readBigUInt64LE());
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536) failed('属性大小');
    attributes = native(Buffer.alloc(bytes));
    if (!initialize(attributes, 4, 0, size)) failed('属性初始化');
    attributesInitialized = true;
    const capabilities = Buffer.alloc(24); // SECURITY_CAPABILITIES, zero capabilities.
    capabilities.writeBigUInt64LE(sid);
    const one = Buffer.alloc(4); one.writeUInt32LE(1);
    const mitigation = Buffer.alloc(8); mitigation.writeBigUInt64LE(0x10000000n); // Win32k disabled.
    for (const [kind, value] of [[0x20009, capabilities], [0x2000f, one], [0x2000e, one], [0x20007, mitigation]] as const) {
      const pointer = native(value);
      if (!update(attributes, 0, kind, pointer, value.length, null, null)) failed('属性设置');
    }
    const startup = Buffer.alloc(112); // STARTUPINFOEXW, x64/ARM64.
    startup.writeUInt32LE(startup.length);
    startup.writeBigUInt64LE(attributes, 104);
    const info = Buffer.alloc(24);
    const command = w([process.execPath, '--no-addons', '--no-experimental-websocket', '-e', source].map(quoteWindowsArgument).join(' '));
    // CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW.
    // No inherited handles, no shell, no ambient environment, no pack bytes.
    if (!create(restricted.handle, w(process.execPath), command, null, null, 0, 0x08080404,
      Buffer.alloc(4), w(directory), startup, info)) failed('挂起创建');
    processHandle = info.readBigUInt64LE();
    thread = info.readBigUInt64LE(8);
    if (!valid(processHandle) || !valid(thread)) failed('进程句柄');
    const tokenOut = Buffer.alloc(8);
    if (!openToken(processHandle, 8, tokenOut)) failed('子令牌读取');
    childToken = tokenOut.readBigUInt64LE();
    if (!valid(childToken)) failed('子令牌句柄');
    const tokenInfo = (handle: bigint, kind: number): Buffer => {
      const data = Buffer.alloc(4096), needed = Buffer.alloc(4);
      if (!query(handle, kind, data, data.length, needed) || needed.readUInt32LE() > data.length) failed('子令牌核验');
      return data;
    };
    if (tokenInfo(childToken, 29).readUInt32LE() !== 1 || tokenInfo(childToken, 46).readUInt32LE() !== 1 ||
        tokenInfo(childToken, 30).readUInt32LE() !== 0 ||
        (tokenInfo(childToken, 45).readUInt32LE() & 1) !== 1 ||
        !equal(tokenInfo(childToken, 31).readBigUInt64LE(), sid)) failed('LPAC 能力核验');
    const before = tokenInfo(restricted.handle, 11), after = tokenInfo(childToken, 11);
    if (before.readUInt32LE() !== 1 || after.readUInt32LE() !== 1 ||
        !equal(before.readBigUInt64LE(8), after.readBigUInt64LE(8))) failed('写限制 SID 核验');
    const api = createWindowsJobApi(koffi);
    job = attachWindowsJob(api, info.readUInt32LE(16), { userCpuSeconds: 5, committedBytes: 512 * 1024 * 1024 });
    if (resume(thread) !== 1) failed('恢复');
    const deadline = Date.now() + 10_000;
    for (;;) {
      const state = wait(processHandle, 0);
      if (state === 0) break;
      if (state !== 0x102) failed('退出观察');
      if (Date.now() >= deadline) throw new Error('Windows LPAC 探针超时');
      await delay(10);
    }
    const code = Buffer.alloc(4);
    if (!exitCode(processHandle, code)) failed('退出码');
    return code.readUInt32LE();
  } finally {
    // A rejected setup can only leave a suspended process; never resume to clean it up.
    let cleanupFailure: Error | undefined;
    if (processHandle !== undefined && valid(processHandle)) {
      if (wait(processHandle, 0) !== 0) {
        if (!terminate(processHandle, 1) && wait(processHandle, 0) !== 0) cleanupFailure = new Error('Windows LPAC 终止失败');
        const deadline = Date.now() + 10_000;
        while (wait(processHandle, 0) === 0x102 && Date.now() < deadline) await delay(10);
        if (wait(processHandle, 0) !== 0) cleanupFailure = new Error('Windows LPAC 退出未确认');
      }
    }
    try { if (job) await job.stop(); }
    finally {
      if (childToken !== undefined && valid(childToken)) close(childToken);
      if (thread !== undefined && valid(thread)) close(thread);
      if (processHandle !== undefined && valid(processHandle)) close(processHandle);
      if (attributesInitialized) deleteAttributes(attributes!);
      for (const pointer of allocations.reverse()) release(heap, 0, pointer);
      if (sid !== undefined && valid(sid)) freeSid(sid);
      restricted.close();
      if (cleanupFailure) throw cleanupFailure;
    }
  }
}
